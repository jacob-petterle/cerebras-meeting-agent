# Transport / IPC Contracts for the Docker ⇄ Mac Boundary — Research & Findings

**Status:** Research only. This document specifies *contracts the team codes against*. It contains **no working implementation** — the "Compose/Dockerfile changes" and message schemas are a **plan**, not merged code. Per the task scope, the only file created is this one.
**Repo:** `meetingsdk-headless-linux-sample` (C++ Zoom Meeting SDK for Linux, headless in Docker, built `linux/amd64`, run under Rosetta on Apple Silicon via `compose.yaml`).
**SDK:** Zoom Meeting SDK for Linux **v7.1.0** (x86_64 build in `lib/zoomsdk/`).
**Architecture premise (published design):** Docker = **transport shim only** (no intelligence). Mac host = orchestration + LLM + STT (`parakeet-mlx`, **32 kHz mono 16-bit PCM** verified) + TTS.
**Grounding:** verified against the actual repo (`compose.yaml`, `Dockerfile`, `bin/entry.sh`, `src/raw_record/*`, `src/util/SocketServer.*`, `lib/zoomsdk/h/**`) plus cited web/forum research (sources in §10).

---

## 1. Executive summary

There are **four** logical channels across the boundary. The single most important networking fact that constrains every choice:

> **On Docker Desktop for macOS the Docker engine runs inside a Linux VM.** The Mac host cannot reach container IPs directly (the bridge network is *not* reachable from the host), and **UNIX-domain sockets / named pipes do not transmit across the VM/hypervisor boundary** — a socket file on a bind mount "is there but non-functional." The only two portable, supported transports across the boundary are **(a) published TCP/UDP ports** (`-p`, host→container) and **(b) `host.docker.internal`** (container→host). See §3 for citations.

This immediately produces a key repo finding: the existing `SocketServer` (`src/util/SocketServer.h:24`) binds an **AF_UNIX** socket at `/tmp/meeting.sock` — a path that is *(i)* inside the container and *(ii)* not even on the bind mount. **It is container-internal only and cannot be used as a Docker↔Mac bridge.** Any cross-boundary socket must be **TCP**.

**Recommended contract set (the thing to implement against):**

