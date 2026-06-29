#ifndef MEETING_SDK_LINUX_SAMPLE_CONFIG_H
#define MEETING_SDK_LINUX_SAMPLE_CONFIG_H

#include <iostream>
#include <fstream>
#include <iterator>

#include <codecvt>
#include <algorithm>
#include <locale>
#include <string>

#include <CLI/CLI.hpp>

#include "util/UrlParser.h"

using namespace std;

class Config {

    const string& m_version = "1.0.2";
    const string& m_name = "Zoom Meeting SDK for Linux Sample v" + m_version;

    CLI::App m_app;

    CLI::App* m_rawRecordAudioCmd;
    string m_audioDir="out";
    string m_audioFile;
    bool m_separateParticipantAudio;
    bool m_transcribe;

    CLI::App* m_rawRecordVideoCmd;
    string m_videoDir="out";
    string m_videoFile;

    // Screen-share (raw external source) path.
    bool m_screenShare = false;

    // TTS virtual-microphone (audio SEND) path.
    bool m_sendAudio = false;
    int  m_audioSendPort = 3001;

    string m_joinUrl;
    string m_meetingId;
    string m_password;
    string m_displayName = "Zoom Meeting Client";
    string m_zak;

    string m_clientId;
    string m_clientSecret;

    string m_zoomHost = "https://zoom.us";
    string m_joinToken;
    string m_onBehalfToken;

    bool m_isMeetingStart;


public:
    Config();

    int read(int ac, char **av);

    bool parseUrl(const string& join_url);

    const string& meetingId() const;
    const string& password() const;
    const string& displayName() const;

    const string& joinToken() const;
    const string& onBehalfToken() const;
    const string& joinUrl() const;

    const string& clientId() const;
    const string& clientSecret() const;
    const string& zak() const;

    const string& zoomHost() const;

    bool isMeetingStart() const;

    bool useRawRecording() const;

    bool useRawAudio() const;
    bool useRawVideo() const;
    bool useScreenShare() const;

    bool sendAudio() const;
    int  audioSendPort() const;

    bool transcribe() const;

    const string& audioFile() const;
    const string& videoFile() const;

    const string& audioDir() const;
    const string& videoDir() const;

    bool separateParticipantAudio() const;
};


#endif //MEETING_SDK_LINUX_SAMPLE_CONFIG_H
