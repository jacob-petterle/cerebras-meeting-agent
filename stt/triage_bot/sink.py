"""``TranscriptSink`` — persist segments and expose a downstream agent seam.

Three outputs, all under the ``transcripts/`` directory derived from config:

* **Append-only JSONL** (``session-<ts>.jsonl``) — one segment per line, the
  machine-readable record, written in arrival order.
* **Rolling readable transcript** (``session-<ts>.md``) — re-rendered on every
  segment, sorted by meeting-relative time and merged by speaker so it reads as
  a conversation: ``[mm:ss] Speaker A: ...``.
* **``on_segment(segment)`` callback** — the seam a future triage agent
  subscribes to. We deliberately do not build the agent here.

Overlapping text at window seams is removed per-speaker via
:func:`triage_bot.buffer.dedupe_overlap` before anything is written.
"""

from __future__ import annotations

import json
import logging
import string
import threading
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable

from triage_bot.buffer import Chunk, dedupe_overlap
from triage_bot.config import SinkConfig

logger = logging.getLogger(__name__)

SegmentHandler = Callable[["Segment"], None]


@dataclass
class Segment:
    """A finalized, written transcript segment.

    Attributes:
        t_start: Meeting-relative start time (seconds).
        t_end: Meeting-relative end time (seconds).
        speaker_id: Raw Zoom node-id.
        speaker_label: Friendly label, e.g. "A", "B" (assigned first-seen).
        text: Transcribed (and seam-deduped) text.
        wall_clock: ISO-8601 UTC timestamp of when the segment was written.
    """

    t_start: float
    t_end: float
    speaker_id: str
    speaker_label: str
    text: str
    wall_clock: str


def _mmss(seconds: float) -> str:
    total = int(round(seconds))
    return f"{total // 60:02d}:{total % 60:02d}"


def _timestamped(base: Path, suffix: str, stamp: str) -> Path:
    """``.../session.jsonl`` + ".md" -> ``.../session-<stamp>.md``."""
    return base.with_name(f"{base.stem}-{stamp}{suffix}")


@dataclass
class TranscriptSink:
    """Writes JSONL + a readable transcript and fans out to ``on_segment``."""

    config: SinkConfig
    on_segment: SegmentHandler | None = None
    _segments: list[Segment] = field(default_factory=list)
    _labels: dict[str, str] = field(default_factory=dict)
    _last_text: dict[str, str] = field(default_factory=dict)
    _lock: threading.Lock = field(default_factory=threading.Lock)
    _jsonl_path: Path = field(init=False)
    _readable_path: Path = field(init=False)

    def __post_init__(self) -> None:
        stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
        base = self.config.transcript_jsonl
        base.parent.mkdir(parents=True, exist_ok=True)
        self._jsonl_path = _timestamped(base, ".jsonl", stamp)
        self._readable_path = _timestamped(base, ".md", stamp)
        logger.info("Transcript -> %s", self._jsonl_path)

    @property
    def jsonl_path(self) -> Path:
        return self._jsonl_path

    @property
    def readable_path(self) -> Path:
        return self._readable_path

    def _label_for(self, speaker_id: str) -> str:
        label = self._labels.get(speaker_id)
        if label is None:
            n = len(self._labels)
            label = string.ascii_uppercase[n] if n < 26 else speaker_id
            self._labels[speaker_id] = label
        return label

    def handle(self, chunk: Chunk, text: str) -> None:
        """Build, dedupe, persist, and dispatch a segment from STT output.

        This is the :class:`~triage_bot.stt.ResultHandler` wired into the
        STT worker. Returns early if the text is fully redundant with the
        previous segment from the same speaker (pure seam overlap).
        """
        with self._lock:
            deduped = dedupe_overlap(self._last_text.get(chunk.speaker_id, ""), text)
            if not deduped:
                self._last_text[chunk.speaker_id] = text
                return
            self._last_text[chunk.speaker_id] = text

            segment = Segment(
                t_start=chunk.t_start,
                t_end=chunk.t_end,
                speaker_id=chunk.speaker_id,
                speaker_label=self._label_for(chunk.speaker_id),
                text=deduped,
                wall_clock=datetime.now(timezone.utc).isoformat(),
            )
            self._segments.append(segment)
            self._append_jsonl(segment)
            self._rewrite_readable()

        if self.config.echo_stdout:
            print(f"[{_mmss(segment.t_start)}] Speaker {segment.speaker_label}: {segment.text}")

        if self.on_segment is not None:
            try:
                self.on_segment(segment)
            except Exception:  # noqa: BLE001 — a bad subscriber must not stall STT
                logger.exception("on_segment subscriber raised")

    def _append_jsonl(self, segment: Segment) -> None:
        with self._jsonl_path.open("a", encoding="utf-8") as fh:
            fh.write(json.dumps(asdict(segment), ensure_ascii=False) + "\n")

    def _rewrite_readable(self) -> None:
        """Re-render the conversation, time-ordered and merged by speaker."""
        ordered = sorted(self._segments, key=lambda s: s.t_start)
        lines: list[str] = ["# triage-bot transcript", ""]
        prev_label: str | None = None
        for seg in ordered:
            if seg.speaker_label == prev_label:
                lines[-1] += f" {seg.text}"  # merge consecutive same-speaker turns
            else:
                lines.append(
                    f"[{_mmss(seg.t_start)}] Speaker {seg.speaker_label}: {seg.text}"
                )
                prev_label = seg.speaker_label

        tmp = self._readable_path.with_suffix(".md.tmp")
        tmp.write_text("\n".join(lines) + "\n", encoding="utf-8")
        tmp.replace(self._readable_path)  # atomic swap
