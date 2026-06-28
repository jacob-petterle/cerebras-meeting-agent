
#include "ZoomSDKShareSource.h"

#include <algorithm>
#include <chrono>
#include <cmath>
#include <fstream>
#include <iomanip>
#include <sstream>
#include <vector>

ZoomSDKShareSource::ZoomSDKShareSource(int width, int height, int fps, string textPath)
    : m_width(width), m_height(height), m_fps(fps > 0 ? fps : 8),
      m_textPath(move(textPath)) {}

ZoomSDKShareSource::~ZoomSDKShareSource() {
    stop();
}

bool ZoomSDKShareSource::isSending() const {
    return m_isSending.load();
}

void ZoomSDKShareSource::onStartSend(IZoomSDKShareSender* pSender) {
    // v7.0.0: this callback is asynchronous — do NOT block or push frames here.
    // Stash the sender and hand the cadence off to the producer thread.
    if (!pSender) {
        Log::error("onStartSend called with null sender");
        return;
    }

    if (m_isSending.load()) {
        Log::info("onStartSend fired while already sending; ignoring");
        return;
    }

    m_shareSender = pSender;
    m_isSending.store(true);
    m_producer = thread(&ZoomSDKShareSource::produceFrames, this);

    Log::success("share onStartSend: producer thread started");
}

void ZoomSDKShareSource::onStopSend() {
    Log::info("share onStopSend");
    stop();
}

void ZoomSDKShareSource::stop() {
    if (!m_isSending.exchange(false)) {
        // Already stopped; still make sure any finished thread is joined.
        if (m_producer.joinable())
            m_producer.join();
        return;
    }

    if (m_producer.joinable())
        m_producer.join();

    m_shareSender = nullptr;
}

string ZoomSDKShareSource::readShareText() const {
    // Best-effort read every frame. The Mac writes this file atomically
    // (temp + rename) so we never observe a torn write; a missing file simply
    // means "nothing to say yet" -> placeholder.
    ifstream in(m_textPath, ios::binary);
    if (!in)
        return "";

    stringstream ss;
    ss << in.rdbuf();
    string text = ss.str();

    // Collapse all whitespace (incl. newlines) to single spaces and trim, so
    // wrapping is purely width-driven and a trailing newline doesn't matter.
    string collapsed;
    collapsed.reserve(text.size());
    bool inSpace = true;  // leading-space trim
    for (char c : text) {
        if (c == ' ' || c == '\t' || c == '\n' || c == '\r' || c == '\f' || c == '\v') {
            if (!inSpace) {
                collapsed.push_back(' ');
                inSpace = true;
            }
        } else {
            collapsed.push_back(c);
            inSpace = false;
        }
    }
    while (!collapsed.empty() && collapsed.back() == ' ')
        collapsed.pop_back();

    // Cap pathological inputs so one bad write can't blow up rendering.
    constexpr size_t kMaxChars = 2000;
    if (collapsed.size() > kMaxChars)
        collapsed.resize(kMaxChars);

    return collapsed;
}

namespace {
    // Greedy word-wrap: pack words into lines no wider than maxWidth at the
    // given font/scale/thickness. A single over-long word gets its own line.
    vector<string> wrapText(const string& text, int fontFace, double fontScale,
                            int thickness, int maxWidth) {
        vector<string> lines;
        istringstream words(text);
        string word, line;

        auto lineWidth = [&](const string& s) {
            int baseline = 0;
            return cv::getTextSize(s, fontFace, fontScale, thickness, &baseline).width;
        };

        while (words >> word) {
            if (line.empty()) {
                line = word;
                continue;
            }
            string candidate = line + " " + word;
            if (lineWidth(candidate) <= maxWidth) {
                line = candidate;
            } else {
                lines.push_back(line);
                line = word;
            }
        }
        if (!line.empty())
            lines.push_back(line);
        return lines;
    }
}

