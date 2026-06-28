> **STATUS: CURRENT but POST-LOCAL (deployment plan, 2026-06-28).** Forward-looking production
> deploy; accurately reflects the current design (Cursor SDK, Option-C spine, ports boundary) but is
> NOT needed for the local harness. See [AGENTS.md](./AGENTS.md).

# Cloudflare Launch Plan — Scoped Agent in a Zoom Call

> Synthesis of a 4-agent research pass over the full Cloudflare developer-platform
> surface (compute, media/realtime, AI/data, networking/deploy/cost), run 2026-06-28
> against official docs (developers.cloudflare.com). Companion to
> [ARCHITECTURE.md](./ARCHITECTURE.md) and [RISK-AUDIT.md](./RISK-AUDIT.md) (Appendix B
> of the latter was the first Cloudflare pass; this verifies, corrects, and extends it).
> System being deployed: the current design in the "system diagram" task — local-first
> media, Cerebras/Gemma in-call brain, Cursor-SDK sub-agents, a resource/diff spine, and
> a screen-shared stage, all behind a swappable `Ports` boundary.

---

## TL;DR

- **The control plane is a clean, almost-native Cloudflare fit. The media plane is not — and that single fact forks the whole deployment.**
- **The hard wall: Cloudflare has no UDP egress at any layer.** Workers `connect()` is TCP-only ("no UDP"); Container egress is HTTP/HTTPS/DNS on ports 80/443 only. Zoom's UDP-first media transport therefore **cannot leave Cloudflare**. This is now *proven*, not "likely" — and the 2026-04/06 egress changelogs add TLS interception + 15-min keepalive but **still no UDP**.
- **So you cannot have "native Zoom bot" AND "all-Cloudflare" at once.** The egress wall sits exactly between them. Pick one:
  - **Path A — native bot, off-CF (the flex):** one Linux x86 box (Fly.io/VM/EC2) runs the Meeting-SDK bot + co-located stage capturer + voice loop. **Everything else runs on Cloudflare.** On-thesis ("self-hosted, no central bot"); one box to operate.
  - **Path B — Recall.ai (all-Cloudflare):** Recall does the Zoom UDP in *its* cloud; Cloudflare only ever speaks HTTPS/WSS:443 to it. **Zero VMs, zero containers, fully on CF.** Simplest ops; a third-party bot identity in the call.
