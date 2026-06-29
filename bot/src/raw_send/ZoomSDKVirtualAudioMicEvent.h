
#ifndef MEETINGSDK_HEADLESS_LINUX_SAMPLE_ZOOMSDKVIRTUALAUDIOMICEVENT_H
#define MEETINGSDK_HEADLESS_LINUX_SAMPLE_ZOOMSDKVIRTUALAUDIOMICEVENT_H

#include <atomic>
#include <cstddef>
#include <deque>
#include <mutex>
#include <thread>
#include <vector>

#include "rawdata/rawdata_audio_helper_interface.h"
#include "../util/Log.h"

using namespace ZOOMSDK;
using namespace std;

/**
 * Virtual microphone source for the bot.
 *
 * Implements the SDK's PUSH model: the SDK hands us a sender in onMicInitialize
 * and gates sending with onMicStartSend/onMicStopSend. We own a paced sender
 * thread that drains a bounded jitter buffer (fed by the TCP ingestion reader)
 * and calls IZoomSDKAudioRawDataSender::send() one 20 ms frame at a time.
 *
 * Audio format is fixed across the whole transport lane: 32,000 Hz, mono,
 * signed 16-bit little-endian PCM (see TRANSPORT_SHIM_PLAN.md §3 Seam B).
 *
 * Mirrors the shape of ZoomSDKVideoSource, and mirrors tanchunsiong's working
 * example (NOT the official sample, whose pSender capture is commented out so
 * its mic never sends).
 */
class ZoomSDKVirtualAudioMicEvent : public IZoomSDKVirtualAudioMicEvent {
public:
    // Locked audio format (see TRANSPORT_SHIM_PLAN.md).
    static constexpr int      c_sampleRate   = 32000;             // Hz, mono
    static constexpr int      c_bytesPerSample = 2;               // s16le
    // 20 ms frame = 640 samples = 1280 bytes @ 32 kHz mono s16le.
    static constexpr size_t   c_frameBytes   = 1280;
    static constexpr int      c_frameMillis  = 20;
    // Bounded jitter buffer. 32 kHz * 2 bytes = 64,000 B/s, so 1 ms = 64 B.
    // Cap ~600 ms so the brain can run a cushion ahead and bursts aren't dropped;
    // oldest bytes are still trimmed past this to bound worst-case latency.
    static constexpr size_t   c_maxBufferBytes = 38400;   // ~600 ms
    // PRE-FILL (low-watermark): once primed we emit real audio, but after the
    // buffer runs dry we re-prime — holding silence until ~120 ms is buffered —
    // instead of dribbling silence frame-by-frame. This cushion absorbs delivery
    // jitter (loaded brain event loop + Rosetta CPU contention) that otherwise
    // underran the old zero-cushion buffer and dropped the agent's voice to
    // silence mid-utterance. ~120 ms = 6 frames = 7,680 B.
    static constexpr size_t   c_prefillBytes = 7680;       // ~120 ms

    ZoomSDKVirtualAudioMicEvent() = default;
    ~ZoomSDKVirtualAudioMicEvent();

    // IZoomSDKVirtualAudioMicEvent
    void onMicInitialize(IZoomSDKAudioRawDataSender* pSender) override;
    void onMicStartSend() override;
    void onMicStopSend() override;
    void onMicUninitialized() override;

    /**
     * Append raw PCM bytes to the jitter buffer. Called by the ingestion reader
     * thread. Input must be 32 kHz mono s16le and 2-byte-sample aligned.
     * Oldest bytes are dropped if the buffer is over capacity (bound latency).
     */
    void enqueuePCM(const char* data, size_t len);

    // Stop and join the sender thread (used on teardown). Idempotent.
    void stop();

private:
    void senderLoop();

    // Fill exactly c_frameBytes into out. Honors the pre-fill gate: emits silence
    // while priming (until c_prefillBytes buffered), then real audio; on a dry
    // buffer it re-arms priming. Zero-pads any partial underrun frame.
    void popFrame(char* out, size_t len);

    // Set by the SDK thread (onMicInitialize/onMicUninitialized), read by the
    // sender thread — atomic so the cross-thread handoff is a defined operation.
    atomic<IZoomSDKAudioRawDataSender*> m_pSender{nullptr};

    atomic<bool> m_canSend{false};   // gated by onMicStartSend/onMicStopSend
    atomic<bool> m_running{false};   // sender thread lifetime
    thread       m_senderThread;

    // Serializes thread spawn (onMicStartSend) against teardown (stop), and
    // guards m_stopped so a start can't race a stop into an unjoinable thread.
    mutex        m_lifecycleMutex;
    bool         m_stopped = false;  // no (re)spawn allowed once stopped

    mutex        m_bufMutex;
    deque<char>  m_pcm;              // 32 kHz mono s16le jitter buffer
    // Playback state under m_bufMutex: false = priming (emit silence until the
    // pre-fill cushion is buffered), true = draining real audio. Starts priming;
    // re-armed to false whenever the buffer runs dry (see popFrame).
    bool         m_playing = false;
};

#endif //MEETINGSDK_HEADLESS_LINUX_SAMPLE_ZOOMSDKVIRTUALAUDIOMICEVENT_H