| # | Channel | Direction | Mechanism | Format | Endpoint / path | Owner (produce → consume) |
|---|---|---|---|---|---|---|
| 1 | **Participant PCM** | Docker → Mac | **Bind-mount file tailing** *(keep — already works)* | Raw PCM, **S16LE, mono, 32 kHz** | `out/node-<node_id>.pcm` (append) on bind mount | Docker writes → Mac tails + tracks offset |
| 2 | **TTS PCM** | Mac → Docker | **localhost TCP stream** (container listens, Mac connects) | Raw PCM, **S16LE, mono, 32 kHz**, paced in 10/20 ms frames | `tcp://host.docker.internal:3001`* — published `-p 3001:3001` | Mac produces final-rate PCM → Docker paces → `IZoomSDKAudioRawDataSender::send()` |
| 3 | **Render cmd** | Mac → Docker | **WebSocket, JSON** (container listens, Mac connects) | NDJSON / WS text frames (schema §6.3) | `ws://localhost:3000/render` — published `-p 3000:3000` | Mac orchestrator → Docker relays to Stage Page / Chromium |
| 4 | **Control / health / lifecycle** | Bi-directional | **WebSocket, JSON** (same server as #3) | JSON messages + heartbeat (schema §6.4) | `ws://localhost:3000/control` | Both; container is the durable server |

\* The Mac connects to the *container* server. From the **Mac side** the address is `localhost:3001` (a published port). The `host.docker.internal` form only appears if a channel is ever inverted so the *container* dials the Mac (see §5.1 and the §8 upgrade note for Channel 1).

**Bottom line:** keep the proven bind-mount receive path as-is; add **one TCP port (3001) for real-time TTS audio** and use the **already-published port 3000 for a JSON WebSocket** carrying render commands + control/health. No UDP, no UNIX sockets across the boundary, no `--network=host` dependency.

---

## 2. The existing receive path (verified)

This already works end-to-end and is the template for "what good looks like."

- **Who writes:** `ZoomSDKAudioRawDataDelegate::onOneWayAudioRawDataReceived(AudioRawData* data, uint32_t node_id)` (`src/raw_record/ZoomSDKAudioRawDataDelegate.cpp:32`) builds `path = m_dir + "/node-" + node_id + ".pcm"` and calls `writeToFile`.
- **How it writes:** `writeToFile` opens the file `std::ios::app | std::ios::binary`, writes `data->GetBuffer()` for `data->GetBufferLen()` bytes, then `close()` + `flush()` **per callback** (`...Delegate.cpp:47-64`). One-way (per-speaker) audio is selected when `separate-participants=true` (`config.toml`), which sets `m_useMixedAudio=false` (`src/Zoom.cpp:285-289`).
- **Where it lands:** `audioDir = "out"` (`config.toml`), and `compose.yaml` bind-mounts the whole repo: `.:/tmp/meeting-sdk-linux-sample`. So `out/node-<id>.pcm` is visible to the Mac live. The Mac reads + resamples/forwards to `parakeet-mlx`.
- **Format (empirically confirmed):** the SDK exposes `GetBuffer()/GetBufferLen()/GetSampleRate()/GetChannelNum()/GetTimeStamp()` on `AudioRawData` (`lib/zoomsdk/h/zoom_sdk_raw_data_def.h:10-62`). The committed sample `out/node-16778240.pcm` is **376,320 bytes**, which is exactly **5.88 s** of S16LE mono @ 32 kHz and exactly **588 × 640-byte frames** → the SDK delivers **~10 ms frames (320 samples / 640 bytes), mono, 16-bit, 32 kHz**. This matches the STT input spec, so **no resampling is required on the receive path.** (`out/verify_32k.wav` corroborates the 32 kHz verification.)
- **Existing torn-read handling (preserve it):** the Mac reader already aligns to **2-byte sample boundaries** and carries an **odd trailing byte** to the next read. That is the correct and necessary behavior for tailing a file that a writer is appending to in arbitrary-sized chunks; **keep it** and apply the same discipline to Channel 2 (see §7.2).

**Caveat already latent in this path:** each callback does `open→write→close→flush`. It works, but it is the *receive* side; for the *send* side (Channel 2) we explicitly avoid file I/O because of real-time pacing needs (§4).

---

## 3. macOS Docker networking realities (verified, not assumed)

| Capability | Reality on Docker Desktop / macOS | Verdict |
|---|---|---|
| **Container → host** | `host.docker.internal` "resolves to the internal IP address of your host." It is an address *inside the VM* and is a **development convenience, not for production**. | ✅ Use for any container-initiated connection to a Mac listener. |
| **Host → container** | "When you publish a container port using `-p`/`--publish`, Docker Desktop makes that container port accessible from your host system… Docker Desktop's backend listens on the specified host port… and forwards the connection into the Linux VM." | ✅ Use published ports for all Mac→Docker channels. |
| **Host → container *IP* directly** | "the Docker `bridge` network is not reachable from the host." The Mac cannot route to `172.x` container IPs. | ❌ Never address a container by its IP from the Mac. |
| **UNIX-domain sockets / named pipes across the boundary** | "Socket files and named pipes only transmit between containers and between OS X processes — no transmission across the hypervisor is supported." A socket file on a bind-mounted **directory** appears but is **non-functional** across the VM boundary. Docker Desktop later added forwarding of a **single, explicitly bind-mounted socket *file*** (`-v /path/host.sock:/path/in.sock`, used mainly for `docker.sock`) — but this is a special-cased, fragile path, not a general high-rate bidirectional app transport. | ❌ Do **not** use AF_UNIX for Docker↔Mac. Use TCP. (Treat the single-file forwarding as out of scope / unverified for our use — see §9.) |
| **Bind mount (VirtioFS)** | VirtioFS is the default sharing implementation; community benchmarks put it ≈ **2–3× slower than native** (vs. 5–6× for the older gRPC-FUSE), and with VirtioFS the legacy `consistent`/`cached`/`delegated` flags "have less impact." Good enough for append+tail PCM (proven), but it adds flush/visibility latency and is **not** ideal for real-time duplex audio. | ✅ Keep for Channel 1; ⚠️ avoid for Channel 2. |
| **`--network=host`** | Supported on the Mac **only in Docker Desktop ≥ 4.34**, and "network protocols that operate below TCP or UDP are not supported." On older versions the flag is silently ineffective. | ⚠️ Do **not** build a contract that depends on host networking; published ports are portable across versions. |

**Net:** the boundary is a **TCP/UDP port boundary plus a shared filesystem.** Everything below is designed within that envelope.

---

## 4. Per-channel mechanism analysis & tradeoffs

### 4.0 Mechanism comparison (the decision matrix)

| Mechanism | One-way latency (loopback/VM) | Jitter | Backpressure | Ordering/Reliability | Real-time fit | Notes for this system |
|---|---|---|---|---|---|---|
| **Bind-mount file tailing** | tens–hundreds of ms (poll interval + VirtioFS flush) | medium–high | **None** (writer never blocks; reader may lag unboundedly) | Append preserves order; reliable | ❌ for playout, ✅ for STT ingest | **Proven** for Channel 1. Unbounded file growth + torn reads are the costs. |
| **localhost TCP** | sub-ms–few ms | low | **Yes** (kernel socket buffer; slow reader → writer blocks) | Ordered + reliable | ✅ best general choice | Through Docker's port-forwarder/VM, still ≪ audio frame budget. Trivial framing. |
| **UDP** | lowest in theory | low | None (you must build it) | Unordered, lossy | ⚠️ only for lossy WAN RTP | On loopback/VM there is ~no loss to "drop late packets" around; you'd reinvent reliability for no gain. **Rejected.** |
| **WebSocket** | ~TCP + tiny framing/handshake | low | Yes (rides TCP) | Ordered + reliable | ✅ for messages/control | Free message framing + a browser-native peer (Chromium Stage Page). Slight overhead vs raw TCP. |

### 4.1 Channel 1 — Participant PCM (Docker → Mac): **keep bind-mount tailing**

It already works, STT tolerates the tens-of-ms file latency (it is batch-windowed transcription, not live duplex), and rewriting a working path adds risk for little benefit. The real costs are **file growth** (no rotation today) and **torn reads** (already handled). Recommendation: keep the mechanism, add **rotation/scoping** (§6.1). If profiling later shows the file path is a latency or disk problem, the clean upgrade is localhost TCP with the Mac as server (§8) — but that is an *optimization*, not required for v1.

### 4.2 Channel 2 — TTS PCM (Mac → Docker): **localhost TCP, container listens**

This is the **most latency- and jitter-sensitive** channel: bytes feed a **live virtual microphone** in an ongoing meeting, so late or bursty audio is *audible*. The send API is:

```cpp
// lib/zoomsdk/h/rawdata/rawdata_audio_helper_interface.h
class IZoomSDKAudioRawDataSender {
  // "Sends audio raw data. Audio sample must be 16-bit audio."
  virtual SDKError send(char* data, unsigned int data_length,
                        int sample_rate,
                        ZoomSDKAudioChannel channel = ZoomSDKAudioChannel_Mono) = 0;
};
class IZoomSDKVirtualAudioMicEvent {
  virtual void onMicInitialize(IZoomSDKAudioRawDataSender* pSender) = 0;
  virtual void onMicStartSend()  = 0;   // begin pushing
  virtual void onMicStopSend()   = 0;
  virtual void onMicUninitialized() = 0;
};
// Registered via IZoomSDKAudioRawDataHelper::setExternalAudioSource(IZoomSDKVirtualAudioMicEvent*)
```

- **Why TCP, not files:** files add VirtioFS flush/visibility latency and unbounded growth; neither is acceptable for paced playout.
- **Why TCP, not UDP:** on the loopback/VM path there is no meaningful packet loss to justify UDP's "drop late" semantics, and you'd have to rebuild ordering + reliability. TCP's socket-buffer **backpressure** is actually desirable here (it lets the shim's bounded jitter buffer regulate the Mac producer).
- **Server placement:** the **container listens** on a published port; the **Mac connects** to `localhost:3001`. Container-as-server is best because the container is the long-lived process tied to the meeting; the Mac orchestrator reconnects to it.
- **Pacing (the crux):** the shim must **pace to wall-clock** inside `onMicStartSend` — pull from a small **jitter buffer (target ~100–200 ms)** and call `send()` on a steady timer in frame-sized chunks. On **underrun → emit silence**; on **overrun → drop oldest** (bounded buffer). Do *not* fast-feed everything the moment it arrives (the §3-cited forum thread on "sampling rate & duration" shows sloppy pacing produces sped-up/garbled playback).

