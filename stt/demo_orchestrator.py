"""End-to-end demo loop: STT -> echo -> SPEAK (TTS->mic) + SHOW (screen share).

This is the whole point of the transport-shim work, exercised end to end with a
hardcoded echo "agent" (no real LLM). It reuses the existing STT pipeline's
``on_segment`` seam: for each finalized transcript segment we

    1. compute  echo = "I heard you say: " + <transcript>
    2. SHOW it  — write ``echo`` to ``<watch_dir>/share_text.txt``, which the
                  bot's screen-share producer renders every frame; and
    3. SPEAK it — synthesize ``echo`` with macOS ``say`` -> 32k mono s16le PCM
                  and stream it (paced, real time) to the container's TCP mic
                  port, which pushes it into the meeting as the bot's voice.

So one spoken sentence by a human round-trips through: capture -> STT -> echo ->
the bot both *saying* and *showing* the echo. If all three channels work, every
transport seam is proven.

Responses are serialized on a single worker thread: ``on_segment`` (called on
the STT worker) only enqueues, and a dedicated responder thread does the slow
synth+stream so utterances play one at a time, in order, without blocking STT.

    uv run python demo_orchestrator.py [path/to/config.toml]
"""

from __future__ import annotations

import logging
import os
import queue
import signal
import sys
import threading
import tomllib
from dataclasses import dataclass
from pathlib import Path

from triage_bot.config import DEFAULT_CONFIG_PATH, load_config
from triage_bot.orchestrator import Orchestrator
from triage_bot.sink import Segment
from triage_bot.tts import PCMSender, synthesize_pcm

logger = logging.getLogger("demo")


@dataclass(frozen=True)
class DemoSettings:
    """Demo-only knobs, read from an optional ``[demo]`` table in config.toml."""

    tts_host: str
    tts_port: int
    echo_prefix: str
    share_text_file: Path

    @classmethod
    def load(cls, config_path: Path, watch_dir: Path) -> "DemoSettings":
        raw: dict = {}
        try:
            with config_path.open("rb") as fh:
                raw = tomllib.load(fh).get("demo", {})
        except FileNotFoundError:
            pass
        share = raw.get("share_text_file")
        return cls(
            tts_host=str(raw.get("tts_host", "127.0.0.1")),
            tts_port=int(raw.get("tts_port", 3001)),
            echo_prefix=str(raw.get("echo_prefix", "I heard you say: ")),
            # Default to the bind-mounted out/ dir the bot reads from.
            share_text_file=Path(share) if share else watch_dir / "share_text.txt",
        )


def _write_atomic(path: Path, text: str) -> None:
    """Write ``text`` to ``path`` atomically (temp + rename) so the bot, which
    re-reads the file every frame, never sees a torn write."""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(text, encoding="utf-8")
    os.replace(tmp, path)  # atomic within the same directory


class EchoResponder:
    """Serializes echo responses: write share text, then speak, one at a time."""

    def __init__(self, settings: DemoSettings) -> None:
        self.settings = settings
        self.sender = PCMSender(settings.tts_host, settings.tts_port)
        self._queue: queue.Queue[str | None] = queue.Queue()
        self._thread = threading.Thread(target=self._run, name="echo-responder", daemon=True)

    def start(self) -> None:
        # Clear any stale share text from a previous run -> bot shows "listening…".
        _write_atomic(self.settings.share_text_file, "")
        logger.info(
            "Echo responder ready. Share text -> %s | TTS -> %s:%d",
            self.settings.share_text_file,
            self.settings.tts_host,
            self.settings.tts_port,
        )
        self._thread.start()

    def on_segment(self, segment: Segment) -> None:
        """STT seam (runs on the STT worker thread): enqueue and return fast."""
        text = segment.text.strip()
        if not text:
            return
        # Feedback-loop guard: if the bot's own injected TTS is captured back into
        # a per-speaker stream, STT would transcribe our echo and we'd echo it
        # again, forever. Skip anything that looks like our own echo. ("heard you
        # say" is the stable core of the default prefix; tolerant of ASR casing.)
        if "heard you say" in text.lower():
            logger.info("skipping likely self-echo: %s", text)
            return
        self._queue.put(text)

    def _run(self) -> None:
        while True:
            text = self._queue.get()
            try:
                if text is None:  # shutdown sentinel
                    return
                self._respond(text)
            except Exception:  # noqa: BLE001 — one bad response must not kill the loop
                logger.exception("echo response failed")
            finally:
                self._queue.task_done()

    def _respond(self, transcript: str) -> None:
        echo = self.settings.echo_prefix + transcript
        logger.info("ECHO: %s", echo)

        # SHOW first so the screen share updates the instant we start speaking.
        _write_atomic(self.settings.share_text_file, echo)

        # SPEAK: synth on this thread, then stream paced to the container mic.
        pcm = synthesize_pcm(echo)
        if not self.sender.send(pcm):
            logger.warning("could not stream audio (bot not reachable?) — shown only")

    def stop(self) -> None:
        self._queue.put(None)
        if self._thread.is_alive():
            self._thread.join(timeout=5.0)
        self.sender.close()


def main() -> None:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s [%(name)s] %(message)s",
    )

    config_path = Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_CONFIG_PATH
    config = load_config(config_path)
    settings = DemoSettings.load(Path(config_path), config.source.watch_dir)

    responder = EchoResponder(settings)
    orchestrator = Orchestrator(config, on_segment=responder.on_segment)

    def _handle_signal(signum, _frame):
        logger.info("Received %s; stopping.", signal.Signals(signum).name)
        orchestrator.request_stop()

    signal.signal(signal.SIGINT, _handle_signal)
    signal.signal(signal.SIGTERM, _handle_signal)

    responder.start()
    try:
        orchestrator.run()  # blocks until stopped
    finally:
        responder.stop()


if __name__ == "__main__":
    main()
