> **STATUS: HISTORICAL risk analysis (2026-06-23), mostly valid.** Risk register (R1–R6) + the Zoom
> de-risk still current. Corrections: voice = local **Moonshine/kokoro** (not Pipecat/Cartesia);
> Appendix B (Cloudflare) is superseded by [CLOUDFLARE-LAUNCH.md](./CLOUDFLARE-LAUNCH.md). Source of
> truth: [AGENTS.md](./AGENTS.md) + the plan.

# Risk Audit — Cerebras × Gemma 4 Hackathon

> De-risking pass for the "scoped agent live in a Zoom call" build. Based on three
> research spikes (Zoom Meeting SDK, Cerebras/Gemma availability, voice stack) run
> 2026-06-22 against official docs + Zoom's own sample source. Event window: **June 28
> 10:00 PT → June 29 10:00 PT** (6 days out).

---

## TL;DR — the headline inverts the instinct

**The thing you fear most (Zoom) is the most de-risked thing in the plan. The one thing
you marked `[DECIDED]` (Gemma-4-on-Cerebras access + tool-loop) is the only risk that can
kill the premise — and it's the cheapest to test.**

- **Zoom join + audio I/O are *solved*** — proven in Zoom's own headless sample source. Only
  one Zoom capability is genuinely at risk (headless *screenshare-send* of custom content),
  and it has a **4-layer fallback cascade**, so it cannot break the recording.