### 4.3 Channel 3 — Render cmd (Mac → Docker): **JSON over WebSocket on :3000**

Render commands are **low-rate discrete messages** (show text/image, clear, layout), not a stream. The Stage Page is **Chromium**, which speaks WebSocket natively, so a WS server in the container can fan commands out to the Stage Page over an in-container `localhost` connection while the Mac orchestrator pushes them in over the published `:3000`. WebSocket gives free message framing and a back-channel for acks/readiness. (Plain NDJSON-over-TCP is an acceptable alternative if no browser is involved, but WS is the better fit given Chromium.)

> **Repo note:** `bin/entry.sh:39` runs `npm --prefix=client install`, but **there is no `client/` directory in the repo** — it only runs on first CMake configure and is currently a dead/aspirational reference. So **no WebSocket/Node server exists yet**; Channels 3–4 are greenfield. Decide explicitly whether the WS server lives in (a) the C++ app, or (b) a small Node sidecar in the same container. Either is fine; both reach the Stage Page over in-container localhost.

### 4.4 Channel 4 — Control / health / lifecycle (bi-directional): **same WebSocket server**

A single bidirectional JSON channel for: readiness handshake, meeting lifecycle events (joined / participant join-leave / **meeting ended**), errors, heartbeats, and **barge-in / stop-speaking** (interrupt TTS when a human talks). Co-locating it with render on :3000 (different path/`type`) keeps the surface minimal; split to a second port only if operational separation is needed later.

