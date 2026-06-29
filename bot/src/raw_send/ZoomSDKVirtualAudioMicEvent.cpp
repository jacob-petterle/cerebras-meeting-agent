
#include "ZoomSDKVirtualAudioMicEvent.h"

#include <algorithm>
#include <chrono>
#include <cstring>
#include <sstream>

ZoomSDKVirtualAudioMicEvent::~ZoomSDKVirtualAudioMicEvent() {
    stop();
}

void ZoomSDKVirtualAudioMicEvent::onMicInitialize(IZoomSDKAudioRawDataSender* pSender) {
    // Stash the sender. (The official sample leaves this commented out, which is
    // why its virtual mic never sends — do not copy that bug.)
    {
        // Re-arm for this session: a prior onMicUninitialized may have stopped us.
        lock_guard<mutex> lock(m_lifecycleMutex);
        m_stopped = false;
    }
    m_pSender.store(pSender, memory_order_release);
    Log::success("virtual mic onMicInitialize");
}

void ZoomSDKVirtualAudioMicEvent::onMicStartSend() {
    Log::info("virtual mic onMicStartSend — sending enabled");
    m_canSend = true;

    // Start the paced sender thread once; subsequent start/stop just toggle the
    // gate. Hold the lifecycle lock so this can't race teardown into spawning a
    // thread that never gets joined.
    lock_guard<mutex> lock(m_lifecycleMutex);
    if (!m_stopped && !m_running.exchange(true))
        m_senderThread = thread(&ZoomSDKVirtualAudioMicEvent::senderLoop, this);
}

void ZoomSDKVirtualAudioMicEvent::onMicStopSend() {
    Log::info("virtual mic onMicStopSend — sending paused");
    m_canSend = false;
}

void ZoomSDKVirtualAudioMicEvent::onMicUninitialized() {
    Log::info("virtual mic onMicUninitialized");
    stop();
    m_pSender.store(nullptr, memory_order_release);
}

void ZoomSDKVirtualAudioMicEvent::enqueuePCM(const char* data, size_t len) {
    if (!data || len == 0)
        return;

    lock_guard<mutex> lock(m_bufMutex);
    m_pcm.insert(m_pcm.end(), data, data + len);

    // Bound latency: drop oldest bytes if we exceed the jitter-buffer cap.
    if (m_pcm.size() > c_maxBufferBytes) {
        auto overflow = m_pcm.size() - c_maxBufferBytes;
        m_pcm.erase(m_pcm.begin(), m_pcm.begin() + overflow);
    }
}

void ZoomSDKVirtualAudioMicEvent::popFrame(char* out, size_t len) {
    lock_guard<mutex> lock(m_bufMutex);
    size_t available = min(len, m_pcm.size());
    for (size_t i = 0; i < available; ++i)
        out[i] = m_pcm[i];
    if (available)
        m_pcm.erase(m_pcm.begin(), m_pcm.begin() + available);
    // Underrun: pad the rest of the frame with silence to keep the VoIP stream
    // continuous rather than stalling the encoder.
    if (available < len)
        memset(out + available, 0, len - available);
}

void ZoomSDKVirtualAudioMicEvent::senderLoop() {
    Log::info("virtual mic sender thread started");

    using clock = chrono::steady_clock;
    const auto framePeriod = chrono::microseconds(c_frameMillis * 1000);

    vector<char> frame(c_frameBytes);
    auto nextSend = clock::now();
    bool sendErrorLogged = false;   // throttle: log a send-error streak once

    while (m_running) {
        auto* sender = m_pSender.load(memory_order_acquire);
        if (m_canSend && sender) {
            popFrame(frame.data(), c_frameBytes);

            auto err = sender->send(frame.data(), c_frameBytes,
                                    c_sampleRate, ZoomSDKAudioChannel_Mono);
            // Never exit() on a transient send error (contrast SocketServer::writeBuf).
            // Log only the start of an error streak so a persistent failure
            // doesn't flood the log at the 50 Hz frame rate.
            if (err != SDKERR_SUCCESS) {
                if (!sendErrorLogged) {
                    stringstream ss;
                    ss << "virtual mic send failed with status " << err;
                    Log::error(ss.str());
                    sendErrorLogged = true;
                }
            } else {
                sendErrorLogged = false;
            }
        }

        // Pace against a monotonic clock with drift correction: advance the
        // target by one frame period each iteration. If we fall behind (e.g. a
        // Rosetta scheduling stall), resync to "now" instead of spiraling.
        nextSend += framePeriod;
        auto now = clock::now();
        if (nextSend > now)
            this_thread::sleep_until(nextSend);
        else
            nextSend = now;
    }

    Log::info("virtual mic sender thread stopped");
}

void ZoomSDKVirtualAudioMicEvent::stop() {
    lock_guard<mutex> lock(m_lifecycleMutex);
    m_stopped = true;   // block any concurrent/subsequent onMicStartSend spawn
    m_canSend = false;
    // Join under the lock: the sender thread never takes m_lifecycleMutex, so
    // this cannot deadlock, and it keeps spawn/join mutually exclusive.
    if (m_running.exchange(false) && m_senderThread.joinable())
        m_senderThread.join();
}
