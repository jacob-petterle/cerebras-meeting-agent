# triage-bot — audio streamer + STT

Streams per-speaker audio produced by the Zoom Linux SDK bot, runs continuous
speech-to-text with `parakeet-mlx`, and emits a timestamped, speaker-labeled
transcript for the triage agent.

## Why this shape

The Zoom bot runs in Docker (amd64 under Rosetta) and writes per-speaker raw PCM
to a **bind-mounted** folder on the host. This Python app runs on the **host**
(Apple Silicon) because `parakeet-mlx` needs MLX, which can't run in the amd64
Linux container. So the integration boundary is the shared `out/` directory:

```
┌─ Docker (amd64/Rosetta) ─┐         ┌─ Host (Apple Silicon) ──────────────┐
│  Zoom bot                │  writes │  triage-bot (this app)               │
│   └─ out/node-<id>.pcm ──┼────────▶│   tail → buffer → Parakeet → agent   │
└──────────────────────────┘  bind   └──────────────────────────────────────┘
```

No sockets, no network — the filesystem is the streaming channel.

## Audio format (verified empirically)

16-bit signed little-endian PCM, **mono**, **32,000 Hz**. (368 KB of capture
decoded to 5.88 s → confirms 32 kHz.) Each sample is 2 bytes.

## Pipeline

```
node-*.pcm (growing, appended by the container)
  → PCMTailer      poll per file, track byte offset, return new 2-byte-aligned samples
  → SpeakerBuffer  accumulate int16 samples per speaker (keyed by node-id)
  → Segmenter      fixed ~8 s window + ~1 s overlap; skip near-silent chunks
  → STTWorker      single serialized MLX consumer: int16 → float32 → parakeet-mlx
  → TranscriptSink {t_start, t_end, speaker_id, text} → JSONL + on_segment() hook
```

## Design decisions locked

- **Segmentation:** fixed window (~8 s) + ~1 s overlap, dedupe at the seam.
- **STT:** `mlx-community/parakeet-tdt-0.6b-v2` via `parakeet-mlx`.
- **Env:** uv project, separate from the Zoom repo.
- **Speakers:** keyed by `node-id` for now (Speaker A/B). Name mapping is a
  later, additive step (needs a small SDK-side change in the bot).
- **Agent handoff:** decoupled via JSONL + a callback seam; agent wiring is a
  separate step.

## Hard parts (and how we handle them)

1. **Reading a file the container is still writing** — poll (re-stat + seek each
   tick), not inotify; Docker Desktop's VirtioFS doesn't deliver fs events
   reliably across the VM boundary.
2. **Sample alignment** — always read an even number of bytes; carry a trailing
   odd byte to the next tick so we never phase-shift the 16-bit stream.
3. **Truncation / restarts** — if file size < tracked offset, reset to 0; new
   `node-<id>.pcm` appearing registers a new speaker mid-stream.
4. **Segmentation seams** — overlap + dedupe so words spanning a cut aren't lost.
5. **Silence gating** — RMS threshold; don't run STT on dead air (saves compute,
   avoids hallucinated tokens).
6. **Concurrency** — parallel tailers feed one queue; a single STT worker drains
   it so MLX access is serialized (one GPU), with natural backpressure.
7. **Conversation ordering** — each speaker is transcribed independently, so
   segments carry timestamps on one shared meeting clock and are merged by time
   to reconstruct who-said-what-when. Each speaker's stream is **anchored** when
   its file is first observed: the anchor records meeting-elapsed seconds at
   that moment, and intra-speaker time then advances exactly by byte offset ÷
   32000 ÷ 2. So a participant who joins five minutes in lands at ~05:00, not
   00:00. (The meeting clock zeroes once the model has loaded and watching
   begins.)

## Config

See `config.toml` — paths, audio format, tick/window/overlap, silence threshold,
model, and sink locations.

## Modules (built)

- `triage_bot/config.py` — load `config.toml`, expose a typed, frozen `Config`.
- `triage_bot/tailer.py` — `PCMTailer`: glob discovery, per-file byte offsets,
  even-byte-aligned reads with odd-byte carry, truncation reset, mid-run files.
- `triage_bot/buffer.py` — `SpeakerBuffer` + `Segmenter`: fixed window + overlap
  carry-over, RMS silence gate, plus `dedupe_overlap` for the transcript seam.
