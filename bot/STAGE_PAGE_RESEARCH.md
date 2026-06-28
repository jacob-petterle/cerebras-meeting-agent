# The "Stage Page" — Chromium-on-Xvfb Render Channel that Feeds the Screen Share — Research & Findings

**Status:** Research only. No working code here — the Dockerfile/`entry.sh`/code items are a **plan**, not something to merge as‑is.
**Repo:** `meetingsdk-headless-linux-sample` (C++ Zoom Meeting SDK for Linux, headless in Docker, **amd64 under Rosetta** on Apple Silicon).
**SDK:** Zoom Meeting SDK for Linux **v7.1.0** (x86_64 build in `lib/zoomsdk/`).
**Companion doc (READ FIRST):** [`SCREENSHARE_RESEARCH.md`](./SCREENSHARE_RESEARCH.md) — this document is the **render side** that *feeds* the share path described there. It deliberately does **not** re‑research the Zoom share API; it references it.

---

## 0. How this builds on `SCREENSHARE_RESEARCH.md`

`SCREENSHARE_RESEARCH.md` settled the **transport** question:

- The Linux SDK can send a screen share two ways: **(A) raw external share** — you push I420 frames via `GetRawdataShareSourceHelper()->setExternalShareSource(...)` → `onStartSend(sender)` → `sender->sendShareFrame(buf, w, h, w*h*3/2, FrameDataFormat_I420_FULL)`; or **(B) desktop/app capture** — `IMeetingShareController::StartMonitorShare(":99-0(0,0,1920,1080)-winid")`, which makes the SDK screen‑grab a real X display.
- It **recommended (A)** (simplest, headless‑safe, mirrors the existing `src/raw_send/ZoomSDKVideoSource.{h,cpp}` pattern) and flagged one risk to validate on v7.1.0: the "blank share" bug (success codes but no visible frames). (B) is the documented fallback.
- It also corrected a project assumption: **`bin/entry.sh` does not start Xvfb today** — there is no live X display in the running container. Approach (A) doesn't need one.

**This document adds the missing half: the renderer.** The Stage Page is **Chromium drawing into an Xvfb display**, and the central design question is *how Chromium's framebuffer gets into the share*. The clean answer (see §2) reuses transport **(A)** unchanged and only swaps the *frame producer*: instead of drawing an OpenCV `cv::Mat` in‑process, the producer **captures Chromium's Xvfb framebuffer** and converts it to I420. SCREENSHARE built the pipe; STAGE_PAGE builds what flows into it.

> **One‑line mental model:** `Mac orchestrator → (WebSocket render commands) → Chromium kiosk on Xvfb :99 → (XShm capture) → BGRA→I420 → sendShareFrame() → Zoom → participants.` Everything left of `sendShareFrame()` is new; everything from `sendShareFrame()` rightward is `SCREENSHARE_RESEARCH.md`.

---

## 1. Executive summary & recommended approach

**Recommended end‑to‑end design:**

| Stage | Choice | Why |
|---|---|---|
| **Render** | **Headed (not `--headless`) Chromium in `--kiosk`, drawing to Xvfb `:99`** | Rich HTML/CSS/Canvas/text/images, driven live; a real browser is the right tool for "render arbitrary generated visuals." |
| **Capture** | **XShm (`MIT-SHM`) grab of the `:99` root window** → BGRA → **I420** (libyuv `ARGBToI420`, or OpenCV `cvtColor`) | On **Xvfb the framebuffer lives in system RAM** — capture is a RAM‑to‑RAM memcpy with no GPU readback, so it's nearly free. |
| **Transport** | **Reuse `SCREENSHARE_RESEARCH.md` approach (A)** — push the I420 buffer through `sendShareFrame()` | Keeps the proven, headless‑safe raw‑share path; the producer thread from SCREENSHARE §8 just sources frames from capture instead of OpenCV. |
| **Command channel** | **Architecture (A): Mac serves the stage page + a WebSocket; container Chromium loads `http://host.docker.internal:<port>/stage` and the page dials a WS back to the Mac** | Only uses the **portable outbound** Docker direction (no published container ports); keeps *all* logic on the Mac ("dumb transport shim"). |
| **Stage content** | **2D only** — text/markdown, images, status lines, CSS layouts. **No WebGL/3D.** | A 2D page needs **no GPU**, so you can run Chromium with `--disable-gpu` and **sidestep the single biggest Rosetta risk** (the GPU process dying under emulation — §8). |

**Why capture→raw‑push (and not `StartMonitorShare` of the display):** both get Chromium's pixels on screen, but capture→raw‑push (i) **reuses the exact transport SCREENSHARE already recommends and de‑risked**, (ii) gives you full control of frame timing/format, (iii) is cheap on Xvfb, and (iv) avoids the fragile Linux device‑string (`:99-0(...)-winid`) and the unproven "SDK‑grabs‑Xvfb" path. `StartMonitorShare` remains the fallback if raw‑push hits the blank‑frame bug on v7.1.0 (see §2.3 and SCREENSHARE §1).

