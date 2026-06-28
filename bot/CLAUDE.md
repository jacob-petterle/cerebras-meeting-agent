# bot/ — Zoom Meeting SDK adapter (Phase-2 Zoom track)

> Source of truth for the project is the repo-root **`AGENTS.md`**; Zoom account/app setup is
> **`ZOOM-SETUP.md`**. This file is scoped to the **bot container** and how the TS orchestrator
> (`packages/server`) drives it. It does not restate either of those.

## What this is

The headless **Zoom Meeting SDK for Linux** bot — the one component that must be a native
container (UDP + native libs). It is a **transport adapter only**: it hears the meeting, speaks
audio it's given, and shares a screen. All intelligence (decide loop, STT, TTS) stays in
`packages/server` per `AGENTS.md` ("All-TypeScript; VAD/STT/TTS run server-side").

Runs as Docker **`linux/amd64` under Rosetta** on Apple Silicon (the SDK is x86_64-only; this is
fine — an arm64-native build SIGSEGVs, the x86_64 SDK v7.1.0 under Rosetta is stable).

## How the TS orchestrator drives the bot (the adapter contract)

All audio at the boundary is **32 kHz mono signed-16-bit little-endian PCM**.

- **Hear** — the bot writes **per-speaker** raw PCM to the bind-mounted `out/node-<userid>.pcm`.
  Feed those bytes to the server's existing **Moonshine STT** (same "raw PCM in, STT server-side"
  path as the local mic adapter — parity, no second STT). Ignore the bot's *own* `node-<botid>.pcm`
  (it's silent) to avoid self-transcription.
- **Speak** — stream the server's **kokoro** TTS audio to the bot over **TCP `:3001`**, as 32 kHz
  mono s16le (kokoro is 24 kHz → resample in the media/adapter layer, per `AGENTS.md`). The bot
  plays it through a virtual mic. Send **one utterance per turn**; expose a **flush/stop** for
  barge-in; suppress STT of the bot's own voice (self-echo guard).
- **Show** — write what to display to the **share channel** `out/share_text.txt`; the bot renders
  it as an OpenCV overlay on its screen-share, updated live. (Text today; image/URL via a Chromium
  stage page is the documented next step — see `ARCHITECTURE.md` "Presentation pipeline".)

## Run

1. **SDK binaries** (gitignored, licensed): download the Linux **x86_64** Meeting SDK v7.1.0 into
   `lib/zoomsdk/` — see `lib/zoomsdk/README.md`.
2. **Credentials/meeting:** `cp sample.config.toml config.toml`; fill Client ID/Secret + a
   `join-url` you host on that account (details in repo-root `ZOOM-SETUP.md`). Keep
   `send-audio=true`, `screen-share=true`.
3. `docker compose up` → bot joins. As host: admit it, **grant recording permission** (gates raw
   capture), allow share. **Regular meeting, not a webinar** (raw share returns `UNKNOWN(13)` in
   webinars); host on the app's own account.

## Operational gotchas
- **Clear `out/node-*.pcm` and `out/share_text.txt` between runs** — files are append-mode and Zoom
  reassigns per-meeting user-ids, so stale files mislead.
- Recording permission is per session; without it no audio is captured.
- The bot's own stream (`node-<botid>.pcm`) is silent and grows large — exclude that user-id.

## Status
Capture, virtual-mic speak (`:3001`), and raw screen-share were validated **end-to-end in a live
meeting** via a throwaway local harness (kept out of this repo per the all-TypeScript decision).
The production loop is **`packages/server` ↔ this bot**.
