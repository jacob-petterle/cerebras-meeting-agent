# Zoom Meeting SDK for Linux Headless Sample

This sample demonstrates how you can run the Zoom Meeting SDK for Linux within a Docker container and configure it for a
variety of use cases through an intuitive CLI or through a configuration file.

## Prerequisites

1. [Docker](https://www.docker.com/)
1. [Zoom Account](https://support.zoom.us/hc/en-us/articles/207278726-Plan-Types-)
1. [Zoom Meeting SDK Credentials](#config:-sdk-credentials) (Instructions below)
    1. Client ID
    1. Client Secret
1. [AssemblyAI Key](https://www.assemblyai.com/)
1. [Anthropic Key](https://www.anthropic.com/)

## 1. Clone the Repository

```bash
# Clone down this repository
git clone git@github.com:zoom/meetingsdk-headless-linux-sample.git
```

## 2. Download the Zoom Linux SDK

Download the latest version of the Zoom SDK for Linux from the Zoom Marketplace and place it in
the [lib/zoomsdk](lib/zoomsdk) folder of this repository.

## 3. Configure the App

If you don't already have them, follow the section on how
to [Get your Zoom Meeting SDK Credentials](#get-your-zoom-meeting-sdk-credentials).


#### Copy the sample config file

```bash
cp sample.config.toml config.toml
```

#### Fill out the config.toml

Here, you can set any of the CLI options so that the app has them available when it runs. Start by adding your Client ID and Client Secret in the relevant fields.

**At a minimum, you need to provide an Client ID and Client Secret along with information about the meeting you would like to join.**

You can either provide a Join URL, or a Meeting ID and Password.

## 4. Run the App

Run the Docker container in order to build and run the app

```shell
docker compose up
```

That's it! You can use the --help argument in [entry.sh](bin/entry.sh) to see the available CLI and config.toml options.
___
## End-to-end demo: the bot SPEAKS and SHOWS

Beyond joining + recording, this fork adds two **send** transport channels so the
bot can talk back and display content — the basis of a headless agent loop:

| Feature | Flag | What it does |
|---------|------|--------------|
| **TTS virtual mic** | `send-audio=true` (`--send-audio`) | Listens on TCP `:3001` for 32 kHz mono s16le PCM and pushes it into the meeting as the bot's microphone. (`src/raw_send/ZoomSDKVirtualAudioMicEvent.*`, `src/util/TCPSocketServer.*`) |
| **Screen share** | `screen-share=true` (`--screen-share`) | Shares a raw external source, rendering the text in `out/share_text.txt` each frame with OpenCV (word-wrapped, 1280×720). (`src/raw_send/ZoomSDKShareSource.*`, `src/events/MeetingShareCtrlEvent.*`) |

Both are **independent of recording** and start in `onJoin` once the bot is
in-meeting. `audio-send-port` is published in [`compose.yaml`](compose.yaml).
All audio in this project is **32 kHz mono signed-16-bit little-endian PCM**.

The Mac-side driver (STT → echo → `say` TTS → `:3001` + `out/share_text.txt`),
the **pre-flight harness** that validates everything without burning meeting
minutes, and the precise live-meeting **RUNBOOK** all live in the companion
`triage-bot` repo. See `triage-bot/RUNBOOK.md`.

___
### Get your Zoom Meeting SDK Credentials

In your web browser, navigate to [Zoom Developer Portal](https://developers.zoom.us/) and register/log into your
developer account.

Click the "Build App" button at the top and choose to "Meeting SDK" application.

1. Name your app
2. Choose whether to list your app on the marketplace or not
3. Click "Create"
4. Fill out the prerequisite information
5. Copy the Client ID and Client Secret to the config.toml file

For more information, you can follow [this guide](https://developers.zoom.us/docs/meeting-sdk/developer-accounts/)

### Keeping secrets secret

Remember, credentials should never be stored in a plaintext file for production use cases.

> :warning: **Never commit config.toml to version control:** The file likely contains Zoom SDK and Zoom OAuth
> Credentials

### Testing

At this time there are no tests.

## Need help?

If you're looking for help, try [Developer Support](https://devsupport.zoom.us) or
our [Developer Forum](https://devforum.zoom.us). Priority support is also available
with [Premier Developer Support](https://zoom.us/docs/en-us/developer-support-plans.html) plans.

### Documentation

Make sure to review [our documentation](https://developers.zoom.us/docs/meeting-sdk/linux/) as a reference when building
with the Zoom Meeting SDK for Linux.
