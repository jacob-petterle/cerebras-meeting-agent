#include "Zoom.h"

SDKError Zoom::config(int ac, char** av) {
    auto status = m_config.read(ac, av);
    if (status) {
        Log::error("failed to read configuration");
        return SDKERR_INTERNAL_ERROR;
    }

    return SDKERR_SUCCESS;
}

SDKError Zoom::init() { 
    InitParam initParam;

    auto host = m_config.zoomHost().c_str();

    initParam.strWebDomain = host;
    initParam.strSupportUrl = host;

    initParam.emLanguageID = LANGUAGE_English;

    initParam.enableLogByDefault = true;
    initParam.enableGenerateDump = true;

    auto err = InitSDK(initParam);
    if (hasError(err)) {
        Log::error("InitSDK failed");
        return err;
    }

    return createServices();
}

SDKError Zoom::createServices() {
    auto err = CreateMeetingService(&m_meetingService);
    if (hasError(err)) return err;

    err = CreateSettingService(&m_settingService);
    if (hasError(err)) return err;

    auto meetingServiceEvent = new MeetingServiceEvent();
    meetingServiceEvent->setOnMeetingJoin(onJoin);

    err = m_meetingService->SetEvent(meetingServiceEvent);
    if (hasError(err)) return err;

    return CreateAuthService(&m_authService);
}

SDKError Zoom::auth() {
    SDKError err{SDKERR_UNINITIALIZE};

    auto id = m_config.clientId();
    auto secret = m_config.clientSecret();

    if (id.empty()) {
        Log::error("Client ID cannot be blank");
        return err;
    }


    if (secret.empty()) {
        Log::error("Client Secret cannot be blank");
        return err;
    }

    err = m_authService->SetEvent(new AuthServiceEvent(onAuth));
    if (hasError(err)) return err;

    generateJWT(m_config.clientId(), m_config.clientSecret());

    AuthContext ctx;
    ctx.jwt_token =  m_jwt.c_str();

    return m_authService->SDKAuth(ctx);
}

void Zoom::generateJWT(const string& key, const string& secret) {

    m_iat = std::chrono::system_clock::now();
    m_exp = m_iat + std::chrono::hours{24};

    m_jwt = jwt::create()
            .set_type("JWT")
            .set_issued_at(m_iat)
            .set_expires_at(m_exp)
            .set_payload_claim("appKey", claim(key))
            .set_payload_claim("tokenExp", claim(m_exp))
            .sign(algorithm::hs256{secret});
}

SDKError Zoom::join() {
    SDKError err{SDKERR_UNINITIALIZE};

    auto mid = m_config.meetingId();
    auto password = m_config.password();
    auto displayName = m_config.displayName();


    if (mid.empty()) {
        Log::error("Meeting ID cannot be blank");
        return err;
    }

    if (password.empty()) {
        Log::error("Meeting Password cannot be blank");
        return err;
    }

    if (displayName.empty()) {
        Log::error("Display Name cannot be blank");
        return err;
    }

    auto meetingNumber = stoull(mid);
    auto userName = displayName.c_str();
    auto psw = password.c_str();

    JoinParam joinParam;
    joinParam.userType = ZOOM_SDK_NAMESPACE::SDK_UT_WITHOUT_LOGIN;

    JoinParam4WithoutLogin& param = joinParam.param.withoutloginuserJoin;

    param.meetingNumber = meetingNumber;
    param.userName = userName;
    param.psw = psw;
    param.vanityID = nullptr;
    param.customer_key = nullptr;
    param.webinarToken = nullptr;
    param.isVideoOff = false;
    param.isAudioOff = false;

    if (!m_config.zak().empty()) {
        Log::success("used ZAK token");
        param.userZAK = m_config.zak().c_str();
    }

    if (!m_config.joinToken().empty()) {
        Log::success("used App Privilege token");
        param.app_privilege_token = m_config.joinToken().c_str();
    }

    if (!m_config.onBehalfToken().empty()) {
        Log::success("used On Behalf Token");
        param.onBehalfToken = m_config.onBehalfToken().c_str();
    }

    if (m_config.useRawAudio() || m_config.sendAudio()) {
        auto* audioSettings = m_settingService->GetAudioSettings();
        if (!audioSettings) return SDKERR_INTERNAL_ERROR;

        audioSettings->EnableAutoJoinAudio(true);

        // Keep the physical device mic muted so only our external (TTS) source
        // is transmitted; the participant itself stays unmuted (UnMuteAudio).
        if (m_config.sendAudio())
            audioSettings->EnableAlwaysMuteMicWhenJoinVoip(true);
    }

    return m_meetingService->Join(joinParam);
}

