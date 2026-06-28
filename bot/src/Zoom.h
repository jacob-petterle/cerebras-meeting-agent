#ifndef MEETING_SDK_LINUX_SAMPLE_ZOOM_H
#define MEETING_SDK_LINUX_SAMPLE_ZOOM_H

#include <iostream>
#include <chrono>
#include <string>
#include <sstream>

#include <jwt-cpp/jwt.h>

#include "Config.h"
#include "util/Singleton.h"
#include "util/Log.h"


#include "zoom_sdk.h"
#include "rawdata/zoom_rawdata_api.h"
#include "rawdata/rawdata_renderer_interface.h"

#include "meeting_service_components/meeting_audio_interface.h"
#include "meeting_service_components/meeting_participants_ctrl_interface.h"
#include "meeting_service_components/meeting_video_interface.h"
#include "meeting_service_components/meeting_sharing_interface.h"
#include "setting_service_interface.h"

#include "events/AuthServiceEvent.h"
#include "events/MeetingServiceEvent.h"
#include "events/MeetingReminderEvent.h"
#include "events/MeetingRecordingCtrlEvent.h"
#include "events/MeetingShareCtrlEvent.h"

#include "raw_record/ZoomSDKRendererDelegate.h"
#include "raw_record/ZoomSDKAudioRawDataDelegate.h"

#include "raw_send/ZoomSDKVideoSource.h"
#include "raw_send/ZoomSDKShareSource.h"
#include "raw_send/ZoomSDKVirtualAudioMicEvent.h"

#include "util/TCPSocketServer.h"

using namespace std;
using namespace jwt;
using namespace ZOOMSDK;

typedef chrono::time_point<chrono::system_clock> time_point;

class Zoom : public Singleton<Zoom> {

    friend class Singleton<Zoom>;

    Config m_config;

    string m_jwt;

    time_point m_iat;
    time_point m_exp;

    IMeetingService* m_meetingService;
    ISettingService* m_settingService;
    IAuthService* m_authService;

    IZoomSDKRenderer* m_videoHelper;
    ZoomSDKRendererDelegate* m_renderDelegate;

    IZoomSDKAudioRawDataHelper* m_audioHelper;
    ZoomSDKAudioRawDataDelegate* m_audioSource;

    ZoomSDKVideoSource* m_videoSource;

    // Screen-share (raw external source) path.
    IZoomSDKShareSourceHelper* m_shareHelper{nullptr};
    ZoomSDKShareSource* m_shareSource{nullptr};

    // TTS virtual-microphone (audio SEND) path.
    ZoomSDKVirtualAudioMicEvent* m_micSource = nullptr;
    TCPSocketServer*             m_audioServer = nullptr;

    SDKError createServices();
    void generateJWT(const string& key, const string& secret);

    /**
     * Callback fired when the SDK authenticates the credentials
    */
    function<void()> onAuth = [&]() {
        auto e = isMeetingStart() ? start() : join();
        string action = isMeetingStart() ? "start" : "join";
        
        if(hasError(e, action + " a meeting")) exit(e);
    };

    /**
     * Callback fires when the app joins the meeting
    */
    function<void()> onJoin = [&]() {
        auto* reminderController = m_meetingService->GetMeetingReminderController();
        reminderController->SetEvent(new MeetingReminderEvent());

        // Audio SEND (virtual mic) needs only in-meeting + VoIP + unmute — no
        // recording privilege — so it's set up independently of raw recording.
        if (m_config.sendAudio())
            startAudioSend();

        // Screen share is also independent of raw recording, so start it before
        // the recording early-return below.
        if (m_config.useScreenShare())
            startScreenShare();

        if (!m_config.useRawRecording())
            return;


        function<void(bool)> onRecordingPrivilegeChanged = [&](bool canRec) {
            if (!canRec) {
                Log::error("Failed to get recording privilege");
                return;
            }

            startRawRecording();
        };

        auto recCtl = m_meetingService->GetMeetingRecordingController();
        auto recordingEvent = new MeetingRecordingCtrlEvent(onRecordingPrivilegeChanged);
        recCtl->SetEvent(recordingEvent);

        SDKError err = recCtl->CanStartRawRecording();

        if (hasError(err)) {
            Log::info("requesting local recording privilege");
            recCtl->RequestLocalRecordingPrivilege();
        }
    };

public:
    Zoom() {};
    SDKError init();
    SDKError auth();
    SDKError config(int ac, char** av);

    SDKError join();
    SDKError start();
    SDKError leave();

    SDKError clean();

    SDKError startRawRecording();
    SDKError stopRawRecording();

    SDKError startScreenShare();
    SDKError stopScreenShare();

    SDKError startAudioSend();

    bool isMeetingStart();

    static bool hasError(SDKError e, const string& action="");

};

#endif //MEETING_SDK_LINUX_SAMPLE_ZOOM_H
