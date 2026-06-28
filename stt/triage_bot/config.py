"""Load ``config.toml`` and expose typed, validated configuration.

The pipeline is driven entirely by ``config.toml`` (see the repo root). This
module reads it once and hands back a frozen :class:`Config` so the rest of the
package never touches raw dicts or re-reads the file.
"""

from __future__ import annotations

import tomllib
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

DEFAULT_CONFIG_PATH = Path(__file__).resolve().parent.parent / "config.toml"

StartFrom = Literal["now", "beginning"]


@dataclass(frozen=True)
class AudioConfig:
    """PCM format the Zoom SDK writes (verified empirically)."""

    sample_rate: int
    channels: int
    sample_width: int  # bytes per sample

    @property
    def bytes_per_second(self) -> int:
        return self.sample_rate * self.channels * self.sample_width


@dataclass(frozen=True)
class SourceConfig:
    """Where to read the growing per-speaker PCM streams from."""

    watch_dir: Path
    file_glob: str
    start_from: StartFrom


@dataclass(frozen=True)
class StreamConfig:
    """Polling / segmentation knobs."""

    tick_seconds: float
    window_seconds: float
    overlap_seconds: float
    silence_rms_threshold: float


@dataclass(frozen=True)
class STTConfig:
    model: str


@dataclass(frozen=True)
class SinkConfig:
    transcript_jsonl: Path
    echo_stdout: bool


@dataclass(frozen=True)
class Config:
    """Top-level, fully-typed configuration for the pipeline."""

    audio: AudioConfig
    source: SourceConfig
    stream: StreamConfig
    stt: STTConfig
    sink: SinkConfig

    @property
    def transcript_dir(self) -> Path:
        """Directory the sink writes JSONL + readable transcripts into."""
        return self.sink.transcript_jsonl.parent


def load_config(path: Path | str = DEFAULT_CONFIG_PATH) -> Config:
    """Parse ``config.toml`` into a validated :class:`Config`.

    Raises:
        FileNotFoundError: if the config file is missing.
        ValueError: if ``start_from`` is not one of the allowed literals.
    """
    path = Path(path)
    with path.open("rb") as fh:
        raw = tomllib.load(fh)

    audio = AudioConfig(
        sample_rate=int(raw["audio"]["sample_rate"]),
        channels=int(raw["audio"]["channels"]),
        sample_width=int(raw["audio"]["sample_width"]),
    )

    start_from = raw["source"]["start_from"]
    if start_from not in ("now", "beginning"):
        raise ValueError(
            f"source.start_from must be 'now' or 'beginning', got {start_from!r}"
        )

    source = SourceConfig(
        watch_dir=Path(raw["source"]["watch_dir"]),
        file_glob=raw["source"]["file_glob"],
        start_from=start_from,
    )

    stream = StreamConfig(
        tick_seconds=float(raw["stream"]["tick_seconds"]),
        window_seconds=float(raw["stream"]["window_seconds"]),
        overlap_seconds=float(raw["stream"]["overlap_seconds"]),
        silence_rms_threshold=float(raw["stream"]["silence_rms_threshold"]),
    )

    stt = STTConfig(model=raw["stt"]["model"])

    sink = SinkConfig(
        transcript_jsonl=Path(raw["sink"]["transcript_jsonl"]),
        echo_stdout=bool(raw["sink"].get("echo_stdout", False)),
    )

    return Config(audio=audio, source=source, stream=stream, stt=stt, sink=sink)
