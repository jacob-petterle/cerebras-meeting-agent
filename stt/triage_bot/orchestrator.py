"""``Orchestrator`` — the tick loop wiring tailer → segmenter → STT → sink.

One thread (this one) polls the tailer and segments audio; a second thread (the
STT worker) drains the chunk queue. On shutdown we flush partial per-speaker
buffers into the queue and drain it so nothing in flight is lost.
"""

from __future__ import annotations

import logging
import threading

from triage_bot.buffer import Segmenter
from triage_bot.config import Config
from triage_bot.sink import SegmentHandler, TranscriptSink
from triage_bot.stt import STTWorker
from triage_bot.tailer import PCMTailer

logger = logging.getLogger(__name__)


class Orchestrator:
    """Owns the pipeline components and runs the polling loop until stopped."""

    def __init__(self, config: Config, on_segment: SegmentHandler | None = None) -> None:
        self.config = config
        self.tailer = PCMTailer(source=config.source, audio=config.audio)
        self.segmenter = Segmenter(audio=config.audio, stream=config.stream)
        self.sink = TranscriptSink(config=config.sink, on_segment=on_segment)
        self.worker = STTWorker(
            stt_config=config.stt, audio=config.audio, on_result=self.sink.handle
        )
        self._stop = threading.Event()

    def request_stop(self) -> None:
        """Ask the loop to exit after the current tick (signal-handler safe)."""
        self._stop.set()

    def run(self) -> None:
        """Start the worker and poll until :meth:`request_stop` is called."""
        logger.info(
            "Watching %s/%s (start_from=%s, tick=%.1fs, window=%.1fs)",
            self.config.source.watch_dir,
            self.config.source.file_glob,
            self.config.source.start_from,
            self.config.stream.tick_seconds,
            self.config.stream.window_seconds,
        )
        self.worker.start()
        # Zero the meeting clock now that the model is loaded, so the first
        # audio read maps to ~t=0 and later joiners are offset from here.
        self.segmenter.reset_clock()
        try:
            while not self._stop.is_set():
                self._tick()
                self._stop.wait(self.config.stream.tick_seconds)
        finally:
            self._shutdown()

    def _tick(self) -> None:
        """One poll: read new audio, segment it, enqueue ready chunks."""
        for update in self.tailer.poll():
            for chunk in self.segmenter.add(update):
                self.worker.submit(chunk)

    def _shutdown(self) -> None:
        """Flush partial buffers, drain the queue, and stop the worker."""
        logger.info("Shutting down: flushing buffers and draining STT queue ...")
        # One last poll so we don't drop bytes written between ticks.
        for update in self.tailer.poll():
            for chunk in self.segmenter.add(update):
                self.worker.submit(chunk)
        for chunk in self.segmenter.flush():
            self.worker.submit(chunk)
        self.worker.stop(drain=True)
        logger.info(
            "Done. Transcript: %s | %s",
            self.sink.jsonl_path,
            self.sink.readable_path,
        )
