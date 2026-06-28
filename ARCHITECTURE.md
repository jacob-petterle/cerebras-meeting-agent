> **⚠️ STATUS: PARTIALLY SUPERSEDED (historical, 2026-06-23).** Sub-agents = **Cursor SDK** (not the
> Shipyard daemon); voice = local **Moonshine/kokoro** (not Pipecat); resources = **Option C seqNo
> append-log mirroring Shipyard's shapes** (NOT a live daemon integration). The ports/adapters and
> presentation-pipeline reasoning here still holds; Thread 2 (Shipyard-daemon WS client) and the
> model-attribution A/B are obsolete. **Source of truth: [AGENTS.md](./AGENTS.md) + the plan.**

# Architecture Brief — All-Local + Shipyard Integration

> Output of a deep-research pass (4 agents over `~/repos/shipyard` + this session's prior
> research). Covers two threads: (1) running the whole "scoped agent in a Zoom call" system
> locally on the Mac, and (2) interfacing it with Shipyard for the heavy agentic work.
> Companion to [RISK-AUDIT.md](./RISK-AUDIT.md) (Zoom/Cerebras/voice risks — not repeated here).

---

## TL;DR

- **Everything runs locally on your Mac** as separate processes. Only model inference
  (Cerebras) and STT/TTS are hosted APIs — inherent, not a compromise.
- **Shipyard is your sub-agent engine.** The in-call orchestrator dispatches **Shipyard
  sub-agents** (which already have the model + Datadog/repo MCPs + skills) to do the real
  research, and their **deliverables stream back live** and become the visuals shown in the call.
  You don't rebuild agentic tool-use.
- **The integration is a headless local-direct WebSocket client** — the same surface Shipyard's
  own web app uses. ~1 day of glue; no packaged client, but the frame protocol is small and
  liftable from `apps/web/src/transport/local-direct/`.
- **One real decision: what powers the sub-agents.** Out of the box they run on Claude/GPT, not
  Gemma. Either keep Gemma as the in-call brain only (recommended — a fast/slow split that plays
  to model strengths and keeps Gemma the speed hero), or also point Shipyard's Codex integration
  at Cerebras (~1-day config hack) so the deep work runs on Gemma too.
- **Your "everything is a resource / subscribe to diffs" spine isn't *inspired by* Shipyard — it
  *is* Shipyard's control + resource protocol.**

---

## Thread 1 — All-local topology

The DO→Container split from the Cloudflare analysis becomes **orchestrator-process →
local-Docker-container**. Same shape, no cloud.

| Component | What it is | Runs as | Notes |
|---|---|---|---|
| **Orchestrator** | The in-call brain: observe-cheap/act-on-tag loop, decides when to act, generates voice reasoning. Driven by **Gemma-on-Cerebras**. | Plain local Node/TS process, **or** a local Durable Object via `workerd`/`wrangler dev` | Local DO gives the CF-portable programming model with no deploy. Caveat: the DO isolate still can't run native SDK or UDP — it only orchestrates; the Zoom container stays separate. Start with a plain process; DO is a nice-to-have. |
| **Zoom bot** | Native Meeting SDK joining a meeting of your choice; raw audio in / audio+video out. | **Docker container** (`linux/amd64`, emulated on arm64) | The one piece that *must* be a container (UDP + native libs). See RISK-AUDIT R3/R4. |
| **Voice loop** | Streaming STT + low-latency TTS + turn detection + barge-in. | Local process (Pipecat) | Wired to the Zoom container's raw audio. Long pole is STT + turn-detect, not TTS (RISK-AUDIT). |
| **Shipyard daemon** | The sub-agent engine (already on your Mac). | Already running (`shipyard start`) | Provides model + MCP tools + skills via local-direct WS. |
| Cerebras (Gemma) | Inference | Hosted API (HTTPS) | Called from the orchestrator. Inherent. |
| STT / TTS | Speech | Hosted APIs (or local models) | APIs are easier; local models possible if fully-offline matters. |

**"All local" = all orchestration/processes on your Mac; only inference + speech are hosted
APIs.** Shipyard itself is the proof this works — its daemon already runs an agent runtime +
CRDT resource sync + UI entirely locally.

---

## Thread 2 — Interfacing with Shipyard

### Verdict
The orchestrator interfaces with the running Shipyard daemon **as a headless local-direct
WebSocket client** — the same channel surface the web app uses. **Not** by becoming a Shipyard
agent (`AgentSubprocess`) — that makes you a *driven* agent, the opposite of a driver.

### The recipe (connect → spawn → receive)

