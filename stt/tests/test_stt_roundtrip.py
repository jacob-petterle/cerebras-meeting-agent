"""Round-trip check: a known WAV through the STT wrapper to its expected text.

Loads the real Parakeet model and downloads weights on first run, so it is slow
and network-dependent. Skipped automatically if the sample WAV is absent.

    uv run python -m pytest tests/test_stt_roundtrip.py -q -s
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

from triage_bot.config import AudioConfig
from triage_bot.stt import ParakeetSTT

SAMPLE_WAV = Path("/Users/dylanskinner/meetingsdk-headless-linux-sample/out/verify_32k.wav")
MODEL = "mlx-community/parakeet-tdt-0.6b-v3"
AUDIO = AudioConfig(sample_rate=32000, channels=1, sample_width=2)


def _words(text: str) -> set[str]:
    return set(re.findall(r"\w+", text.lower()))


@pytest.mark.skipif(not SAMPLE_WAV.exists(), reason="verify_32k.wav not present")
def test_known_wav_roundtrips():
    stt = ParakeetSTT(MODEL, AUDIO)
    text = stt.transcribe_file(SAMPLE_WAV)
    print(f"\nTranscript: {text!r}")

    # Expected: "Hello TriageBot, how are you, stinky boy?" — allow ASR/casing
    # variance by asserting the salient content words are present.
    got = _words(text)
    for expected in ("hello", "how", "are", "you", "stinky", "boy"):
        assert expected in got, f"missing {expected!r} in transcript: {text!r}"