---

## 5. Connection topology & who-is-server

| Channel | Server (listens) | Client (dials) | Address used by client |
|---|---|---|---|
| 1 Participant PCM | *(none — filesystem)* | *(none)* | `out/node-<id>.pcm` |
| 2 TTS PCM | **Container** `:3001` | Mac | `localhost:3001` |
| 3 Render | **Container** `:3000` | Mac | `ws://localhost:3000/render` |
| 4 Control | **Container** `:3000` | Mac | `ws://localhost:3000/control` |

### 5.1 Why container-as-server for all Mac→Docker channels
The container is the process bound to a single meeting's lifetime; the Mac orchestrator is the long-lived coordinator that (re)attaches to whichever container is currently in a meeting. Host→container is exactly the published-port direction Docker Desktop supports cleanly (§3). The only case requiring `host.docker.internal` is the **future** inversion of Channel 1 to TCP (Mac listens, container dials out) — see §8.

---

## 6. Concrete data contracts

### 6.1 Channel 1 — Participant PCM (Docker → Mac)
- **Encoding:** raw headerless PCM, **signed 16-bit little-endian, mono, 32,000 Hz.** Byte rate = 64,000 B/s per speaker. SDK callback ≈ 10 ms = **640 bytes** (320 samples).
- **Path / naming (today):** `out/node-<node_id>.pcm`, opened append. `<node_id>` is the Zoom participant `user_id` (`uint32_t`).
- **Rotation (recommended addition — none exists today):** scope per meeting to avoid cross-session contamination and unbounded growth:
  - `out/<session_id>/node-<node_id>.pcm` where `<session_id>` is assigned at join, **or**
  - size-based rollover `out/node-<node_id>.<seq>.pcm` (e.g. roll at 256 MB).
  - Truncate/clear the session dir at meeting start so a tailing reader never replays stale audio after a container restart.
- **Resampling owner:** **nobody** — source is already 32 kHz mono 16-bit = STT input. If Zoom ever delivers a different `GetSampleRate()` (it is queryable per-buffer), the **Mac** owns any resample (Docker is transport-only).
- **Reader discipline:** track per-file byte offset; align to 2-byte samples; carry odd trailing byte (already implemented — preserve).
- **Optional timing sidecar:** if STT needs precise alignment, persist `AudioRawData::GetTimeStamp()` (ms) into a sidecar `out/<session>/node-<id>.ts` rather than interleaving it into the PCM (keeps the PCM a clean raw stream).

