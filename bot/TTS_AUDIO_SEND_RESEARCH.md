# TTS Audio Send Research — Zoom Meeting SDK for Linux v7.1.0 (headless)

**Status:** Research / findings only. This document is a **plan**, not an implementation. No code in this repo has been (or should be) changed as part of this task except the creation of this file.

**Goal:** Let the headless bot act as a **virtual microphone** — take TTS PCM produced on the Mac host and "speak" it into the Zoom meeting as the bot's own mic audio.

**Scope of this doc:** the SDK send mechanism, required PCM format, the timing/buffering model, permissions, headless/PulseAudio interaction, Rosetta/version caveats, an implementation sketch mirroring the existing `ZoomSDKVideoSource`, and a *brief* recommendation for the Mac→container ingestion channel (deep transport analysis is deferred to the separate transport-contracts task).

All SDK claims below were verified against the headers in `lib/zoomsdk/h/` (file + line references are given inline).

---

## 1. Executive summary

The Zoom Linux SDK exposes a first-class **"virtual audio mic"** path for sending raw PCM into a meeting. It is the audio analogue of the raw-video send path the repo already stubs out in `src/raw_send/ZoomSDKVideoSource.{h,cpp}`. The three pieces, all confirmed present in `lib/zoomsdk/h/rawdata/rawdata_audio_helper_interface.h`:

1. **`IZoomSDKAudioRawDataHelper::setExternalAudioSource(IZoomSDKVirtualAudioMicEvent*)`** — registers our object as the bot's mic source. The helper is obtained from the free function **`GetAudioRawdataHelper()`** (`lib/zoomsdk/h/rawdata/zoom_rawdata_api.h:20`).
2. **`IZoomSDKVirtualAudioMicEvent`** — a callback sink we implement. The SDK calls `onMicInitialize(IZoomSDKAudioRawDataSender* pSender)` (handing us the sender), then `onMicStartSend()` / `onMicStopSend()` to gate sending, and `onMicUninitialized()` on teardown.
3. **`IZoomSDKAudioRawDataSender::send(char* data, unsigned int data_length, int sample_rate, ZoomSDKAudioChannel channel)`** — the actual push call. **16-bit PCM only**, `data_length` must be **even**.

**The model is PUSH, not pull.** The SDK does *not* poll us on a timer. It hands us a sender and tells us *when* sending is allowed (`onMicStartSend`); *we* are responsible for calling `send()` repeatedly, **paced in real time**, from our own thread. Sending faster than real time → sped-up/garbled audio and/or buffer overrun; sending slower → gaps/choppiness.

### Recommended approach (one paragraph)

