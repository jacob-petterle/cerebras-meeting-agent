"""Fast unit tests for the model-free pipeline components.

Covers the correctness hazards that are easy to get wrong: tailer byte
alignment / odd-byte carry-over, truncation reset, mid-run file discovery,
the segmenter's window+overlap slicing and silence gating, and seam dedupe.

Run with:  uv run python -m pytest tests/test_components.py -q
"""

from __future__ import annotations

import numpy as np

from triage_bot.buffer import Segmenter, dedupe_overlap, rms
from triage_bot.config import AudioConfig, SourceConfig, StreamConfig
from triage_bot.tailer import PCMTailer, TailUpdate

AUDIO = AudioConfig(sample_rate=32000, channels=1, sample_width=2)


def _source(tmp_path, start_from="beginning") -> SourceConfig:
    return SourceConfig(
        watch_dir=tmp_path, file_glob="node-*.pcm", start_from=start_from
    )


def _write(path, samples: np.ndarray) -> None:
    with path.open("ab") as fh:
        fh.write(samples.astype("<i2").tobytes())


# --- tailer ---------------------------------------------------------------


def test_tailer_reads_appended_samples(tmp_path):
    f = tmp_path / "node-1.pcm"
    f.write_bytes(b"")
    tailer = PCMTailer(source=_source(tmp_path), audio=AUDIO)

    _write(f, np.array([1, 2, 3, 4], dtype="<i2"))
    updates = tailer.poll()
    assert len(updates) == 1
    np.testing.assert_array_equal(updates[0].samples, [1, 2, 3, 4])
    assert updates[0].speaker_id == "1"
    assert updates[0].start_offset_bytes == 0


def test_tailer_carries_odd_byte(tmp_path):
    f = tmp_path / "node-1.pcm"
    f.write_bytes(b"")
    tailer = PCMTailer(source=_source(tmp_path), audio=AUDIO)

    # Write 3 bytes: one whole sample + one dangling byte.
    f.open("ab").write(b"\x01\x00\x05")
    updates = tailer.poll()
    assert len(updates) == 1
    np.testing.assert_array_equal(updates[0].samples, [1])

    # Complete the dangling sample; the carried byte must combine correctly.
    f.open("ab").write(b"\x00")  # 0x05 + 0x00 -> sample value 5
    updates = tailer.poll()
    assert len(updates) == 1
    np.testing.assert_array_equal(updates[0].samples, [5])
    assert updates[0].start_offset_bytes == 2  # second sample starts at byte 2


def test_tailer_truncation_resets(tmp_path):
    f = tmp_path / "node-1.pcm"
    f.write_bytes(b"")
    tailer = PCMTailer(source=_source(tmp_path), audio=AUDIO)
    _write(f, np.array([10, 20, 30], dtype="<i2"))
    tailer.poll()

    # Producer restarts the file (shrinks). Tailer must reset to 0.
    f.write_bytes(b"")
    _write(f, np.array([99], dtype="<i2"))
    updates = tailer.poll()
    assert len(updates) == 1
    np.testing.assert_array_equal(updates[0].samples, [99])
    assert updates[0].start_offset_bytes == 0


def test_tailer_start_from_now_skips_existing(tmp_path):
    f = tmp_path / "node-1.pcm"
    _write(f, np.array([1, 2, 3, 4], dtype="<i2"))  # pre-existing audio
    tailer = PCMTailer(source=_source(tmp_path, "now"), audio=AUDIO)
    assert tailer.poll() == []  # nothing replayed

    _write(f, np.array([7, 8], dtype="<i2"))
    updates = tailer.poll()
    np.testing.assert_array_equal(updates[0].samples, [7, 8])
    assert updates[0].start_offset_bytes == 8  # picks up after the existing 4


def test_tailer_discovers_new_speaker_midrun(tmp_path):
    f1 = tmp_path / "node-1.pcm"
    f1.write_bytes(b"")
    tailer = PCMTailer(source=_source(tmp_path), audio=AUDIO)
    tailer.poll()

    f2 = tmp_path / "node-2.pcm"
    _write(f2, np.array([42, 43], dtype="<i2"))
    updates = tailer.poll()
    assert len(updates) == 1
    assert updates[0].speaker_id == "2"
    np.testing.assert_array_equal(updates[0].samples, [42, 43])


# --- segmenter ------------------------------------------------------------


def _stream(window=1.0, overlap=0.25, threshold=0) -> StreamConfig:
    return StreamConfig(
        tick_seconds=1.0,
        window_seconds=window,
        overlap_seconds=overlap,
        silence_rms_threshold=threshold,
    )


def test_segmenter_window_and_overlap(tmp_path):
    seg = Segmenter(
        audio=AUDIO, stream=_stream(window=1.0, overlap=0.25), clock=lambda: 0.0
    )
    # 1.0s window = 32000 samples; step = 0.75s = 24000 samples.
    loud = (np.ones(32000 * 3, dtype="<i2") * 1000)  # 3s of loud audio
    chunks = seg.add(TailUpdate("1", 0, loud))
    assert len(chunks) >= 2
    first = chunks[0]
    assert abs(first.t_start - 0.0) < 1e-6
    assert abs((first.t_end - first.t_start) - 1.0) < 1e-6
    # Second window starts one step (0.75s) later -> overlap retained.
    assert abs(chunks[1].t_start - 0.75) < 1e-6


def test_segmenter_silence_gate(tmp_path):
    seg = Segmenter(
        audio=AUDIO,
        stream=_stream(window=1.0, overlap=0.25, threshold=250),
        clock=lambda: 0.0,
    )
    quiet = np.full(32000 * 2, 10, dtype="<i2")  # RMS ~10, below threshold
    assert seg.add(TailUpdate("1", 0, quiet)) == []


def test_segmenter_anchors_late_joiner_to_meeting_clock(tmp_path):
    # A controllable meeting clock: speaker 1 is anchored at t=0, speaker 2
    # joins five minutes (300s) in.
    now = {"t": 0.0}
    seg = Segmenter(
        audio=AUDIO, stream=_stream(window=1.0, overlap=0.25), clock=lambda: now["t"]
    )
    loud = np.ones(32000 * 2, dtype="<i2") * 1000

    early = seg.add(TailUpdate("1", 0, loud))
    assert abs(early[0].t_start - 0.0) < 1e-3

    now["t"] = 300.0
    late = seg.add(TailUpdate("2", 0, loud))
    assert abs(late[0].t_start - 300.0) < 1e-3
    # Intra-speaker timing still advances exactly by byte offset.
    assert abs((late[0].t_end - late[0].t_start) - 1.0) < 1e-6


def test_rms_zero_for_silence():
    assert rms(np.zeros(100, dtype="<i2")) == 0.0
    assert rms(np.array([], dtype="<i2")) == 0.0


# --- dedupe ---------------------------------------------------------------


def test_dedupe_overlap_strips_repeated_prefix():
    prev = "hello there how are you"
    cur = "how are you doing today"
    assert dedupe_overlap(prev, cur) == "doing today"


def test_dedupe_overlap_no_overlap():
    assert dedupe_overlap("alpha beta", "gamma delta") == "gamma delta"


def test_dedupe_overlap_fully_contained():
    assert dedupe_overlap("the quick brown fox", "brown fox") == ""


def test_dedupe_overlap_empty_previous():
    assert dedupe_overlap("", "fresh start") == "fresh start"
