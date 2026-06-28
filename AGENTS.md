# AGENTS.md — source of truth for implementers

> **If you are a sub-agent or a future session: read THIS file + the implementation plan
> (`~/.claude/plans/staged-splashing-axolotl.md`) first.** On any conflict with the older research
> docs (ARCHITECTURE.md, RISK-AUDIT.md), this file + the plan win. See "Doc status" at the bottom.

## What we're building (current phase)

A scoped AI agent that joins a live conversation, listens, decides when to help, researches via a
sub-agent, and responds by voice + on a shared screen. **Right now we are building the entire loop
for LOCAL use only — no Zoom.** Zoom is a later adapter swap.

## Architecture (locked)

- **Ports & adapters.** Brain + tools + resource spine are transport-agnostic. Local adapters
  (browser mic → WS PCM, system speakers, in-app stage) now; Zoom adapters later. Build core once.
- **All-TypeScript.** No Python. One pnpm workspace, Node ≥ 22.13.
- Loop: `mic → VAD → STT → transcript → 5s heartbeat → Gemma decides → call_agent → stage render + TTS speak`.

## Stack (decided, source-verified)

- **LLM** — `openai` npm → baseURL `https://api.cerebras.ai/v1`, model `gemma-4-31b`. **Accumulate streamed `tool_calls` by `index`** (Cerebras quirk).
- **Sub-agent** — `@cursor/sdk` (native TS). Mocked first (fixed FINDINGS.html), real later. Brief: CURSOR-SDK-BRIEF.md.
- **STT** — Moonshine (`onnx-community/moonshine-base-ONNX`) via `@huggingface/transformers` 3.8.1, **`device:'cpu'`** (verified running locally, on-device). NOTE: transformers.js 3.8.1 has **no `'coreml'` device string** — ANE/CoreML would need an onnxruntime-node execution-provider config, a later optimization. **No hosted fallback.**
- **TTS** — `kokoro-js` (on-device, ~sub-1s/sentence). **No hosted fallback.**
- **VAD** — `@ricky0123/vad-node` (pin `onnxruntime-node`).
- **Web** — Vite.

## Resource spine (Option C — grounded in Shipyard)

Own **seqNo append-log**, NOT Loro. Mirrors Shipyard's plain-JSON/JSONL message+deliverable model
(`seqNo == array index`). `AppendLog<T>.since(cursor)` is the heartbeat delta-read; shapes mirror
`MessageSchema` + `DeliverableRecord`. Contracts already written in
`packages/protocol/src/{events,resources,tools}.ts`. **Do NOT** add Loro / `@loro-extended` / the
local-direct frame protocol / the at-least-once shell — deliberately skipped. Full design: the
plan's "Resource model" section.

## Web consumer + stage render (grounded in Shipyard — research aced557d)

Our web app mirrors Shipyard's **real consumer pattern** — NOT its plugin system (the file-based
plugin `plugin_push` is a full-snapshot replace with no seqNo/catch-up — strictly weaker than our
transcript needs). **Decision: Option A** (our own WS subscribe/render). Copy:

- **Console (transcript) = seqNo append-log consumer.** Model on `~/repos/shipyard/apps/web/src/stores/channel-store.ts` (appendMessage/catchUp, ordered by seqNo, highWaterMark, dedupe). This is the consumer half of our `subscribe`/`catch_up`/`append` protocol — already designed. **No change to ws.ts.**
- **Stage (artifacts) = deliverable renderer.** Model on `~/repos/shipyard/apps/web/src/components/panels/deliverable-viewers.tsx` — a pure `kind → component` switch (html→sandboxed iframe, markdown→md, json→pre, image/screenshot→img). Reuse the sandboxed-iframe primitive `~/repos/shipyard/apps/web/src/components/visualize/html-sandbox.tsx`. **mermaid is not a deliverable kind** — render mermaid→SVG client-side (mermaid.js) into the sandbox.
- **Do NOT** use the plugin data-bridge or the canvas/Loro stack. Optional cheap nod to future Shipyard-compat: name the stage iframe messages `shipyard-plugin-data`/`-push` (~20 lines, postMessage layer only, no server change).

## What NOT to build (for the local harness)

- **No Zoom** — later adapter (ZOOM-SETUP.md is Dylan's Phase-2 track).
- **No Cloudflare** — CLOUDFLARE-LAUNCH.md is post-local deployment, not now.
- **No Shipyard daemon / local-direct WS client** — ARCHITECTURE.md Thread 2 is superseded; we use the Cursor SDK.
- **No Pipecat** — voice is local Moonshine/kokoro.
- **No Loro/CRDT** — resources are a seqNo append-log.

## Implementer gotchas

- **Audio sample rates:** mic = 48 kHz → resample to **16 kHz mono** for VAD + Moonshine; kokoro
  outputs **24 kHz** → resample for playback. Resampling lives in the media/adapter layer.
- **Streamed tool_calls:** assemble by `index` across chunks (a test guards this).
- **Node ≥ 22.13** (required by `@cursor/sdk`). Pin `onnxruntime-node` (vad-node is a stale binding).
- **Keep the browser dumb:** mic → raw PCM over WS; VAD/STT/TTS run server-side (parity with Zoom).

## Build plan & tasks

- Plan (steps, test spec, file tree): `~/.claude/plans/staged-splashing-axolotl.md`.
- Tasks #1–#10 in the Shipyard panel: foundation → core/media/web in parallel → adapters → wire+smoke → swap real SDK → verify.

## Local reference repos (read the source, don't guess)

- `~/repos/shipyard` — resource model we mirror: `packages/loro-schema/src/{schema.ts:346,deliverable-schemas.ts:45,jsonl-conversation-store.ts:58}`.
- `~/repos/cursor-sdk` — Cursor Agent SDK (`dist/esm/*.d.ts`).
- `~/repos/meetingsdk-headless-linux-sample`, `~/repos/meetingsdk-linux-raw-recording-sample` — Zoom (Phase 2).

## Outstanding verification (NOT a blocker to building)

- **R2 spike (runtime, ~20 min):** does Gemma emit clean tool calls on Cerebras (3 chained calls ×10)? De-risks `decide.ts`. Run before trusting `decide`. Everything else (Cerebras compat, Cursor SDK, Shipyard resources, media packages) is already source-verified.

## Doc status

- **AGENTS.md** (this) + **the plan** — SOURCE OF TRUTH.
- **CURSOR-SDK-BRIEF.md** — CURRENT (the chosen sub-agent engine).
- **CLOUDFLARE-LAUNCH.md** — CURRENT, post-local deployment plan (not needed for the local build).
- **ZOOM-SETUP.md** — CURRENT, Phase-2 Zoom track (Dylan; not in the local build).
- **RISK-AUDIT.md** — HISTORICAL, mostly valid (risk register R1–R6, Zoom de-risk). Note: Pipecat→Moonshine/kokoro; Appendix B → CLOUDFLARE-LAUNCH.md.
- **ARCHITECTURE.md** — PARTIALLY SUPERSEDED. Ports/adapters + presentation-pipeline reasoning still holds; the Shipyard-daemon integration, Pipecat, and model-attribution A/B are obsolete.
