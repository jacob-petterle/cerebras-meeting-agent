"""Dev harness: simulate the Zoom bot's growing per-speaker PCM output.

The real producer is a Docker container we can't easily run, so this script
mimics it: it copies real sample PCM into a throwaway watch dir and *appends*
to ``node-*.pcm`` in small chunks on a timer (in a background thread), exactly
as the container does. A second speaker file appears partway through to
exercise mid-run discovery. The full pipeline runs against that temp dir and we
print the resulting transcript paths.

    uv run python scripts/simulate_meeting.py

This is the end-to-end integration check (it loads the Parakeet model). For the
fast, model-free correctness tests see ``tests/test_components.py``.
"""

from __future__ import annotations

import logging
import sys
import tempfile
import threading
from pathlib import Path

# Allow `uv run python scripts/simulate_meeting.py` to import the package.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from triage_bot.config import (
    AudioConfig,
    Config,
    SinkConfig,
    SourceConfig,
    STTConfig,
    StreamConfig,
)
from triage_bot.orchestrator import Orchestrator

# Real captures written by the Zoom bot; used as replay source material.
# We replay the non-silent capture for *both* simulated speakers so the run
# demonstrates two speakers being time-ordered and merged in the transcript.
# (node-16781312.pcm is pure silence — replaying it would only exercise the
# silence gate, which the unit tests already cover.)
SAMPLE_DIR = Path("/Users/dylanskinner/meetingsdk-headless-linux-sample/out")
SAMPLE_PCMS = ["node-16778240.pcm", "node-16778240.pcm"]

CHUNK_SECONDS = 0.5  # how much audio to append per writer tick
WRITER_TICK = 0.25  # wall-clock seconds between appends (faster than real time)
SECOND_SPEAKER_DELAY = 10.0  # when the 2nd speaker "joins" (file appears), seconds
RUN_SECONDS = 30.0  # how long to let the pipeline run before stopping


def _build_config(watch_dir: Path, transcript_dir: Path) -> Config:
    return Config(
        audio=AudioConfig(sample_rate=32000, channels=1, sample_width=2),
        source=SourceConfig(
            watch_dir=watch_dir, file_glob="node-*.pcm", start_from="beginning"
        ),
        stream=StreamConfig(
            tick_seconds=0.5,
            window_seconds=8.0,
            overlap_seconds=1.0,
            silence_rms_threshold=250,
        ),
        stt=STTConfig(model="mlx-community/parakeet-tdt-0.6b-v3"),
        sink=SinkConfig(
            transcript_jsonl=transcript_dir / "session.jsonl", echo_stdout=True
        ),
    )


def _stream_pcm(src: Path, dst: Path, stop: threading.Event, delay: float = 0.0) -> None:
    """Append ``src`` into ``dst`` in chunks on a timer, like the container."""
    if stop.wait(delay):
        return
    data = src.read_bytes()
    bytes_per_chunk = int(CHUNK_SECONDS * 32000 * 2)
    dst.touch()
    pos = 0
    while pos < len(data) and not stop.is_set():
        with dst.open("ab") as fh:
            fh.write(data[pos : pos + bytes_per_chunk])  # closed -> flushed
        pos += bytes_per_chunk
        if stop.wait(WRITER_TICK):
            return


def main() -> None:
    logging.basicConfig(
        level=logging.INFO, format="%(asctime)s %(levelname)s [%(name)s] %(message)s"
    )
    log = logging.getLogger("harness")

    missing = [p for p in SAMPLE_PCMS if not (SAMPLE_DIR / p).exists()]
    if missing:
        raise SystemExit(f"Missing sample PCM(s) in {SAMPLE_DIR}: {missing}")

    with tempfile.TemporaryDirectory(prefix="triage-sim-") as tmp:
        tmp_path = Path(tmp)
        watch_dir = tmp_path / "out"
        watch_dir.mkdir()
        transcript_dir = tmp_path / "transcripts"

        config = _build_config(watch_dir, transcript_dir)
        orchestrator = Orchestrator(config)

        stop = threading.Event()
        writers = [
            threading.Thread(
                target=_stream_pcm,
                args=(SAMPLE_DIR / SAMPLE_PCMS[0], watch_dir / "node-1.pcm", stop),
                daemon=True,
            ),
            threading.Thread(
                target=_stream_pcm,
                args=(
                    SAMPLE_DIR / SAMPLE_PCMS[1],
                    watch_dir / "node-2.pcm",
                    stop,
                    SECOND_SPEAKER_DELAY,
                ),
                daemon=True,
            ),
        ]
        for w in writers:
            w.start()

        # Stop the orchestrator after RUN_SECONDS from a timer thread.
        threading.Timer(RUN_SECONDS, orchestrator.request_stop).start()

        log.info("Simulating meeting into %s ...", watch_dir)
        orchestrator.run()
        stop.set()

        jsonl = orchestrator.sink.jsonl_path
        readable = orchestrator.sink.readable_path
        log.info("=== JSONL (%s) ===", jsonl)
        if jsonl.exists():
            print(jsonl.read_text())
        log.info("=== Readable (%s) ===", readable)
        if readable.exists():
            print(readable.read_text())


if __name__ == "__main__":
    main()
