
#ifndef MEETINGSDK_HEADLESS_LINUX_SAMPLE_ZOOMSDKSHARESOURCE_H
#define MEETINGSDK_HEADLESS_LINUX_SAMPLE_ZOOMSDKSHARESOURCE_H

#include <atomic>
#include <string>
#include <thread>

#include <opencv2/opencv.hpp>

#include "rawdata/rawdata_share_source_helper_interface.h"
#include "../util/Log.h"

using namespace ZOOMSDK;
using namespace std;

/**
 * External raw screen-share source (approach A) that renders LIVE text.
 *
 * Mirrors ZoomSDKVideoSource but for the share path. The SDK hands us an
 * IZoomSDKShareSender via onStartSend (asynchronous as of Meeting SDK v7.0.0,
 * so we must NOT block in the callback). We stash the sender and signal a
 * dedicated producer thread that owns the sendShareFrame cadence.
 *
 * Each frame the producer re-reads a bind-mounted text file (out/share_text.txt
 * by default — the Mac orchestrator writes the echo response there) and renders
 * it word-wrapped, high-contrast on a dark 1280x720 canvas via cv::putText. An
 * empty or missing file shows a neutral "listening…" placeholder. This is what
 * the demo SHARES into the meeting: the same text the bot speaks.
 *
 * A small live footer (elapsed clock + frame counter) proves the feed is moving
 * rather than a stuck frame — useful for the documented "blank share" risk,
 * where sendShareFrame can return SDKERR_SUCCESS while participants see nothing.
 */
class ZoomSDKShareSource : public IZoomSDKShareSource {

    // Set by onStartSend, cleared by onStopSend. Only touched on the SDK
    // callback thread before/after the producer thread runs, so the atomic flag
    // below is what gates the producer's access to it.
    IZoomSDKShareSender* m_shareSender{nullptr};

    atomic<bool> m_isSending{false};
    thread m_producer;

    int m_width;
    int m_height;
    int m_fps;

    // Path the producer re-reads every frame for the text to render. Relative
    // to the bot's working directory (the bind-mounted repo root in-container),
    // so it resolves to the same out/share_text.txt the Mac writes.
    string m_textPath;

    /**
     * Producer-thread body: builds and pushes the current text frame until
     * m_isSending goes false. Owns all sendShareFrame calls.
     */
    void produceFrames();

    /** Read m_textPath best-effort; returns "" if missing/empty/unreadable. */
    string readShareText() const;

    /**
     * Render the given text word-wrapped + high-contrast on a dark canvas.
     * Empty text -> a neutral "listening…" placeholder. The footer shows the
     * frame counter / elapsed time so a viewer can confirm the feed is live.
     */
    cv::Mat renderFrame(const string& text, uint64_t frameNumber, double elapsedSeconds) const;

public:
    explicit ZoomSDKShareSource(int width = 1280, int height = 720, int fps = 8,
                                string textPath = "out/share_text.txt");
    ~ZoomSDKShareSource();

    // IZoomSDKShareSource
    void onStartSend(IZoomSDKShareSender* pSender) override;
    void onStopSend() override;

    /** Stops the producer thread if running (idempotent). */
    void stop();

    bool isSending() const;
};


#endif //MEETINGSDK_HEADLESS_LINUX_SAMPLE_ZOOMSDKSHARESOURCE_H