- **Recommended:** deploy the **control plane to Cloudflare now** (it's a win under either path), build the orchestrator as a **Durable Object** to match the deploy shape, **default to Recall for an all-CF launch**, and **keep the native off-CF bot as the flex/insurance**. Keep hosted Deepgram/Cartesia for voice in the demo; cite Workers AI Deepgram voice as the "why Cloudflare" consolidation story.
- **Cost on Cloudflare is a rounding error:** ~$5/mo demo, ~$28–42/mo light-prod. The real spend is off-CF (Recall ≈$0.50/hr, or a Fly box, plus Cerebras/STT/TTS) — none of it a CF line item.

---

## The one constraint that shapes everything

| Layer | UDP egress? | Evidence |
|---|---|---|
| Workers `connect()` TCP Socket API | **No** — "no UDP", TCP-only | `/workers/runtime-apis/tcp-sockets/` |
| Container process egress | **No** — "Only ports 80, 443, and DNS are available" | `/containers/platform-details/outbound-traffic/` |
| Spectrum (TCP/UDP proxy) | **No** — ingress-to-*origin* DDoS proxy, not an egress path for CF compute | `/spectrum/` |
| Realtime SFU (WebRTC) | **No** — build-your-own WebRTC SFU; can't bridge Zoom's proprietary media cloud | `/realtime/sfu/` |
| Realtime TURN (standalone) | **No (for Zoom)** — CF TURN *does* speak UDP, but (1) CF compute still can't originate UDP to it, and (2) the **Zoom Meeting SDK exposes no external-TURN/ICE config**, so Zoom never routes through it | `/realtime/turn/` |
| Magic Transit / WAN / WARP | **No** — for customer-owned networks (BYO IP prefixes), not serverless egress | `/magic-transit/` |
| Browser Rendering | **N/A** — can *render* the stage page but emits only screenshots/PDF/HTML (no live media stream), and hard-caps at **10 min/session** → **cannot be the screenshare capturer** | `/browser-rendering/platform/limits/` |

**Conclusion (High confidence):** the native Zoom media bot can never be a Cloudflare Container or Worker. In the clean design, **Cloudflare runs zero containers** — the media bot, the headless-Chromium stage *capturer*, and the latency-sensitive voice loop co-locate on the off-CF box (Path A) or live inside Recall (Path B).

---

## What goes where — full offering map

Legend: 🟢 strong fit / deploy · 🟡 optional or post-demo · 🔴 can't / don't use.

| System component | Cloudflare offering | Verdict | Note |
|---|---|---|---|
| Orchestrator (in-call brain) + per-principal runtime | **Agents SDK = SQLite-backed Durable Object**, one per principal | 🟢 | An `Agent` *is* a DO; gets WS Hibernation, `alarm()`, synchronous SQLite, durable identity. Wall-clock **unlimited**; bills only **active CPU**; **no GB-s while hibernating** → the observe-cheap idle loop costs ≈nothing. |
| Resource/diff spine (append-only log + WS fan-out) | **Same per-principal DO** — SQLite table + Hibernatable WebSockets + `broadcast()` | 🟢 | This is the canonical CF pattern; maps 1:1 to your "everything is a resource, subscribe to diffs" design. 10 GB/DO, rows ≤2 MB → log needs rollover/compaction. "Thousands" of WS/DO (no hard cap published). |
| Stage page + UI hosting | **Worker Static Assets** (one Worker: assets + `/api/*` + `/ws`) | 🟢 | Static requests are free; one deploy, one domain. Use `run_worker_first` for `/api/*` and `/ws`. **Pages not needed.** |
| Deliverables (html/screenshot/json) | **R2** | 🟢 | Zero egress fees. Serve via Worker binding (preferred) or **custom-domain** public bucket (not `r2.dev`, which is rate-limited dev-only); presigned URLs (1s–7d) for private. |
| Cerebras/Gemma call path | **AI Gateway** → Cerebras (named provider) | 🟢 | SSE streaming passes through real-time → the ~1500 tok/s stays visible. Adds retries (≤5), fallback, rate-limit, logging, token/latency analytics. **Keep Guardrails + DLP OFF** (they buffer the full response and kill the speed effect). |
| Per-principal metadata / indexes | **D1** | 🟡 | Only if you need cross-principal relational queries; it can't fan-out, so a DO still fronts it. |
| Session pointers / stage-state cache | **KV** | 🟡 | Fine as a cache. 🔴 **Never** for the append-only log — eventual consistency (≤60s) wrecks ordering/atomicity. |
| Async sub-agent / deliverable jobs | **Queues** | 🟡 | 128 KB/msg (bodies → R2). Overkill for a single call; useful at scale. |
| Deep sub-agent research (today: Cursor SDK) | **Agents SDK child agents** (live) + **Workflows** (durable long-running) + **Containers/Sandboxes** (code-exec) | 🟡 | CF's own "Durable AI Agent" guide pairs Agents (real-time) with Workflows (retryable steps). Note: today's design calls the **Cursor SDK** for `call_agent`; that's an external HTTPS call and works from a DO unchanged. |
| Token/latency overlay + activity metrics | **Analytics Engine** (`writeDataPoint` + SQL) | 🟡 | Good telemetry sink; sampled + not real-time, so it complements (not replaces) the DO log. |
| Sub-agent memory (optional) | **AI Search** (ex-AutoRAG, renamed Apr 2026) or **Vectorize** | 🟡 | AI Search = managed RAG/agent-memory, hybrid vector+BM25, self-contained instances. Lower effort than hand-rolling Vectorize. |
| Zoom **media** bot (UDP, native SDK) | Containers / Workers | 🔴 | **No UDP egress.** Off-CF (Path A) or Recall (Path B). |
| Screenshare **capturer** (Chromium→frames) | Browser Rendering | 🔴 | No live-stream output + 10-min cap. Co-locate with the bot. |
| Live LLM loop as a journaled engine | Workflows | 🔴 | Wrong tool for real-time (it's a step-retry async engine). Use the DO. |
| External Postgres/MySQL acceleration | Hyperdrive | 🔴 | N/A — no external SQL here. |
| LLM hosting | Workers AI (`@cf/google/gemma-4-26b-a4b-it` exists) | 🔴 for the in-call brain | Won't match Cerebras's ~1500 tok/s. Keep Cerebras as the speed hero. |

---

## The one real decision: media plane (A vs B)

| | **Path A — native bot (off-CF)** | **Path B — Recall.ai (all-CF)** |
|---|---|---|
| Where Zoom UDP happens | One Linux x86 box you run (Fly.io/VM/EC2) | Recall's cloud |
| What's on Cloudflare | Everything except the media box | **Everything** |
| VMs / containers to operate | One box (bot + capturer + voice co-located) | **Zero** |
| Control channel | **Bot dials OUT to the `MediaBridge` DO** over `wss://`, bearer-secret on the `Upgrade` | Recall ⇄ your control plane over HTTPS/WS |
| Audio for your own STT/TTS | **Raw PCM both ways**, direct to your server (`audioInBridge` / `audioOutUplink` map 1:1) | **In:** raw PCM to your WS (16 kHz mono S16LE, mixed or per-participant) ✅ feeds your STT. **Out:** no raw-PCM mic — TTS rides the Output Media stage webpage (WebAudio→MediaStream) or chunked mp3 clips |
| Stage screenshare | Chromium on the box captures the CF-hosted stage URL → Zoom share | Recall renders the CF stage URL as screenshare directly |
| Story | On-thesis: "runs as *you*, self-hosted, no central bot" | "All on Cloudflare"; a third-party bot identity in the call |
| Cost | Fly box ~$5–30/mo (or hourly) | ~$0.50/hr of meeting |
| Risk | x86 emulation + headless plumbing (see RISK-AUDIT R3/R4) | Vendor dependency; **agent voice-out has no raw-PCM path** — rides the stage webpage (a browser hop in Recall's cloud) |

**If you keep your own VAD/STT/TTS (the current design), the binding constraint is the agent's *voice-out*, not the meeting audio-in** (verified vs docs.recall.ai, 2026-06-28). Recall streams clean raw PCM *in* to your WS (16 kHz mono S16LE) — your STT is unchanged — but exposes **no raw-PCM mic**: the agent's TTS must ride the Output Media stage webpage (WebAudio→MediaStream) or be chunked into mp3 clips (Recall's own term: "short clips" — poor for streamed TTS / barge-in). The native bot takes raw PCM **both** ways with zero indirection, so **keeping your stack favors Path A.** (This also corrects an earlier note: inbound raw-PCM-to-backend *is* supported — RISK-AUDIT was right; only outbound lacks it.)

**Why the bot dials *out* to the DO (not a Tunnel inbound):** a Durable Object only gets WebSocket **Hibernation** when it is the *server* (inbound). An **outbound** WS from a DO does **not** hibernate and keeps the DO resident (billed) for only **15 min/connection** — the wrong shape for a long call. So: **bot = WS client, DO = hibernatable WS server.** No Cloudflare Tunnel required, and the VM needs no inbound ports. Bonus: **mint the Zoom Meeting SDK JWT inside the DO** and hand it to the bot over that socket → `ZOOM_SDK_SECRET` lives in CF secrets, never on the box.

> The two big architecture decisions are coupled (this confirms RISK-AUDIT Appendix B): **going all-in on Cloudflare pushes you toward Recall, not away from it.** Native + all-CF is impossible.

### Off-CF media-bot hosting — the shortlist (Path A)
The off-CF box needs one scarce thing: **real, arbitrary UDP egress** (+ linux/amd64 + Docker). Verified June 2026:

| Host | UDP egress | Per-meeting ephemeral | Cost | Verdict |
|---|---|---|---|---|
| **Fly.io Machines** | ✅ outbound on native egress (bot is outbound-initiated → no dedicated IP needed) | ✅ microVM/call, per-second billing | ~$0.003/hr+ shared-CPU | 🟢 **top pick** — built for spin-per-call |
| **AWS EC2 / GCE** | ✅ full | ⚠️ VM boot per call (use a warm pool) | $/hr by size | 🟢 max control, more ops |
| **AWS Fargate/ECS** | ✅ via NAT GW (symmetric NAT — fine for client→server Zoom UDP) | ✅ run-task/call | task + NAT GW ~$0.045/hr+GB | 🟢 solid; NAT adds cost/latency |
| **Hetzner / DigitalOcean VM** | ✅ default-allow outbound | ❌ always-on (no per-call API) | cheapest (~€4–20/mo) | 🟢 best $/perf for a warm pool |
| **GCP Cloud Run** | ✅ UDP via Direct VPC egress | ❌ request-coupled | always-on CPU + min-instance | 🟡 **~60-min request cap** kills calls >1h; awkward |
| **Render** | ❓ undocumented / not first-class | — | — | 🔴 no UDP-media story |

**Pick:** **Fly.io Machines** for self-host (microVM-per-meeting ≈ Recall's model, but yours; native x86 also fixes RISK-AUDIT R4's emulation pain). Hetzner/DO if you'd rather run a cheap warm pool. **Not Cloud Run** (60-min cap), **not Render**.

**Rejected — "CF Container + tunnel UDP over WSS to an exit node":** technically possible, strictly worse. The exit node is *itself* the UDP-capable box you were avoiding, and wrapping real-time media in a TCP/WSS tunnel re-introduces head-of-line blocking (one lost segment stalls all frames) plus an extra hop. Run the bot on the UDP host directly; CF orchestrates it over the spine. **Compute was never the constraint — UDP egress is.**

**Managed alternatives to Recall (if you go Path B):** Recall is the only managed service doing the *full* loop on Zoom (audio in + webpage→screenshare/camera out, $0.50/recording-hr, most mature) — with the audio-**out** caveat in the table above (inbound raw PCM is clean; only the agent's voice lacks a raw-PCM path). Narrower options: **MeetingBaaS** (source-available; Zoom + speaking bots + raw-audio WS; ~$0.35–0.68/hr), **Attendee** (open-source; wraps the native Zoom SDK; audio-out + webcam-image but no live screenshare — and still needs a UDP host from the table above). **Daily/Pipecat reach Zoom only *via* MeetingBaaS; Vexa/Symbl don't fit** (no Zoom media-out).

---

## Cloudflare control plane — the part that's unambiguous

Build this now; it's a win under either media path.

- **`OrchestratorAgent` DO (one per principal):** the Gemma-driven observe/act loop, the resource spine (transcript + deliverable store, diff/subscribe), schedules via `alarm()`. Unlimited wall-clock; active-CPU billing; hibernates between @mentions.
- **`MediaBridge` DO:** a hibernatable WS *server* the off-CF bot (A) or Recall (B) dials into. Carries decisions, deliverable events, stage commands — **not raw audio** (keep PCM off the DO path for latency).
- **Worker + Static Assets:** serves `/stage`, the UI, `/api/*`, and the `/ws` upgrade. One deploy.
- **AI Gateway → Cerebras:** `…/{gateway_id}/compat/chat/completions` with `model: "cerebras/<gemma-slug>"` (model string passes through unchanged), or the dedicated `…/cerebras/...` route. Set `stream_options:{include_usage:true}` to recover token counts on streams (cost tracking is otherwise flaky on streamed responses).
- **R2 / D1 / KV / Queues:** deliverables / metadata / cache / async jobs as above.

### Voice path (STT/TTS) — honest verdict
Workers AI now natively hosts **Deepgram Nova-3/Flux (STT)** and **Aura-2 (TTS)** with WebSocket streaming (a real 2026 change). STT is the *same Deepgram engine* you already use — a low-risk swap. TTS would be a **vendor swap** (no Cartesia in the catalog; ElevenLabs only via AI Gateway). **But** your voice loop runs co-located with audio I/O (off-CF box / Recall), not on a Worker — so "all-CF voice" calls CF's WS endpoints from the box and **doesn't beat calling Deepgram directly on latency**; the win is consolidation, not speed. **For the demo: keep hosted Deepgram/Cartesia (working, lowest risk); cite Workers AI Deepgram voice as the post-demo "why Cloudflare" consolidation.** CF's own turn budget: 40ms mic + ~300ms STT + ~400ms LLM + ~150ms TTS → sub-800ms (Cerebras keeps the LLM stage well under budget).

---

## Deployment — `wrangler.jsonc` skeleton

```jsonc
{
  "name": "zoom-agent-control-plane",
  "main": "src/index.ts",
  "compatibility_date": "2026-06-28",
  "compatibility_flags": ["nodejs_compat"],

  "assets": {
    "directory": "./public",
    "binding": "ASSETS",
    "run_worker_first": ["/api/*", "/ws"],
    "not_found_handling": "single-page-application"
  },

  "durable_objects": { "bindings": [
    { "name": "ORCHESTRATOR", "class_name": "OrchestratorAgent" },
    { "name": "MEDIA_BRIDGE",  "class_name": "MediaBridge" }
  ]},
  "migrations": [
    { "tag": "v1", "new_sqlite_classes": ["OrchestratorAgent", "MediaBridge"] }
  ],

  "r2_buckets":    [ { "binding": "ARTIFACTS", "bucket_name": "zoom-agent-artifacts" } ],
  "kv_namespaces": [ { "binding": "SESSIONS",  "id": "<kv-id>" } ],
  "d1_databases":  [ { "binding": "DB", "database_name": "zoom-agent", "database_id": "<d1-id>" } ],
  "queues": {
    "producers": [ { "binding": "JOBS", "queue": "agent-jobs" } ],
    "consumers": [ { "queue": "agent-jobs", "max_batch_size": 10, "max_retries": 3,
                     "dead_letter_queue": "agent-jobs-dlq" } ]
  },

  "vars": { "AI_GATEWAY_ID": "zoom-agent", "STAGE_URL": "https://agent.example.com/stage" },
  "observability": { "enabled": true, "head_sampling_rate": 1 },
  "routes": [ { "pattern": "agent.example.com", "custom_domain": true } ]
  // NO "containers" block — the media bot cannot egress UDP from CF.
}
```

**Bindings:** `ORCHESTRATOR` (DO), `MEDIA_BRIDGE` (DO), `ASSETS` (static), `ARTIFACTS` (R2), `SESSIONS` (KV), `DB` (D1), `JOBS` (Queue). AI Gateway is **not a binding** — it's an HTTPS endpoint you `fetch()`.

**Secrets** (`wrangler secret put`, per-env): `CEREBRAS_API_KEY`, `CF_AIG_TOKEN`, `ZOOM_SDK_SECRET` (DO mints the JWT), `RECALL_API_KEY` (Path B), `DEEPGRAM_API_KEY` / `CARTESIA_API_KEY` (if called from CF), `BOT_SHARED_SECRET` (bearer the off-CF bot presents on the control WS).

**Observability (minimal good setup):** Workers Logs (`observability.enabled`, **sample down** `head_sampling_rate` in prod — it's the most likely overage line), `wrangler tail` for live, Analytics Engine for the token/latency overlay, the free AI Gateway dashboard for per-call Cerebras cost/latency.

---

## Cost envelope (Cloudflare footprint only; per-unit rates from 2026 pricing pages)

| | Demo (a dozen <40-min calls) | Light prod (~50 principals, ~500 mtg-hrs/mo) |
|---|---|---|
| Workers Paid base | $5.00 | $5.00 |
| Worker requests + CPU | $0 (within incl) | ~$3.60 |
| DO requests + duration | $0 (**hibernated**) | ~$1.35 (duration ≈$0 via hibernation) |
| R2 (storage + ops) | $0 | ~$6.00 (~100 GB + ops) |
| KV / D1 / Queues | $0 | ~$0 |
| Workers Logs | $0 | ~$12.00 (**sample down to cut this**) |
| AI Gateway | $0 (free all plans) | $0 |
| Containers / Browser Rendering | $0 (not used) | $0 (not used) |
| **Cloudflare total** | **≈ $5/mo** | **≈ $28/mo** |

**Off-CF (context, not a CF line item):** Recall ≈ $0.50/hr × 500 hr ≈ **$250/mo**, *or* a Fly.io box ~$5–30/mo; plus Cerebras + STT + TTS usage. **The dominant true cost is media + inference, off Cloudflare. Hibernation is the lever that keeps DO duration near-free.**

---

## Corrections to our priors

| Prior (from earlier briefs) | Correction |
|---|---|
| "CF lists real-time as unsupported for Workflows" (ARCHITECTURE.md basis for Agents-over-Workflows) | **No such statement exists in CF docs.** The conclusion (use Agents/DOs, not Workflows, for the live loop) is still right — but on *architectural* grounds (DOs are the real-time WS primitive; Workflows are a journaled step-retry engine). Stop citing the phantom disclaimer. |
| "No UDP egress... *likely* can't egress" (RISK-AUDIT App. B) | **Strengthened to proven.** UDP is categorically absent at every layer; `connect()` is explicitly TCP-only. |
| Sub-agent engine = Shipyard (ARCHITECTURE.md) | Superseded by the current "system diagram" task: `call_agent` uses the **Cursor SDK**. Either way it's an external HTTPS call, fine from a DO. |
| AI Gateway "arbitrary OpenAI-compatible provider" | Partly — it routes by **known provider slug**; the generic "point at any base URL" Universal Endpoint is **deprecated**. Cerebras is a *named* provider, so this is a non-issue here. |

---

## Confidence map

| Claim | Confidence | Basis |
|---|---|---|
| No UDP egress on CF at any layer → native Zoom bot can't run on CF | **Proven** | `connect()` TCP-only + container outbound 80/443/DNS docs |
| Recall transport → all-Cloudflare works | **Proven** | 443 always available; outbound WSS documented |
| Browser Rendering can't be the capturer (no live stream, 10-min cap) | **Proven** | Outputs list + limits page |
| Orchestrator + spine = SQLite DO + Hibernation, 1/principal | **High** | Agents/DO docs; hibernation billing semantics |
| Bot must dial OUT to the DO (hibernation only inbound) | **High** | DO WebSockets best-practices (direct quotes) |
| AI Gateway preserves SSE streaming; Guardrails/DLP break it | **High** | Guardrails usage-considerations + streaming docs |
| Workers AI Deepgram STT/TTS viable (streaming) | **High** | nova-3 / aura-2 model pages |
| CF cost ≈ $5 (demo) / $28–42 (light prod) | **Med** | Per-unit rates High; usage numbers are labeled assumptions |
| AI Gateway added latency negligible | **Med** | One edge hop; CF publishes no number |
| Cerebras serves your exact Gemma-4 slug | **Low (out of scope)** | Cerebras-side; AG passes the slug through regardless |

---

## Production readiness — what's still missing

The CF + Recall design is a clean *architecture*, but it's a demo build, not a production system. Honest gaps, by severity:

**Hard blockers (would actually stop a real launch):**
- **Cerebras Gemma is private-preview** (RISK-AUDIT R1) — no GA SLA. Production needs committed access or a GA model. The single biggest one.
- **Recording / consent compliance** — a bot that joins + captures meetings triggers two-party-consent law (CA et al.) + GDPR. Needs bot self-disclosure + a consent flow. Legal blocker for a product.
- **Zoom outside-account authorization** — joining *others'* meetings requires OBO / ZAK / **RTMS** (Mar 2026). Own-account demo is exempt; a product is not.

**Engineering hardening (standard, currently absent):**
- **Auth + multi-tenancy** — real authn/authz on the operator console + the join API. The DO-per-principal gives *isolation*, not *access control*.
- **Error handling + reconnection + graceful degradation** — Recall WS drops, Cerebras 5xx, STT stalls, Cursor timeout. The orchestrator must reconnect and degrade (shallow answer when research fails). Real-time systems fail constantly.
- **Cost controls** — per-principal budget caps + a runaway-loop kill switch (Cerebras + Recall $0.50/hr + Cursor all bill per use). The in-flight lock prevents double-fire; it doesn't cap spend.
- **Durable background jobs → Workflows** — wrap the `call_agent` research as a Cloudflare **Workflow** so it's checkpointed + retryable (survives a crash mid-research). This is exactly CF's "Agent (real-time) + Workflow (durable steps)" pattern. Not for the live loop.
- **State durability** — compact/rollover the append-only log before the DO's 10 GB cap; the DO is single-region (DR plan if a colo fails); backups.
- **Secrets** — Secrets Store + rotation, not plaintext env forever.
- **Observability + alerting** — Workers Logs + Analytics Engine (+ your Datadog) with SLOs/alerts on join-success, turn-latency, cost-per-meeting.
- **Testing + staging + deploy** — the test suite (plan tasks 9–10), a staging env, CI, and DO-migration discipline.

**Scale checks to confirm:** Recall concurrency limits, Cerebras rate limits (preview!), DO 1,000 req/s/object (fine when sharded per principal), Container concurrency.

---

## What I need from you

1. **Media path — Recall (all-CF) or native (off-CF box)?** This is *the* decision. It sets whether `MediaBridge` accepts a Recall WS or your bot's WS, and whether any VM exists at all. (My call: ship the CF control plane now; default to Recall for the all-CF launch; keep native off-CF as the flex.)
2. **Orchestrator runtime now — plain local process, or commit to a Durable Object (`workerd` locally → CF later)?** Committing to the DO shape now means the local build *is* the deploy artifact (RISK-AUDIT R6's "migrates to CF DO later", made real).
3. **AI Gateway in the hot path for the demo?** Worth it for logging/analytics/retries/fallback — but you must accept **Guardrails + DLP off** the Cerebras streaming path. Confirm that's fine.
4. **Voice for the demo:** keep hosted Deepgram/Cartesia (recommended), or switch STT to Workers AI Deepgram now for the "all-CF" narrative (accepting the TTS voice swap)?

---

## Sources (all developers.cloudflare.com unless noted)
- Egress / UDP: `/containers/platform-details/outbound-traffic/` · `/workers/runtime-apis/tcp-sockets/`
- DO + Agents: `/durable-objects/best-practices/websockets/` · `/durable-objects/platform/limits/` · `/agents/`
- Containers: `/containers/` · `/containers/pricing/` · GA `/changelog/post/2026-04-13-containers-sandbox-ga/`
- AI Gateway: `/ai-gateway/usage/providers/cerebras/` · `/ai-gateway/usage/chat-completion/` · `/ai-gateway/features/guardrails/usage-considerations/`
- Workers AI voice: `/changelog/post/2025-08-27-partner-models/` · blog `cloudflare-realtime-voice-ai` (2025-08-29)
- Static Assets: `/workers/static-assets/` · R2: `/r2/` · `/r2/buckets/public-buckets/`
- Browser Rendering limits: `/browser-rendering/platform/limits/` · Realtime TURN: `/realtime/turn/`
- Tunnel / Access: `/cloudflare-one/connections/connect-networks/` · `/cloudflare-one/identity/service-tokens/`
- AI Search: `/ai-search/` (renamed from AutoRAG, 2026-04-16)
