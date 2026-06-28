"""``SpeakerBuffer`` + ``Segmenter`` — turn sample streams into STT-sized chunks.

Each speaker's int16 samples are accumulated independently. When a buffer fills
the fixed window (``window_seconds``) we emit a :class:`Chunk` and retain an
``overlap_seconds`` tail as the head of the next window, so words that straddle
the cut appear in both windows and aren't lost. Overlapping *text* at the seam
is removed later (see :func:`dedupe_overlap`, applied by the sink).

Near-silent chunks (int16 RMS below the configured threshold) are dropped here
so the single STT worker never burns compute on dead air — and so the model
doesn't hallucinate tokens from silence.

Timestamps are **meeting-relative**, on a single clock shared by all speakers.
Each speaker's stream is anchored when its file is first observed: the anchor
records the meeting-elapsed time at that moment, and intra-speaker time then
advances exactly by byte-offset ÷ bytes-per-second. So a participant who joins
five minutes in lands at ~05:00, not 00:00, and the merged transcript reflects
the real flow of the conversation.
"""

from __future__ import annotations

import re
import time
from dataclasses import dataclass, field
from typing import Callable

import numpy as np

from triage_bot.config import AudioConfig, StreamConfig
from triage_bot.tailer import TailUpdate


@dataclass
class Chunk:
    """A window of one speaker's audio, ready for transcription.

    Attributes:
        speaker_id: Zoom node-id.
        t_start: Meeting-relative start time in seconds.
        t_end: Meeting-relative end time in seconds.
        samples: int16 mono PCM samples for the window.
        is_final: True if emitted by :meth:`Segmenter.flush` at shutdown.
    """

    speaker_id: str
    t_start: float
    t_end: float
    samples: np.ndarray
    is_final: bool = False


def rms(samples: np.ndarray) -> float:
    """Root-mean-square amplitude of int16 samples (0 for an empty array)."""
    if samples.size == 0:
        return 0.0
    return float(np.sqrt(np.mean(samples.astype(np.float64) ** 2)))


_WORD_RE = re.compile(r"\w+")


def _normalize_words(text: str) -> list[str]:
    return [w.lower() for w in _WORD_RE.findall(text)]


def dedupe_overlap(previous: str, current: str) -> str:
    """Drop a leading run of ``current`` that repeats the tail of ``previous``.

    Consecutive windows share ``overlap_seconds`` of audio, so the start of one
    transcript often re-states the end of the prior one. We find the longest
    word-suffix of ``previous`` that equals a word-prefix of ``current`` and
    strip that prefix from ``current``. Comparison is case-insensitive and
    punctuation-insensitive; the returned text preserves original casing.
    """
    prev_words = _normalize_words(previous)
    cur_tokens = list(_WORD_RE.finditer(current))
    cur_words = [m.group(0).lower() for m in cur_tokens]
    if not prev_words or not cur_words:
        return current.strip()

    max_k = min(len(prev_words), len(cur_words))
    overlap = 0
    for k in range(max_k, 0, -1):
        if prev_words[-k:] == cur_words[:k]:
            overlap = k
            break

    if overlap == 0:
        return current.strip()
    if overlap >= len(cur_words):
        return ""  # entirely contained in the previous segment

    # Slice from the end of the last overlapping word in the original string.
    cut = cur_tokens[overlap - 1].end()
    return current[cut:].strip()