### 6.2 Channel 2 — TTS PCM (Mac → Docker)
- **Encoding:** raw PCM, **S16LE, mono, 32,000 Hz** (chosen to match the rest of the pipeline → **zero resampling**, and passed verbatim as `send(buf, len, 32000, ZoomSDKAudioChannel_Mono)`).
- **Framing on the wire:** simplest viable = **raw byte stream**; the shim re-chunks into 10 ms (640 B) or 20 ms (1280 B) frames for `send()`. If discrete utterances / interruption are needed, prefer a tiny length-prefixed frame: `[uint32 le payload_len][payload]`, with utterance boundaries and "flush/stop" signaled on the **control channel** (§6.4) rather than inline. Keep audio bytes and control on separate channels.
- **Pacing owner:** **Docker** (jitter buffer + wall-clock timer in `onMicStartSend`).
- **Resampling owner:** **Mac.** Docker forwards bytes unchanged. If the Mac TTS native rate ≠ 32 kHz, the Mac resamples before sending.
- **Sample-rate parameter:** `send()` takes `sample_rate` explicitly; agree on **32,000** so it is a single constant on both sides. (Exact set of Zoom-accepted virtual-mic rates — 8/16/32/48 kHz — is not stated in the headers; 32 kHz is the verified-working rate elsewhere in this pipeline. See §9.)

### 6.3 Channel 3 — Render cmd schema (Mac → Docker, WebSocket JSON)
One JSON object per WS text frame (or NDJSON line if TCP):
```json
{
  "v": 1,
  "id": "rc_01H...",            // ULID/UUID, unique per command (for ack/idempotency)
  "ts": 1719600000123,          // ms epoch, sender clock
  "type": "render",
  "action": "show_text",        // show_text | show_image | update | clear | layout
  "payload": {                  // action-specific; opaque to the shim, consumed by Stage Page
    "text": "…",
    "region": "main",
    "style": { "size": "lg" }
  }
}
```
- The **shim relays opaquely** (it does not interpret `payload` — "no intelligence"). The Stage Page interprets it.
- The Stage Page **acks** on the control channel: `{ "v":1, "type":"ack", "ref":"rc_01H…", "status":"applied" | "error", "detail":"…" }`.

### 6.4 Channel 4 — Control / health schema (bi-directional, WebSocket JSON)
```json
// Heartbeat (either direction), expect pong within N ms
{ "v":1, "type":"ping", "ts":1719600000000 }
{ "v":1, "type":"pong", "ts":1719600000005 }

// Readiness handshake (startup ordering — see §7.6)
{ "v":1, "type":"hello", "role":"shim",         "meeting":"<id>", "caps":["tts","render"] }
{ "v":1, "type":"hello", "role":"orchestrator", "ready":true }

// Lifecycle events (shim → Mac)
{ "v":1, "type":"event", "event":"meeting_joined",  "meeting":"<id>" }
{ "v":1, "type":"event", "event":"participant_join","node_id":16778240, "name":"…" }
{ "v":1, "type":"event", "event":"participant_left","node_id":16778240 }
{ "v":1, "type":"event", "event":"meeting_ended" }
{ "v":1, "type":"event", "event":"mic_ready" }        // onMicStartSend fired → safe to stream TTS

// Barge-in / playout control (Mac → shim)
{ "v":1, "type":"tts_control", "action":"flush" }     // drop jitter buffer now (human is speaking)
{ "v":1, "type":"tts_control", "action":"stop" }
```
All messages carry `v` (schema version) and are JSON objects. Unknown `type`/`action` must be ignored (forward-compatible).

---

## 7. Failure modes & lifecycle

