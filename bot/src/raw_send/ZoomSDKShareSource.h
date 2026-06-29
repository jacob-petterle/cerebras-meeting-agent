
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
 * External raw screen-share source (SCREENSHARE approach A) with two frame
 * sources, selected by the SHARE_MODE env var:
 *
 *   SHARE_MODE=stage (default) — capture a headed Chromium "stage page" that is
 *       drawing onto the Xvfb display ($DISPLAY, default :99). Each frame the
 *       producer grabs the root window via a persistent XShm segment (BGRA),
 *       converts BGRA->I420 with OpenCV, and pushes it via sendShareFrame. This
 *       is the STAGE_PAGE_RESEARCH.md "capture -> raw-push" pipeline.
 *
 *   SHARE_MODE=text — the original fallback: re-read out/share_text.txt every
 *       frame and render it word-wrapped on a dark canvas via cv::putText.
 *
 * If stage mode is requested but the X display / XShm capture can't be set up
 * (no Xvfb, headers/ext missing, Chromium dead), the producer logs once and
 * degrades to the text renderer rather than sending nothing — so there is
 * always *some* visible share.
 *
 * Transport is unchanged from the text-only version: the SDK hands us an
 * IZoomSDKShareSender via onStartSend (asynchronous as of Meeting SDK v7.0.0,
 * so we must NOT block in the callback). We stash the sender and signal a
 * dedicated producer thread that owns the sendShareFrame cadence. All Xlib/XShm
 * state lives behind an opaque XShmCapture (defined in the .cpp) so Xlib's
 * macros (None/Bool/Status) never leak into the SDK/OpenCV translation units.
 */
class ZoomSDKShareSource : public IZoomSDKShareSource {

public:
    enum class Mode { Stage, Text };

private:
    // Set by onStartSend, cleared by onStopSend. Only touched on the SDK
    // callback thread before/after the producer thread runs, so the atomic flag
    // below is what gates the producer's access to it.
    IZoomSDKShareSender* m_shareSender{nullptr};

    atomic<bool> m_isSending{false};
    thread m_producer;

    int m_width;
    int m_height;
    int m_fps;

    Mode m_mode;

    // X display to capture in stage mode (e.g. ":99"); from $DISPLAY.
    string m_display;

    // Opaque XShm capture state (Xlib types kept out of this header).
    struct XShmCapture;
    XShmCapture* m_capture{nullptr};

    // Path the producer re-reads every frame for the text to render (text mode,
    // and the stage-mode fallback). Relative to the bot's working directory.
    string m_textPath;

    /**
     * Producer-thread body: builds and pushes the current frame until
     * m_isSending goes false. Owns all sendShareFrame calls.
     */
    void produceFrames();

    /**
     * Set up (or tear down) the XShm capture against m_display. initCapture
     * returns false if no X display / extension / segment could be obtained;
     * the producer then falls back to text rendering. Both run on the producer
     * thread so all Xlib calls stay single-threaded.
     */
    bool initCapture();
    void teardownCapture();

    /**
     * Grab one frame of the Xvfb root window into outBgr (BGR, m_width x
     * m_height). Returns false on a capture error (the producer then falls back
     * to text for that frame). Reuses the persistent XShm segment.
     */
    bool captureFrame(cv::Mat& outBgr);

    /** Read m_textPath best-effort; returns "" if missing/empty/unreadable. */
    string readShareText() const;

    /**
     * Render the given text word-wrapped + high-contrast on a dark canvas.
     * Empty text -> a neutral "listening…" placeholder. The footer shows the
     * frame counter / elapsed time so a viewer can confirm the feed is live.
     */
    cv::Mat renderFrame(const string& text, uint64_t frameNumber, double elapsedSeconds) const;

public:
    explicit ZoomSDKShareSource(int width = 1280, int height = 720, int fps = 10,
                                string textPath = "out/share_text.txt");
    ~ZoomSDKShareSource();

    // IZoomSDKShareSource
    void onStartSend(IZoomSDKShareSender* pSender) override;
    void onStopSend() override;

    /** Stops the producer thread if running (idempotent). */
    void stop();

    bool isSending() const;

    Mode mode() const { return m_mode; }
};


#endif //MEETINGSDK_HEADLESS_LINUX_SAMPLE_ZOOMSDKSHARESOURCE_H
