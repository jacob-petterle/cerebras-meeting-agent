# Screen Sharing from the Headless Linux Zoom Bot — Research & Findings

**Status:** Research only. No feature code in this document is meant to be merged as‑is — the "Implementation sketch" is a plan, not working code.
**Repo:** `meetingsdk-headless-linux-sample` (C++ Zoom Meeting SDK for Linux, headless in Docker, amd64 under Rosetta on Apple Silicon).
**SDK:** Zoom Meeting SDK for Linux **v7.1.x** (x86_64 build in `lib/zoomsdk/`).
**Author of findings:** grounded in the actual headers under `lib/zoomsdk/h/` plus web/forum research (sources at the end).

---

## 1. Executive summary & recommended approach

**Yes — the Linux Meeting SDK supports a headless bot *sending* a screen share, and it exposes two distinct mechanisms:**

| Mechanism | Header / entry point | What it shares | Headless‑friendly? |
|---|---|---|---|
| **(A) Raw / external share source** | `GetRawdataShareSourceHelper()->setExternalShareSource(...)` in `rawdata/rawdata_share_source_helper_interface.h` | Frames *you* push programmatically (I420/YUV) — no real screen needed | ✅ **Yes** — analogous to the external video (camera) source the repo already references |
| **(B) Desktop / application share** | `IMeetingShareController::StartMonitorShare()` / `StartAppShare()` in `meeting_service_components/meeting_sharing_interface.h` | An actual X11 monitor/window the SDK captures | ⚠️ Requires a **real, running X display** (Xvfb) for the SDK to grab pixels from |

**Recommendation: spike approach (A) first — but treat one known risk as the thing to validate before committing.** For a triage bot whose job is to *display generated content* (rendered text, diagnostics, a status image), approach (A) is architecturally the right call: it's dramatically simpler and more maintainable than spinning up an X server, rendering into it, and asking the SDK to screen‑grab it. It is the exact send‑side analogue of the external **video** source this project already has a stub for (`src/raw_send/ZoomSDKVideoSource.{h,cpp}`), needs no GL/EGL/GBM surface and no X display, and the API is confirmed present in our v7.1.0 headers.

