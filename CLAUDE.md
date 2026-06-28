# CLAUDE.md — Zoom triage-bot: how the agent drives the bot, and how to keep it healthy

> Repo guidance for anyone (human or agent) wiring the Cerebras/Gemma agent to the Zoom bot.
> The bot is the **transport** (it hears, speaks, shares); the agent is the **brain**. This doc
> is the contract between them + the operational/health rules. Move it to the consolidated repo
> (`cerebras-meeting-agent`) and fold into AGENTS.md/ARCHITECTURE.md.

## The shape

```
Zoom ──audio──▶ bot capture ──node-*.pcm (bind mount)──▶ STT (parakeet-mlx) ──transcript──▶ AGENT
AGENT ──speak(audio)──▶ TCP :3001 ──▶ bot virtual mic ──▶ Zoom   (bot is HEARD)
AGENT ──share_screen(content)──▶ share channel ──▶ bot raw screen-share ──▶ Zoom   (bot is SEEN)
```

Everything except the agent runs on the Mac host. Bot runs in Docker `linux/amd64` under Rosetta
(SDK is x86_64-only; this is fine). Audio is **32 kHz mono signed-16-bit little-endian PCM** at
every boundary.

## What the AGENT must do / know

### 1. Speak (play audio the agent produced)
- The agent decides what to say and produces audio (e.g. kokoro). To make the bot say it, deliver
  the audio to the **TTS channel: TCP `localhost:3001`** as **32 kHz mono s16le PCM**.
- **Resampling is the bot-side adapter's job** (`triage_bot/tts.py` `PCMSender`). The agent may hand
  audio at its native rate (kokoro is ~24 kHz) **as long as it declares the sample rate/encoding** —
  the adapter resamples to 32 kHz and **paces it to real time** (the bot has a ~200 ms jitter buffer;
  don't dump faster than real time without the pacer).
- Deliver **one utterance per call** (a file or a length-delimited message) so playout has clean
  boundaries. The bot keeps the mic open and sends silence between utterances.
- **Interruption / barge-in:** the agent must be able to **stop/flush** current playout when a human
  starts talking. Expose + honor a control signal (`tts_control: flush|stop`). Without this the bot
  talks over people.

### 2. Share screen (via a tool call)
- `share_screen(content)` updates what the bot shows. **Supported now:** `type:"text"` → written to
  the share channel (`out/share_text.txt`) → rendered as an OpenCV overlay, updated live each frame.
- **Planned:** `type:"image"` / `type:"deliverable"` (by id) / `type:"url"` (Chromium Stage Page).
  For images/deliverables the agent must make the asset reachable (bind-mount path or a URL the bot
  fetches). Keep content legible: 1280×720, big high-contrast text (Zoom re-encodes the share).
- Calling it again **replaces** the displayed content. There is one share surface.

### 3. Self-echo prevention (critical — prevents feedback loops)
- The bot captures **its own** audio stream too (`node-<bot_userid>.pcm`). The agent/orchestrator must
  **not** transcribe the bot's own voice and re-trigger itself. Today: a self-echo guard + STT is
  suppressed while the bot is speaking. The agent should treat only **human** transcript segments as
  input, never its own `speak` output.

### 4. Latency expectations
- STT is **chunked (~1–2 s)**, not word-streaming. TTS is paced real-time. Share is sub-second + Zoom's
  own encode (a few hundred ms). Design turns around "~1–2 s after I stop talking," not instant.

## How to keep it healthy (polling / monitoring — "make sure the audio looks good")

Add a **status/heartbeat channel** (the control WS, contracts doc Channel 4) where the bot emits
every ~1 s, and a small **monitor** that polls it and the audio. Watch:

| Signal | Healthy | Red flag → likely cause |
|---|---|---|
| Per-speaker `node-*.pcm` growing while a human talks | bytes increase | flat → recording permission not granted / capture dropped |
| Captured audio **RMS** (per speaker) | above silence floor when speaking, no clipping | always silent → wrong mic/muted human; clipping → gain too high |
| Audio **format** at boundaries | 32 kHz / mono / s16le | wrong → garbled/chipmunk; validate, don't assume |
| STT emitting segments | new transcript within ~2 s of speech | none → `start_from` skipped it, or worker stalled |
| `:3001` connected + jitter-buffer depth | connected while speaking, depth steady | underrun → choppy; overrun → latency bloat |
| Mic state | `onMicStartSend` fired + bot unmuted | not → mute/unmute twice workaround; check host didn't mute bot |
| Share | `Sharing_Self_Send_Begin` active | not → share blocked / webinar (`UNKNOWN(13)`) / no permission |

Build a `monitor.py` (or extend `preflight/`) that samples these continuously and prints/streams a
health line; alert on any red flag. The cheap pre-meeting version already exists in `preflight/`.

## Operational gotchas (these cost live-meeting time — do them)
- `start_from = "now"`: speak **after** the orchestrator is up; it ignores pre-existing audio.
- **Clear `out/node-*.pcm` and `out/share_text.txt` between runs.** Files are append-mode and Zoom
  assigns new per-meeting user-ids, so stale files re-transcribe old audio and mislead.
- The bot's **own** `node-<bot_userid>.pcm` is silent and grows huge — ignore it (exclude that node id
  from STT to save cycles).
- Host must grant the bot **recording permission** (gates capture) and allow share; **regular meeting,
  not a webinar**; host on the **same Zoom account** that owns the app (own-account no-review path);
  free Basic caps group meetings at **40 min**.

## Pointers
- Transport contracts (ports, formats, channels): `bot/TRANSPORT_CONTRACTS_RESEARCH.md`.
- TTS send internals: `bot/TTS_AUDIO_SEND_RESEARCH.md`. Screen share: `bot/SCREENSHARE_RESEARCH.md`.
  Stage Page (future Chromium share): `bot/STAGE_PAGE_RESEARCH.md`. Plan: `bot/TRANSPORT_SHIM_PLAN.md`.
- Live run procedure + PASS/FAIL table: `stt/RUNBOOK.md`.
