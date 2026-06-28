"""macOS TTS synthesis + paced PCM streaming to the Zoom bot's virtual mic.

The container can't run TTS (it's a dumb transport shim, amd64/Rosetta); the Mac
synthesizes speech with the built-in ``say`` command and streams raw PCM to the
container over TCP. The container re-paces those bytes and pushes them into the
meeting as the bot's microphone (see the C++ ``ZoomSDKVirtualAudioMicEvent`` /
``TCPSocketServer``).

**One audio format everywhere:** 32,000 Hz, mono, signed 16-bit little-endian
PCM. ``say`` is asked for exactly that, and whatever it actually produces is
normalized to it before sending, so a quirk in ``say`` can't desync the format.

**Pacing matters.** The container's jitter buffer is only ~200 ms and *drops the
oldest bytes when it overflows*. If we blasted a whole utterance at once, most of
it would be dropped. So :class:`PCMSender` streams in 20 ms frames paced against
a monotonic clock at real time (32,000 B/s) — matching the rate the container
drains and pushes into the meeting.

Reusable API:
    * :func:`synthesize_pcm` — ``text`` -> 32k mono s16le PCM ``bytes``.
    * :class:`PCMSender` — paced, reconnecting TCP sender.

Runnable standalone (used by ``preflight/04_tts_tcp.sh``)::

    uv run python -m triage_bot.tts --text "hello" --host 127.0.0.1 --port 3001
    uv run python -m triage_bot.tts --text "hello" --out /tmp/resp.pcm   # file, no socket
"""

from __future__ import annotations

import argparse
import logging
import socket
import subprocess
import tempfile
import time
from pathlib import Path

import numpy as np
import soundfile as sf

logger = logging.getLogger(__name__)

# The single locked audio format for the whole transport lane.
SAMPLE_RATE = 32000          # Hz
CHANNELS = 1                 # mono
SAMPLE_WIDTH = 2             # bytes (s16le)
BYTES_PER_SECOND = SAMPLE_RATE * CHANNELS * SAMPLE_WIDTH  # 64,000

# 20 ms frame = 640 samples = 1280 bytes (mirrors the container's frame size).
FRAME_MS = 20
FRAME_BYTES = int(BYTES_PER_SECOND * FRAME_MS / 1000)     # 1280


def _say_to_wav(text: str, wav_path: Path) -> None:
    """Invoke macOS ``say`` to render ``text`` to a WAV at the target format."""
    subprocess.run(
        [
            "say",
            "--data-format=LEI16@32000",  # signed 16-bit LE, 32 kHz
            "--file-format=WAVE",
            "-o",
            str(wav_path),
            text,
        ],
        check=True,
        capture_output=True,
    )


def _resample_linear(samples: np.ndarray, src_rate: int, dst_rate: int) -> np.ndarray:
    """Cheap linear resample. Only a fallback — ``say`` is asked for 32 kHz."""
    if src_rate == dst_rate or samples.size == 0:
        return samples
    duration = samples.size / src_rate
    dst_n = int(round(duration * dst_rate))
    src_x = np.linspace(0.0, duration, num=samples.size, endpoint=False)
    dst_x = np.linspace(0.0, duration, num=dst_n, endpoint=False)
    return np.interp(dst_x, src_x, samples.astype(np.float64)).astype(np.int16)


def synthesize_pcm(text: str) -> bytes:
    """Synthesize ``text`` and return 32 kHz mono s16le PCM bytes.

    Whatever ``say`` actually writes is normalized to the locked format:
    multi-channel is down-mixed to mono and a non-32 kHz rate is resampled, so
    the bytes returned are always exactly the format the container expects.
    """
    text = text.strip()
    if not text:
        return b""

    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
        wav_path = Path(tmp.name)
    try:
        _say_to_wav(text, wav_path)
        data, sr = sf.read(wav_path, dtype="int16")
    finally:
        wav_path.unlink(missing_ok=True)

    if data.ndim > 1:  # down-mix to mono
        data = data.mean(axis=1).astype(np.int16)
    if sr != SAMPLE_RATE:
        logger.warning("say produced %d Hz, resampling to %d Hz", sr, SAMPLE_RATE)
        data = _resample_linear(data, sr, SAMPLE_RATE)

    return data.astype("<i2").tobytes()


class PCMSender:
    """Paced, reconnecting TCP sender for raw PCM to the container's mic port.

    Connection is lazy and self-healing: a refused/broken socket is logged and
    retried on the next :meth:`send`, so the demo keeps transcribing even when
    the container isn't up yet — the audio channel just stays silent until it is.
    """

    def __init__(self, host: str = "127.0.0.1", port: int = 3001,
                 connect_timeout: float = 2.0) -> None:
        self.host = host
        self.port = port
        self.connect_timeout = connect_timeout
        self._sock: socket.socket | None = None

    def _ensure_connected(self) -> bool:
        if self._sock is not None:
            return True
        try:
            self._sock = socket.create_connection(
                (self.host, self.port), timeout=self.connect_timeout
            )
            self._sock.settimeout(None)  # blocking sends after connect
            logger.info("TTS sender connected to %s:%d", self.host, self.port)
            return True
        except OSError as exc:
            logger.warning(
                "TTS sender could not connect to %s:%d (%s) — is the bot running?",
                self.host, self.port, exc,
            )
            self._sock = None
            return False

    def send(self, pcm: bytes) -> bool:
        """Stream ``pcm`` in real-time-paced 20 ms frames. Returns success.

        Pacing keeps the container's ~200 ms jitter buffer from overflowing
        (which would drop audio). Drift is corrected against a monotonic clock.
        """
        if not pcm:
            return True
        if not self._ensure_connected():
            return False

        assert self._sock is not None
        period = FRAME_MS / 1000.0
        next_tick = time.monotonic()
        try:
            for off in range(0, len(pcm), FRAME_BYTES):
                self._sock.sendall(pcm[off:off + FRAME_BYTES])
                next_tick += period
                slack = next_tick - time.monotonic()
                if slack > 0:
                    time.sleep(slack)
                else:
                    next_tick = time.monotonic()  # fell behind; resync, don't spiral
            return True
        except OSError as exc:
            logger.warning("TTS send failed (%s); will reconnect next time", exc)
            self.close()
            return False

    def close(self) -> None:
        if self._sock is not None:
            try:
                self._sock.close()
            finally:
                self._sock = None


def _main() -> int:
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    ap = argparse.ArgumentParser(description="Synthesize text and stream/save PCM.")
    ap.add_argument("--text", required=True, help="Text to synthesize")
    ap.add_argument("--host", default="127.0.0.1", help="TCP host (container mic port)")
    ap.add_argument("--port", type=int, default=3001, help="TCP port")
    ap.add_argument("--out", help="Write raw PCM to this file instead of sending over TCP")
    args = ap.parse_args()

    pcm = synthesize_pcm(args.text)
    seconds = len(pcm) / BYTES_PER_SECOND
    logger.info("synthesized %d bytes (%.2fs of 32k mono s16le)", len(pcm), seconds)

    if args.out:
        Path(args.out).write_bytes(pcm)
        logger.info("wrote PCM to %s", args.out)
        return 0

    sender = PCMSender(args.host, args.port)
    ok = sender.send(pcm)
    sender.close()
    if not ok:
        logger.error("send failed")
        return 1
    logger.info("sent %d bytes to %s:%d", len(pcm), args.host, args.port)
    return 0


if __name__ == "__main__":
    raise SystemExit(_main())