SDKError Zoom::start() {
    SDKError err;

    StartParam startParam;
    startParam.userType = SDK_UT_NORMALUSER;

    StartParam4NormalUser  normalUser;
    normalUser.vanityID = nullptr;
    normalUser.customer_key = nullptr;
    normalUser.isAudioOff = false;
    normalUser.isVideoOff = false;

    err = m_meetingService->Start(startParam);
    hasError(err, "start meeting");

    return err;
}

SDKError Zoom::leave() {
    if (!m_meetingService) 
        return SDKERR_UNINITIALIZE;

    auto status = m_meetingService->GetMeetingStatus();
    if (status == MEETING_STATUS_IDLE)
        return SDKERR_WRONG_USAGE;

    return  m_meetingService->Leave(LEAVE_MEETING);
}

SDKError Zoom::clean() {
    // Stop the share producer + the TTS ingestion/sender threads BEFORE tearing
    // down the meeting service, so neither thread can call into an
    // already-destroyed SDK sender.
    if (m_shareSource)
        m_shareSource->stop();

    if (m_audioServer) {
        m_audioServer->stop();
        delete m_audioServer;
        m_audioServer = nullptr;
    }

    if (m_micSource) {
        m_micSource->stop();
        delete m_micSource;
        m_micSource = nullptr;
    }

    if (m_meetingService)
        DestroyMeetingService(m_meetingService);

    if (m_settingService)
        DestroySettingService(m_settingService);

    if (m_authService)
        DestroyAuthService(m_authService);

    if (m_audioHelper)
        m_audioHelper->unSubscribe();

    if (m_videoHelper)
        m_videoHelper->unSubscribe();

    delete m_renderDelegate;
    delete m_shareSource;
    return CleanUPSDK();
}

SDKError Zoom::startRawRecording() {
    if (m_meetingService->GetMeetingStatus() != ZOOM_SDK_NAMESPACE::MEETING_STATUS_INMEETING) {
        Log::error("You must be in a meeting to start raw recording");
        return SDKERR_WRONG_USAGE;
    }

    auto recCtl = m_meetingService->GetMeetingRecordingController();
    if (!recCtl) {
        Log::error("Failed to get meeting recording controller");
        return SDKERR_INTERNAL_ERROR;
    }

    auto err = recCtl->StartRawRecording();
    if (hasError(err, "start raw recording"))
        return err;

    if (m_config.useRawVideo()) {
        if (!m_renderDelegate) {
            m_renderDelegate = new ZoomSDKRendererDelegate();
            m_videoSource = new ZoomSDKVideoSource();
        }

        err = createRenderer(&m_videoHelper, m_renderDelegate);
        if (hasError(err, "create raw video renderer"))
            return err;

        m_renderDelegate->setDir(m_config.videoDir());
        m_renderDelegate->setFilename(m_config.videoFile());
        
        auto participantCtl = m_meetingService->GetMeetingParticipantsController();
        auto uid = participantCtl->GetParticipantsList()->GetItem(0);

        m_videoHelper->setRawDataResolution(ZoomSDKResolution_720P);
        err = m_videoHelper->subscribe(uid, RAW_DATA_TYPE_VIDEO);
        if (hasError(err, "subscribe to raw video"))
            return err;

        Log::info("writing video raw data to " + m_renderDelegate->dir() + "/" + m_renderDelegate->filename());

  /*      auto* videoSourceHelper = GetRawdataVideoSourceHelper();
        if (!videoSourceHelper) {
            Log::error("Initializing Video Source Helper");
            return SDKERR_UNINITIALIZE;
        }

        err = videoSourceHelper->setExternalVideoSource(m_videoSource);
        if (hasError(err, "set video source"))
            return err;

        auto* videoSettings = m_settingService->GetVideoSettings();
        videoSettings->EnableAutoTurnOffVideoWhenJoinMeeting(false);

       auto* sender = m_videoSource->getSender();
        SDKError e;
        do {
            Log::info("attempting unmute");
            auto* videoCtl = m_meetingService->GetMeetingVideoController();
            e = videoCtl->UnmuteVideo();
            if (hasError(e, "unmute")) sleep(1);
        } while (hasError(e));*/

    }

    if (m_config.useRawAudio()) {
        auto* audioController = m_meetingService->GetMeetingAudioController();
        if (audioController) {
            auto voipErr = audioController->JoinVoip();
            if (hasError(voipErr, "join VoIP")) {
                Log::error("Failed to join VoIP audio");
            }
        }

        m_audioHelper = GetAudioRawdataHelper();
        if (!m_audioHelper)
            return SDKERR_UNINITIALIZE;

        if (!m_audioSource) {
            auto mixedAudio = !m_config.separateParticipantAudio();
            auto transcribe = m_config.transcribe();

            m_audioSource = new ZoomSDKAudioRawDataDelegate(mixedAudio, transcribe);
            m_audioSource->setDir(m_config.audioDir());
            m_audioSource->setFilename(m_config.audioFile());

            // Tell the delegate our OWN user-id so it never writes node-<self>.pcm — the bot must not
            // capture/transcribe its own audio (silence + injected TTS). Removes the EXCLUDE_NODE_ID dance.
            auto* partCtl = m_meetingService->GetMeetingParticipantsController();
            if (partCtl) {
                auto* self = partCtl->GetMySelfUser();
                if (self) m_audioSource->setExcludeNodeId(self->GetUserID());
            }
        }

        err = m_audioHelper->subscribe(m_audioSource);
        if (hasError(err, "subscribe to raw audio"))
            return err;

        Log::info("writing audio raw data to " + m_audioSource->dir() + "/" + m_audioSource->filename());
    }

    return SDKERR_SUCCESS;
}