**The decisive practical lever: keep the Stage Page 2D.** The hardest, least‑resolved problem in this whole stack is **headed Chromium's GPU process dying under Rosetta** ([docker/for-mac#7552](https://github.com/docker/for-mac/issues/7552)). If the stage renders text/images/CSS (which is exactly the stated use case — "text/diagnostics/images/generated visuals"), **WebGL is never needed**, so `--disable-gpu` is safe and the GPU‑process failure mode is avoided entirely. Only invest in software‑GL (llvmpipe/SwiftShader) if the stage genuinely needs WebGL/Three.js — and treat that as the high‑risk variant under Rosetta.

**Effort/scope:** this is materially more than the SCREENSHARE (A) spike — it adds Xvfb + a browser + a capture loop + a Mac‑side page/WS server + Dockerfile/`entry.sh` changes. Recommended sequencing is in §10.

---

## 2. How the Stage Page output reaches the share (the core design decision)

Two candidate couplings between "Chromium on `:99`" and "the Zoom share":

### 2.1 ✅ Recommended — Capture the Xvfb framebuffer, push as raw share (feeds SCREENSHARE approach **A**)

The bot process **captures the `:99` root window** every frame, converts BGRA→I420, and calls `sendShareFrame()` — i.e. the **same `ZoomSDKShareSource` + producer‑thread plumbing sketched in `SCREENSHARE_RESEARCH.md` §8**, with one change: the producer reads pixels from X instead of drawing them.

```
Chromium → Xvfb :99 framebuffer (BGRX, 32bpp, depth 24)
        → XShmGetImage() into a persistent shared-memory XImage   (≈ RAM memcpy)
        → cv::Mat(H, W, CV_8UC4, shm) → I420  (libyuv ARGBToI420 / cv::cvtColor BGRA2YUV_I420)
        → sender->sendShareFrame(i420, W, H, W*H*3/2, FrameDataFormat_I420_FULL)
```

