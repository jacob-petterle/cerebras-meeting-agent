#include "Config.h"

Config::Config() :
        m_app(m_name, "zoomsdk"),
        m_rawRecordAudioCmd(m_app.add_subcommand("RawAudio", "Enable Audio Raw Recording")),
        m_rawRecordVideoCmd(m_app.add_subcommand("RawVideo", "Enable Video Raw Recording"))
    {
    m_app.set_config("--config", "config.toml");

    m_app.add_option("-m, --meeting-id", m_meetingId,"Meeting ID of the meeting");
    m_app.add_option("-p, --password", m_password,"Password of the meeting");
    m_app.add_option("-n, --display-name", m_displayName,"Display Name for the meeting")->capture_default_str();

    m_app.add_option("-z,--zak", m_zak, "ZAK Token to join the meeting");

    m_app.add_option("--host", m_zoomHost, "Host Domain for the Zoom Meeting")->capture_default_str();
    m_app.add_option("-u, --join-url", m_joinUrl, "Join or Start a Meeting URL");
    m_app.add_option("-t, --join-token", m_joinToken, "Join the meeting with App Privilege using a token");
    m_app.add_option("-b, --on-behalf", m_onBehalfToken, "Join the meeting on behalf of a user using a token");


    m_app.add_option("--client-id", m_clientId, "Zoom Meeting Client ID")->required();
    m_app.add_option("--client-secret", m_clientSecret, "Zoom Meeting Client Secret")->required();

    m_app.add_flag("-s, --start", m_isMeetingStart, "Start a Zoom Meeting");

    m_app.add_flag("--screen-share", m_screenShare, "Share the bot's screen (raw external source; renders out/share_text.txt)");

    m_app.add_flag("--send-audio", m_sendAudio, "Send audio (TTS) into the meeting via a virtual microphone");
    m_app.add_option("--audio-send-port", m_audioSendPort, "TCP port the container listens on for inbound TTS PCM (32kHz mono s16le)")->capture_default_str();

    m_rawRecordAudioCmd->add_option("-f, --file", m_audioFile, "Output PCM audio file")->required();
    m_rawRecordAudioCmd->add_option("-d, --dir", m_audioDir, "Audio Output Directory");
    m_rawRecordAudioCmd->add_flag("-s, --separate-participants", m_separateParticipantAudio, "Output to separate PCM files for each participant");
    m_rawRecordAudioCmd->add_flag("-t, --transcribe", m_transcribe, "Transcribe audio to text");

    m_rawRecordVideoCmd->add_option("-f, --file", m_videoFile, "Output YUV video file")->required();
    m_rawRecordVideoCmd->add_option("-d, --dir", m_videoDir, "Video Output Directory");

}

int Config::read(int ac, char **av) {
    try {
        m_app.parse(ac, av);
    } catch( const CLI::CallForHelp &e ){
        exit(m_app.exit(e));
    } catch (const CLI::ParseError& err) {
        return m_app.exit(err);
    } 

    if (!m_joinUrl.empty())
        parseUrl(m_joinUrl);

   return 0;
}

// Your updated Config::parseUrl function
bool Config::parseUrl(const string& join_url) {
    auto url = UrlParser::parse(join_url);
    
    if (!url.valid) {
        cerr << "unable to parse join URL" << endl;
        return false;
    }
    
    string token, lastRoute;
    istringstream ss(url.path);
    
    while (getline(ss, token, '/')) {
        if (token.empty()) continue;
        
        m_isMeetingStart = token == "s";
        
        if (lastRoute == "j" || lastRoute == "s") {
            m_meetingId = token;
            break;
        }
        
        lastRoute = token;
    }
    
    if (m_meetingId.empty()) 
        return false;
    
    auto pwdIt = url.queryParams.find("pwd");
    if (pwdIt == url.queryParams.end()) 
        return false;
    
    m_password = pwdIt->second;
    
    return true;
}
const string& Config::clientId() const {
    return m_clientId;
}

const string& Config::clientSecret() const {
    return m_clientSecret;
}

const string &Config::zak() const
{
    return m_zak;
}

bool Config::useRawRecording() const {
    return useRawAudio() || useRawVideo();
}

bool Config::useRawAudio() const {
    return !m_audioFile.empty() || m_separateParticipantAudio || m_transcribe;
}

bool Config::useRawVideo() const {
    return !m_videoFile.empty();
}

bool Config::useScreenShare() const {
    return m_screenShare;
}

bool Config::sendAudio() const {
    return m_sendAudio;
}

int Config::audioSendPort() const {
    return m_audioSendPort;
}

bool Config::transcribe() const
{
    return m_transcribe;
}

const string& Config::audioDir() const {
    return m_audioDir;
}

const string& Config::audioFile() const {
        return m_audioFile;

}

const string& Config::videoDir() const {
    return m_videoDir;
}
const string& Config::videoFile() const {
    return m_videoFile;
}

bool Config::separateParticipantAudio() const {
    return m_separateParticipantAudio;
}

bool Config::isMeetingStart() const {
    return m_isMeetingStart;
}

const string& Config::joinToken() const {
    return m_joinToken;
}

const string &Config::onBehalfToken() const
{
    return m_onBehalfToken;
}

const string& Config::meetingId() const {
    return m_meetingId;
}

const string& Config::password() const {
    return m_password;
}

const string& Config::displayName() const {
    return m_displayName;
}

const string& Config::zoomHost() const {
    return m_zoomHost;
}