**1. Connect** (frame codec: `packages/loro-schema/src/transport/local-direct/local-direct-frame-protocol.ts`)
- Read `~/.shipyard/data/local-direct.json` → `{ port, token, protocolVersion }` (`local-direct-token.ts:22`).
- Open `ws://127.0.0.1:{port}` with subprotocol `shipyard-direct.{token}` (server validates loopback + token, `local-direct-server.ts:89`).
- Send `HELLO { protocolVersion, token, browserMachineId }` within 3s; await `HELLO_ACK { accepted:true }`. **`protocolVersion` must match the daemon exactly — read it from the advert file, never hardcode** (seen as 119–120; it bumps often). Reply to `PING` with `PONG`.

**2. Open channels**
- `daemon-control:{yourSourceId}` (`DAEMON_CONTROL_LABEL`, `channel-protocol.ts:3014`)
- `task-messages:{taskId}` (`buildTaskMessagesLabel`, `channel-protocol.ts:3027`)

**3. Spawn a sub-agent** (on @-tag in the call)
- Control: `{ type:'create_task', taskId, channelId, title, cwd, mode:'task' }` (`channel-protocol.ts:1337`). `cwd` is **required** — point it at the `harbor-checkout` repo. Spawn-only; the prompt goes via task-messages.
- Task-messages: `{ type:'subscribe', sinceSeqNo:0 }` then `{ type:'send_message', correlationId, content:[{type:'text', text:'Research what changed before the incident; query Datadog; save findings via register_deliverable.'}] }` (`channel-protocol.ts:275`).

**4. Receive results**
- **Live reasoning:** `stream_delta` on task-messages (`channel-protocol.ts:316`) — token-level + tool calls.
- **Final output:** last `message` with `senderKind:'agent'` (`channel-protocol.ts:329`).
- **Deliverables (the visuals):** `deliverable_registered` broadcasts on the **control** channel the instant the sub-agent calls `register_deliverable` (`broadcast-wiring.ts:97`). `DeliverableRecord` carries `kind` (html/screenshot/json/…) + `filePath`. **Same Mac → read the file off disk** (`deliverable-server.ts:193` interns it to a stable path). Instruct the sub-agent to use `filePath` (not `assetId`) to avoid the asset-transfer channel.
- **Completion:** no `turn_complete` on task-messages; use control `task_state_update` / `PersistedTurnStats` (`channel-protocol.ts:2348`, `:2572`).

**5. Present in the call:** the Gemma orchestrator summarizes/speaks the result (voice loop) and
shows the deliverable HTML/screenshot on the canvas the Zoom container shares.

### Client lib vs raw protocol
No packaged third-party client. Lift `LocalDirectTransport` + `VirtualPeerConnection` +
`VirtualDataChannel` from `apps/web/src/transport/local-direct/` (not React-coupled; swap browser
`WebSocket` for `ws` via the existing `webSocketCtor` option), then hand-write ~100 lines of
channel-driver logic. The frame protocol is the stable public contract in `@shipyard/loro-schema`.

### What you reuse vs build
- **Reuse (Shipyard):** the entire agentic tool-use loop, model access, MCP integrations
  (Datadog, repo), skills (incl. deep-research), deliverable + visualization machinery.
- **Build (in-window):** the Gemma orchestrator, the Zoom container, the voice loop, and the
  local-direct client glue. All genuinely new — satisfies "judged work built in-window."

### Visualizations note
`visualize`/`present` write the **canvas Loro CRDT** (not a control message), so consuming
canvas-placed elements requires attaching a `loro-extended` Repo to the `loro-sync` channel
(heavier). **Pragmatic path: have the sub-agent emit visuals as deliverables** (`kind:'html'` +
`filePath`) — zero Loro machinery. Only wire `loro-sync` if you specifically need canvas elements.

---

## Presentation pipeline — the screen-share (the value prop)

**The "shared screen" is a headless-browser *stage page* that the orchestrator owns; the Zoom
bot captures and broadcasts it.** The bot shares a *rendered web page*, not files. Deliverables
are rendered onto the stage; **Gemma directs what's shown.**

Flow: sub-agent emits a deliverable (`filePath`) → orchestrator gets `deliverable_registered`,
reads the file → **Gemma decides: promote to screen, or drop as a link in chat** → on promote,
push a render command to the stage page → Zoom bot is already capturing the page → it appears live.

- **Gemma is the director, not just a renderer.** Curating *which* deliverables hit the screen vs.
  links is the intelligence — it's the `respond(thread, modality)` primitive (`present` vs `text`).
- **Rendering by type** (standard browser): HTML → inject/iframe; **mermaid → `mermaid.js` renders
  source→SVG**; image → `<img>`; json/log → table/pre.
- **The re-pivot = Gemma pushing updated mermaid source** → the stage redraws live. The speed hero
  is a one-line render command.
- **Capture (native):** Chromium on Xvfb in the bot container → framebuffer → YUV420 → Zoom SDK
  share sender. This is the R3 risk; fallback cascade (virtual-cam / Recall webpage-URL / human
  shares the stage) yields an identical recording.