1. **Reconnection (TCP/WS).** Container is the durable server; the Mac client reconnects with exponential backoff + jitter. On reconnect, replay nothing for audio (resume live); for control, re-send `hello` and re-subscribe. WS heartbeats (`ping`/`pong`, e.g. 5 s interval, 15 s timeout) detect half-open sockets that the OS hasn't torn down.
2. **Partial / torn reads.** PCM = 2 bytes/sample. Channel 1 reader already aligns to 2-byte boundaries and carries the odd byte — **keep**. Channel 2 shim must likewise buffer until it has whole samples (and whole frames) before calling `send()`; never hand `send()` an odd byte count.
3. **Container restart.** Bind-mount files **persist** → a tailing reader could replay stale audio; mitigate via per-session dir + truncate-on-start (§6.1). All TCP/WS connections drop → clients reconnect. The virtual mic re-initializes via `onMicInitialize` → wait for `mic_ready` (event) before resuming TTS.
4. **Meeting end.** SDK fires meeting-end (`MeetingServiceEvent`); shim should: flush + close PCM files, emit `event: meeting_ended` on control, stop the pacing timer, and close the TTS stream. Mac tears down STT/TTS for that session.
5. **Clock / latency drift.** The Mac (TTS producer) and container (SDK consumer) clocks are independent — **do not assume they are synced.** Pace strictly off the **consumer** (`send()` cadence) via the bounded jitter buffer: underrun → silence, overrun → drop oldest. For STT alignment use `AudioRawData::GetTimeStamp()` rather than wall-clock correlation.
6. **Startup ordering.** Neither side may assume the other is up. Container starts its servers immediately and tolerates no client; Mac retries `connect()` until the container listens. **Gate TTS streaming** on *both* (a) control `hello` handshake complete and (b) `mic_ready` event. Render commands sent before the Stage Page is attached should be queued briefly or rejected with an `ack:error` the orchestrator can retry.
7. **Backpressure / overload.** TCP socket buffers provide natural backpressure for Channels 2–3; the shim's jitter buffer must be **bounded** so a stalled meeting cannot OOM the container. Channel 1 has *no* backpressure (file append) — the Mac reader must keep up or skip forward (it is the consumer's responsibility).

---

## 8. Optional upgrade path for Channel 1 (not required for v1)
If file-tailing latency or disk growth becomes a problem, invert to TCP: the **Mac listens**, the **container connects out** to `host.docker.internal:<port>` and streams each speaker as a length-prefixed framed message `[uint32 node_id][uint32 len][pcm…]` (or one connection per speaker). This is the only channel that would use `host.docker.internal`, and the container must retry the outbound connection until the Mac listener is up. Keep the bind-mount path as the fallback.

---

## 9. Required `compose.yaml` / `Dockerfile` changes (plan — no code)

**`compose.yaml`:**
- **Ports:** keep `"3000:3000"` (render + control WS); **add `"3001:3001"`** (TTS PCM TCP). Add `"3002:3002"` only if control is later split from render.
- **Volume:** keep the bind mount `.:/tmp/meeting-sdk-linux-sample` (Channel 1 depends on it). No change needed.
- **`extra_hosts`:** on Docker Desktop `host.docker.internal` resolves automatically; for portability to plain Linux Compose (CI) add `extra_hosts: ["host.docker.internal:host-gateway"]`. Only relevant if/when Channel 1 is inverted (§8).
- **Env:** parameterize ports/host so they aren't hard-coded — e.g. `TTS_TCP_PORT=3001`, `WS_PORT=3000`, `BOT_SESSION_DIR=out/<session>`. The C++ app reads these (extend `Config`), the Mac reads the same constants.

**`Dockerfile`:**
- TCP sockets need **no new packages** (POSIX sockets are in libc; the repo already uses `<sys/socket.h>` in `SocketServer`).
- If the WS server is implemented in **C++**, add a small header-only/lib WS dependency via vcpkg (e.g. a WebSocket++/uWebSockets-class lib) — declare it in `vcpkg.json`. If implemented as a **Node sidecar**, create the missing `client/` dir that `entry.sh:39` already references and add a `node`/`npm` install layer.
- `ENTRYPOINT`/tini unchanged. `entry.sh` would additionally launch the WS/TCP server process (or the C++ app hosts it in-process on its existing thread model, mirroring `SocketServer::start()` but with `AF_INET`).
- **Do not** rely on `--network=host` (§3); published ports are the contract.

---

## 10. Sources