@dataclass
class SpeakerBuffer:
    """Accumulates one speaker's samples and slices fixed windows with overlap."""

    speaker_id: str
    audio: AudioConfig
    stream: StreamConfig
    #: Returns meeting-elapsed seconds; sampled once to anchor this speaker.
    clock: Callable[[], float]
    _pending: np.ndarray = field(
        default_factory=lambda: np.empty(0, dtype="<i2")
    )
    #: File byte offset of the first sample currently in ``_pending``.
    _start_offset_bytes: int = 0
    #: Meeting-elapsed seconds when this speaker's stream was first observed.
    _anchor_seconds: float = 0.0
    #: File byte offset captured at the anchor moment.
    _anchor_byte: int = 0
    _initialized: bool = False

    @property
    def _window_samples(self) -> int:
        return int(self.stream.window_seconds * self.audio.sample_rate)

    @property
    def _overlap_samples(self) -> int:
        return int(self.stream.overlap_seconds * self.audio.sample_rate)

    def _offset_to_seconds(self, byte_offset: int) -> float:
        """Map a file byte offset to meeting-relative time via the join anchor."""
        elapsed_in_stream = (byte_offset - self._anchor_byte) / self.audio.bytes_per_second
        return self._anchor_seconds + elapsed_in_stream

    def add(self, update: TailUpdate) -> list[Chunk]:
        """Append samples; emit any full windows that became available."""
        if not self._initialized:
            # Anchor this speaker to the meeting clock at first observation.
            self._start_offset_bytes = update.start_offset_bytes
            self._anchor_byte = update.start_offset_bytes
            self._anchor_seconds = self.clock()
            self._initialized = True
        self._pending = np.concatenate([self._pending, update.samples])
        return self._drain()

    def _drain(self) -> list[Chunk]:
        chunks: list[Chunk] = []
        window = self._window_samples
        step = window - self._overlap_samples
        while self._pending.size >= window:
            chunk = self._make_chunk(self._pending[:window], is_final=False)
            if chunk is not None:
                chunks.append(chunk)
            # Retain the overlap tail as the head of the next window.
            self._pending = self._pending[step:]
            self._start_offset_bytes += step * self.audio.sample_width
        return chunks

    def flush(self) -> Chunk | None:
        """Emit whatever remains as a final (possibly partial) chunk."""
        if self._pending.size == 0:
            return None
        chunk = self._make_chunk(self._pending, is_final=True)
        self._pending = np.empty(0, dtype="<i2")
        return chunk

    def _make_chunk(self, samples: np.ndarray, *, is_final: bool) -> Chunk | None:
        """Build a chunk, returning None if it is below the silence threshold."""
        if rms(samples) < self.stream.silence_rms_threshold:
            return None
        t_start = self._offset_to_seconds(self._start_offset_bytes)
        n_bytes = samples.size * self.audio.sample_width
        t_end = self._offset_to_seconds(self._start_offset_bytes + n_bytes)
        return Chunk(
            speaker_id=self.speaker_id,
            t_start=t_start,
            t_end=t_end,
            samples=samples.copy(),
            is_final=is_final,
        )


@dataclass
class Segmenter:
    """Routes :class:`TailUpdate`s to per-speaker buffers and collects chunks.

    All buffers share one meeting clock so timestamps are comparable across
    speakers. By default the clock counts monotonic seconds from segmenter
    construction; call :meth:`reset_clock` to re-zero it the instant the
    pipeline actually starts watching (e.g. after the model finishes loading).
    A clock can be injected for deterministic tests.
    """

    audio: AudioConfig
    stream: StreamConfig
    clock: Callable[[], float] | None = None
    _epoch: float = field(default_factory=time.monotonic)
    _buffers: dict[str, SpeakerBuffer] = field(default_factory=dict)

    def __post_init__(self) -> None:
        if self.clock is None:
            self.clock = lambda: time.monotonic() - self._epoch

    def reset_clock(self) -> None:
        """Re-zero the meeting epoch to now (no-op for an injected clock)."""
        self._epoch = time.monotonic()

    def _buffer_for(self, speaker_id: str) -> SpeakerBuffer:
        buf = self._buffers.get(speaker_id)
        if buf is None:
            buf = SpeakerBuffer(
                speaker_id=speaker_id,
                audio=self.audio,
                stream=self.stream,
                clock=self.clock,
            )
            self._buffers[speaker_id] = buf
        return buf

    def add(self, update: TailUpdate) -> list[Chunk]:
        """Feed one tailer update; return any chunks that are ready for STT."""
        return self._buffer_for(update.speaker_id).add(update)

    def flush(self) -> list[Chunk]:
        """Flush every speaker's residual buffer (call at shutdown)."""
        chunks: list[Chunk] = []
        for buf in self._buffers.values():
            chunk = buf.flush()
            if chunk is not None:
                chunks.append(chunk)
        return chunks