- **Links → Zoom chat** (the SDK's chat send), tagged "acting as Jacob."

**Why this is strong:** the stage is *your* polished web app — styling, token/latency overlay,
identity badge, transitions, re-pivot — all **risk-free standard web rendering** you fully control.
Shipyard sub-agents just feed it content; the Zoom transport is swappable underneath without
touching the stage. The cool part (the live-building screen) is the *least* risky; only the
last-inch capture-into-Zoom carries the R3 caveat, and it's decoupled.

---

## The one real decision — what powers the sub-agents

Shipyard sub-agents run on **Claude / GPT-Codex / Cursor**, not Gemma (model picker = 3 hardcoded
catalogs; spawn router refuses unknown model ids; `AgentId` ∈ {claude-code, codex, cursor}).

| Option | What | Effort | Gemma's role | Trade |
|---|---|---|---|---|
| **(A) Gemma = in-call brain only** *(recommended)* | Zero Shipyard changes. Gemma drives the fast reflexive layer; Claude sub-agents do deep work. | 0 | The **speed hero** — observe/act/voice/**re-pivot** at 1,500 tok/s | A *fast/slow* split that plays each model to its strength (Claude is genuinely better at multi-step tool-use — this also sidesteps the R2 Gemma-tool-loop risk). Gemma still owns the Speed-prize moment. |
| **(B) Gemma powers sub-agents too** | Point Shipyard's **Codex** integration at `api.cerebras.ai/v1` via its per-thread `config` passthrough + add a `gemma-4` catalog entry. | ~0.5–1.5 days | The literal engine behind the research too | Config-only diff on a tested seam (`codex-subprocess-spawn-helpers.ts`), but it edits Shipyard — **disclose it**. The purist "even the deep research runs on Gemma" flex. |

**Recommendation: (A) as the core, (B) as a stretch if ahead.** Why (A) isn't a compromise:
Gemma = fast reflexive cognition (the demo's star), Shipyard/Claude = slow deliberate cognition.
Each model to its strength; Gemma stays central; build stays small.

*(Claude's path can't reach Cerebras — `ANTHROPIC_BASE_URL` is Anthropic-protocol, not
OpenAI-compatible. Cursor is closed. Only the Codex seam works for option B.)*

---

## Sequencing (the honest caveat)

The Shipyard integration is a ~1-day spike **and adds a runtime dependency** (the daemon must be
up + logged in + an agent installed). **Do not let it block the minimum demo.**

1. Build **Gemma-in-the-call + Zoom + voice + one visual** end-to-end first (the brief's
   must-build core). This is the working video.
2. Layer the **Shipyard sub-agent escalation** after — it's the "coming to Shipyard" tie-in (§10
   of the brief), not the critical path.
3. The orchestrator should **degrade gracefully** if the daemon is down (Gemma gives a shallow
   answer without sub-agents).

---

## Risks & open questions

| Item | Status | Resolve by |
|---|---|---|
| Protocol-version lockstep / daemon self-update rotates port+token | Known | Read advert file each connect; reconnect on change (`local-direct-manager.ts:194`). |
| Exact turn-completion signal on task-messages | Unverified | Spike: watch control `task_state_update` status flip / `PersistedTurnStats`. |
| Does raw control `create_task` carry a prompt, or strictly task-messages? | Likely spawn-only | Confirm in `control-channel-wiring.ts` `create_task` case. |
| Loopback listener without a logged-in user | Inferred required | Confirm; assume Shipyard logged in + agent installed. |
| Canvas/`visualize` consumption via `loro-sync` | Not implement-traced | Only if canvas elements (not deliverables) are required; spike a Loro client on the channel. |
| Option B: empirical Cerebras-via-Codex spawn; Gemma slug + `wire_api`; codex-subprocess strip check | Unverified | One live Codex spawn pointed at Cerebras. |
| Zoom screenshare-send (R3), x86 emulation (R4), voice latency | See RISK-AUDIT | — |

---

## Next steps
- Decide: model attribution **(A)** or **(A)+(B)**; orchestrator runtime **plain process** or **local DO (workerd)**.
- Then `/spec` → test-first implementation plan for the local-direct client glue, **or** spike the
  local-direct client first to de-risk the integration.

## Key Shipyard files for the integration
- `packages/loro-schema/src/transport/local-direct/local-direct-frame-protocol.ts` — frame codec (public contract)
- `apps/web/src/transport/local-direct/local-direct-transport.ts` — liftable transport class
- `packages/loro-schema/src/protocols/channel-protocol.ts` — control + task-messages wire types
- `apps/daemon/src/services/channels/control-channel/broadcast-wiring.ts` — `deliverable_registered` broadcast
- `apps/daemon/src/services/session/codex-subprocess-spawn-helpers.ts` — option-B Cerebras seam
- `apps/daemon/src/services/local-direct/local-direct-token.ts` — advert file shape