Add a `ZoomSDKVirtualAudioMicEvent` delegate class under `src/raw_send/` (mirroring `ZoomSDKVideoSource`, and mirroring tanchunsiong's working `ZoomSDKVirtualAudioMicEvent.cpp` — see §10). Register it via `GetAudioRawdataHelper()->setExternalAudioSource(...)` while in-meeting, in the **staff-confirmed order: `setExternalAudioSource(mic)` → `JoinVoip()` → `UnMuteAudio(myUserId)`** (forum §10). Before joining VoIP, set `GetAudioSettings()->EnableAlwaysMuteMicWhenJoinVoip(true)` so the *physical* device mic stays muted while our external source is the audio that goes out. Stream **16 kHz, mono, 16-bit signed little-endian PCM** from the Mac. Capture the sender in `onMicInitialize` (`pSender_ = pSender;` — **the official Zoom sample has this line commented out, which is why its mic never sends; do not copy that bug**). On `onMicStartSend`, start a dedicated sender thread that drains a small jitter buffer and calls `pSender->send(chunk, chunkLen, 16000, ZoomSDKAudioChannel_Mono)` in 10–20 ms frames, paced against a monotonic clock for latency control. Ensure the bot is **unmuted** (`IMeetingAudioController::UnMuteAudio(myUserId)` in a retry loop, exactly like the commented-out `UnmuteVideo` loop in `Zoom.cpp`). For the Mac→container transport, feed the jitter buffer from a **localhost stream socket** carrying raw PCM frames (see §8) — reuse the pattern of the existing `src/util/SocketServer.cpp`, but as a *client/reader* of host audio rather than a writer.

---

## 2. Exact SDK API surface (verified against `lib/zoomsdk/h/`)

### 2.1 Acquire the helper — `lib/zoomsdk/h/rawdata/zoom_rawdata_api.h`

```cpp
extern "C" {
    SDK_API bool                        HasRawdataLicense();              // line 17
    SDK_API IZoomSDKAudioRawDataHelper* GetAudioRawdataHelper();          // line 20
}
```

> The repo already calls `GetAudioRawdataHelper()` for the *receive* path (`src/Zoom.cpp:280`). The **same helper instance** carries `setExternalAudioSource()` for sending — so we can reuse the existing `m_audioHelper` member (`src/Zoom.h:59`, type `IZoomSDKAudioRawDataHelper*`).

### 2.2 Register the virtual mic — `lib/zoomsdk/h/rawdata/rawdata_audio_helper_interface.h`

```cpp
class IZoomSDKAudioRawDataHelper {
public:
    virtual ~IZoomSDKAudioRawDataHelper(){}
    virtual SDKError subscribe(IZoomSDKAudioRawDataDelegate* pDelegate,
                               bool bWithInterpreters = false) = 0;        // RECEIVE (already used)
    virtual SDKError unSubscribe() = 0;
    // SEND / virtual mic:  (line 84)
    virtual SDKError setExternalAudioSource(IZoomSDKVirtualAudioMicEvent* pSource) = 0;
};
```

### 2.3 The callback sink we implement — same header, lines 43–64

```cpp
class IZoomSDKVirtualAudioMicEvent {
public:
    virtual ~IZoomSDKVirtualAudioMicEvent() {}
    // Handed the sender; stash it. Do NOT send yet.
    virtual void onMicInitialize(IZoomSDKAudioRawDataSender* pSender) = 0;  // line 51
    // Sending is now allowed — start our sender loop.
    virtual void onMicStartSend() = 0;                                     // line 55
    // Stop sending (e.g. muted / leaving).
    virtual void onMicStopSend() = 0;                                      // line 59
    // Sender is gone — null it out.
    virtual void onMicUninitialized() = 0;                                 // line 63
};
```

### 2.4 The sender object — same header, lines 27–41

```cpp
class IZoomSDKAudioRawDataSender {
public:
    virtual ~IZoomSDKAudioRawDataSender() {}
    /**
     * Sends audio raw data. Audio sample must be 16-bit audio.
     * @param data         the audio data's address.
     * @param data_length  the audio data's length. Must be an even number.
     * @param sample_rate  the audio data's sampling rate.
     *   Mono   : 8000/11025/16000/32000/44100/48000/50000/50400/96000/192000/2822400
     *   Stereo : 8000/16000/32000/44100/48000/50000/50400/96000/192000
     */
    virtual SDKError send(char* data, unsigned int data_length, int sample_rate,
                          ZoomSDKAudioChannel channel = ZoomSDKAudioChannel_Mono) = 0;  // line 40
};
```

### 2.5 The channel enum — `lib/zoomsdk/h/zoom_sdk_def.h:515`

```cpp
enum ZoomSDKAudioChannel {
    ZoomSDKAudioChannel_Mono,    // 0
    ZoomSDKAudioChannel_Stereo,  // 1
};
```

### 2.6 Audio / mute control — `lib/zoomsdk/h/meeting_service_components/meeting_audio_interface.h`

```cpp
class IMeetingAudioController {
    virtual SDKError JoinVoip() = 0;                                  // line 165 (repo already calls this)
    virtual SDKError LeaveVoip() = 0;                                 // line 172
    virtual SDKError MuteAudio(unsigned int userid, bool allowUnmuteBySelf = true) = 0; // line 181
    virtual SDKError UnMuteAudio(unsigned int userid) = 0;            // line 189
    virtual bool     CanUnMuteBySelf() = 0;                           // line 196
    ...
};
```

Own user id for unmute: `m_meetingService->GetMeetingParticipantsController()->GetMySelfUser()->GetUserID()`
(`meeting_participants_ctrl_interface.h:525` `GetMySelfUser()`, `:101` `GetUserID()`).

### 2.7 Call sequence (the important part)

```
InitSDK → CreateMeetingService/AuthService/SettingService → SDKAuth (JWT)
   ├─ (pre-join) GetAudioSettings()->EnableAutoJoinAudio(true)      [already at Zoom.cpp:153]
   ├─ (pre-join) GetAudioSettings()->EnableAlwaysMuteMicWhenJoinVoip(true) ← NEW (keeps real device mic muted)
   └─ onJoin (MeetingServiceEvent)                                  [src/Zoom.h:80]
        └─ in-meeting (MEETING_STATUS_INMEETING)
             ├─ helper  = GetAudioRawdataHelper()                   [already in Zoom.cpp:280]
             ├─ helper->setExternalAudioSource(&micEvent)   ← NEW   [register virtual mic FIRST]
             ├─ audioCtl = GetMeetingAudioController()
             ├─ audioCtl->JoinVoip()                                [already in Zoom.cpp:274 — move AFTER setExternalAudioSource]
             ├─ loop: audioCtl->UnMuteAudio(myUserId) until SUCCESS ← NEW (mirror UnmuteVideo loop)
             │
             │   ── then asynchronously, driven by SDK callbacks ──
             ├─ micEvent.onMicInitialize(pSender)   → stash pSender   (pSender_ = pSender;)
             ├─ micEvent.onMicStartSend()           → start sender thread
             │      thread: while(running) { pull frame; pSender->send(buf,len,16000,Mono); pace; }
             ├─ micEvent.onMicStopSend()            → pause/stop thread
             └─ micEvent.onMicUninitialized()       → pSender = nullptr; join thread
```

**Ordering notes (the order is staff-confirmed on the Zoom devforum — see §10):**
- **Staff-recommended order:** `setExternalAudioSource()` → `JoinVoip()` → `UnMuteAudio(getMyself()->GetUserID())`. If you `JoinVoip`/unmute *before* registering the source, reporters get only `onMicInitialize` and **`onMicStartSend` never fires**. The repo today calls `JoinVoip()` (`Zoom.cpp:274`) *before* it touches the audio helper (`:280`) — for the send path, **register the external source before `JoinVoip()`**.
- `setExternalAudioSource` is called once the bot is **in-meeting**. Whether the send path *also* requires `StartRawRecording()` to have been called (the receive `subscribe` path does) is still an open question (§9) — but note that the working samples register the source within the same in-meeting flow.
- The bot must be **unmuted** for participants to hear the injected audio. `EnableAlwaysMuteMicWhenJoinVoip(true)` mutes the *physical* device mic (not the participant) so only the external source is transmitted.
- **Known regression / workaround:** since SDK v5.16.5, some versions fire `onMicUninitialized` unexpectedly or never fire `onMicStartSend`; the community workaround is to **mute then unmute the bot twice** to kick the handshake (§10). The v7.0.x changelogs list no virtual-mic changes, so the API itself is unchanged — but keep this workaround handy if `onMicStartSend` doesn't arrive.

---

## 3. Required audio format + timing model

### 3.1 Format (hard requirements from the header)

| Property      | Requirement                                                                                   |
|---------------|-----------------------------------------------------------------------------------------------|
| Bit depth     | **16-bit signed PCM** (the header says "Audio sample must be 16-bit audio"). Little-endian.   |
| Byte length   | `data_length` **must be even** (a whole number of 16-bit samples).                            |
| Channels      | `ZoomSDKAudioChannel_Mono` (recommended for voice) or `_Stereo` (interleaved L/R).            |
| Sample rate   | Must be one of the **supported** values (see §2.4). For **mono**: 8000/11025/**16000**/32000/44100/48000/… |

**Recommended: 16 kHz, mono, 16-bit.** Rationale: it is explicitly in the supported-mono list, it is the natural rate for speech, and it minimizes bytes over the Mac→container channel. (48 kHz mono is also fine if the TTS already produces it and we want max fidelity.)

> **What the working sample uses:** tanchunsiong's `PlayAudioFileToVirtualMic2` streams **48 kHz, mono, 16-bit** in **640-byte chunks** (= 320 samples ≈ 6.67 ms at 48 kHz). Zoom staff on the devforum specify "**16 bit signed, mono channel and little endian order**" and note "the frequency can be set when sending" (the sample uses 44100 in one variant, 48000 in another). So 16 kHz mono is a valid, smaller-footprint choice; 44100/48000 are the rates the published examples happen to use. Match `sample_rate` in the `send()` call to the actual PCM rate. (§10)

### 3.2 Resampling — likely required

The supported-mono rates are a **fixed allow-list**. Common neural-TTS output rates are **NOT** on it:
- **22050 Hz** (Piper, many classic TTS) → **not supported** (list has 11025, not 22050).
- **24000 Hz** (Kokoro, several modern TTS, OpenAI-style 24k) → **not supported**.
- 16000 / 44100 / 48000 → supported (no resample needed).

**Implication:** if the Mac TTS emits 22050 or 24000 Hz, we **must resample** before `send()` (or pass a sample_rate the SDK rejects). Resample to **16000** (cheapest, speech-appropriate) on the Mac host (preferred — keeps the container a dumb shim and the bytes small) or in the container. Doing it on the Mac is consistent with the "transport shim only" architecture. Use a real resampler (e.g. libsamplerate / `soxr` / `scipy.signal.resample_poly` / `ffmpeg`), not naive decimation, to avoid aliasing artifacts.

### 3.3 Timing model — PUSH (we drive the loop), with real-time pacing recommended

Confirmed from the interface shape **and** from Zoom staff on the devforum: the model is **push** — the SDK does **not** poll us. `onMicStartSend()` takes **no buffer argument** and there is **no per-frame pull callback**.

- The SDK signals *readiness* (`onMicStartSend`) and *stop* (`onMicStopSend`); it never asks us for N samples.
- **We push.** A dedicated thread calls `send()` repeatedly; each call hands the SDK a chunk of PCM that it enqueues into the VoIP encoder pipeline. This is exactly what tanchunsiong's `onMicStartSend` does — it spawns a detached thread that loops `send()` (§10).
- **How much the SDK buffers internally:** the published sample reads 640-byte chunks in a tight `while(file.good())` loop **with no per-chunk sleep** — i.e. it pushes a whole file rapidly and the SDK buffers/paces playout itself. So the SDK clearly has meaningful internal buffering, and a fast push of a *bounded* clip works in the sample.
- **Why we should still pace for a *live* stream:** our source is a continuous TTS stream, not a fixed file. If we push unbounded audio as fast as it arrives, we accumulate latency (buffer bloat) and lose control over barge-in/flush. So pace the loop to the wall clock for **latency control**, not just correctness:
  - 16 kHz mono 16-bit → **32 000 bytes/sec** → **320 bytes per 10 ms frame** (160 samples); 640 bytes = 20 ms.
  - Send one frame, then sleep so the loop period ≈ frame duration, measured against a **monotonic clock** with drift correction (accumulate "audio time sent" vs. "real time elapsed" and adjust sleep).
- **Failure modes (engineering reasoning — see the caveat below):**
  - *Send far faster than real time, unbounded* → growing latency / possible buffer overrun.
  - *Send too slow / starve* → gaps, choppiness.
  - *One huge `send()`* (an entire utterance at once) → opaque buffering, no barge-in. Chunk it.

> **Caveat — not Zoom-documented:** Zoom does **not** publish a hard rule that each `send()` must be paced to the wall clock, and the reference sweep found **no** Linux-send-specific primary source diagnosing "sped-up/choppy" audio (the robotic/choppy forum threads are about the *Web* SDK / general client audio, not this raw-send API). Real-time pacing here is well-understood engineering practice for a live stream, not a quoted Zoom requirement. Validate empirically (§9).

### 3.4 Buffering strategy

- Put a small **ring / jitter buffer** between the ingestion reader (socket) and the sender thread. ~100–250 ms is plenty for speech and keeps latency low.
- When the buffer underruns (no TTS available), send **silence frames** (zeroed 320-byte buffers) rather than stopping — this keeps the VoIP stream continuous and avoids the SDK perceiving a stall. (Verify whether continuous silence is needed vs. simply pausing — §9.)
- `send()` returns `SDKError`; log non-`SDKERR_SUCCESS` returns. Do not `exit()` on transient send errors (contrast the existing `SocketServer::writeBuf`, which `exit()`s on failure — do not copy that behavior into the audio path).

---

## 4. Permissions / meeting constraints

- **No recording privilege needed to *send*.** Receiving raw data in this repo is gated behind `CanStartRawRecording()` / `RequestLocalRecordingPrivilege()` / `StartRawRecording()` (`src/Zoom.h:97–106`, `src/Zoom.cpp:208–220`); the official sample README confirms that recording gate is for the **receive/subscribe** path. Sending as a virtual mic is conceptually just "being a participant with a mic." The hard requirements are: **be in the meeting**, **`JoinVoip()`**, and **be unmuted**. *(Whether the SDK gates `setExternalAudioSource` behind `StartRawRecording()` anyway is an open question — §9.)*
- **Auth-token caveat — use JWT/SDK auth, not a recording token, for send.** A devforum report (§10) found that a **`local_recording` token blocked audio send** (`onMicStartSend` never fired) while **JWT/SDK auth allowed full audio send**. This repo authenticates with a generated **JWT** (`Zoom.cpp:79–91`, `SDKAuth`), so the send path should be fine — but do not switch the bot to a recording-token auth for this feature.
- **Noise suppression can swallow injected audio.** Zoom staff noted on the forum that the SDK's noise suppression can make low-level/synthetic injected audio inaudible. If the injected TTS is heard intermittently or not at all despite a correct send loop, suspect audio processing — check audio settings for suppression and ensure adequate signal level. (§9 / §10)
- **Raw-data entitlement.** The SDK build must be licensed for raw data (`HasRawdataLicense()`, `zoom_rawdata_api.h:17`). The repo already relies on this for receive, so the entitlement is presumably present.
- **Mute state.** If the meeting has *mute on entry* (`IsMuteOnEntryEnabled()`), or the host muted the bot, injected audio is inaudible until unmuted. Self-unmute may be blocked unless `CanUnMuteBySelf()` is true or the host allows it. Plan a retry loop and surface a clear log if unmute keeps failing.
- **VoIP vs telephony.** We want VoIP (`AUDIOTYPE_VOIP`). `JoinVoip()` is correct; don't use 3rd-party telephony.
- **Account-level prerequisites** (carried over from the receive path): the meeting/account must permit the bot to join and use audio; on managed accounts local-recording-style raw-data may require admin enablement. Verify with whatever account already works for receive.

---

## 5. Headless + PulseAudio interaction

Current setup (`bin/entry.sh`): Xvfb is implied by the broader project; `setup-pulseaudio()` creates a **null sink** `SpeakerOutput`, sets it as default sink, sets `SpeakerOutput.monitor` as default source, and writes `~/.config/zoomus.conf` with `system.audio.type=default`. The `Dockerfile` installs ALSA + PulseAudio.

Key points for **sending**:
- The **raw virtual-mic path bypasses PulseAudio for the actual samples.** `send()` hands PCM straight to the SDK's VoIP encoder; it does **not** read from a Pulse source. So we do **not** need a new Pulse *source* device to feed audio, and we do **not** need to play TTS into PulseAudio.
- However, the SDK still **initializes its audio subsystem on startup**, and that init benefits from a valid default sink/source existing (which the null sink already provides). So the existing `setup-pulseaudio()` is most likely **sufficient as-is** for sending — no new Pulse module required. *(Verify — §9: confirm the virtual mic initializes without a real capture device and that the existing null sink doesn't need a companion source for the SDK's mic init to succeed.)*
- The existing receive setup uses `SpeakerOutput.monitor` as the default source; that's about *capturing what's played*. For the virtual mic we override the mic source at the SDK level via `setExternalAudioSource`, independent of Pulse.

**Net:** expect **no `bin/entry.sh` / `Dockerfile` changes** strictly required for the send path. Keep that assumption on the "verify" list.

---

## 6. v7.1.0 + Rosetta / amd64 caveats

- **API stability:** the virtual-mic trio (`setExternalAudioSource` / `IZoomSDKVirtualAudioMicEvent` / `IZoomSDKAudioRawDataSender::send`) is present and stable in the v7.1.0 headers shipped here. The `send()` signature includes the `channel` parameter (defaulted to mono) — older examples online sometimes show a 3-arg `send()`; this build is the 4-arg form (`rawdata_audio_helper_interface.h:40`). Match the local header, not blog posts.
- **Version history (verified, §10):** the Meeting SDK **Linux 7.0.0** and **7.0.5** changelogs list **no** changes to the virtual audio mic / raw-audio-send API (7.0.0's breaking changes are Ubuntu-20+-only OS support, a `SetBOOption` return-type change, and async `OnStartSendShare`). So the send API is unchanged across the 6.x → 7.x boundary that this repo just crossed. **However**, a regression introduced at **v5.16.5.24346** caused `onMicUninitialized` to fire unexpectedly / `onMicStartSend` not to fire on some builds (persisted into 6.1.x); the community workaround is **mute → unmute twice**. Keep this in mind if the handshake misbehaves on v7.1.0.
- **Rosetta timing risk (the big one for audio):** the SDK is x86_64 running under Rosetta 2 on Apple Silicon. Real-time audio pacing is sensitive to **clock jitter and scheduling latency**, both of which emulation can worsen. Mitigations:
  - Pace against a **monotonic clock** with accumulated-drift correction (don't just `sleep(10ms)` in a loop — error compounds).
  - Prefer slightly larger frames (**20 ms / 640 bytes**) to reduce per-call overhead under emulation, at the cost of ~10 ms more latency.
  - Keep a **jitter buffer** (§3.4) so transient scheduling stalls don't starve the encoder.
  - Budget CPU headroom; emulated real-time encode + resample can be marginal. Test for chipmunk/choppy artifacts specifically under Rosetta, not just on native x86_64.
- **Library rename:** `bin/entry.sh` copies `libmeetingsdk.so` → `libmeetingsdk.so.1`; the send path adds no new shared libs, so no change there.
- **amd64 build:** the container is built/run as linux/amd64; no arch-specific audio code is needed (we deal in raw PCM bytes).

---

## 7. Implementation sketch (PLAN — not working code)

Mirror the existing raw-**video** send delegate (`src/raw_send/ZoomSDKVideoSource.{h,cpp}`) and how it would wire into `Zoom.cpp`.

### 7.1 New files

**`src/raw_send/ZoomSDKVirtualAudioMicEvent.h`** — implements `IZoomSDKVirtualAudioMicEvent`:

```cpp
#include "rawdata/rawdata_audio_helper_interface.h"
#include "../util/Log.h"
using namespace ZOOMSDK;

class ZoomSDKVirtualAudioMicEvent : public IZoomSDKVirtualAudioMicEvent {
    IZoomSDKAudioRawDataSender* m_pSender = nullptr;   // handed to us by SDK
    std::atomic<bool> m_canSend{false};
    std::thread       m_senderThread;
    // jitter buffer fed by the ingestion reader (see §8):
    RingBuffer        m_pcm;        // 16kHz mono s16le bytes

    void onMicInitialize(IZoomSDKAudioRawDataSender* pSender) override; // stash sender
    void onMicStartSend() override;                                     // m_canSend=true; start thread
    void onMicStopSend()  override;                                     // m_canSend=false
    void onMicUninitialized() override;                                 // join thread; m_pSender=nullptr

    void senderLoop();   // paced 10ms frames -> m_pSender->send(...,16000,Mono)
public:
    // called by the ingestion reader thread:
    void enqueuePCM(const char* data, size_t len);
};
```

**`src/raw_send/ZoomSDKVirtualAudioMicEvent.cpp`** — key bodies:

- `onMicInitialize`: `m_pSender = pSender; Log::success("mic onInitialize");` (mirrors `ZoomSDKVideoSource::onInitialize` storing the sender, `ZoomSDKVideoSource.cpp:16`).
- `onMicStartSend`: set `m_canSend = true`; launch `m_senderThread = std::thread(&...::senderLoop, this);` (mirrors `onStartSend` setting `m_isReady`, `ZoomSDKVideoSource.cpp:27`).
- `onMicStopSend`: `m_canSend = false;` (mirrors `onStopSend`).
- `onMicUninitialized`: stop + join thread; `m_pSender = nullptr;` (mirrors `onUninitialized` nulling the sender, `ZoomSDKVideoSource.cpp:37`).
- `senderLoop`: every ~10 ms (monotonic-clock paced), pop 320 bytes from `m_pcm` (or a 320-byte silence frame on underrun) and call:
  ```cpp
  m_pSender->send(frame, 320, 16000, ZoomSDKAudioChannel_Mono);
  ```
  Check the returned `SDKError`; log on failure; never `exit()`.

### 7.2 Changes to `src/Zoom.h`

- Add includes: `#include "raw_send/ZoomSDKVirtualAudioMicEvent.h"`.
- Add member: `ZoomSDKVirtualAudioMicEvent* m_micSource = nullptr;` (alongside `m_videoSource`, `Zoom.h:62`).
- (`m_audioHelper` of type `IZoomSDKAudioRawDataHelper*` already exists — reuse it.)

### 7.3 Changes to `src/Zoom.cpp`

**(a) Pre-join, in `Zoom::join()`** alongside the existing `EnableAutoJoinAudio(true)` (`Zoom.cpp:149–154`):

```cpp
auto* audioSettings = m_settingService->GetAudioSettings();
audioSettings->EnableAutoJoinAudio(true);                 // already present
audioSettings->EnableAlwaysMuteMicWhenJoinVoip(true);     // NEW — real device mic stays muted; our source feeds the meeting
```

**(b) In-meeting, in `startRawRecording`'s `useRawAudio()` block — register the source BEFORE `JoinVoip()`** (staff-confirmed order, §2.7 / §10). This means reordering relative to today's code (which calls `JoinVoip()` at `:274` before touching the helper at `:280`):

```cpp
m_audioHelper = GetAudioRawdataHelper();                  // already present (Zoom.cpp:280)
if (!m_audioHelper) return SDKERR_UNINITIALIZE;
if (!m_micSource) m_micSource = new ZoomSDKVirtualAudioMicEvent();

auto sendErr = m_audioHelper->setExternalAudioSource(m_micSource);   // NEW — FIRST
if (hasError(sendErr, "set external audio source")) return sendErr;

auto* audioController = m_meetingService->GetMeetingAudioController();
auto voipErr = audioController->JoinVoip();               // already present (Zoom.cpp:274) — now AFTER setExternalAudioSource
hasError(voipErr, "join VoIP");

// unmute self (mirror the commented-out UnmuteVideo loop, Zoom.cpp:262-267)
auto* partCtl = m_meetingService->GetMeetingParticipantsController();
auto  myId    = partCtl->GetMySelfUser()->GetUserID();
SDKError ue;
do {
    ue = audioController->UnMuteAudio(myId);
    if (hasError(ue, "unmute audio")) sleep(1);
} while (hasError(ue));
```

> **Mirror tanchunsiong, not the official Zoom sample.** In the official `zoom/meetingsdk-linux-raw-recording-sample`, `onMicInitialize` has its sender-capture line commented out (`//pSender->send(); pSender_ = pSender;`), so `pSender_` is never set and the mic never sends. tanchunsiong's `GetRawVideoAndAudioAPIExample/demo/ZoomSDKVirtualAudioMicEvent.cpp` fixes it (`pSender_ = pSender;` on its own line). Use the tanchunsiong version as the body reference (§10).
>
> Note: today `setExternalAudioSource` (send) and `subscribe` (receive) share `m_audioHelper`. Sending and receiving can coexist (full-duplex bot). Gate send behind a new config flag so receive-only deployments are unaffected.

### 7.4 Config (`src/Config.{h,cpp}`)

- Add a flag, e.g. `--send-audio` / `m_sendAudio`, and a `sendAudio()` accessor, parallel to `useRawAudio()` (`Config.cpp:105`). Optionally a `--audio-in-socket <path/port>` option for the ingestion endpoint (§8).
- Wire `startRawRecording()` to only register the virtual mic when `sendAudio()` is true.

### 7.5 Build (`CMakeLists.txt`)

- Add `src/raw_send/ZoomSDKVirtualAudioMicEvent.cpp` to the sources (same place `ZoomSDKVideoSource.cpp` is listed). Ensure `<thread>`/`<atomic>` available (C++ standard already set by the project).

### 7.6 Ingestion reader (small)

- A reader (own thread) that connects/listens on the chosen channel (§8), reads raw PCM frames, and calls `m_micSource->enqueuePCM(buf, len)`. Reuse the structure of `src/util/SocketServer.cpp` (AF_UNIX `SOCK_STREAM`) but as a reader; or a localhost TCP socket; or tail a FIFO. Keep transport choice config-driven.

---

## 8. Recommended Mac→container ingestion approach (brief — defer deep analysis)

**Recommendation: a localhost streaming socket carrying raw 16 kHz mono s16le PCM frames**, with the container as the *reader*. Concretely, the lowest-friction options, in order:

1. **TCP socket on localhost / `host.docker.internal`** — Mac TTS process streams PCM; container connects out (or listens on a published port). Cross-platform on Docker Desktop for Mac, supports backpressure naturally, low latency. **Preferred** for a streaming, real-time signal.
2. **Bind-mounted Unix domain socket** — matches the repo's existing `SocketServer` (`/tmp/meeting.sock`, AF_UNIX). Clean and fast, but Unix-socket sharing across the Docker-for-Mac VM boundary is fiddlier than TCP.
3. **Bind-mounted file / FIFO the bot tails** — simplest to prototype and symmetric with the existing *receive* design (PCM files in `out/`). But a plain growing file is poor for a live, paced, low-latency stream (no natural framing/backpressure, awkward EOF/turn semantics). A **named pipe (FIFO)** is better than a regular file if a file-like path is desired.

**Why a socket over a tailed file for *this* signal:** TTS playback is latency-sensitive and turn-based (start/stop per utterance). A stream socket gives clean framing, immediate delivery, and backpressure; a tailed file adds polling latency and makes "utterance boundaries / barge-in / flush" clumsy. The receive path tolerates files because it's a sink; the send path is a live source and wants a stream.

> Framing, format negotiation, flow control, and reconnect semantics are **out of scope here** — that's the transport-contracts task. This is only a directional recommendation: **stream raw PCM over a localhost socket; resample to 16 kHz mono s16le on the Mac.**

---

## 9. Gaps & open questions (verify before/while implementing)

1. **Does `setExternalAudioSource` require `StartRawRecording()`?** The receive path (`subscribe`) clearly does. It is unverified whether the *send* path is also gated behind raw-recording being started, or whether it works with just in-meeting + VoIP. **Test both:** register the source (a) inside the started-recording flow and (b) without starting recording.
2. **Exact moment to call `setExternalAudioSource`.** Staff guidance (§10) is `setExternalAudioSource` → `JoinVoip` → `UnMuteAudio` (the plan follows this). Still verify on v7.1.0 that the SDK then fires `onMicInitialize` → `onMicStartSend`. If `onMicStartSend` never fires, apply the **mute/unmute-twice** workaround (§2.7) and check VoIP/mute state.
3. **Underrun behavior.** Is sending continuous **silence** during gaps required to keep the stream alive, or can the sender thread simply pause (stop calling `send`) until more PCM arrives? Affects jitter-buffer design (§3.4).
4. **Chunk size sensitivity.** Confirm 10 ms (320 B) vs 20 ms (640 B) frames produce clean audio; find the largest chunk that stays smooth (fewer calls = less Rosetta overhead). Is there a max `data_length` the SDK accepts per `send()`?
5. **Pacing under Rosetta.** Measure actual jitter; confirm monotonic-clock drift correction is sufficient and there's no chipmunk/choppy artifact under emulation (§6).
6. **PulseAudio sufficiency for send.** Confirm the SDK's mic/audio init succeeds with only the existing null sink (no real/extra capture source), so `bin/entry.sh` needs no change (§5).
7. **Unmute reliability.** Confirm `CanUnMuteBySelf()` / host policy lets the bot unmute itself; otherwise injected audio is silent. Decide behavior if unmute is denied (log + retry vs. give up).
8. **Full-duplex coexistence.** Confirm send (`setExternalAudioSource`) and receive (`subscribe`) on the same `m_audioHelper` coexist without one tearing down the other (the bot likely needs both: hear the room for STT *and* speak TTS).
9. **`send()` thread-safety / which thread.** The working sample confirms calling `send()` from our own detached worker thread (spawned in `onMicStartSend`) works; still confirm no SDK-thread affinity issue under v7.1.0 + Rosetta.
10. **Noise suppression swallowing audio.** Zoom staff flagged that the SDK's noise suppression can make injected audio inaudible (§4 / §10). If TTS is faint/intermittent despite a correct loop, investigate audio-processing settings and signal level.
11. **Real-time pacing is *not* a Zoom-documented rule.** No primary source confirms each `send()` must be wall-clock-paced, and no Linux-send-specific "choppy/sped-up" root-cause thread was found (§3.3). Validate empirically whether unbounded fast pushing of a *live* stream causes latency growth or artifacts, and tune the pacing accordingly.
12. **Mute model.** Confirm `EnableAlwaysMuteMicWhenJoinVoip(true)` mutes only the *physical device* mic (not the participant) so the external source still transmits while `UnMuteAudio(myId)` keeps the participant unmuted.

---

## 10. Sources

**Primary — local SDK headers (authoritative for this build, verified):**
- `lib/zoomsdk/h/rawdata/rawdata_audio_helper_interface.h` — `IZoomSDKAudioRawDataHelper::setExternalAudioSource` (L84), `IZoomSDKVirtualAudioMicEvent` (L43–64), `IZoomSDKAudioRawDataSender::send` (L40, incl. supported sample-rate lists).
- `lib/zoomsdk/h/rawdata/zoom_rawdata_api.h` — `GetAudioRawdataHelper()` (L20), `HasRawdataLicense()` (L17).
- `lib/zoomsdk/h/zoom_sdk_def.h` — `ZoomSDKAudioChannel` enum (L515).
- `lib/zoomsdk/h/zoom_sdk_raw_data_def.h` — `AudioRawData` accessors (`GetBuffer`/`GetBufferLen`/`GetSampleRate`/`GetChannelNum`, L35–53).
- `lib/zoomsdk/h/meeting_service_components/meeting_audio_interface.h` — `IMeetingAudioController` (`JoinVoip` L165, `UnMuteAudio` L189, `CanUnMuteBySelf` L196).
- `lib/zoomsdk/h/meeting_service_components/meeting_participants_ctrl_interface.h` — `GetMySelfUser()` (L525), `GetUserID()` (L101).
- `lib/zoomsdk/h/rawdata/rawdata_video_source_helper_interface.h` — analogous video send interface (pattern reference).

**Local repo (pattern references):**
- `src/raw_send/ZoomSDKVideoSource.{h,cpp}` — existing raw-video send delegate to mirror.
- `src/Zoom.cpp` (`startRawRecording`, L208–301; `JoinVoip` L274; `GetAudioRawdataHelper` L280; commented `UnmuteVideo` loop L262–267) / `src/Zoom.h`.
- `src/raw_record/ZoomSDKAudioRawDataDelegate.{h,cpp}` — existing raw-audio *receive* delegate.
- `src/util/SocketServer.{h,cpp}` — existing AF_UNIX socket pattern for the ingestion reader.
- `bin/entry.sh`, `Dockerfile` — PulseAudio null-sink setup, ALSA/Pulse install, `libmeetingsdk.so.1` rename.

**External — verified (primary example code, official docs, devforum):**

*Example code (mirror these for the implementation):*
- **tanchunsiong/zoom_meetingsdk_linux_rawdatademos** — the working virtual-mic send example. Use this, not the official sample (which has the `pSender_` bug). https://github.com/tanchunsiong/zoom_meetingsdk_linux_rawdatademos
  - `GetRawVideoAndAudioAPIExample/demo/ZoomSDKVirtualAudioMicEvent.cpp` — `onMicInitialize` captures `pSender_`; `onMicStartSend` spawns a detached thread that loops `send()` in 640-byte chunks (48 kHz mono 16-bit).
  - `GetRawVideoAndAudioAPIExample/demo/meeting_sdk_demo.cpp` — `GetAudioRawdataHelper()` → `setExternalAudioSource(...)`; `JoinVoip()` → `UnMuteAudio(getMyself()->GetUserID())`; `EnableAlwaysMuteMicWhenJoinVoip(true)` pre-join.
- **zoom/meetingsdk-linux-raw-recording-sample** (official) — covers **both** receive and send (`SendVideoRawData`/`SendAudioRawData`, `turnOnSendVideoAndAudio()`), plus `demo/setup-pulseaudio.sh` and the `~/.config/zoomus.conf` requirement. ⚠️ Its `ZoomSDKVirtualAudioMicEvent.cpp` has `pSender_ = pSender;` **commented out** in `onMicInitialize` — a known bug that prevents sending. https://github.com/zoom/meetingsdk-linux-raw-recording-sample

*Official API reference (signatures, sample-rate lists, "16-bit", "even length"):*
- `IZoomSDKAudioRawDataSender::send` — https://marketplacefront.zoom.us/sdk/meeting/linux/class_i_zoom_s_d_k_audio_raw_data_sender.html
- `IZoomSDKVirtualAudioMicEvent` — https://marketplacefront.zoom.us/sdk/meeting/linux/class_i_zoom_s_d_k_virtual_audio_mic_event.html
- `IZoomSDKAudioRawDataHelper` — https://marketplacefront.zoom.us/sdk/meeting/linux/class_i_zoom_s_d_k_audio_raw_data_helper.html

*Zoom Developer Forum (devforum.zoom.us):*
- "Meeting SDK Sending Audio raw data" (staff: 16-bit signed mono LE; unmute/JoinVoip; noise-suppression can mute injected audio; push model) — https://devforum.zoom.us/t/meeting-sdk-sending-audio-raw-data/100571
- "Can't receive onMicStartSend … using local_recording token" (staff: order = setExternalAudioSource → JoinVoip → UnMuteAudio; local_recording token blocked audio send, JWT worked; pre-join `EnableAlwaysMuteMicWhenJoinVoip`/auto-join-audio) — https://devforum.zoom.us/t/cant-receive-onmicstartsend-event-when-using-local-recording-token-for-authorization-linux-meeting-sdk/99747
- "Virtual mic not working after upgrade — onMicUninitialized called unexpectedly" (regression at v5.16.5.24346; workaround: mute/unmute twice) — https://devforum.zoom.us/t/upgraded-sdk-virtual-mic-not-working-now-izoomsdkvirtualaudiomicevent-onmicuninitialized-is-called-unexpectedly/114825
- "Switch between raw audio buffers and default mic input" (`setExternalAudioSource(null)` reverts to real mic; *staff reply unverified*) — https://devforum.zoom.us/t/we-want-to-switch-between-using-raw-audio-buffers-and-default-mic-input-after-connecting-with-a-meeting-its-using-mic-by-default/96707
- Changelog Linux 7.0.0 (no virtual-mic changes; OS/`SetBOOption`/share-async breaking changes) — https://devforum.zoom.us/t/changelog-meeting-sdk-linux-7-0-0/142719
- Changelog Linux 7.0.5 (no virtual-mic changes) — https://devforum.zoom.us/t/changelog-meeting-sdk-linux-7-0-5/143799

*Headless PulseAudio setup (same mechanism, Zoom-published):*
- Video SDK raw streaming on Linux — https://developers.zoom.us/blog/video-sdk-raw-streaming-linux/
- PulseAudio setup / troubleshooting — https://github.com/zoom/zoom-plugin/blob/main/skills/video-sdk/linux/troubleshooting/pulseaudio-setup.md

**Not verified from a primary source (flagged in-text):** (1) a Zoom-published rule that `send()` must be paced to the wall clock; (2) a Linux-send-specific root-cause for "sped-up/choppy" audio (the choppy/robotic threads found are Web-SDK / general client, not this raw-send API); (3) staff confirmation on the runtime mic-switching thread. All **SDK API claims** in this document are verified against the local headers and do not depend on these external sources.