> ### ⚠️ Critical risk to validate first (from forum/third‑party research, §6)
> Multiple developers report that on the **Linux** Meeting SDK, the raw share path "succeeds" — `setExternalShareSource` returns OK, `onStartSend` fires, `sendShareFrame` returns `SDKERR_SUCCESS` — yet **participants see a blank "Bot has started screen sharing" surface with no frames.** This was reported unresolved on v6.4.6 / v6.5.5 / v6.5.10; **its status on our v7.1.0 is unconfirmed.** Recall.ai's analysis attributes the blank view to meeting policy / an existing active share / UI layout rather than the API call order — i.e. it's often fixable with correct setup, not necessarily a hard SDK defect. There are also two related gotchas: **(1)** v7.0.0 made the `onStartSend` callback **asynchronous** (don't block in it), and **(2)** the raw share path returns `SDKERR_UNKNOWN(13)` in **webinars** (works in regular meetings). See §5–§6.

**So the plan is: build approach (A) (it's ~1 class + ~30 lines, mirroring the existing video‑source block), and in the same spike verify a second participant actually sees the frames on v7.1.0.** If the spike confirms frames render, ship (A). If it reproduces the blank‑frame bug and it can't be cleared by fixing share policy / stopping other shares / honoring the async callback, fall back to **approach (B)**.

**Approach (B)** (render to Xvfb, then `StartMonitorShare`) is the documented fallback and the only option if you must mirror a *real* desktop/app the bot drives (e.g., a browser). It is heavier: it requires Xvfb (which **this repo does not currently start** — see §4), the finicky Linux device‑name string format, and carries more Rosetta risk. Note its "reliability" advantage is partly inferential — Xvfb itself is battle‑tested, but *the Zoom Linux SDK capturing an Xvfb display headless* is not something the research could prove with a working public example either.

**Bottom line for the triage‑bot use case:** render your content to an in‑memory bitmap (OpenCV is already a dependency), convert BGR→I420, and feed it through a `ZoomSDKShareSource` modeled on the existing `ZoomSDKVideoSource` — then *immediately verify visibility* with a real second participant before building anything on top of it.

---

## 2. The exact SDK API surface (verified against `lib/zoomsdk/h/`)

There are two cooperating header families. **Raw share send** is driven by the *rawdata share source helper*; the *meeting share controller* is used for status/permission/stop and for desktop/app capture.

### 2A. Raw / external share source — `rawdata/rawdata_share_source_helper_interface.h`

The whole send path lives in this one header (full file is ~100 lines). Key declarations:

```cpp
// Pushes one frame of share content. YUV (I420) by default.
class IZoomSDKShareSender {
public:
    virtual SDKError sendShareFrame(char* frameBuffer,
                                    int width, int height, int frameLength,
                                    FrameDataFormat format = FrameDataFormat_I420_FULL) = 0;
};

// You implement this. The SDK calls onStartSend with a sender you keep a pointer to.
class IZoomSDKShareSource {
public:
    virtual void onStartSend(IZoomSDKShareSender* pSender) = 0;  // begin pushing frames
    virtual void onStopSend() = 0;                                // stop / tear down
};

// Optional: share computer-audio-style audio alongside the visual share.
class IZoomSDKShareAudioSender {
public:
    virtual SDKError sendShareAudio(char* data, unsigned int data_length,
                                    int sample_rate, ZoomSDKAudioChannel channel) = 0;
};
class IZoomSDKShareAudioSource {
public:
    virtual void onStartSendAudio(IZoomSDKShareAudioSender* pShareAudioSender) = 0;
    virtual void onStopSendAudio() = 0;
};

// The helper that actually starts the external share.
class IZoomSDKShareSourceHelper {
public:
    // Starts sharing an external (user-supplied) visual source; optional audio source.
    virtual SDKError setExternalShareSource(IZoomSDKShareSource* pShareSource,
                                            IZoomSDKShareAudioSource* pShareAudioSource = nullptr) = 0;
    // Starts sharing a pure external audio source (like "share computer audio").
    virtual SDKError setSharePureAudioSource(IZoomSDKShareAudioSource* pShareAudioSource) = 0;
};
```

You obtain the helper from the free function in `rawdata/zoom_rawdata_api.h`:

```cpp
extern "C" {
    SDK_API bool                       HasRawdataLicense();
    SDK_API IZoomSDKShareSourceHelper* GetRawdataShareSourceHelper();   // <-- this one
    SDK_API IZoomSDKVideoSourceHelper* GetRawdataVideoSourceHelper();   // (camera source, for comparison)
    SDK_API IZoomSDKAudioRawDataHelper* GetAudioRawdataHelper();
    // ...
}
```

**Frame format** (`enum FrameDataFormat` in `zoom_sdk_def.h:504`):
```cpp
enum FrameDataFormat {
    FrameDataFormat_I420_LIMITED,
    FrameDataFormat_I420_FULL,   // default for sendShareFrame
};
```
So frames are **I420 (planar YUV 4:2:0)**. For width `W` and height `H`, an I420 buffer length is `W*H + 2*((W+1)/2)*((H+1)/2)` ≈ `W*H*3/2`. That value is what you pass as `frameLength`.

**Call sequence (raw external share):**
1. Be in a meeting (`MEETING_STATUS_INMEETING`).
2. `auto* helper = GetRawdataShareSourceHelper();`
3. `helper->setExternalShareSource(myShareSource /*, myAudioSource (optional)*/);` — this *initiates* the raw share (per the header's doc comment "Starts sharing external source").
4. SDK fires `myShareSource->onStartSend(IZoomSDKShareSender* pSender)` — store `pSender`. **⚠️ As of v7.0.0 this callback is asynchronous** (forum changelog, §6): do **not** block inside it and do **not** push frames before it has fired. Signal a separate producer thread instead.
5. On your own cadence (e.g., a timer/thread at N fps), build an I420 buffer and call `pSender->sendShareFrame(buf, w, h, len, FrameDataFormat_I420_FULL)`. A `SDKERR_SUCCESS` return means *the SDK accepted the buffer*, **not** that participants are seeing it (see the blank‑frame risk in §1/§6) — verify visually.
6. To stop: `GetMeetingShareController()->StopShare()` (and/or stop pushing frames); SDK fires `onStopSend()`.

> This mirrors the **external video source** flow already present in the repo (`setExternalVideoSource` → `onInitialize`/`onStartSend` → `IZoomSDKVideoSender::sendVideoFrame`). The share equivalent is simpler — `onStartSend` directly hands you the sender, with no capability negotiation step.

### 2B. Meeting share controller — `meeting_service_components/meeting_sharing_interface.h`

Obtained via `IMeetingService::GetMeetingShareController()` (declared in `meeting_service_interface.h:1119`). This controller is what you use for **status events, permission checks, stopping, and desktop/app capture**.

**Methods available on Linux** (i.e., *not* behind `#if defined(WIN32)`):

```cpp
class IMeetingShareController {
public:
    virtual SDKError SetEvent(IMeetingShareCtrlEvent* pEvent) = 0;

    // ----- Desktop / application capture (approach B) -----
    virtual SDKError StartAppShare(HWND hwndSharedApp) = 0;
    virtual SDKError StartMonitorShare(const zchar_t* monitorID) = 0;

    // ----- Lifecycle / control (work with raw share too) -----
    virtual SDKError IsSupportAdvanceShareOption(AdvanceShareOption option_) = 0;
    virtual SDKError StopShare() = 0;
    virtual SDKError LockShare(bool isLock) = 0;             // deprecated → SetMultiShareSettingOptions
    virtual SDKError PauseCurrentSharing() = 0;
    virtual SDKError ResumeCurrentSharing() = 0;

    // ----- Introspection / permissions -----
    virtual IList<unsigned int>* GetViewableSharingUserList() = 0;
    virtual IList<ZoomSDKSharingSourceInfo>* GetSharingSourceInfoList(unsigned int userID) = 0;
    virtual bool   CanStartShare() = 0;                      // deprecated → CanStartShare(reason)
    virtual bool   CanStartShare(CannotShareReasonType& reason) = 0;
    virtual bool   IsDesktopSharingEnabled() = 0;
    virtual SDKError IsShareLocked(bool& bLocked) = 0;

    // ----- Multi-share / audio-share settings -----
    virtual SDKError SetMultiShareSettingOptions(MultiShareOption shareOption) = 0;
    virtual SDKError GetMultiShareSettingOptions(MultiShareOption& shareOption) = 0;
    virtual SDKError EnableShareComputerSound(bool bEnable) = 0;
    virtual SDKError SetAudioShareMode(AudioShareMode mode) = 0;
    // ... (camera-switch, optimize-for-video-clip, CanShareVideoFile, etc.)
};
```

> ⚠️ **Windows‑only methods (do NOT exist on Linux):** `StartShareFrame()`, `StartWhiteBoardShare()`, `StartShareCamera()`, `StartVideoFileShare()`, `ShowSharingAppSelectWnd()`, `StartAirPlayShare()`, `IsShareAppValid()`, `BlockWindowFromScreenshare()`, `ShowShareOptionDialog()`, BO‑share methods, white‑board legal‑notice getters. They are all inside `#if defined(WIN32)` blocks in the header. On Linux you have `StartAppShare`, `StartMonitorShare`, and the raw external share path — that's it for *starting* a share.

**Linux monitor/app device‑name format** (from the header doc on `StartMonitorShare`/`StartAppShare`):
```
hostname:display_number-screen_number(x, y, width, height)-winid
e.g.  :0-0(0,0,1920,1080)-34563456
```
i.e. it expects a real X11 `display:screen` plus geometry and a window/app id. This is the crux of why approach (B) needs a live X server.

**Share status event interface — `IMeetingShareCtrlEvent`:**
```cpp
class IMeetingShareCtrlEvent {
public:
    virtual void onSharingStatus(ZoomSDKSharingSourceInfo shareInfo) = 0;     // begin/end/pause/resume
    virtual void onFailedToStartShare() = 0;                                  // <-- watch this
    virtual void onShareContentNotification(ZoomSDKSharingSourceInfo shareInfo) = 0; // finalized content type
    virtual void onShareSettingTypeChangedNotification(ShareSettingType type) = 0;
    virtual void onMultiShareSwitchToSingleShareNeedConfirm(IShareSwitchMultiToSingleConfirmHandler* handler) = 0;
    virtual void onLockShareStatus(bool bLocked) = 0;                         // deprecated
    virtual void onSharedVideoEnded() = 0;
    virtual void onVideoFileSharePlayError(ZoomSDKVideoFileSharePlayError error) = 0;
    virtual void onOptimizingShareForVideoClipStatusChanged(ZoomSDKSharingSourceInfo shareInfo) = 0;
};
```

**Relevant enums (in `zoom_sdk_def.h` unless noted):**
- `enum SharingStatus` (`:561`): `Sharing_Self_Send_Begin`, `Sharing_Self_Send_End`, `Sharing_Self_Send_Pure_Audio_Begin/End`, `Sharing_Other_Share_Begin/End`, `Sharing_Pause`, `Sharing_Resume`, …
- `enum ShareType` (`:420`): `SHARE_TYPE_AS` (application), `SHARE_TYPE_DS` (desktop), `SHARE_TYPE_DATA` (data — what a raw/external source typically reports), `SHARE_TYPE_FRAME`, `SHARE_TYPE_VIDEO_FILE`, `SHARE_TYPE_CAMERA`, `SHARE_TYPE_COMPUTER_AUDIO`, …
- `enum CannotShareReasonType` (`:526`): `_None`, `_Locked`, `_Disabled`, `_Other_Screen_Sharing`, `_Need_Grab_*`, `_Reach_Maximum`, … — returned by `CanStartShare(reason)`.
- `enum FrameDataFormat` (`:504`): `FrameDataFormat_I420_LIMITED`, `FrameDataFormat_I420_FULL`.
- `enum ZoomSDKAudioChannel` (`:515`): `ZoomSDKAudioChannel_Mono`, `ZoomSDKAudioChannel_Stereo`.
- `enum ShareSettingType` / `enum MultiShareOption` (in `meeting_sharing_interface.h`): control the "only host can share" / grab / multi‑share policies (see §3).

---

## 3. Permissions & meeting constraints

What the headers tell us, plus forum/doc confirmation (§6):

- **Host/co‑host is NOT inherently required to share.** Whether a non‑host participant can share is governed by the meeting's share setting:
  - `ShareSettingType_LOCK_SHARE` — "**Only host can share**" (a.k.a. lock share). If set, a participant bot **cannot** start a share until the host unlocks it or promotes the bot.
  - `ShareSettingType_HOST_GRAB` / `ShareSettingType_ANYONE_GRAB` — one share at a time; starting a new share grabs/replaces the current one.
  - `ShareSettingType_MULTI_SHARE` — multiple simultaneous shares allowed.
  - The corresponding host‑side control is `MultiShareOption` (`Enable_Multi_Share`, `Enable_Only_HOST_Start_Share`, `Enable_Only_HOST_Grab_Share`, `Enable_All_Grab_Share`) via `SetMultiShareSettingOptions()`.
- **Always gate on `CanStartShare(CannotShareReasonType& reason)`** before attempting a share. If it returns false with `_Locked`/`_Disabled`, the bot needs host/co‑host or a settings change. `IsDesktopSharingEnabled()` is a coarser pre‑check.
- **`onFailedToStartShare()`** fires if the start is rejected — wire it and log the reason.
- **Single‑share semantics:** under the default (non‑multi) policy, the bot starting a share will *grab* (take over) the current share, or be blocked, depending on `HOST_GRAB` vs `ANYONE_GRAB`. If a human is presenting, the bot could steal the floor — consider checking `GetViewableSharingUserList()` first.
- **Waiting room:** irrelevant to sharing per se — the bot must already be admitted and `MEETING_STATUS_INMEETING`. Sharing calls before then return `SDKERR_WRONG_USAGE`.
- **Raw data license / privilege:** raw *send* paths are part of the SDK's raw‑data feature set (`HasRawdataLicense()` exists alongside `GetRawdataShareSourceHelper()`). This repo already obtains **local recording privilege** before doing raw work (`CanStartRawRecording()` / `RequestLocalRecordingPrivilege()` in `Zoom.h`'s `onJoin`). **Open question (see §8):** confirm whether raw *share sending* specifically requires the same recording privilege/entitlement, or only the meeting share permission. Treat it as "likely needs the raw‑data entitlement your account already has for recording" until confirmed.

---

## 4. Headless specifics (Xvfb, GL/EGL/GBM, the current container)

**Important correction to the project's stated assumptions:** despite the task brief mentioning an Xvfb `:99` display, **`bin/entry.sh` in this repo does *not* start Xvfb or any X server.** It only sets up D‑Bus + PulseAudio (virtual `SpeakerOutput` sink) and then builds and runs the binary. The project *links* X11 (`find_package(X11 REQUIRED)` in `CMakeLists.txt`, `libx11-dev`/`libx11-xcb1` in the `Dockerfile`) because the SDK's shared lib has X11 symbol dependencies — but there is **no live X display** in the running container today. Raw audio/video *receive* and the external‑video *send* path work without one.

Consequences:

- **Approach (A), raw external share: needs NO X display, NO GL/EGL/GBM surface.** You build I420 buffers in memory and call `sendShareFrame`. This is the headless‑safe path and requires **no Dockerfile changes**. (The image already has `libgl1`, `libgbm1`, `libgl1-mesa-dri` present, but the raw send path doesn't exercise them.)
- **Approach (B), monitor/app share: needs a real X display.** `StartMonitorShare`/`StartAppShare` take a Linux device string like `:0-0(0,0,1920,1080)-winid` — the SDK literally screen‑grabs an X11 monitor/window. To use it headless you would have to:
  1. Add `xvfb` (and likely a window manager + the app you want to show) to the `Dockerfile`.
  2. Start `Xvfb :99 -screen 0 1920x1080x24` and `export DISPLAY=:99` in `entry.sh` *before* the SDK initializes. Research also indicates the SDK's capture path expects an **X11** session — set `XDG_SESSION_TYPE=X11` (the SDK does not reliably support Wayland capture).
  3. Render your content into that display, then pass the matching device string (`:99-0(0,0,1920,1080)-winid`) to `StartMonitorShare`.
  This is materially more moving parts and more failure modes — another reason to prefer (A).
- **Rosetta / amd64 emulation risk:** the project is built `x86_64` and runs under Rosetta on Apple Silicon. Raw share avoids GPU/GL paths entirely (pure CPU memcpy + the SDK's own I420 encode), so it's the *lowest‑risk* path under emulation. The main cost is CPU: per‑frame BGR→I420 conversion and the SDK's encode run on emulated x86 — keep resolution/fps modest (e.g., 1280×720 @ 5–10 fps for a text/diagnostics display is plenty). Approach (B) under Rosetta is riskier: Xvfb + Mesa software GL under emulation is slow and more likely to hit driver/EGL edge cases. (Note: the Meeting SDK is x86_64‑only — there is **no native ARM64 Linux build** — so Rosetta is unavoidable on Apple Silicon regardless of approach.)

### Enabling Xvfb for approach (B) — what it would actually take

The good news: **most of the X11 plumbing is already in the image.** The `Dockerfile` already installs the exact libraries an X11 screen‑grabber uses — `libxcb-shm0`, `libxcb-image0`, `libxcb-xfixes0`, `libxcb-randr0`, `libx11-xcb1`, plus `libgl1`/`libgbm1`/`libgl1-mesa-dri`. That strongly implies the SDK captures via **XShm** and that the *only* missing piece is a running X server. Concretely:

1. **`Dockerfile` — add the X virtual framebuffer server (it is NOT currently installed):**
   - `xvfb` (provides the `Xvfb` binary), and usually `x11-xserver-utils` + `x11-utils` (for `xset`, `xwininfo`/`xdpyinfo` to discover window/screen geometry).
   - If you intend to share a *window* (`StartAppShare`) rather than the whole virtual screen, add a lightweight window manager (`openbox` or `fluxbox`) and whatever app renders your content (e.g., a headful Chromium if you render HTML). For whole‑screen capture (`StartMonitorShare` of `:99` screen 0) a WM is usually unnecessary.
2. **`bin/entry.sh` — start Xvfb before the SDK initializes** (it currently only sets up D‑Bus + PulseAudio):
   - `Xvfb :99 -screen 0 1920x1080x24 &` then `export DISPLAY=:99` and `export XDG_SESSION_TYPE=X11`.
   - Wait for readiness (poll `xdpyinfo -display :99` until it succeeds) before launching `zoomsdk`.
   - Start your content renderer into `:99` (and a WM if used).
3. **Render something onto `:99`** — this is the part that has no analogue today. The bot must run *some* X client that draws the diagnostics you want shared (an HTML page in headful Chromium, a Qt/GTK app, or a simple X drawing program). Whatever is on that virtual screen is what participants will see.
4. **In code — call the capture API with the Linux device string.** Per the header, `StartMonitorShare` wants `:99-0(0,0,1920,1080)-winid` and `StartAppShare` wants the app variant. **Discovering the right `winid`/geometry is the fiddly part** — you'll likely enumerate it via X (`xwininfo`/Xlib) or the SDK's own monitor enumeration. Getting this string wrong is a common cause of failed/blank desktop shares.
5. **Gate on `CanStartShare(reason)`** and watch `onFailedToStartShare()` exactly as in approach (A).

**Effort estimate:** ~half a day to a day, dominated by (3) the renderer and (4) the device‑string discovery — versus ~1–2 hours for the approach‑(A) spike. **Added risk under Rosetta:** Xvfb + software‑GL rendering of your content runs emulated; expect higher CPU and slower frame rates than (A). **Image size:** `xvfb` + a renderer (especially headful Chromium) adds tens to hundreds of MB.

> Net: Xvfb is *achievable* here and the image is already 80% prepared for it, but it trades a small, in‑process frame push (A) for an out‑of‑process display + renderer + capture pipeline (B). Only invest in it if the (A) spike shows frames don't render, or if you specifically need to mirror a real app/desktop.

---

## 5. SDK version

- The bundled SDK is **Zoom Meeting SDK for Linux v7.1.x (x86_64)** (`lib/zoomsdk/libmeetingsdk.so`, `release_info/README.md` points to `developers.zoom.us/docs/meeting-sdk/linux/`).
- **The raw‑share‑send API is present in this exact build — verified at the BINARY level, not just the headers.** Confirmed against `lib/zoomsdk/libmeetingsdk.so`:
  - `nm -D` lists **`GetRawdataShareSourceHelper`** as an exported text symbol (alongside `GetRawdataVideoSourceHelper`, `GetAudioRawdataHelper`, `HasRawdataLicense`).
  - The **concrete implementation class** `ZoomSDKShareSourceHelper` is compiled in, with these mangled symbols:
    - `_ZN7ZOOMSDK24ZoomSDKShareSourceHelper22setExternalShareSourceEPNS_19IZoomSDKShareSourceEPNS_24IZoomSDKShareAudioSourceE` → `ZoomSDKShareSourceHelper::setExternalShareSource(IZoomSDKShareSource*, IZoomSDKShareAudioSource*)`
    - `_ZN7ZOOMSDK24ZoomSDKShareSourceHelper14sendShareFrameEPciiiNS_15FrameDataFormatE` → `ZoomSDKShareSourceHelper::sendShareFrame(char*, int, int, int, FrameDataFormat)`
  - Baked‑in runtime validation strings prove the path is *implemented* (not a stub): `[ZoomSDKShareSourceHelper::sendShareFrame] frameBuffer : nullptr`, `[ZoomSDKShareSourceHelper::setExternalShareSource] pShareSource is nullptr`, `... wrong usage`.
  - **Audio share send is also compiled in:** `SDKShareAudioSource::sendShareAudio`, `CSDKAuidoRawDataChannel::SendShareAudioRawData`, and `ZoomSDKShareSourceHelper::setSharePureAudioSource`.
  - The desktop‑capture path is present too (internal share‑manager symbols like `OnPTStartAppShare`, `DoStopShareWithShareSourceId`).
  - **Conclusion: the SDK we have can send a screen share. This is settled — the open question (§1) is only about runtime *visibility*, not API availability.**
- The raw external share source has been part of the Linux raw‑data SDK across the 6.x→7.x line. No deprecation of the raw share path is indicated in the v7.x headers (the *deprecated* items are `LockShare`, the `ViewShare`/`onLockShareStatus` UI bits — not the send path).
- **⚠️ v7.0.0 breaking change (forum changelog, §6): the share‑source `onStartSend` callback became asynchronous.** Code written against ≤6.x that pushed frames synchronously from the callback must be restructured to signal a producer thread. This is the most likely v7‑specific footgun for this feature.

**Known issues / regressions surfaced by research (forum + third‑party — verify against v7.1.0 yourself):**

| Version reported | Issue | Status per research |
|---|---|---|
| v6.4.6 / v6.5.5 / v6.5.10 | `sendShareFrame()` returns `SDKERR_SUCCESS` but participants see a **blank** share ("Bot has started screen sharing", no frames) | Unresolved in those versions (no Zoom‑staff fix in thread, as of Aug 2025). **v7.x status unconfirmed.** |
| v7.0.0+ | `onStartSend` is now **asynchronous** | Documented behavior change, not a bug — but breaks naive ≤6.x ports |
| v7.0.0 (and reported through May 2026) | `setExternalShareSource` (and share audio) returns `SDKERR_UNKNOWN(13)` in **webinars**, even with app‑privilege token; works in regular meetings | Unresolved per forum |
| Linux ARM64 | Meeting SDK **not** shipped for ARM64 Linux (x86_64 only) — feature request only | Not available (relevant to the Rosetta/Apple‑Silicon context — see §4) |

---

## 6. Reference implementations & web sources

> Reliability tiers: **[OFFICIAL]** Zoom docs/headers/changelog · **[FORUM]** devforum user reports (may include Zoom‑staff replies) · **[3P]** credible third‑party (Recall.ai runs Zoom bots at scale) · **[GEN]** general/community.

### What the research did and did NOT find

- **`tanchunsiong/zoom_meetingsdk_linux_rawdatademos` — the repo EXISTS** (last pushed 2026‑06‑17), but it does **NOT** contain a raw‑share‑*send* example. *(An earlier automated pass wrongly reported it missing; this was verified directly by cloning and grepping the source.)* — https://github.com/tanchunsiong/zoom_meetingsdk_linux_rawdatademos **[GEN, verified]**
  - **Confirmed by grep across the whole repo:** **zero** occurrences of `setExternalShareSource`, `sendShareFrame`, `IZoomSDKShareSource`, `IZoomSDKShareSender`, or `GetRawdataShareSourceHelper`. So even this canonical community source has no Linux screen‑share‑send code — reinforcing that the send path is under‑exercised in public examples.
  - **What it *does* have, and why it's still the best structural reference:**
    - `SendRawVideoAndAudioExample/` and `AllInOneExample/` send raw **camera video + audio** via `GetRawdataVideoSourceHelper()->setExternalVideoSource(...)` (`AllInOneExample/demo/meeting_sdk_demo.cpp:255‑258`) plus a `ZoomSDKVideoSource` class — i.e. the **exact send‑delegate pattern** our `ZoomSDKShareSource` should mirror, just swapping the video helper for the share helper.
    - `MeetingShareCtrlEventListener.{cpp,h}` (in `AllInOneExample/` and `GetRawVideoAndAudioAPIExample/`) implements `IMeetingShareCtrlEvent` (only `onSharingStatus`/`onFailedToStartShare` are non‑empty) and is wired via `m_pMeetingService->GetMeetingShareController()->SetEvent(...)` (`AllInOneExample/demo/meeting_sdk_demo.cpp:655‑656`) — a ready template for the optional share‑event listener in our §8 sketch. (This listener *observes* share; it does not start one.)
    - Multiple Dockerfiles (`Ubuntu`, `UbuntuDesktop`, `Centos8/9`, `OracleLinux8`) and `azure-container-apps` / `ecs-fargate` deployment manifests — useful headless‑Docker references.
  - Tan also has `zoom_videosdk_linux_rawdatademos` and Windows equivalents (`Zoom_MeetingSDK_Windows_RawDataDemos`); the **Windows** Meeting‑SDK demos are worth checking for a share‑source example since the share API is cross‑platform, but were not retrieved here.
- **Official `zoom/meetingsdk-linux-raw-recording-sample`** — demonstrates raw audio/video **receive** and raw **video/audio send** (external camera), but **does not** demonstrate screen‑share sending. — [github.com/zoom/meetingsdk-linux-raw-recording-sample](https://github.com/zoom/meetingsdk-linux-raw-recording-sample) **[OFFICIAL]**
- **Official `zoom/meetingsdk-headless-linux-sample`** (the upstream of *this* repo) — headless join + Docker patterns; **no** share‑sending example. — [github.com/zoom/meetingsdk-headless-linux-sample](https://github.com/zoom/meetingsdk-headless-linux-sample) **[OFFICIAL]**
- **No public, working Linux example of `sendShareFrame()` producing visible output was found** — consistent with the blank‑frame reports below.

### Most useful sources

- **[FORUM] sendShareFrame produces no visible frames** — the central bug report; participants see a blank share despite success codes (v6.4.6/6.5.5/6.5.10). Read this before committing to approach (A). — https://devforum.zoom.us/t/meeting-sdk-linux-rawdata-api-method-sendshareframe-does-not-work-no-shared-screen-frames-shown/136748
- **[3P] Recall.ai — "Why can't I send shared screen frames?"** — root‑cause analysis: success codes only mean the SDK accepted the buffer, not that it rendered; blank views usually trace to meeting policy / an existing active share / UI layout / frame cadence (recommends 10–30 fps, monotonic timing). Most actionable troubleshooting source. — https://www.recall.ai/blog/why-cant-i-send-shared-screen-frames
- **[FORUM] Changelog: Meeting SDK Linux 7.0.0** — documents the `onStartSend`/share‑source callback becoming **asynchronous** (the key v7 breaking change), plus Ubuntu‑20+‑only support. — https://devforum.zoom.us/t/changelog-meeting-sdk-linux-7-0-0/142719
- **[FORUM] Webinar mode: setExternalShareSource returns UNKNOWN(13)** — raw share send broken in webinars even with app‑privilege token; works in meetings (reported through May 2026). — https://devforum.zoom.us/t/webinar-mode-setexternalsharesource-share-share-audio-returns-unknown-13-even-with-app-privilege-token-raw-recording-active-works-in-meeting/143684
- **[FORUM] Recording shared screen with Linux SDK** — a developer on v6.0.12 wires `GetRawdataShareSourceHelper()->setExternalShareSource(...)` then `IMeetingShareController::ResumeCurrentSharing()`. Confirms the helper‑based start path, but the poster did **not** share the frame‑feeding code, and used custom wrapper class names (not standard SDK interfaces). Treat the `ResumeCurrentSharing()` step as a hint to investigate, not gospel. — https://devforum.zoom.us/t/recording-shared-screen-with-linux-sdk/114172
- **[FORUM] Permissions / giving share rights to participants** — general discussion of host/co‑host vs. "only host can share". — https://devforum.zoom.us/t/how-can-i-give-host-permissions-or-screen-sharing-permissions-to-registrants-created-with-registrants/88683
- **[FORUM] ARM64 support request** — Linux Meeting SDK is x86_64 only; ARM64 is an open feature request (context for the Rosetta setup). — https://devforum.zoom.us/t/is-there-a-support-for-meeting-sdk-app-for-linux-on-arm64/94417

### Official API references (authoritative, but verify against the bundled headers — versions can drift)

- **[OFFICIAL] IMeetingShareController** — https://marketplacefront.zoom.us/sdk/meeting/linux/class_i_meeting_share_controller.html
- **[OFFICIAL] zoom_rawdata_api.h** (defines `GetRawdataShareSourceHelper()`) — https://marketplacefront.zoom.us/sdk/meeting/linux/zoom__rawdata__api_8h.html
- **[OFFICIAL] Meeting SDK Linux — Raw Data guide** — https://developers.zoom.us/docs/meeting-sdk/linux/add-features/raw-data/
- **[OFFICIAL] Meeting SDK Linux changelog index** — https://developers.zoom.us/changelog/meeting-sdk/linux/
- **[OFFICIAL] Video SDK Linux — share (separate SDK, but documents raw I420 share formats)** — https://developers.zoom.us/docs/video-sdk/linux/share/

### Headless / Xvfb / Rosetta context

- **[3P] Recall.ai — streaming video to a meeting** (camera vs. screen‑share `IZoomSDKVideoSource` distinction) — https://www.recall.ai/blog/zoom-sdk-streaming-video-to-meeting
- **[GEN] Xvfb inside Docker** (virtual display pattern for approach B) — https://sick.codes/xfce-inside-docker-virtual-display-screen-inside-your-headless-container/
- **[GEN] ArchWiki: Zoom on Linux** (X11 vs. Wayland for screen capture; `XDG_SESSION_TYPE=X11`) — https://wiki.archlinux.org/title/Zoom_Meetings

> **Caveat on AI‑sourced snippets:** one community/forum snippet surfaced a plane‑based `sendShareFrame(y,u,v,stride_y,stride_uv)` signature. **That is not our SDK's signature.** The header in `lib/zoomsdk/h/rawdata/rawdata_share_source_helper_interface.h` is `sendShareFrame(char* frameBuffer, int width, int height, int frameLength, FrameDataFormat format)` — a single packed I420 buffer. Trust §2A over any web snippet.

---

## 7. Use‑case fit & approach comparison (triage bot displaying generated content)

The bot's goal: show rendered text / diagnostics / a generated image to meeting participants.

| Dimension | (A) Raw external share source | (B) Render to Xvfb + desktop share |
|---|---|---|
| **New moving parts** | 1 delegate class + ~30 lines wiring | Xvfb + WM + render target + device‑string plumbing + Dockerfile/entry.sh changes |
| **X display needed** | ❌ No | ✅ Yes (`:99`) |
| **GL/EGL/GBM** | ❌ No | Likely (software GL via Mesa) |
| **Rosetta/amd64 risk** | Low (CPU memcpy + I420 encode) | Higher (emulated Mesa/Xvfb) |
| **Maps to existing repo code** | ✅ Direct analogue of `ZoomSDKVideoSource` | No existing pattern |
| **Frame control / determinism** | Full (you push exactly what you render) | Indirect (SDK grabs whatever is on screen) |
| **Effort** | Low | Medium‑High |
| **Reliability headless** | Code path is simplest, **but carries the documented blank‑frame risk — unverified on v7.1.0** (§1/§6) | Capture path avoids that specific bug, but adds more failure surface (Xvfb/X11/device‑string) and is not proven for *SDK‑capturing‑Xvfb* either |
| **Known SDK bugs** | Blank frames (≤6.5.x), webinar `UNKNOWN(13)`, v7 async callback | None specific found, but unproven headless |

**Verdict: spike (A), keep (B) as the documented fallback.** Approach (A) is the right design and the cheapest to try — render the bot's content into an in‑memory image (OpenCV `cv::Mat`, already a dependency, used in `ZoomSDKRendererDelegate`), convert to I420 with `cv::cvtColor(bgr, yuv, cv::COLOR_BGR2YUV_I420)`, and push `yuv.data` via `sendShareFrame`. No X server, no GL, minimal Rosetta exposure, reuses the existing send‑delegate shape. **The one thing that decides A‑vs‑B is empirical: does a second participant actually see the frames on v7.1.0?** Spend the first hour answering that. If yes → ship (A). If the blank‑frame bug reproduces and can't be cleared (verify it's a real meeting not a webinar, no other active share, share policy permits it, async callback honored) → switch to (B): Xvfb + `StartMonitorShare`.

---

## 8. Implementation sketch (plan, not code)

> Mirrors the existing external‑video‑source pattern (`src/raw_send/ZoomSDKVideoSource.{h,cpp}` + the commented‑out block in `Zoom.cpp:247‑267`). Do **not** copy this into the build as‑is — it's a design.

**New files**
- `src/raw_send/ZoomSDKShareSource.h` / `.cpp` — implements `IZoomSDKShareSource`:
  - `onStartSend(IZoomSDKShareSender* pSender)` → store `m_shareSender = pSender`, set a `m_isSending = true` flag, and **signal a separate frame‑producer thread** (do not block or loop inside the callback — it's asynchronous as of v7.0.0). The producer thread owns the `sendShareFrame` cadence.
  - `onStopSend()` → `m_isSending = false`, join/stop the producer thread, null the sender.
  - A `sendFrame(cv::Mat bgr)` (or `sendFrame(char* i420, w, h)`) helper that converts BGR→I420 and calls `m_shareSender->sendShareFrame(buf, w, h, w*h*3/2, FrameDataFormat_I420_FULL)`.
  - (Mirror the `Frame`/`isReady()`/`getSender()` accessors from `ZoomSDKVideoSource` for consistency.)
- *(Optional, later)* `src/events/MeetingShareCtrlEvent.{h,cpp}` — implements `IMeetingShareCtrlEvent` so you can log `onFailedToStartShare`, react to `onSharingStatus`, and confirm `Sharing_Self_Send_Begin`. Follow the shape of `src/events/MeetingRecordingCtrlEvent.{h,cpp}`.

**`CMakeLists.txt`**
- Add `src/raw_send/ZoomSDKShareSource.h` / `.cpp` (and the optional event files) to the `add_executable(zoomsdk ...)` source list. No new link libs needed (OpenCV + meetingsdk already linked).

**`src/Zoom.h`**
- `#include "rawdata/rawdata_share_source_helper_interface.h"` and `#include "meeting_service_components/meeting_sharing_interface.h"`.
- Add members: `IZoomSDKShareSourceHelper* m_shareHelper{nullptr};` `ZoomSDKShareSource* m_shareSource{nullptr};` (and optionally `IMeetingShareController*` cache / a `MeetingShareCtrlEvent*`).
- Declare `SDKError startScreenShare();` and `SDKError stopScreenShare();`.

**`src/Zoom.cpp`** — new `startScreenShare()`, called once in‑meeting (e.g., from `onJoin` after recording setup, or from a new branch in `startRawRecording()`/its own method):
```text
1. Guard: GetMeetingStatus() == MEETING_STATUS_INMEETING else SDKERR_WRONG_USAGE.
2. auto* shareCtl = m_meetingService->GetMeetingShareController();
3. shareCtl->SetEvent(new MeetingShareCtrlEvent(...));   // optional but recommended
4. CannotShareReasonType reason;
   if (!shareCtl->CanStartShare(reason)) { log reason (e.g. _Locked → need host); return; }
5. m_shareHelper = GetRawdataShareSourceHelper();
   if (!m_shareHelper) return SDKERR_UNINITIALIZE;
6. if (!m_shareSource) m_shareSource = new ZoomSDKShareSource();
7. auto err = m_shareHelper->setExternalShareSource(m_shareSource);   // starts the raw share
8. // SDK now calls m_shareSource->onStartSend(sender); begin pushing I420 frames there.
```
- `stopScreenShare()` → `m_meetingService->GetMeetingShareController()->StopShare();` then drop the source.
- In `clean()`, `delete m_shareSource;` (alongside the existing `delete m_renderDelegate;`).

**Frame production**
- Build a `cv::Mat` (e.g., 1280×720 BGR), draw text/diagnostics with `cv::putText`/`cv::rectangle`.
- `cv::cvtColor(bgr, i420, cv::COLOR_BGR2YUV_I420);` → `i420.data` is a contiguous I420 buffer of length `w*h*3/2`.
- Call `sendShareFrame` on a timer/thread at ~5–10 fps (more than enough for a text dashboard; keep it low for Rosetta).

**Config (`src/Config.{h,cpp}`)**
- Add a flag mirroring the existing `useRawVideo()` style — e.g. a `--raw-share` option or a `share` subcommand — so screen sharing is opt‑in. Follow the CLI11 pattern already used for `m_rawRecordVideoCmd`.

**`Dockerfile` / `bin/entry.sh`**
- **No changes required for approach (A).** (Only approach (B) would need Xvfb + `DISPLAY` setup.)

---

## 9. Open questions / risks

1. **🔴 #1 RISK — blank frames despite success codes.** The headline unknown: does a second participant actually *see* `sendShareFrame` output on **v7.1.0**? Reported broken on ≤6.5.x with no staff fix; v7.x unconfirmed (§1/§6). *Mitigate:* make this the first thing the spike proves; if it reproduces, work the Recall.ai checklist (real meeting not webinar, no other active share, share policy permits, async callback honored) before concluding it's unfixable.
2. **🔴 Webinar incompatibility.** If any target sessions are **webinars**, raw share send returns `SDKERR_UNKNOWN(13)` (§5/§6). Confirm the bot only operates in regular meetings, or plan around this.
3. **v7.0.0 async `onStartSend`.** Don't block in the callback / don't push frames before it fires. *Risk:* low if designed for from the start (§2A/§8).
4. **Privilege for raw share send.** Confirm whether `setExternalShareSource` needs the raw‑data/recording entitlement (the bot already requests local‑recording privilege) or only the meeting's share permission. *Risk:* low‑moderate; test host vs. plain participant.
5. **Does `setExternalShareSource` alone start the share, or is a controller call also needed?** Header doc says it "starts sharing external source" and `onStartSend` implies yes, but one forum example also called `ResumeCurrentSharing()` afterward (§6). *Risk:* low — try helper‑only first; if no `onStartSend`, investigate the controller call.
6. **"Only host can share" meetings.** With lock‑share on, the participant bot can't share without host/co‑host. Product decision: make the bot host, or have the host unlock/promote it. Gate on `CanStartShare(reason)`.
7. **Stealing the floor.** Under single‑share policies, the bot's share may grab an existing presenter's share. Check `GetViewableSharingUserList()` first.
8. **Rosetta CPU cost.** I420 conversion + SDK encode on emulated x86 (and the SDK is x86_64‑only — no native ARM64). *Mitigate:* modest resolution/fps (1280×720 @ 5–10 fps); measure container CPU.
9. **Frame cadence / thread‑safety.** You own the push loop. Don't call `sendShareFrame` after `onStopSend`; guard the sender pointer.
10. **Audio share** (optional): to also play audio into the share, implement `IZoomSDKShareAudioSource` and pass it as the 2nd arg to `setExternalShareSource` (mind `sendShareAudio` sample‑rate/channel constraints in the header).

## 10. Recommended next step

**Run a 1–2 hour de‑risking spike of approach (A), gated on visibility.** Concretely:
1. Add `ZoomSDKShareSource` (mirroring `ZoomSDKVideoSource`) and a `Zoom::startScreenShare()` behind an opt‑in flag; wire `GetRawdataShareSourceHelper()->setExternalShareSource(...)` after join, with `IMeetingShareCtrlEvent` logging `onSharingStatus`/`onFailedToStartShare`.
2. From a producer thread (async‑callback‑safe), push a static OpenCV test card (text + timestamp) at ~5 fps as packed I420.
3. **Join from a normal second client and confirm the test card is visible** — in a *regular meeting*, with the bot able to share (host or permissive policy).
4. **Decision gate:** visible → proceed to dynamic content on (A). Blank despite the Recall.ai checklist → fall back to (B): add Xvfb to the Dockerfile/`entry.sh`, render into `:99`, and use `StartMonitorShare` with the Linux device string.

Defer all approach‑(B)/Xvfb work until step 3 forces it.