SDKError Zoom::stopRawRecording() {
    auto recCtrl = m_meetingService->GetMeetingRecordingController();
    auto err = recCtrl->StopRawRecording();
    hasError(err, "stop raw recording");

    return err;
}

SDKError Zoom::startAudioSend() {
    if (m_meetingService->GetMeetingStatus() != ZOOM_SDK_NAMESPACE::MEETING_STATUS_INMEETING) {
        Log::error("You must be in a meeting to send audio");
        return SDKERR_WRONG_USAGE;
    }

    // Staff-confirmed order (devforum): register the external source FIRST, then
    // JoinVoip(), then UnMuteAudio(). Registering after JoinVoip/unmute leaves
    // onMicStartSend never firing.

    // 1. Register the virtual mic on the (shared) audio helper. Send and receive
    //    coexist full-duplex on the same helper, so reuse m_audioHelper.
    m_audioHelper = GetAudioRawdataHelper();
    if (!m_audioHelper)
        return SDKERR_UNINITIALIZE;

    if (!m_micSource)
        m_micSource = new ZoomSDKVirtualAudioMicEvent();

    auto err = m_audioHelper->setExternalAudioSource(m_micSource);
    if (hasError(err, "set external audio source"))
        return err;

    // 2. Join VoIP.
    auto* audioController = m_meetingService->GetMeetingAudioController();
    if (!audioController)
        return SDKERR_UNINITIALIZE;

    auto voipErr = audioController->JoinVoip();
    hasError(voipErr, "join VoIP for audio send");

    // 3. Unmute self (retry loop), mirroring the commented-out UnmuteVideo loop.
    //    NOTE: startAudioSend() runs on the SDK's meeting-service callback thread,
    //    which also delivers onMicInitialize/onMicStartSend. Keep the total
    //    blocking window small (a few short retries) so we don't starve those
    //    callbacks; if unmute is denied by host policy the bot stays muted and
    //    the RUNBOOK's mute/unmute-twice workaround applies at runtime.
    auto* participantCtl = m_meetingService->GetMeetingParticipantsController();
    if (participantCtl) {
        auto* self = participantCtl->GetMySelfUser();
        if (self) {
            auto myId = self->GetUserID();
            SDKError ue;
            int attempts = 0;
            do {
                ue = audioController->UnMuteAudio(myId);
                if (hasError(ue, "unmute audio")) usleep(300 * 1000);  // 300 ms
            } while (hasError(ue) && ++attempts < 5);
        }
    }

    // 4. Start the TCP ingestion reader feeding the jitter buffer.
    if (!m_audioServer) {
        auto* mic = m_micSource;
        m_audioServer = new TCPSocketServer(
            m_config.audioSendPort(),
            [mic](const char* data, size_t len) { mic->enqueuePCM(data, len); });
        m_audioServer->start();
    }

    Log::success("audio send (virtual mic) ready on TCP port " + to_string(m_config.audioSendPort()));
    return SDKERR_SUCCESS;
}

