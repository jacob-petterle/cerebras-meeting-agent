# Transport-Shim Lane — Unified Implementation Plan

**What this is:** a synthesis of the four research docs into one plan, with the cross-doc
seam-checks (where the independently-written docs agree, conflict, or leave gaps), a unified
build order with de-risk gates, and the open decisions to make before building.

**Source docs:** [`SCREENSHARE_RESEARCH.md`](./SCREENSHARE_RESEARCH.md) ·
[`TTS_AUDIO_SEND_RESEARCH.md`](./TTS_AUDIO_SEND_RESEARCH.md) ·
[`STAGE_PAGE_RESEARCH.md`](./STAGE_PAGE_RESEARCH.md) ·
[`TRANSPORT_CONTRACTS_RESEARCH.md`](./TRANSPORT_CONTRACTS_RESEARCH.md)

**Premise:** Docker container = transport shim only (no intelligence). Mac host =
orchestration + LLM + STT (parakeet-mlx) + TTS. SDK is amd64-only → whole container runs
under Rosetta on Apple Silicon (fixed constraint, cross-cutting risk).

---

## 1. Unified architecture

```
                 ┌──────────────── Docker container (amd64 / Rosetta) ────────────────┐
 Zoom meeting ──▶│ Zoom Bot SDK                                                        │
   (audio in)    │   • raw audio RECEIVE → out/node-<id>.pcm  ───bind mount──▶ Mac STT │
                 │   • virtual mic  ◀── TCP :3001 ── TTS PCM ◀──────────────── Mac TTS │
                 │   • raw screen share ◀── I420 frames ◀── XShm capture of :99        │
                 │ Xvfb :99  ◀── draws ── Chromium (kiosk, --disable-gpu, 2D)          │
                 │                              ▲ render cmds (WebSocket)              │
                 └──────────────────────────────┼─────────────────────────────────────┘
                                                 │  (topology = OPEN DECISION #1)
                                       Mac orchestrator (brain)
```

Four boundary channels (from `TRANSPORT_CONTRACTS_RESEARCH.md`, the authority on the wire):

| # | Channel | Direction | Mechanism | Status |
|---|---|---|---|---|
| 1 | Participant PCM | Docker→Mac | **bind-mount file tail** `out/node-<id>.pcm` | ✅ already works |
| 2 | TTS PCM | Mac→Docker | **TCP :3001** (container listens) | new |
| 3 | Render cmd | Mac→Docker | **WebSocket JSON :3000** | new — *topology disputed, see §3* |
| 4 | Control/health | bi-dir | **WebSocket JSON** (same server) | new |

---

## 2. Where the four docs AGREE (locked)

- **Screen share = raw external source (approach A), not desktop capture.** `GetRawdataShareSourceHelper()->setExternalShareSource()` → `onStartSend(sender)` → `sender->sendShareFrame(i420, w, h, w*h*3/2, FrameDataFormat_I420_FULL)`. Mirrors the existing `ZoomSDKVideoSource`. Verified present at the binary level in v7.1.0. (`StartMonitorShare` of Xvfb is the fallback only.)
- **Stage Page feeds that same share path.** Chromium draws to Xvfb `:99`; the bot **captures `:99` via XShm**, converts BGRA→I420, pushes through the *same* `sendShareFrame`. The SDK never touches `:99` → **no display contention** (resolves the apparent Xvfb conflict; see §4).
- **TTS = virtual mic.** `GetAudioRawdataHelper()->setExternalAudioSource()` → `IZoomSDKVirtualAudioMicEvent` → `send()`. Order is staff-confirmed: **`setExternalAudioSource` → `JoinVoip` → `UnMuteAudio(myId)`**. Mirror tanchunsiong's example, **not** the official sample (its `pSender_` capture is commented out → never sends).
- **Rosetta is THE risk.** Raw share push = low risk (CPU memcpy). Headed Chromium = highest risk (GPU process dies under Rosetta → mitigate with **`--disable-gpu`, 2D-only stage**). TTS = clock-jitter risk → monotonic-clock pacing + jitter buffer.
- **De-risk before building.** Both visual docs gate everything on one spike: does `sendShareFrame` actually render to a 2nd participant on v7.1.0? (The "blank share despite success codes" bug, unresolved on ≤6.5.x.)

---

## 3. Where the docs CONFLICT (decide before building)

### 🔴 Seam A — Render-channel topology (the one real architectural disagreement)
- **`STAGE_PAGE` says:** Mac serves the page + WS; Chromium dials **out** to `http://host.docker.internal:<port>/stage` and the page opens a WS **back to the Mac**. The C++ shim isn't in the render path at all. Rationale: outbound is the portable Docker direction; keeps the shim truly dumb.
- **`TRANSPORT_CONTRACTS` says:** the **container** runs the WS server on published `:3000`; the **Mac connects in**; Chromium connects to that server over in-container localhost. Rationale: container is the durable per-meeting server; host→container via `-p` is cleanly supported.
- **Both work on Docker Desktop.** The decision: *does the C++ shim relay render commands, or does Chromium talk to the Mac directly?* **Recommendation: STAGE_PAGE's "Chromium → Mac directly"** — it keeps the shim genuinely intelligence-free and uses the portable outbound direction; the Mac already needs to serve assets/generated images anyway. (Keep TTS + control as container-listens per TRANSPORT — these aren't browser-native and want the durable server.)