- Docker Desktop networking (published ports, forwarding into the VM): https://docs.docker.com/desktop/features/networking/
- Docker Desktop networking how-tos (`host.docker.internal`, "bridge network is not reachable from the host"): https://docs.docker.com/desktop/features/networking/networking-how-tos/
- Host network driver / Docker Desktop support (≥ 4.34; sub-TCP/UDP protocols unsupported): https://docs.docker.com/engine/network/drivers/host/ and roadmap https://github.com/docker/roadmap/issues/238
- UNIX socket / named-pipe transmission across the hypervisor — "no transmission across the hypervisor is supported"; socket on bind mount "there but non-functional": https://github.com/docker/for-mac/issues/483 ; https://forums.docker.com/t/unix-socket-on-bind-mount/142653 ; https://forums.docker.com/t/socket-pipes-in-mounted-volumes-not-working/12861
- VirtioFS bind-mount performance / consistency: https://www.cncf.io/blog/2023/02/02/docker-on-macos-is-slow-and-how-to-fix-it/ ; https://www.paolomainardi.com/posts/docker-performance-macos-2025/ ; https://collabnix.com/unlocking-high-performance-with-virtiofs-in-docker-desktop/ ; https://www.infoq.com/news/2022/03/docker-desktop-macos-virtiofs/
- Getting around Docker's host-network limitation on Mac: https://medium.com/@lailadahi/getting-around-dockers-host-network-limitation-on-mac-9e4e6bfee44b
- Zoom Meeting SDK raw data (concept + subscribe/send overview): https://developers.zoom.us/docs/meeting-sdk/linux/ ; https://www.recall.ai/blog/how-to-subscribe-to-raw-audio-from-the-meeting-sdk
- Zoom raw-audio sample-rate / duration pacing pitfalls: https://devforum.zoom.us/t/meeting-sdk-sending-raw-audio-data-impacted-by-sampling-rates-and-duration/116705
- **In-repo (authoritative for SDK signatures & current behavior):** `lib/zoomsdk/h/rawdata/rawdata_audio_helper_interface.h` (send/virtual-mic), `lib/zoomsdk/h/zoom_sdk_raw_data_def.h` (`AudioRawData`), `src/raw_record/ZoomSDKAudioRawDataDelegate.cpp`, `src/util/SocketServer.{h,cpp}`, `compose.yaml`, `bin/entry.sh`, `config.toml`.

---

## 11. Gaps & open questions

1. **Zoom virtual-mic accepted sample rates.** Headers prove `send()` takes a `sample_rate` and "must be 16-bit," but do **not** enumerate accepted rates. 32 kHz is recommended (matches pipeline, avoids resampling) but the accepted set (8/16/32/48 kHz?) and any required frame-length constraint should be confirmed by a send spike. The forum evidence suggests pacing/duration matters more than the rate itself.
2. **Send-side frame size & timing.** Whether `send()` expects a specific chunk duration (e.g. exactly 10 ms) or accepts arbitrary lengths is unconfirmed — affects the shim's jitter-buffer frame size. (Separate "SDK send side" research task owns this; this doc only fixes the *transport*.)
3. **Single-file UNIX-socket forwarding.** Docker Desktop's `-v host.sock:/in.sock` forwarding exists mainly for `docker.sock`; its viability for a *custom, high-rate, bidirectional* app socket across the VM is unverified. We deliberately **avoid** it in favor of TCP; revisit only if a measured TCP problem appears.
4. **WS server home.** Render/control server can live in the C++ app or a Node sidecar. The repo's `entry.sh` references a non-existent `client/` dir — a decision + cleanup is needed. Picking Node also affects the `Dockerfile`.
5. **Stage Page ↔ shim wiring.** This doc assumes the Stage Page (Chromium) connects to the in-container WS server over localhost. The actual Stage Page bring-up (headless Chromium under Xvfb) is a separate task; confirm it can hold a persistent WS to the shim.
6. **Latency budget numbers.** No end-to-end latency measurement exists yet (Mac TTS → wire → jitter buffer → `send()` → meeting). The ~100–200 ms jitter-buffer target is a starting heuristic; tune against a real meeting.
7. **Channel 1 file growth in long meetings.** Rotation (§6.1) is recommended but unimplemented; confirm the Mac reader can follow a rotation/rename scheme without dropping samples.
8. **`node_id` ↔ display-name mapping.** STT diarization likely needs participant names; the mapping (from `participant_join` control events) must be reconciled with the `node-<node_id>.pcm` filenames — confirm the SDK `user_id` used in the filename equals the one in participant events.