namespace {
    string describeCannotShareReason(CannotShareReasonType reason) {
        switch (reason) {
            case CannotShareReasonType_None:                            return "None";
            case CannotShareReasonType_Locked:                          return "Locked (only host can share)";
            case CannotShareReasonType_Disabled:                        return "Disabled";
            case CannotShareReasonType_Other_Screen_Sharing:            return "Another participant is sharing their screen";
            case CannotShareReasonType_Other_WB_Sharing:                return "Another participant is sharing a whiteboard";
            case CannotShareReasonType_Need_Grab_Myself_Screen_Sharing: return "Need to grab (own screen share active)";
            case CannotShareReasonType_Need_Grab_Other_Screen_Sharing:  return "Need to grab (other screen share active)";
            case CannotShareReasonType_Need_Grab_Audio_Sharing:         return "Need to grab (audio share active)";
            case CannotShareReasonType_Need_Grap_WB_Sharing:            return "Need to grab (whiteboard share active)";
            case CannotShareReasonType_Reach_Maximum:                   return "Reached maximum share sessions";
            case CannotShareReasonType_Have_Share_From_Mainsession:     return "A share exists in the main session";
            case CannotShareReasonType_Other_DOCS_Sharing:              return "Another participant is sharing docs";
            case CannotShareReasonType_Need_Grab_DOCS_Sharing:          return "Need to grab (docs share active)";
            default:                                                    return "Unknown (" + to_string(reason) + ")";
        }
    }
}

SDKError Zoom::startScreenShare() {
    if (m_meetingService->GetMeetingStatus() != ZOOM_SDK_NAMESPACE::MEETING_STATUS_INMEETING) {
        Log::error("You must be in a meeting to start screen share");
        return SDKERR_WRONG_USAGE;
    }

    auto* shareCtl = m_meetingService->GetMeetingShareController();
    if (!shareCtl) {
        Log::error("Failed to get meeting share controller");
        return SDKERR_INTERNAL_ERROR;
    }

    // Wire status/failure logging before attempting the share so the run is
    // debuggable (onSharingStatus / onFailedToStartShare).
    shareCtl->SetEvent(new MeetingShareCtrlEvent());

    // Gate on share permission and log the reason if blocked (e.g. _Locked
    // means the bot needs host privilege or the host to unlock share).
    CannotShareReasonType reason;
    if (!shareCtl->CanStartShare(reason)) {
        Log::error("cannot start share: " + describeCannotShareReason(reason));
        return SDKERR_NO_PERMISSION;
    }

    m_shareHelper = GetRawdataShareSourceHelper();
    if (!m_shareHelper) {
        Log::error("Failed to get raw share source helper");
        return SDKERR_UNINITIALIZE;
    }

    // Lift Zoom's built-in "limited sharing FPS" throttle. The stage is full-motion
    // (the animated aura orb), but Zoom defaults to a content-share cap that makes it
    // choppy/low-bitrate. Disable the cap (and raise the max value as belt-and-suspenders
    // in case the account forces the limit on) so our high-fps producer isn't throttled.
    if (m_settingService) {
        if (auto* shareSettings = m_settingService->GetShareSettings()) {
            shareSettings->EnableLimitFPSWhenShare(false);
            shareSettings->SetLimitFPSValueWhenShare(limitfps_15_frame);
            Log::info("share settings: limited-FPS throttle disabled");
        }
    }

    if (!m_shareSource)
        m_shareSource = new ZoomSDKShareSource();

    // Initiates the raw external share; the SDK then fires onStartSend(sender)
    // on the source (asynchronous as of v7.0.0), which starts the producer.
    auto err = m_shareHelper->setExternalShareSource(m_shareSource);
    if (hasError(err, "set external share source"))
        return err;

    Log::success("screen share started (raw external source: out/share_text.txt)");
    return SDKERR_SUCCESS;
}

SDKError Zoom::stopScreenShare() {
    if (m_shareSource)
        m_shareSource->stop();

    if (!m_meetingService)
        return SDKERR_UNINITIALIZE;

    auto* shareCtl = m_meetingService->GetMeetingShareController();
    if (!shareCtl)
        return SDKERR_INTERNAL_ERROR;

    auto err = shareCtl->StopShare();
    hasError(err, "stop screen share");

    return err;
}

bool Zoom::isMeetingStart() {
    return m_config.isMeetingStart();
}


bool Zoom::hasError(const SDKError e, const string& action) {
    auto isError = e != SDKERR_SUCCESS;

    if(!action.empty()) {
        if (isError) {
            stringstream ss;
            ss << "failed to " << action << " with status " << e;
            Log::error(ss.str());
        } else {
            Log::success(action);
        }
    }
    return isError;
}
