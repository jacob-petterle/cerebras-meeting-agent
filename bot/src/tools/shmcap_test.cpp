// shmcap_test — standalone proof that the stage-capture path works.
//
// Opens $DISPLAY (default :99), XShm-grabs the root window, reports the frame's
// mean BGR (so a black/empty grab is obvious), and writes a PNG. This is the
// build-time/runtime verification called for by SCREENSHARE/STAGE_PAGE research:
// "verify Chromium starts on :99 and you can XShmGetImage a non-black frame."
// It deliberately does NOT link the Zoom SDK — it exercises only the capture +
// BGRA->BGR conversion that ZoomSDKShareSource uses in stage mode.
//
// Usage: shmcap_test [output.png]   (default out/stage_capture_test.png)

#include <opencv2/opencv.hpp>

#include <sys/ipc.h>
#include <sys/shm.h>
#include <X11/Xlib.h>
#include <X11/Xutil.h>
#include <X11/extensions/XShm.h>

#include <cstdio>
#include <cstdlib>
#include <string>

int main(int argc, char** argv) {
    const char* dispEnv = getenv("DISPLAY");
    const std::string display = (dispEnv && *dispEnv) ? dispEnv : ":99";
    const std::string out = (argc > 1) ? argv[1] : "out/stage_capture_test.png";

    Display* d = XOpenDisplay(display.c_str());
    if (!d) {
        fprintf(stderr, "shmcap_test: cannot open display %s\n", display.c_str());
        return 1;
    }
    if (!XShmQueryExtension(d)) {
        fprintf(stderr, "shmcap_test: MIT-SHM not available on %s\n", display.c_str());
        XCloseDisplay(d);
        return 2;
    }

    const int screen = DefaultScreen(d);
    const Window root = RootWindow(d, screen);

    XWindowAttributes attr;
    XGetWindowAttributes(d, root, &attr);

    XShmSegmentInfo shm{};
    XImage* img = XShmCreateImage(d, attr.visual, attr.depth, ZPixmap, nullptr,
                                  &shm, attr.width, attr.height);
    if (!img) {
        fprintf(stderr, "shmcap_test: XShmCreateImage failed\n");
        XCloseDisplay(d);
        return 3;
    }

    shm.shmid = shmget(IPC_PRIVATE,
                       static_cast<size_t>(img->bytes_per_line) * img->height,
                       IPC_CREAT | 0600);
    shm.shmaddr = img->data = static_cast<char*>(shmat(shm.shmid, nullptr, 0));
    shm.readOnly = False;
    XShmAttach(d, &shm);
    XSync(d, False);

    int rc = 0;
    if (!XShmGetImage(d, root, img, 0, 0, AllPlanes)) {
        fprintf(stderr, "shmcap_test: XShmGetImage failed\n");
        rc = 4;
    } else {
        cv::Mat bgra(attr.height, attr.width, CV_8UC4, img->data, img->bytes_per_line);
        cv::Mat bgr;
        cv::cvtColor(bgra, bgr, cv::COLOR_BGRA2BGR);

        const cv::Scalar m = cv::mean(bgr);
        printf("shmcap_test: captured %dx%d depth=%d  mean BGR=(%.1f, %.1f, %.1f)\n",
               attr.width, attr.height, attr.depth, m[0], m[1], m[2]);

        if (cv::imwrite(out, bgr)) {
            printf("shmcap_test: wrote %s\n", out.c_str());
        } else {
            fprintf(stderr, "shmcap_test: imwrite to %s failed\n", out.c_str());
            rc = 5;
        }
    }

    XShmDetach(d, &shm);
    img->data = nullptr;  // shm-backed, not malloc'd
    XDestroyImage(img);
    shmdt(shm.shmaddr);
    shmctl(shm.shmid, IPC_RMID, nullptr);
    XCloseDisplay(d);

    return rc;
}