- `triage_bot/stt.py` — `ParakeetSTT` (reusable parakeet-mlx wrapper, int16 →
  temp WAV) + `STTWorker` (single thread serializing MLX access over a queue).
- `triage_bot/sink.py` — `TranscriptSink`: append-only JSONL + rolling readable
  `.md` (time-ordered, speaker-merged) + an `on_segment(segment)` callback seam.
- `triage_bot/orchestrator.py` — tick loop wiring tailer → buffers → queue → STT
  → sink, with graceful shutdown (flush partial buffers, drain the queue).
- `main.py` — entrypoint: load config, install SIGINT/SIGTERM handlers, run.

## Running it

Against the live `out/` dir (uses `config.toml`; `start_from="now"` so audio
already on disk at startup is **not** re-transcribed):

```sh
uv run python main.py                # or: uv run python main.py path/to/config.toml
```

Ctrl-C (SIGINT) or SIGTERM stops it cleanly: it flushes each speaker's partial
buffer, drains the STT queue, and prints the transcript paths. Output lands in
`transcripts/session-<timestamp>.jsonl` (one segment per line) and
`transcripts/session-<timestamp>.md` (readable `[mm:ss] Speaker A: …`).

### Tests / dev harness

```sh
# Fast, model-free unit tests (tailer alignment, segmenter, dedupe):
uv run python -m pytest tests/test_components.py -q

# STT round-trip on the known sample WAV (loads the model; downloads on first run):
uv run python -m pytest tests/test_stt_roundtrip.py -q -s

# Full end-to-end simulation: a background thread appends to node-*.pcm in a
# temp dir (a 2nd speaker appears mid-run) while the real pipeline transcribes.
uv run python scripts/simulate_meeting.py
```

### Downstream agent seam

`TranscriptSink` accepts an `on_segment(segment)` callback; `Orchestrator`
forwards it through. A future triage agent subscribes there — no agent is built
here (that's an additive step), the seam is just left clean.

## End-to-end demo loop (echo "agent")

`demo_orchestrator.py` wires that `on_segment` seam to a hardcoded echo responder
to exercise **every** transport channel end to end (no real LLM):

```
you speak → STT → echo "I heard you say: <text>"
         → say → 32k mono s16le PCM → TCP :3001 → bot SPEAKS it
         └→ write out/share_text.txt → bot SHOWS it on screen share
```

```sh
uv run python demo_orchestrator.py     # runs STT + echo + speak + show together
```

- `triage_bot/tts.py` — macOS `say` → 32k mono s16le PCM (`synthesize_pcm`), and
  `PCMSender`, a **real-time-paced** TCP sender (so the container's ~200 ms jitter
  buffer never overflows). Also runnable standalone: `python -m triage_bot.tts`.
- `demo_orchestrator.py` — subscribes to `on_segment`, serializes responses on one
  worker thread (write share text, then speak), with a self-echo guard so the bot
  never transcribes and re-echoes its own voice.
- The container side (the bot that speaks + shares) lives in the
  `meetingsdk-headless-linux-sample` repo; this app drives it over the bind-mounted
  `out/` dir and `localhost:3001`.

Demo knobs are in `config.toml` under `[demo]` (TTS host/port, echo prefix,
share-text path).

## Pre-flight harness + live RUNBOOK

Meeting minutes are scarce, so validate everything possible **without** a meeting
first. `preflight/01..05` each print a clear `PASS`/`FAIL`:

```sh
./preflight/01_build.sh        # container builds; binary exposes both send features
./preflight/02_stt_file.sh     # Parakeet transcribes out/verify_32k.wav correctly
./preflight/03_say_format.sh   # `say` outputs exactly 32k mono s16le
./preflight/04_tts_tcp.sh      # Mac → TCP :3001 PCM path (run with the container stopped)
./preflight/05_share_render.sh # share text overlay renders legibly → preflight/out/*.png
```

Then follow **[`RUNBOOK.md`](RUNBOOK.md)** for the single live-meeting test: exact
start order, what to say, the three things to verify (HEARD / SEEN / TRANSCRIPT),
a per-channel PASS/FAIL checklist, and an "if X is broken, likely cause" table.