cv::Mat ZoomSDKShareSource::renderFrame(const string& text, uint64_t frameNumber,
                                        double elapsedSeconds) const {
    // Dark, near-neutral background for maximum contrast with white text.
    cv::Mat bgr(m_height, m_width, CV_8UC3, cv::Scalar(35, 30, 28));

    // Border so the edges of the shared surface are obvious to a viewer.
    cv::rectangle(bgr, cv::Point(8, 8), cv::Point(m_width - 8, m_height - 8),
                  cv::Scalar(90, 80, 75), 3);

    const int font = cv::FONT_HERSHEY_SIMPLEX;
    const int margin = 60;
    const int maxTextWidth = m_width - 2 * margin;

    // Header label (muted) so it's clear what this surface is.
    cv::putText(bgr, "ZOOM BOT - live share", cv::Point(margin, 70),
                font, 0.9, cv::Scalar(150, 200, 120), 2, cv::LINE_AA);

    // Main content region (between header and footer).
    const int yTop = 120;
    const int yBottom = m_height - 90;
    const int availHeight = yBottom - yTop;

    const bool placeholder = text.empty();
    const string content = placeholder ? "listening" : text;
    const cv::Scalar textColor = placeholder ? cv::Scalar(150, 150, 150)
                                             : cv::Scalar(255, 255, 255);
    const int thickness = placeholder ? 2 : 3;

    // Auto-fit: shrink the font scale until the wrapped block fits vertically,
    // so a long echo sentence stays on-screen and a short one stays large.
    double scale = placeholder ? 2.2 : 2.0;
    const double minScale = 0.7;
    vector<string> lines;
    int lineHeight = 0;
    for (; scale >= minScale; scale -= 0.1) {
        lines = wrapText(content, font, scale, thickness, maxTextWidth);
        int baseline = 0;
        cv::Size sz = cv::getTextSize("Ayg", font, scale, thickness, &baseline);
        lineHeight = sz.height + baseline + static_cast<int>(scale * 16);  // + line spacing
        if (static_cast<int>(lines.size()) * lineHeight <= availHeight)
            break;
    }

    if (placeholder)
        lines = {"listening..."};

    // Vertically center the block within the content region; center each line
    // horizontally for a balanced "card" look.
    const int blockHeight = static_cast<int>(lines.size()) * lineHeight;
    int y = yTop + max(0, (availHeight - blockHeight) / 2) + static_cast<int>(scale * 36);
    for (const auto& l : lines) {
        int baseline = 0;
        cv::Size sz = cv::getTextSize(l, font, scale, thickness, &baseline);
        int x = max(margin, (m_width - sz.width) / 2);
        cv::putText(bgr, l, cv::Point(x, y), font, scale, textColor, thickness, cv::LINE_AA);
        y += lineHeight;
    }

    // Live footer: elapsed clock + frame counter prove the feed is moving (not a
    // stuck frame), plus a moving accent bar visible from across a room.
    ostringstream footer;
    footer << "t = " << fixed << setprecision(1) << elapsedSeconds
           << " s   frame #" << frameNumber;
    cv::putText(bgr, footer.str(), cv::Point(margin, m_height - 40),
                font, 0.7, cv::Scalar(140, 140, 140), 2, cv::LINE_AA);

    int barX = static_cast<int>((std::sin(elapsedSeconds) * 0.5 + 0.5) * (m_width - 200 - margin)) + margin;
    cv::rectangle(bgr, cv::Point(barX, m_height - 30), cv::Point(barX + 140, m_height - 20),
                  cv::Scalar(120, 200, 255), cv::FILLED);

    return bgr;
}

void ZoomSDKShareSource::produceFrames() {
    using namespace std::chrono;

    const auto start = steady_clock::now();
    const auto frameInterval = duration_cast<steady_clock::duration>(duration<double>(1.0 / m_fps));
    const int frameLength = m_width * m_height * 3 / 2;  // packed I420 length

    Log::info("share producer: " + std::to_string(m_width) + "x" + std::to_string(m_height) +
              " @ " + std::to_string(m_fps) + " fps, text=" + m_textPath);

    uint64_t frameNumber = 0;
    auto nextFrame = start;

    cv::Mat i420;  // reused across iterations

    while (m_isSending.load()) {
        const double elapsed = duration<double>(steady_clock::now() - start).count();

        const string text = readShareText();
        cv::Mat bgr = renderFrame(text, frameNumber, elapsed);
        cv::cvtColor(bgr, i420, cv::COLOR_BGR2YUV_I420);  // contiguous I420, len = w*h*3/2

        if (m_shareSender) {
            auto err = m_shareSender->sendShareFrame(
                reinterpret_cast<char*>(i420.data),
                m_width, m_height, frameLength, FrameDataFormat_I420_FULL);

            // SUCCESS only means the SDK accepted the buffer, not that anyone
            // sees it — visibility is the manual spike. Log only the first
            // failure to avoid flooding at fps cadence.
            if (err != SDKERR_SUCCESS && frameNumber == 0)
                Log::error("sendShareFrame failed with status " + std::to_string(err));
        }

        ++frameNumber;

        // Monotonic pacing: advance the target by one interval and sleep to it,
        // catching up if we fell behind rather than drifting.
        nextFrame += frameInterval;
        std::this_thread::sleep_until(nextFrame);
    }

    Log::info("share producer: stopped after " + std::to_string(frameNumber) + " frames");
}
