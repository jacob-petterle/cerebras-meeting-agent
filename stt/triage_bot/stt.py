"""``STTWorker`` — the single, serialized Parakeet consumer.

MLX gives us one GPU, so all model access funnels through **one** worker
thread. Parallel tailer/segmenter work feeds a thread-safe queue; this worker
drains it, transcribes each chunk, and hands the text to a callback. The model
is loaded once at startup and reused for every chunk.

``parakeet_mlx``'s ``transcribe`` takes a file path (not an array), so each
chunk is written to a temporary 16-bit PCM WAV — the same on-disk format the
Parakeet CLI was verified against — and removed afterwards.
"""

from __future__ import annotations

import logging
import queue
import tempfile
import threading
from pathlib import Path
from typing import Callable

import numpy as np
import soundfile as sf

from triage_bot.buffer import Chunk
from triage_bot.config import AudioConfig, STTConfig

logger = logging.getLogger(__name__)

#: Callback invoked with (chunk, transcript_text) for every non-empty result.
ResultHandler = Callable[[Chunk, str], None]


class ParakeetSTT:
    """Thin, reusable wrapper around a loaded ``parakeet-mlx`` model.

    Kept separate from the worker thread so it can be unit-tested directly
    (e.g. round-tripping a known WAV to its expected text).
    """

    def __init__(self, model_name: str, audio: AudioConfig) -> None:
        self.model_name = model_name
        self.audio = audio
        self._model = None

    def load(self) -> None:
        """Load the model once. Safe to call repeatedly (no-op after first)."""
        if self._model is None:
            from parakeet_mlx import from_pretrained

            logger.info("Loading Parakeet model %s ...", self.model_name)
            self._model = from_pretrained(self.model_name)
            logger.info("Model loaded.")

    def transcribe_samples(self, samples: np.ndarray) -> str:
        """Transcribe int16 mono samples by routing through a temp WAV file."""
        self.load()
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
            tmp_path = Path(tmp.name)
        try:
            sf.write(
                tmp_path,
                samples.astype("<i2"),
                self.audio.sample_rate,
                subtype="PCM_16",
            )
            return self.transcribe_file(tmp_path)
        finally:
            tmp_path.unlink(missing_ok=True)

    def transcribe_file(self, path: Path | str) -> str:
        """Transcribe an audio file and return the stripped text."""
        self.load()
        assert self._model is not None
        result = self._model.transcribe(str(path))
        return result.text.strip()


class STTWorker:
    """Background thread that serializes MLX access over a chunk queue."""

    def __init__(
        self,
        stt_config: STTConfig,
        audio: AudioConfig,
        on_result: ResultHandler,
        max_queue: int = 256,
    ) -> None:
        self._stt = ParakeetSTT(stt_config.model, audio)
        self._on_result = on_result
        self._queue: queue.Queue[Chunk | None] = queue.Queue(maxsize=max_queue)
        self._thread = threading.Thread(
            target=self._run, name="stt-worker", daemon=True
        )
        self._started = False
        self._ready = threading.Event()
        self._load_error: BaseException | None = None

    def start(self) -> None:
        """Start the consumer thread and block until the model is loaded.

        The model is loaded *inside* the worker thread, not here: MLX GPU
        streams are thread-local, so the thread that runs ``mx.eval`` must also
        be the one that loaded the model. Blocking on a readiness event keeps
        startup synchronous (and surfaces load errors) without crossing threads.
        """
        self._thread.start()
        self._started = True
        self._ready.wait()
        if self._load_error is not None:
            raise self._load_error

    def submit(self, chunk: Chunk) -> None:
        """Enqueue a chunk for transcription (blocks if the queue is full)."""
        self._queue.put(chunk)

    @property
    def pending(self) -> int:
        """Approximate number of chunks waiting to be transcribed."""
        return self._queue.qsize()

    def _run(self) -> None:
        try:
            self._stt.load()
        except BaseException as exc:  # noqa: BLE001 — report to start(), don't hang
            self._load_error = exc
            self._ready.set()
            return
        self._ready.set()

        while True:
            chunk = self._queue.get()
            try:
                if chunk is None:  # shutdown sentinel
                    return
                self._transcribe(chunk)
            finally:
                self._queue.task_done()

    def _transcribe(self, chunk: Chunk) -> None:
        try:
            text = self._stt.transcribe_samples(chunk.samples)
        except Exception:  # noqa: BLE001 — never let one bad chunk kill the worker
            logger.exception(
                "STT failed for speaker %s [%.2f-%.2f]",
                chunk.speaker_id,
                chunk.t_start,
                chunk.t_end,
            )
            return
        if text:
            self._on_result(chunk, text)

    def stop(self, *, drain: bool = True) -> None:
        """Signal shutdown and wait for the worker to finish.

        With ``drain=True`` (default) all queued chunks are transcribed before
        the worker exits, so partial audio flushed at shutdown is not dropped.
        """
        if not self._started:
            return
        if drain:
            self._queue.join()
        self._queue.put(None)
        self._thread.join()