- **Cerebras-Gemma is real and good** (Gemma 4 shipped Apr 2; Cerebras serves the 31B Dense
  variant at ~1,500 tok/s; Gemma 4 hits 86.4% on tool-calling vs 6.6% for Gemma 3). **But it's
  *private preview* — your access *is* the hackathon grant.** No grant → no premise. One fallback
  (`gpt-oss-120b`) exists but is *off-premise* (it isn't Gemma).
- **The voice loop is buildable in 24h** on Pipecat, with barge-in off-the-shelf. The brief's
  "TTS is the long pole" is **wrong** — reallocate that worry.

**Two cheap hour-0 curls de-risk the only fatal items. Everything else has a fallback.**

### The single most important *pre-event* action
Secure **Gemma-4-on-Cerebras API access this week.** It's the only fatal dependency with no
on-premise fallback, and historically (Llama 4 hackathon) access was Discord-approval-gated with
latency. Don't wait for hour 0 — get a key now and confirm `GET /v1/models` shows a `gemma-4*` ID.

---

## Risk register (ranked by true severity = fatality × absence-of-fallback)

| ID | Risk | Severity | Premise fallback? | De-risked by |
|----|------|----------|-------------------|--------------|
| **R1** | **Cerebras Gemma-4 access.** Private preview, not on public tier. Access = the hackathon grant (likely Discord approval w/ latency). | 🔴 **Fatal** | **None** | Hour-0 (ideally this week): `GET /v1/models` shows `gemma-4*`. If not → escalate in Discord immediately. |
| **R2** | **Gemma tool-loop on Cerebras's stack.** Gemma natively does tools, Cerebras API does tools — but the *intersection* is undocumented (their tool-use docs only cover gpt-oss / GLM). | 🔴 **Fatal-to-premise** | Off-premise only (`gpt-oss-120b`, 3000 tok/s, documented tools) | 3 chained tool calls ×10 runs, want ≥4/5 success; capture tok/s. ~20 min once you have a key. |
| **R3** | **Native headless screenshare-SEND of custom content (Linux).** API exists (`setExternalShareSource` → `sendShareFrame`) but documented to return success while rendering *nothing*; StartShare methods are `#ifdef WIN32`-gated. | 🟠 **Covered** (the crux capability, but fully fallback-protected — *not* demo-fatal) | 3 fallback layers (see cascade below) | Timeboxed 2–3h spike: do frames render to a real participant? Green → native. Blank → fall back, don't debug. |
| **R4** | **"Local" = x86_64 Linux SDK in Docker on an Apple-Silicon Mac.** Runs under amd64 emulation (Rosetta/QEMU) — slower/flakier for GL/media. Plus Xvfb + PulseAudio + `zoomus.conf` + manual SDK download. | 🟠 **Friction** | n/a | Spike A: container joins your meeting + receives audio + sends 1 audio clip + 1 virtual-cam frame. A well-trodden afternoon. |
| **R5** | **Voice round-trip + barge-in.** | 🟢 **Solved** | n/a (Pipecat handles barge-in, ~140ms P95) | Pipecat loop (STT→Cerebras→TTS). Long pole is **STT (~300ms) + end-of-turn**, *not* TTS. |
| **R6** | **Per-principal runtime ("DO") locally + resource/diff spine.** | 🟢 **Low** | n/a | Long-lived local process per principal + append-only log + websocket fan-out. Known quantity; migrates to Cloudflare DO later. |

**Read the colors:** two reds (the real threats) are both *cheap hour-0 checks*. The thing you
feared (R3) is amber and *covered*. The greens are handled engineering.

---

## The screenshare fallback cascade (why R3 can't break the demo)

Your own brief (§7) already decoupled the agent's canvas from the Zoom transport. That gives four
layers, **each producing an identical recording**:

1. **Native `sendShareFrame` on Linux** — true Zoom screenshare, *if frames render*. ⚠️ at risk.
2. **Native virtual-camera send** — rock-solid (what every production bot, incl. Recall, actually
   uses). Reads as "the bot turned its camera on," a participant tile, *not* a screenshare banner/
   center-stage layout. ✅ reliable.
3. **Recall.ai Output Media** — renders a webpage you control as **screenshare** (true center-stage
   layout) or camera, into Zoom. Sidesteps the exact Linux bug. ✅ reliable, cloud, ~$0.50/hr.
4. **Human shares the canvas, agent drives it remotely** — on camera, identical. ✅ always works.

For a detailed commit-timeline visual you want the **center-stage screenshare *layout*** (a camera
tile is too small to read). That layout is reliably available via #3 or #4 even if #1 fails — so
native screenshare-send is a *flex to attempt*, never a blocker.

---

## The fork this audit forces: native-local vs Recall.ai

You said **"local first."** That collides with the research. The real decision:

### Option A — Native local (recommended as the *real* path)
Linux Meeting SDK headless in Docker on your Mac.
- **For:** On-thesis — "the agent runs as *you*, on *your* machine, no central bot." It's the
  technical-taste flex. Join + audio + virtual-cam are a proven afternoon.
- **Against:** x86 emulation on your M-series + headless plumbing (Xvfb/Pulse/`zoomus.conf`);
  screenshare-send may not render (R3).

### Option B — Recall.ai (recommended as *silent insurance*, not the lead)
One API: bot joins Zoom, raw PCM in, webpage-as-screenshare + audio out.
- **For:** Collapses *all* Zoom risk into API calls. ~$0.50/hr, free signup credits. The
  always-works path for the video.
- **Against:** **Cloud, not local** (breaks the local-first optics). A *central third-party bot
  identity* in the call — which rubs against the "no central bot" story. **Nuance:** your moat is
  the *per-principal scope mechanism*, which is transport-independent — Recall doesn't break the
  identity *argument*, only the "we self-hosted it all" *optics*.

### Recommendation: both/and, sequenced by the decoupling principle
1. **Build the agent + canvas + voice loop as the product.** The Zoom bot is *transport* — the
   recording must never depend on it landing.
2. **Pre-wire Recall.ai as insurance** (an afternoon, a few dollars). You always have a working
   "agent speaking + sharing in a real Zoom call" path for the video.
3. **Attempt the native Linux bot as the flex.** Spike A (safe: join+audio+virtual-cam) →
   Spike B (timeboxed: native screenshare-send). If B renders, you *lead* with native and it's
   on-thesis. If not, fall back — on tape it's identical.

---

## Corrections to the brief

| Brief says | Reality | Fix |
|---|---|---|
| "~2,100 tok/s" overlay | Gemma 4 31B on Cerebras is **~1,500 tok/s** | Show a **live-measured** counter (from `usage` + wall-clock) or label "~1,500". Don't get contradicted on stage. |
| "Audio I/O is the long pole; target sub-~150ms TTS" | TTS is the **easiest** leg (Cartesia/ElevenLabs Flash/Aura-2 all clear sub-300ms TTFA). Long pole is **STT (~300ms) + end-of-turn detection** | Drop the sub-150ms-TTS hunt. Spend that time on turn-detection (Smart Turn v2) + the audio plumbing. |
| "headless Meeting SDK (Linux)" | Correct — but it's **x86_64-only** (emulated on your Mac), and **screenshare-send specifically** is the unreliable bit; join/audio are fine | Plan container emulation; treat screenshare-send as timeboxed. |
| Gemma tool-use flagged as a worry | Gemma 4 is now **genuinely strong** at tools (86.4%); use the 31B Dense variant (what Cerebras serves) | Keep the worry only as the *R2 intersection* spike, not a model-capability doubt. |

---

## De-risking spike plan (cheap + fatal first; all throwaway, pre-event-legal)

| # | Spike | When | Time | Pass criteria |
|---|-------|------|------|---------------|
| 1 | **Cerebras provisioning** — `curl .../v1/models` shows `gemma-4*` | **This week** | 5 min | A `gemma-4*` model ID is visible on your key. |
| 2 | **Gemma tool-loop** — 3 chained tools (`find_city`→`get_weather`→`format`), OpenAI client, strict mode, run 10× | After key | 20 min | ≥8/10 complete the chain in order; capture tok/s. |
| 3 | **Zoom Spike A (native, safe)** — container joins *your* meeting, receives audio, sends 1 clip + 1 virtual-cam frame | Parallel | half-day | All four pass → transport feasible natively. |
| 4 | **Zoom Spike B (the crux)** — `sendShareFrame` to a real participant | Parallel, hard timebox | 2–3h | Frames render → native screenshare. Blank → STOP, fall back. |
| 5 | **Recall.ai insurance** — bot joins, webpage-as-screenshare in, mixed audio out | Parallel | afternoon | Always-works video path proven. |
| 6 | **Voice loop** — Pipecat: Deepgram/AssemblyAI → Cerebras → Cartesia, on Recall audio, barge-in on | After 5 | half-day | Round-trip <1s; interrupt <200ms. |

---

## Recommended stack (fastest path)

| Layer | Choice | Note |
|---|---|---|
| Zoom I/O | **Native Linux SDK in Docker** (flex) + **Recall.ai** (insurance) | Recall = webpage-as-screenshare, raw PCM in. |
| Orchestration | **Pipecat** | Barge-in built in; accepts custom Cerebras LLM. Saves the hardest glue. |
| STT | **Deepgram Nova-3** (~150ms interim) or **AssemblyAI Universal-Streaming** (immutable) | Native raw-PCM WebSocket. |
| LLM | **Gemma 4 31B on Cerebras** | ~1,500 tok/s; OpenAI-compatible; strict-mode tools. |
| TTS | **Cartesia Sonic** (≈90–188ms TTFA); fallback ElevenLabs Flash / Deepgram Aura-2 | Streams first audio before full gen. |
| Turn-taking | **Smart Turn v2** (Pipecat) | Cuts the hidden end-of-turn long pole. |

---

## Local environment (confirmed 2026-06-22)
- **arch:** arm64 (Apple Silicon) → Linux SDK runs under `--platform linux/amd64` emulation.
- **macOS:** 26.5.1 · **Docker:** 29.2.1 (installed). Colima not present.
- **Cloned reference repos** (SDK binaries NOT included — download from Zoom Marketplace into `lib/zoomsdk`):
  - `~/repos/meetingsdk-headless-linux-sample/` — join + audio recv + video-send stub + Dockerfile.
  - `~/repos/meetingsdk-linux-raw-recording-sample/` — virtual-mic send + video source + per-distro Dockerfiles.

---

## Confidence map

| Claim | Confidence | Basis / caveat |
|---|---|---|
| Zoom autonomous join (guest, no login) on your own meeting, no app review | **High** | Zoom sample source (`Zoom.cpp`); cross-account policy docs. |
| Audio send + receive (incl. per-participant PCM) headless | **High** | Confirmed in Zoom sample source. |
| Native headless **screenshare-send renders reliably** | **Low** | API exists; multiple reports of success-code-but-blank; WIN32-gated. **Must spike.** |
| Gemma 4 real, on Cerebras (31B, ~1,500 tok/s), strong tools | **High** | Google blog + Cerebras blog (explicit quotes). |
| Gemma-4 **access provisioned for you** | **Med** | "Early access via hackathon" stated; exact mechanics/latency unconfirmed. **Test this week.** |
| **Cerebras stack exposes Gemma tool-calls cleanly** | **Low** | Gemma absent from Cerebras tool-use docs. **The R2 spike.** |
| Voice loop + barge-in in 24h on Pipecat | **Med-High** | Contingent on the audio-I/O spike landing early. |
| Recall.ai does join + PCM-in + webpage-screenshare-out on Zoom | **Med-High** | Output Media docs; exact out-audio format/latency verify day 1. |

---

## What I need from you

1. **Screenshare requirement:** is the hero frame's "agent sharing its screen" satisfied by a
   **center-stage screenshare *layout*** (reliably available via Recall/human-drive) — or do you
   specifically want it done via the **native Linux SDK** (→ Spike B is mandatory)? *Default
   assumption: want the layout, native is a flex.*
2. **Local-first stance:** is "local / self-hosted, no central bot" **load-bearing for the story**
   (→ native is the path, Recall is silent backup) or **pragmatic** (→ Recall can be the spine)?
3. **Go-ahead to start the throwaway spikes** (your rules allow pre-event learning spikes) — or
   write per-component specs first? I'd start with spikes 1–2 (Cerebras) since they're fatal+cheap.

---

## Key sources
- Cerebras × Gemma 4: <https://www.cerebras.ai/blog/gemma-4-on-cerebras-the-fastest-inference-is-now-multimodal>
- Cerebras tool-use / OpenAI-compat: <https://inference-docs.cerebras.ai/capabilities/tool-use>, <https://inference-docs.cerebras.ai/resources/openai>
- Zoom headless sample: <https://github.com/zoom/meetingsdk-headless-linux-sample>
- Zoom screenshare-send issue: <https://devforum.zoom.us/t/meeting-sdk-linux-rawdata-api-method-sendshareframe-does-not-work-no-shared-screen-frames-shown/136748>
- Recall.ai output media: <https://docs.recall.ai/docs/output-video-in-meetings>, pricing <https://www.recall.ai/pricing>
- Pipecat barge-in: <https://docs.pipecat.ai/guides/learn/pipeline>; Smart Turn v2: <https://huggingface.co/pipecat-ai/smart-turn-v2>

---

## Appendix B — Production runtime on Cloudflare (verified 2026-06-23)

**Q: can the whole system run on Cloudflare?** Yes for the control plane; for the media
plane **only via Recall, not natively.**

- **Cloudflare Containers exist** (GA 2026-04-13): run arbitrary `linux/amd64` images with
  native libs, each spawned/supervised by a DO (`@cloudflare/containers`, `getContainer`).
  Tiers up to 4 vCPU / 12 GiB / 20 GB; cold start ~1–3s; scale-to-zero via `sleepAfter`.
- **The blocker is egress, not compute.** No UDP egress *anywhere* on CF (Zoom's primary
  media path) — hard no. Zoom's TCP/443 fallback is **unconfirmed**: CF documents container
  egress as HTTP/HTTPS/DNS only (`enableInternet` = "outbound HTTP requests"); a raw media
  TLS stream isn't HTTP. So a **native** Zoom media bot likely can't egress from CF.
- **Right control-plane primitive: Agents SDK** (`agents`, DOs + WebSocket Hibernation),
  **not Workflows** (CF lists real-time as unsupported for Workflows).
- **All-Cloudflare is achievable only via Recall transport:** CF Agent ↔ Recall over HTTPS +
  WebSocket, no container, no media-egress problem. Native transport → media bot on a
  VM/Fly.io, DO orchestrates remotely.

| Want | Path |
|---|---|
| Everything on Cloudflare | **Recall** transport → all-CF, no container |
| Native self-built integration | Media on **VM/Fly.io** (UDP); CF = control plane only |

> The two big architecture decisions are linked: **going all-in on Cloudflare pushes you toward
> Recall, not away.** You can't have native + all-CF — the egress wall sits between them.

Sources: Containers GA <https://developers.cloudflare.com/changelog/post/2026-04-13-containers-sandbox-ga/>
· container API <https://developers.cloudflare.com/durable-objects/api/container/>
· egress <https://developers.cloudflare.com/containers/platform-details/outbound-traffic/>
· Agents vs Workflows <https://developers.cloudflare.com/agents/concepts/workflows/>