### 🟡 Seam B — TTS sample rate (minor conflict)
- `TTS_AUDIO_SEND` leans **16 kHz** (smaller, speech-native); `TRANSPORT_CONTRACTS` says **32 kHz** to match the rest of the pipeline (zero resampling, one constant everywhere).
- **Resolution: lock 32 kHz mono S16LE for ALL audio** (receive already is; 32 kHz is a supported virtual-mic mono rate). Mac TTS resamples to 32 kHz before sending. One format across every channel.

### 🟡 Seam C — WS server home
- `TRANSPORT_CONTRACTS` flags that `entry.sh:39` runs `npm --prefix=client install` but **there is no `client/` dir** (dead reference). The render/control server is greenfield: **C++ (vcpkg WS lib) vs Node sidecar.** Decide; if Node, create `client/`. (If Seam A picks "Chromium → Mac directly," the *Mac* owns the WS server and the container may need no WS server at all — simplifying this.)

---

## 4. Gaps the individual docs flagged that span the lane

1. **Xvfb is NOT running today.** Every doc that assumed "`:99` already exists" is wrong — `entry.sh` only starts D-Bus + PulseAudio. Xvfb is added *solely* for the Stage Page; raw share + TTS need no display. (Reconciled, but note it.)
2. **The existing `SocketServer` (AF_UNIX `/tmp/meeting.sock`) cannot bridge to the Mac** — UNIX sockets don't cross the Docker-for-Mac VM boundary. The TTS ingestion reader must be **AF_INET (TCP)**, not a reuse of `SocketServer` as-is.
3. **Speaker names ↔ STT.** The STT pipeline deferred node-id→name mapping. The **control channel (#4) `participant_join` events carry names** → this is where the STT transcript gets real speaker labels. Confirm the SDK `user_id` in `node-<id>.pcm` equals the one in participant events. *(Cross-lane win: the transport work solves the STT naming gap.)*
4. **Process supervision.** Xvfb + Chromium + bot + WS/TCP servers = 4+ long-lived processes in one container; `entry.sh` backgrounds manually. Needs a supervisor or health-checked bash.
5. **Webinar incompatibility (screen share only):** raw share returns `UNKNOWN(13)` in webinars. Confirm the bot only joins regular meetings.
6. **Privilege:** TTS send needs only in-meeting + VoIP + unmute (no recording privilege). Screen-share-send privilege is an open question — test host vs. participant.

---

## 5. Unified build order (with de-risk gates)

**Phase 0 — Cheap de-risk spikes (do FIRST; gate everything visual):**
- **0a. Screen-share visibility spike** — push a static I420 test card via `setExternalShareSource`/`sendShareFrame` in a *regular meeting*; confirm a 2nd participant SEES it on v7.1.0. ← gates Phase 3 & 4.
- **0b. TTS send spike** (parallel, independent) — register the virtual mic, send a WAV, confirm it's audible. Apply mute/unmute-twice workaround if `onMicStartSend` doesn't fire.
- **0c. (if 0a passes) Chromium-on-Xvfb-under-Rosetta** — `--kiosk --disable-gpu` on a static page; confirm it stays up (the GPU-process-death risk).

**Phase 1 — Lock contracts:** 32 kHz everywhere; TCP :3001 (TTS); WS :3000 (render+control); bind-mount keep (participant PCM); message schemas (`TRANSPORT_CONTRACTS` §6). **Resolve Seam A + C.**

**Phase 2 — TTS path** (if 0b passed): `ZoomSDKVirtualAudioMicEvent` + TCP ingestion reader + jitter buffer + ordering. Mostly independent of the visual work.

**Phase 3 — Screen-share path** (if 0a passed): `ZoomSDKShareSource` + async producer thread (v7 `onStartSend` is async).

**Phase 4 — Stage Page** (depends on Phase 3): Xvfb + Chromium + XShm capture → I420 → feed the Phase-3 share source; render WS channel + minimal 2D stage web app.

**Phase 5 — Control/health channel + supervision + integration**, including feeding participant names to the STT pipeline (gap #3).

**Dependency summary:** 0a → 3 → 4; 0b → 2; everything after 1. TTS (2) and screen-share (3) are independent tracks that can proceed in parallel once their spikes pass.

---

## 6. Open decisions (need answers before Phase 1)
1. **Render topology (Seam A):** Chromium→Mac directly *(recommended)* vs container-as-WS-server.
2. **WS server home (Seam C):** C++ in-process vs Node sidecar (partly settled by #1).
3. **Confirm bot only joins regular meetings, not webinars** (screen-share blocker).
4. **Scope for v1:** is TTS *and* screen-share both in scope now, or sequence one first? (They're independent — TTS is lower-risk.)