**Why this is the cleanest fit:**
- **Reuses the de‑risked transport.** Nothing about the Zoom send path changes vs. SCREENSHARE; the blank‑frame question, the v7 async `onStartSend`, webinar `UNKNOWN(13)`, and the privilege questions are all inherited from there unchanged — so SCREENSHARE's spike already covers them.
- **Capture is effectively free on Xvfb.** Xvfb's framebuffer is a linear pixel array in **main memory** (it can even be backed by a SysV shared‑memory segment via `Xvfb -shmem`, or an mmap'd file via `-fbdir`). The classic "X capture is slow because pixels live in VRAM and readback is slow" problem **does not apply** — there is no GPU. XShm grab at 1280×720/1920×1080 is sub‑ms to low‑single‑digit‑ms, dominated by memory bandwidth. ([X.Org MIT‑SHM](https://www.x.org/releases/X11R7.7/doc/xextproto/shm.html), [Xvfb man page](https://manpages.ubuntu.com/manpages/questing/en/man1/Xvfb.1.html))
- **Full control** over resolution, fps, format, and which frames to send (e.g. skip unchanged frames via XDamage — §6).
- **Decouples render from transport** — you can later swap the renderer (OpenCV, a different browser, etc.) without touching the share code.

**The only added cost vs. SCREENSHARE's pure‑OpenCV plan** is the BGRA→I420 conversion of a *captured* frame instead of a *drawn* one — the same conversion, a different pixel source (§7 has the numbers).

### 2.2 Display coordination (important — reconcile with SCREENSHARE §4)

SCREENSHARE correctly noted approach (A) needs **no** X display, and the container has none today. STAGE_PAGE **introduces Xvfb `:99` solely for Chromium to draw on.** In the capture→raw‑push design **the Zoom SDK never touches `:99`** — only the bot's capture loop reads it. So there is no contention: `:99` is a private rendering surface, and the SDK still sends frames via the displayless raw path. (Contrast: approach (B) below *would* point the SDK at `:99`.)

### 2.3 ⚠️ Fallback — `StartMonitorShare(":99-...")` (SCREENSHARE approach **B**)

Let the SDK screen‑grab the Xvfb display Chromium draws on, using the Linux device string `hostname:display-screen(x,y,w,h)-winid` (e.g. `:99-0(0,0,1920,1080)-<winid>`). **Use only if** raw‑push reproduces the blank‑frame bug on v7.1.0 and SCREENSHARE's checklist can't clear it. Downsides: fragile device‑string discovery (enumerate `winid`/geometry via `xwininfo`/Xlib), the SDK's X11 capture path is unproven headless, and it concentrates more risk under Rosetta. See SCREENSHARE §2B/§4 for the full treatment — **not re‑researched here.**

### 2.4 Off‑the‑shelf capture alternative — `ffmpeg -f x11grab`

Instead of a bespoke XShm loop you can run `ffmpeg -f x11grab -framerate 15 -video_size 1280x720 -i :99 -pix_fmt yuv420p ...` and read the I420 stream from a pipe. ffmpeg's x11grab/xcbgrab uses MIT‑SHM under the hood (falls back to `XGetImage`). ([ffmpeg devices](https://ffmpeg.org/ffmpeg-devices.html), [xcbgrab.c](https://github.com/FFmpeg/FFmpeg/blob/master/libavdevice/xcbgrab.c)) **Trade‑off:** less control over exact frame timing, damage handling, and zero‑copy than a native XShm+libyuv loop, plus a process boundary. Good for a quick spike; the native loop is better for production.

---

## 3. Running Chromium in this container

### 3.1 Installation (Dockerfile, amd64)

- **Do NOT `apt-get install chromium-browser` on Ubuntu 24.04** — it's a transitional package that redirects to the **Chromium snap, and snap does not run in Docker.** Dead end. ([stablebuild](https://www.stablebuild.com/blog/install-chromium-in-an-ubuntu-docker-container))
- **Recommended (matches the amd64/Rosetta pin): `google-chrome-stable` from Google's apt repo.** Most reliable + current; it declares its own deps. Caveat: **Google ships amd64 Chrome only — no arm64 .deb** (fine here, but it locks you to amd64). ([computingforgeeks](https://computingforgeeks.com/install-google-chrome-ubuntu/))
- **Open‑source / future arm64‑portable alternative:** switch the base image to **Debian** and install Debian's real `chromium` package (ships **both amd64 and arm64**; slower update cadence). ([baeldung](https://www.baeldung.com/ops/docker-google-chrome-headless))
- **Fonts & runtime libs:** add `fonts-liberation` (must‑have; without it non‑Latin text is tofu) and, if rendering arbitrary content, `fonts-noto-color-emoji` + `fonts-noto-cjk`. Chrome's deb pulls most libs, but in slim images list them explicitly: `libnss3`, `libnspr4`, `libatk1.0-0`, `libatk-bridge2.0-0`, `libcups2`, `libgdk-pixbuf2.0-0`, `libxcomposite1`, `libxdamage1`, `libxrandr2`, `libxss1`, `libasound2t64`, `xdg-utils`. **Many X libs this needs are already in the repo's Dockerfile** (`libx11-xcb1`, `libxcb-*`, `libgbm1`, `libgl1`, `libgl1-mesa-dri`). ([dep list gist](https://gist.github.com/ipepe/94389528e2263486e53645fa0e65578b))

### 3.2 Launch flags (headed kiosk drawing to Xvfb — **not** `--headless`)

Set `DISPLAY=:99`, do **not** pass `--headless` (we want it to draw to the X server so we can capture it). Recommended baseline:

```
--kiosk                          # full-screen, no browser UI (preferred over --app for a capture target)
--no-sandbox                     # Chrome's sandbox doesn't work in most containers
--disable-dev-shm-usage          # /dev/shm defaults to 64MB in Docker → crashes without this
--ozone-platform=x11             # force X11 Ozone backend → draws to Xvfb (explicit; Chrome 140 made the hint auto-detect)
--window-position=0,0
--window-size=<W>,<H>            # MATCH the Xvfb screen size exactly
--force-device-scale-factor=1    # avoid DPI scaling surprises (pair with Xvfb -dpi 96)
--no-first-run --noerrdialogs --disable-infobars
--disable-session-crashed-bubble # kills the "Restore pages?" bubble
--disable-features=TranslateUI --disable-translate
--disable-notifications --disable-default-apps --disable-extensions
--disable-popup-blocking --mute-audio
http://host.docker.internal:<port>/stage   # the Mac-served stage page (see §5)
```

Sources: kiosk flag set ([gist](https://gist.github.com/lellky/673d84260dfa26fa9b57287e0f67d09e)); `--no-sandbox`/`--disable-dev-shm-usage` rationale ([alpine-chrome](https://github.com/jlandure/alpine-chrome)); crash‑bubble ([crbug 41150021](https://issues.chromium.org/issues/41150021)); Ozone/X11 ([Ozone overview](https://chromium.googlesource.com/chromium/src/+/lkgr/docs/ozone_overview.md)).

**GPU flags — pick based on whether the stage needs WebGL:**
- **2D stage (recommended): add `--disable-gpu`.** Text/CSS/2D‑Canvas render fine with the CPU rasterizer and **no GPU process**, which is exactly what dodges the Rosetta GPU‑process death (§8). This is the safest configuration for this use case.
- **WebGL/3D stage (high‑risk under Rosetta):** do **not** use `--disable-gpu`; instead use software GL — **Mesa llvmpipe** via `--use-angle=gl` (≈49% less CPU than SwiftShader; needs `libgl1-mesa-dri`/`libglx-mesa0`/`libegl-mesa0`/`libvulkan1`), **or** SwiftShader via `--use-gl=angle --use-angle=swiftshader-webgl --enable-unsafe-swiftshader`. **On Chrome 137+, `--enable-unsafe-swiftshader` is mandatory** for any SwiftShader‑backed WebGL (the automatic fallback was removed in 137; deprecation warnings began in 130). ([SwiftShader docs](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/docs/gpu/swiftshader.md), [Intent to Remove](https://groups.google.com/a/chromium.org/g/blink-dev/c/yhFguWS_3pM), [llvmpipe vs SwiftShader benchmark](https://botbrowser.io/en/blog/mesa-llvmpipe-vs-swiftshader-chromium-linux/))

### 3.3 Note: the SDK already embeds a web runtime

`lib/zoomsdk/new_home_page/new_home_page.zip` is **Zoom's own client UI** — a Vue PWA (`manifest.json` → "Zoom Client", tagged `new_home_page_prod.universal.7.1.0.397`), rendered by the SDK's bundled Qt/CEF web view. This confirms a Chromium‑class renderer already ships in the SDK process, but it's Zoom's internal home page, **not** a repurposable stage surface. Mentioned only as context (and a long‑shot alternative — see §9).

---

## 4. Xvfb setup

Recommended server invocation (start it in `entry.sh` **before** Chromium and before the bot's capture loop):

```
Xvfb :99 -screen 0 1920x1080x24 -ac -nolisten tcp -dpi 96 +extension RANDR &
export DISPLAY=:99
export XDG_SESSION_TYPE=X11
```

- **Depth 24 is mandatory** — Chromium/Aura doesn't work at lower depths. Use `WxHx24`. ([chromium-dev thread](https://groups.google.com/a/chromium.org/g/chromium-dev/c/S6-oPBXWaUY))
- **`-dpi 96`** matches Chromium's assumed DPI (Xvfb defaults to 100); pair with `--force-device-scale-factor=1`. ([chromium-reviews](https://groups.google.com/a/chromium.org/g/chromium-reviews/c/8-jyeodvwbc))
- **Match `-screen 0 WxHx24` to Chromium `--window-size=W,H`** so the kiosk window exactly fills the framebuffer you capture.
- **Readiness:** Xvfb has no "ready" flag. Poll `xdpyinfo -display :99` in a retry loop before launching Chromium, or use the `xvfb-run -a --server-args="..."` wrapper which manages startup. ([mattzeunert](https://www.mattzeunert.com/2018/07/21/running-headful-chrome-on-ubuntu-server.html))
- **Optional, for cheaper capture:** `Xvfb :99 -shmem` (or `-fbdir <dir>`) points the framebuffer at shared memory / an mmap'd file so the capture loop can read it directly with no X round‑trip — an alternative to `XShmGetImage`. ([Xvfb man page](https://manpages.ubuntu.com/manpages/questing/en/man1/Xvfb.1.html))

---

## 5. The render‑command channel (Mac → Stage Page)

### 5.1 Docker networking facts that drive the choice

- **Docker Desktop for Mac:** the container reaches a server on the Mac at **`host.docker.internal`** (resolves to the host's internal IP) — no config, no published ports for the **container→host (outbound)** direction. ([Docker networking](https://docs.docker.com/desktop/networking/))
- **Plain Linux Docker:** `host.docker.internal` does **not** exist by default — add `--add-host=host.docker.internal:host-gateway` (Engine 20.10+) / Compose `extra_hosts: ["host.docker.internal:host-gateway"]`. **Bake this into `compose.yaml` now** so the same URL works on Mac Desktop and Linux. ([docker run reference](https://docs.docker.com/reference/cli/docker/container/run/))
- **Direction asymmetry:** container→host (outbound) needs no published ports and is portable; host→container needs `-p` and traverses the Desktop VM forwarding layer. **Prefer the container dialing out.**

### 5.2 Three architectures, and the recommendation

| | Where the page + commands live | Networking direction | Verdict |
|---|---|---|---|
| **(A) Mac serves page + WS; Chromium loads `host.docker.internal/stage`, page opens WS back to Mac** | Mac (brain) | **Outbound only** (portable) | ✅ **Recommended** |
| (B) Server *inside* the container serves page + WS; Mac pushes to it | Container | Inbound (`-p`, VM forwarding) or rebuilds (A) | ❌ Duplicate logic, image rebuilds, less portable |
| (C) Chromium `--remote-debugging-port`; Mac drives page via **CDP** (`Runtime.evaluate`/`Page.navigate`) | Browser internals | Inbound (publish debug port) | ⚠️ Powerful but a debug RPC, stringly‑typed, version‑coupled, unauthenticated‑RCE footgun |

**Choose (A).** It uses only the portable outbound direction, keeps **all** app logic on the Mac (the container ships only "Chromium pointed at a URL" — a true transport shim), and gives low‑latency **full‑duplex** push with a clean typed envelope + acks. The container needs ~50 lines of client JS (a WS client + a dispatcher/reducer) — the only code beyond the Mac server. **Keep CDP (C) as a *secondary ops* channel** (bind `--remote-debugging-port` to localhost *inside* the container for health checks, screenshots, "page crashed → reload" recovery) — but not as the render bus. ([CDP](https://chromedevtools.github.io/devtools-protocol/), [Page domain](https://chromedevtools.github.io/devtools-protocol/tot/Page/), [Runtime domain](https://chromedevtools.github.io/devtools-protocol/tot/Runtime/))

### 5.3 Transport: WebSocket

Full‑duplex, one persistent connection → lowest latency + lowest per‑message overhead, and the same socket carries acks/telemetry back. SSE is the runner‑up (one‑way push, free auto‑reconnect, but no clean return channel); HTTP polling is worst; `postMessage` is in‑browser only (useful to fan a received message out to iframes, not for Mac→container). ([WebSocket vs SSE vs polling](https://ably.com/blog/websockets-vs-sse))

> **Prior‑art note:** this is the **same pattern as OBS browser‑source overlays + `obs-websocket`** and **reveal.js multiplex** — a central server broadcasts state over WS; the browser page is a thin reducer that re‑renders. ([obs-websocket](https://github.com/obsproject/obs-websocket), [reveal multiplex](https://github.com/reveal/multiplex)) The repo also already has a **Unix‑domain‑socket IPC** (`/tmp/meeting.sock`, `src/util/SocketServer.{h,cpp}`); that's bot↔(local tooling) on Linux and is **not** a substitute for the Mac↔page channel, but it's evidence the codebase already does socket IPC.

### 5.4 Message schema sketch (discriminated‑union JSON over WS)

**Envelope (every message):**
```json
{ "v": 1, "id": "01HZ...ULID", "ts": "2026-06-28T17:04:00.123Z", "type": "show_text", "payload": { } }
```
`v` = protocol version · `id` = ULID/UUID (acks + idempotency) · `ts` = ISO‑8601 · `type` = op discriminator · `payload` = type‑specific.

**Commands (Mac → page):**
```json
{ "type":"show_text",  "payload": { "text":"## Welcome\nLet's begin.", "format":"markdown", "region":"main", "duration_ms":0 } }
{ "type":"show_image", "payload": { "source":"url",  "url":"http://host.docker.internal:8765/img/abc.png", "region":"main", "fit":"contain" } }
{ "type":"show_image", "payload": { "source":"data", "mime":"image/png", "data":"iVBORw0KGgo...", "region":"main", "fit":"cover" } }
{ "type":"show_generated_image", "payload": { "status":"pending|ready|error", "source":"url", "url":"...", "prompt":"a watercolor fox", "region":"main" } }
{ "type":"set_layout",   "payload": { "template":"split-2col", "regions": { "left":{"flex":1}, "right":{"flex":1} }, "theme":"dark" } }
{ "type":"update_status","payload": { "line":"Listening… (STT live)", "level":"info", "connection":"ok", "latency_ms":42 } }
{ "type":"clear",        "payload": { "scope":"region", "region":"main" } }
{ "type":"reset",        "payload": { "to":"idle" } }
```
- `format`: `plain|markdown`; `region` = named slot in the current layout; `duration_ms:0` = persist until replaced.
- **Prefer `source:"url"`** (Mac serves the asset, page fetches via `host.docker.internal`); reserve base64 `source:"data"` for ephemeral/generated images.
- `show_generated_image.status` lets one `id` update in place ("generating…" → swap to the final image).

**Return messages (page → Mac, same socket):**
```json
{ "type":"ack",   "payload": { "ref":"01HZ...ULID", "status":"applied|rejected|error", "applied_ts":"...", "error":"unknown region: foo" } }
{ "type":"hello", "payload": { "client":"stage-page", "page_v":"1.0.0", "viewport":{"w":1920,"h":1080}, "last_seen_id":"01HZ..." } }
```

**Ack strategy:** fire‑and‑forget the chatty ops (`update_status`); request acks for state‑changing ops (`set_layout`, `show_image`, `reset`) via an `"ack":true` envelope flag and match `ack.ref`→`id` with a timeout/retry. On (re)connect the page sends `hello`; the Mac replays current desired state; `id`‑based idempotency prevents double‑apply.

---

## 6. The minimal Stage web app

A single page the agent updates live — kept deliberately small and **2D‑only**:

- **A reducer over WS state.** On load: open `ws://host.docker.internal:<port>/ws`, send `hello`, then dispatch incoming messages to render functions. No routing, no SPA framework required (vanilla JS is enough; Vue/React/Svelte are fine if preferred).
- **A layout shell with named regions** (`main`, `left`, `right`, a persistent `status` bar) so commands target slots (`region` field). `set_layout` swaps the template/theme.
- **Renderers:** `show_text` (render markdown → sanitized HTML), `show_image`/`show_generated_image` (`<img>` with `fit: contain|cover`, plus a "generating…" placeholder for `pending`), `update_status` (a low, always‑visible diagnostics line), `clear`/`reset`.
- **Design for capture:** fixed viewport = the Xvfb resolution; dark theme (`#181818`‑ish, matching Zoom) reads well in a share; large, high‑contrast type (it'll be re‑encoded by Zoom — see §7); avoid rapid full‑frame animation (it defeats damage‑based capture and burns Rosetta CPU). CSS transitions are fine; WebGL/Three.js is **not** recommended (see §3.2/§8).
- **Resilience:** auto‑reconnect the WS with backoff; on reconnect re‑`hello` so the Mac restores state. Optionally a heartbeat so the Mac knows the page is alive.

---

## 7. Resolution / DPI / framerate / latency

### 7.1 Resolution & DPI

- **Start at 1280×720, depth 24** for a text/diagnostics stage — plenty for legible content and the lightest Rosetta CPU load. Go **1920×1080** only if you need denser layouts; it's ~2.25× the per‑frame conversion work (§7.3).
- Keep **all three sizes equal:** `Xvfb -screen 0 1280x720x24` == Chromium `--window-size=1280,720` == the I420 frame `W×H`. Mismatches cause black borders or scaling.
- **DPI/scale:** `Xvfb -dpi 96` + `--force-device-scale-factor=1` for predictable 1:1 rendering. If text looks too small at 1080p, bump `--force-device-scale-factor=1.25/1.5` (it scales crisply at render time) rather than changing resolution. ([force-device-scale-factor](https://issues.chromium.org/issues/40210045/resources))
- Zoom re‑encodes the share, so don't over‑invest in resolution; **legibility (font size/contrast) matters more than pixel count.** Recall.ai's share guidance (cited in SCREENSHARE §6) recommends **10–30 fps** for share content.

### 7.2 Framerate, latency & tearing

- **Capture cadence: ~10–15 fps is ample** for a slide/dashboard. Better: **damage‑driven** — capture+convert+send only when the page actually changes (XDamage; GStreamer's `ximagesrc use-damage` does exactly this), plus a **low‑rate keepalive frame (~1/s)** so late joiners get a full frame and Zoom's stream stays alive. ([XComposite/XDamage](https://download.nvidia.com/XFree86/Linux-x86_64/435.17/README/xcompositeextension.html))
- **End‑to‑end latency budget** (render cmd → visible in share): WS push (~ms) → browser paints next frame (~16–100 ms) → next capture tick picks it up (≤ one capture period, e.g. ~67 ms @15 fps) → BGRA→I420 (low‑single‑digit ms) → `sendShareFrame` → **Zoom's own encode/network (the dominant term, typically a few hundred ms)**. Realistically **sub‑second**, dominated by Zoom, not by capture. For a status/diagnostics display this is fine.
- **Tearing / double‑buffering:** Xvfb has **no vsync**, so capturing mid‑paint can tear. Mitigations, in order of effort: (1) for a mostly‑static page, updates are rare so tearing is rarely visible — often acceptable; (2) **capture on XDamage after the damage region settles**; (3) **XComposite redirect** Chromium's window to an off‑screen pixmap and capture that (clean, atomic frames) — the OBS "XComposite" path. ([XComposite offscreen pixmaps](https://download.nvidia.com/XFree86/Linux-x86_64/435.17/README/xcompositeextension.html), [x11mirror-client](https://github.com/gh0stwizard/x11mirror-client))

### 7.3 Capture/convert cost (the only meaningful per‑frame CPU)

- **XShm capture on Xvfb ≈ free** (RAM‑to‑RAM, no GPU readback).
- **BGRA→I420 conversion** is the real cost — O(W·H), output `W·H·3/2` bytes: 1280×720 ≈ 0.92 MP→1.38 MB/frame; 1920×1080 ≈ 2.07 MP→3.11 MB/frame. With SIMD it's low‑single‑digit ms/frame at 720p natively — **but under Rosetta, x86 SIMD may be emulated/scalar and run several× slower.** Prefer **libyuv `ARGBToI420`** (Chromium/WebRTC's converter; fuses convert+subsample in one pass; note libyuv "ARGB" == BGRA‑in‑memory, matching XShm output) over OpenCV for the hot loop, though OpenCV `cv::cvtColor(..., COLOR_BGRA2YUV_I420)` (already a repo dependency) is adequate at 720p/low‑fps. ([libyuv](https://chromium.googlesource.com/libyuv/libyuv/), [OpenCV color conversions](https://docs.opencv.org/4.x/de/d25/imgproc_color_conversions.html))
- **Cheap‑keeping tips:** lower fps; capture only on damage; downscale during conversion (libyuv fuses scale+convert); reuse one persistent XShm segment (no per‑frame alloc); build SIMD‑native libyuv/OpenCV for the actual deployment arch.

---

## 8. Rosetta / amd64 caveats (the biggest risk)

The Meeting SDK is **x86_64‑only — there is no native ARM64 Linux build** (SCREENSHARE §5), so on Apple Silicon the whole container runs amd64 under Rosetta, and that constraint is fixed. Adding Chromium adds the **most emulation‑fragile component** in the stack:

- **🔴 Documented, unresolved: the headed Chromium GPU process dies under Rosetta.** On Apple Silicon Docker Desktop, headed x86_64 Chromium logs `Failed to open file: /run/rosetta/rosetta`, `Exiting GPU process due to errors during initialization`, `ContextResult::kTransientFailure`, and shows "Page Unresponsive" — while the **same image works on Intel Macs and AWS Lambda**, isolating the cause to Rosetta's GPU‑process path. No resolution in the thread. ([docker/for-mac#7552](https://github.com/docker/for-mac/issues/7552))
  - **Primary mitigation (this design's whole point): keep the stage 2D and run `--disable-gpu`** so there *is* no GPU process to die. For text/diagnostics/images this loses nothing.
  - If WebGL is unavoidable: try `--in-process-gpu` (runs GPU code in the browser process), accept higher fragility, and budget time. Both llvmpipe (SIMD/JIT) and SwiftShader (JIT in the GPU process) are exactly the dynamically‑generated x86 code Rosetta translates least reliably.
- **General amd64‑under‑Rosetta instability:** reports of containers pinning **100% CPU / hanging** and **segfaults** in amd64 containers. Rosetta is ~4–5× faster than QEMU, but the standing advice is **"don't run amd64 if you can run native arm64."** Here you can't (the SDK forces amd64), so harden for it: conservative resolution/fps, `--disable-gpu`, watchdog/restart on the Chromium process. ([for-mac#6998](https://github.com/docker/for-mac/issues/6998), [for-mac#6773](https://github.com/docker/for-mac/issues/6773), [ddev on Rosetta](https://ddev.com/blog/amd64-with-rosetta-on-macos/))
- **CPU headroom:** Chromium + Xvfb + per‑frame I420 conversion + the SDK's own encode all run emulated on the same cores. Keep the stage static‑ish, 720p, ≤15 fps, damage‑driven; measure container CPU under Rosetta before scaling up.
- **Mitigation roadmap if Rosetta proves too fragile:** because the SDK is the only amd64‑locked piece, a future option is to **split** — run the Stage Page Chromium + capture in a **native arm64** sidecar (Debian `chromium` is arm64) and feed I420 frames to the amd64 SDK container over a socket. More moving parts; only if needed. (Noted in §9.)

---

## 9. Gaps & open questions

1. **🔴 Inherited from SCREENSHARE: does raw `sendShareFrame` actually render on v7.1.0?** The capture→raw‑push design lives or dies on the same blank‑frame question. **Resolve via SCREENSHARE's spike (push a static test card, verify a 2nd participant sees it) *before* building the Chromium/capture pipeline.** If it fails, fall back to §2.3 (`StartMonitorShare` of `:99`).
2. **🔴 Rosetta GPU‑process death ([for-mac#7552]).** Confirmed for *headed* Chromium under Rosetta. The 2D/`--disable-gpu` plan should sidestep it, but **this is unverified for this exact image/SDK combo** — prove that headed Chromium with `--disable-gpu` stays up on `:99` under Rosetta as an early checkpoint.
3. **Tearing vs. effort.** Will plain XShm full‑screen capture tear visibly for the actual content cadence, or is XComposite‑offscreen needed? Unknown until measured; start simple (XShm + damage), escalate to XComposite only if tearing shows.
4. **libyuv vs OpenCV.** libyuv isn't a current repo dependency; OpenCV is. Is OpenCV `cvtColor` fast enough at the target res/fps under Rosetta, or is adding libyuv worth it? Measure before adding a dependency.
5. **Exact resolution/fps sweet spot under Rosetta.** 1280×720@15 is the proposed default; the real CPU ceiling (Chromium + convert + SDK encode, emulated) needs measurement.
6. **WebGL need.** Does any planned "generated visual" require WebGL/3D (e.g. data‑viz with Three.js)? If yes, the safe `--disable-gpu` path is off the table and §8's high‑risk software‑GL path applies — decide early.
7. **Mac‑side server scope.** This doc specifies the container/page side; the **Mac WebSocket+asset server is assumed to exist** (part of the orchestrator) and is out of scope here. Confirm who owns it and that it serves both `/stage` (page assets) and `/ws` (commands) + generated images.
8. **`compose.yaml` portability.** Add `extra_hosts: ["host.docker.internal:host-gateway"]` so the same URL works on Linux Docker, not just Desktop. (Untested in this repo.)
9. **/dev/shm sizing.** `--disable-dev-shm-usage` avoids the 64 MB‑shm crash, but if perf suffers consider `--shm-size=1g` in compose instead. Untested here.
10. **Process supervision.** Xvfb + Chromium + the bot are now three long‑lived processes in one container; `entry.sh` currently backgrounds helpers manually. A supervisor (or robust bash with health‑checks/restarts) is likely needed but un‑designed.
11. **Reusing the SDK's embedded CEF (long shot).** Could the SDK's bundled web runtime (the `new_home_page` Qt/CEF view, §3.3) be repurposed to render the stage instead of a separate Chromium? Almost certainly not exposed/supported, but it would eliminate a whole browser if it were. Unverified.
12. **Audio.** Out of scope here; if the stage should also play audio into the share, see SCREENSHARE's `IZoomSDKShareAudioSource` notes — not re‑researched.

---

## 10. Recommended next steps (sequencing)

1. **Gate on SCREENSHARE first.** Run SCREENSHARE's raw‑share (A) visibility spike. If a 2nd participant can't see a static test card on v7.1.0, stop and resolve that (or commit to §2.3) before any Chromium work.
2. **Prove Chromium‑on‑Xvfb under Rosetta.** Add `xvfb` + `google-chrome-stable` to the Dockerfile; start `Xvfb :99` + a `--kiosk --disable-gpu` Chromium on a static local HTML page in `entry.sh`; confirm it **stays up** (checkpoint for gap #2) — e.g. periodically `XShmGetImage` `:99` and dump a PNG.
3. **Wire capture → existing share source.** Replace the OpenCV‑drawn frame in SCREENSHARE's `ZoomSDKShareSource` producer with an XShm grab of `:99` → I420 → `sendShareFrame`. Verify the participant now sees the static page.
4. **Add the command channel.** Stand up the Mac `/stage` + `/ws` server (or stub), point Chromium at `http://host.docker.internal:<port>/stage`, implement the §5.4 schema + page reducer, and drive `show_text`/`show_image`/`update_status` live.
5. **Optimize only if needed:** damage‑driven capture, XComposite (if tearing), libyuv (if convert is the bottleneck), resolution/fps tuning under measured Rosetta CPU.

> Defer XComposite, libyuv, WebGL/software‑GL, and the arm64‑sidecar split until measurement forces them.

---

## 11. Sources (cited inline above)

**Chromium in Docker / kiosk / flags**
- [stablebuild — Chromium in Ubuntu Docker (snap caveat)](https://www.stablebuild.com/blog/install-chromium-in-an-ubuntu-docker-container) · [computingforgeeks — install Google Chrome](https://computingforgeeks.com/install-google-chrome-ubuntu/) · [baeldung — Docker headless Chrome](https://www.baeldung.com/ops/docker-google-chrome-headless) · [chrome dep list gist](https://gist.github.com/ipepe/94389528e2263486e53645fa0e65578b)
- [kiosk flag set gist](https://gist.github.com/lellky/673d84260dfa26fa9b57287e0f67d09e) · [alpine-chrome (sandbox/dev-shm)](https://github.com/jlandure/alpine-chrome) · [crbug 41150021 — crash bubble](https://issues.chromium.org/issues/41150021) · [Ozone overview](https://chromium.googlesource.com/chromium/src/+/lkgr/docs/ozone_overview.md) · [force-device-scale-factor](https://issues.chromium.org/issues/40210045/resources)

**Software GL / WebGL**
- [Chromium SwiftShader docs](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/docs/gpu/swiftshader.md) · [Intent to Remove: SwiftShader WebGL fallback](https://groups.google.com/a/chromium.org/g/blink-dev/c/yhFguWS_3pM) · [crbug 40277080](https://issues.chromium.org/issues/40277080) · [llvmpipe vs SwiftShader benchmark](https://botbrowser.io/en/blog/mesa-llvmpipe-vs-swiftshader-chromium-linux/)

**Xvfb**
- [Xvfb man page (depth, -shmem, -fbdir)](https://manpages.ubuntu.com/manpages/questing/en/man1/Xvfb.1.html) · [chromium-dev — depth 24 requirement](https://groups.google.com/a/chromium.org/g/chromium-dev/c/S6-oPBXWaUY) · [chromium-reviews — DPI](https://groups.google.com/a/chromium.org/g/chromium-reviews/c/8-jyeodvwbc) · [mattzeunert — headful Chrome on Xvfb](https://www.mattzeunert.com/2018/07/21/running-headful-chrome-on-ubuntu-server.html)

**X11 capture → I420**
- [X.Org MIT-SHM / XShm](https://www.x.org/releases/X11R7.7/doc/xextproto/shm.html) · [NVIDIA XComposite README (offscreen pixmaps, Damage)](https://download.nvidia.com/XFree86/Linux-x86_64/435.17/README/xcompositeextension.html) · [x11mirror-client (Composite/Damage/Render capture)](https://github.com/gh0stwizard/x11mirror-client) · [ffmpeg devices (x11grab, bgr0/yuv420p)](https://ffmpeg.org/ffmpeg-devices.html) · [ffmpeg xcbgrab.c (MIT-SHM)](https://github.com/FFmpeg/FFmpeg/blob/master/libavdevice/xcbgrab.c) · [OpenCV color conversions](https://docs.opencv.org/4.x/de/d25/imgproc_color_conversions.html) · [libyuv (Google)](https://chromium.googlesource.com/libyuv/libyuv/) · [ARM libyuv optimization case study](https://developer.arm.com/documentation/110065/latest/Optimization-case-studies/libyuv)

**Render channel / Docker networking / prior art**
- [Docker Desktop networking (host.docker.internal)](https://docs.docker.com/desktop/networking/) · [docker run reference (--add-host host-gateway)](https://docs.docker.com/reference/cli/docker/container/run/) · [CDP overview](https://chromedevtools.github.io/devtools-protocol/) · [CDP Page domain](https://chromedevtools.github.io/devtools-protocol/tot/Page/) · [CDP Runtime domain](https://chromedevtools.github.io/devtools-protocol/tot/Runtime/) · [WebSockets vs SSE (Ably)](https://ably.com/blog/websockets-vs-sse) · [obs-websocket](https://github.com/obsproject/obs-websocket) · [OBS browser source](https://obsproject.com/kb/browser-source) · [reveal.js multiplex](https://github.com/reveal/multiplex)

**Rosetta / amd64**
- [docker/for-mac#7552 — headed Chromium GPU process dies under Rosetta](https://github.com/docker/for-mac/issues/7552) · [for-mac#6998 — 100% CPU/hang](https://github.com/docker/for-mac/issues/6998) · [for-mac#6773 — segfaults](https://github.com/docker/for-mac/issues/6773) · [ddev — amd64 with Rosetta on macOS](https://ddev.com/blog/amd64-with-rosetta-on-macos/)

**Companion (this repo)**
- [`SCREENSHARE_RESEARCH.md`](./SCREENSHARE_RESEARCH.md) — the share/transport side this document feeds.
