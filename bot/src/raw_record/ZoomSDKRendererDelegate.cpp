#include "ZoomSDKRendererDelegate.h"


ZoomSDKRendererDelegate::ZoomSDKRendererDelegate() {
    if (!m_cascade.load("/usr/share/opencv4/haarcascades/haarcascade_frontalface_default.xml"))
        Log::error("failed to load cascade file");

    m_faces.reserve(2);
}

ZoomSDKRendererDelegate::~ZoomSDKRendererDelegate() {
    if (m_videoWriter.isOpened()) {
        m_videoWriter.release();
    }
}


void ZoomSDKRendererDelegate::initializeVideoWriter(int frameWidth, int frameHeight, double fps) {
    int fourcc = VideoWriter::fourcc('a','v','c','1');
    std::string filename = "out/" + m_filename;
    m_videoWriter.open(filename, fourcc, fps, Size(frameWidth, frameHeight), true);
}

void ZoomSDKRendererDelegate::onRawDataFrameReceived(YUVRawDataI420 *data)
{
    if (!m_videoWriter.isOpened()) {
        initializeVideoWriter(data->GetStreamWidth(), data->GetStreamHeight(), 30);
    }

    auto res = async(launch::async, [&]{
        Mat I420(data->GetStreamHeight() * 3/2, data->GetStreamWidth(), CV_8UC1, data->GetBuffer());
        Mat small, gray;

        cvtColor(I420, gray, COLOR_YUV2GRAY_I420);
        resize(gray, small, Size(), m_fx, m_fx, INTER_LINEAR);
        equalizeHist(small, small);

        m_cascade.detectMultiScale(small, m_faces, 1.1, 2, 0|CASCADE_SCALE_IMAGE, Size(30, 30));

        Scalar color = Scalar(0, 0, 255);
        for (size_t i = 0; i < m_faces.size(); i++) {
            Rect r = m_faces[i];
            rectangle(gray, Point(cvRound(r.x*m_scale), cvRound(r.y*m_scale)),
                        Point(cvRound((r.x + r.width-1)*m_scale),
                            cvRound((r.y + r.height-1)*m_scale)), color, 3, 8, 0);
        }

        if (m_videoWriter.isOpened()) {
            Mat colorFrame;
            cvtColor(gray, colorFrame, COLOR_GRAY2BGR);
            m_videoWriter.write(colorFrame);
        }
    });
}



void ZoomSDKRendererDelegate::writeToFile(const string &path, YUVRawDataI420 *data)
{

	std::ofstream file(path, std::ios::out | std::ios::binary | std::ios::app);
	if (!file.is_open())
        return Log::error("failed to open video output file: " + path);

	file.write(data->GetBuffer(), data->GetBufferLen());

	file.close();
	file.flush();
}

string ZoomSDKRendererDelegate::dir() const {
    return m_dir;
}
void ZoomSDKRendererDelegate::setDir(const string &dir)
{
    m_dir = dir;
}

string ZoomSDKRendererDelegate::filename() const
{
    return m_filename;
}

void ZoomSDKRendererDelegate::setFilename(const string &filename)
{
    m_filename = filename;
}
