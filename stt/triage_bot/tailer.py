"""``PCMTailer`` — incrementally read growing per-speaker PCM files.

The Zoom bot (running in Docker) continuously *appends* raw PCM to
``node-<id>.pcm`` files in a bind-mounted directory. We consume them from the
host by polling: every tick we re-``stat`` each file and read whatever bytes
appeared since last time. We deliberately do **not** use inotify/filesystem
events — Docker Desktop's VirtioFS does not deliver them reliably across the VM
boundary.

Two correctness hazards are handled here:

* **Sample alignment.** Each sample is 2 bytes (16-bit LE). A read can land on
  an odd byte boundary, so we only ever emit complete samples and carry a
  trailing odd byte to the next tick. Sample boundaries are tracked relative to
  the file start so the int16 stream never phase-shifts.
* **Truncation / restart.** If a file shrinks (size < bytes already read), the
  producer restarted it; we reset our offset to 0 and re-read from the top.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

from triage_bot.config import AudioConfig, SourceConfig

_NODE_ID_RE = re.compile(r"node-(?P<id>.+)\.pcm$")


def _speaker_id_from_path(path: Path) -> str:
    """Extract the Zoom node-id used as the speaker key from a filename."""
    match = _NODE_ID_RE.search(path.name)
    return match.group("id") if match else path.stem


@dataclass
class TailUpdate:
    """A batch of newly-read, sample-aligned audio from one speaker's file.

    Attributes:
        speaker_id: Zoom node-id the audio belongs to.
        start_offset_bytes: Byte offset (from file start) of the first sample in
            ``samples``. Meeting-relative time = ``start_offset_bytes`` /
            ``bytes_per_second``.
        samples: int16 mono PCM samples.
    """

    speaker_id: str
    start_offset_bytes: int
    samples: np.ndarray


@dataclass
class _FileState:
    """Per-file bookkeeping for incremental reads."""

    speaker_id: str
    #: Total bytes read from the file so far (advances past the odd carry too).
    read_bytes: int = 0
    #: Bytes emitted as complete samples; always even (sample-aligned).
    emitted_bytes: int = 0
    #: Trailing odd byte read but not yet emitted (0 or 1 byte).
    carry: bytes = b""


@dataclass
class PCMTailer:
    """Discover and incrementally read ``node-*.pcm`` streams.

    Construct once, then call :meth:`poll` every tick. ``poll`` re-globs the
    watch directory (so new speakers appearing mid-meeting are picked up) and
    returns all sample-aligned audio that appeared since the previous call.
    """

    source: SourceConfig
    audio: AudioConfig
    _files: dict[Path, _FileState] = field(default_factory=dict)

    def __post_init__(self) -> None:
        # Initial discovery honours start_from: "now" seeks each existing file
        # to its current (aligned) EOF so pre-existing audio is not replayed.
        self._discover(initial=True)

    def _discover(self, *, initial: bool) -> None:
        """Glob the watch dir and register any not-yet-tracked files.

        Files discovered after startup (new speakers) always start at offset 0
        so none of their audio is missed, regardless of ``start_from``.
        """
        for path in sorted(self.source.watch_dir.glob(self.source.file_glob)):
            if path in self._files:
                continue
            state = _FileState(speaker_id=_speaker_id_from_path(path))
            if initial and self.source.start_from == "now":
                try:
                    size = path.stat().st_size
                except OSError:
                    size = 0
                aligned = size - (size % 2)
                state.read_bytes = aligned
                state.emitted_bytes = aligned
            self._files[path] = state

    def poll(self) -> list[TailUpdate]:
        """Read new bytes from every tracked file and return aligned samples."""
        self._discover(initial=False)

        updates: list[TailUpdate] = []
        for path, state in self._files.items():
            update = self._read_file(path, state)
            if update is not None:
                updates.append(update)
        return updates

    def _read_file(self, path: Path, state: _FileState) -> TailUpdate | None:
        """Read appended bytes from one file, emitting only complete samples."""
        try:
            size = path.stat().st_size
        except OSError:
            return None

        # Truncation / restart: file shrank below where we'd read. Start over.
        if size < state.read_bytes:
            state.read_bytes = 0
            state.emitted_bytes = 0
            state.carry = b""

        if size <= state.read_bytes:
            return None  # no new data

        try:
            with path.open("rb") as fh:
                fh.seek(state.read_bytes)
                new_data = fh.read(size - state.read_bytes)
        except OSError:
            return None

        if not new_data:
            return None
        state.read_bytes += len(new_data)

        # Prepend any carried odd byte, then split off a fresh odd byte (if any).
        buf = state.carry + new_data
        n_complete = len(buf) - (len(buf) % 2)
        if n_complete == 0:
            state.carry = buf
            return None

        sample_bytes = buf[:n_complete]
        state.carry = buf[n_complete:]

        start_offset = state.emitted_bytes
        state.emitted_bytes += n_complete

        samples = np.frombuffer(sample_bytes, dtype="<i2")
        return TailUpdate(
            speaker_id=state.speaker_id,
            start_offset_bytes=start_offset,
            samples=samples,
        )
