#!/usr/bin/env bash

# directory for CMake output
BUILD=build

# directory for application output
mkdir -p out

# Stage-page screen share knobs (overridable via compose `environment:`):
#   SHARE_MODE   stage (default) -> launch Chromium on Xvfb and capture it
#                text            -> skip Chromium; the bot renders out/share_text.txt
#   DEBUG_UI     1 -> the bot loads the FULL operator console (?view=full) so you can debug what the
#                agent is doing live INSIDE the Zoom screen-share; default 0 -> deliverable-only stage.
#   STAGE_URL    explicit FULL override of the page Chromium loads (host + view). When unset it is
#                built from DEBUG_UI against the Mac's Vite dev server.
#   DISPLAY      the Xvfb display Chromium draws on / the bot captures (:99)
SHARE_MODE="${SHARE_MODE:-stage}"
DEBUG_UI="${DEBUG_UI:-0}"
case "$DEBUG_UI" in 1 | true | yes | on) STAGE_VIEW="full" ;; *) STAGE_VIEW="stage" ;; esac
STAGE_URL="${STAGE_URL:-http://host.docker.internal:5173/?view=${STAGE_VIEW}}"
export DISPLAY="${DISPLAY:-:99}"
echo "[entry] DEBUG_UI=$DEBUG_UI -> loading stage page: $STAGE_URL"

CHROME_BIN="${CHROME_BIN:-google-chrome-stable}"

setup-pulseaudio() {
  # Enable dbus
  if [[  ! -d /var/run/dbus ]]; then
    mkdir -p /var/run/dbus
    dbus-uuidgen > /var/lib/dbus/machine-id
    dbus-daemon --config-file=/usr/share/dbus-1/system.conf --print-address
  fi

  usermod -G pulse-access,audio root

  # Cleanup to be "stateless" on startup, otherwise pulseaudio daemon can't start
  rm -rf /var/run/pulse /var/lib/pulse /root/.config/pulse/
  mkdir -p ~/.config/pulse/ && cp -r /etc/pulse/* "$_"

  pulseaudio -D --exit-idle-time=-1 --system --disallow-exit

  # Create a virtual speaker output

  pactl load-module module-null-sink sink_name=SpeakerOutput
  pactl set-default-sink SpeakerOutput
  pactl set-default-source SpeakerOutput.monitor

  # Make config file
  echo -e "[General]\nsystem.audio.type=default" > ~/.config/zoomus.conf
}

# Start the virtual X server the stage Chromium draws on and the bot captures.
# Xvfb has no "ready" signal, so poll xdpyinfo until the display answers.
start-xvfb() {
  # 960x540x16: half-res 16:9, Zoom recompresses anyway; ~56% fewer pixels than
  # 1280x720 cuts XShm capture + SwiftShader raster cost proportionally.
  echo "starting Xvfb on $DISPLAY (960x540x16)"
  Xvfb "$DISPLAY" -screen 0 960x540x16 -ac -nolisten tcp &> out/xvfb.log &

  for i in {1..50}; do
    if xdpyinfo -display "$DISPLAY" &> /dev/null; then
      echo "Xvfb ready on $DISPLAY"
      return 0
    fi
    sleep 0.2
  done

  echo "ERROR: Xvfb did not become ready on $DISPLAY" >&2
  return 1
}

# Launch headed (NOT --headless) Chromium in kiosk mode on the Xvfb display so
# the page actually renders into the framebuffer we capture. --disable-gpu is
# deliberate: sidesteps the Chromium GPU-process death under Rosetta on Apple Silicon.
# --enable-unsafe-swiftshader restores WebGL via the software (SwiftShader/ANGLE) path
# so WEBGL_debug_renderer_info is available — agent-orb.tsx detects "SwiftShader" and
# uses the zero-CPU CSS orb instead of the fragment shader, keeping load low. "unsafe"
# means software-rendered only (no GPU sandbox), not a security concern for our stage.
# --fps-cap=15 limits Blink's compositor to 15 fps — enough for this mostly-static
# stage, cuts the SwiftShader budget ~50% vs the default 60 fps.
start-chromium() {
  local url="${1:-$STAGE_URL}"
  echo "launching Chromium (kiosk, 15fps cap) on $DISPLAY -> $url"
  "$CHROME_BIN" \
    --kiosk \
    --no-sandbox \
    --disable-gpu \
    --enable-unsafe-swiftshader \
    --disable-dev-shm-usage \
    --window-size=960,540 \
    --window-position=0,0 \
    --force-device-scale-factor=1 \
    --fps-cap=15 \
    --no-first-run \
    --noerrdialogs \
    --disable-infobars \
    --disable-session-crashed-bubble \
    --disable-features=TranslateUI \
    --user-data-dir=/tmp/chrome-profile \
    "$url" &> out/chrome.log &

  echo "Chromium pid $!"
}

build() {
  # Configure CMake if this is the first run
  [[ ! -d "$BUILD" ]] && {
    cmake -B "$BUILD" -S . --preset debug || exit;
    npm --prefix=client install
  }

  # Rename the shared library
  LIB="lib/zoomsdk/libmeetingsdk.so"
  [[ ! -f "${LIB}.1" ]] && cp "$LIB"{,.1}

  # Set up and start pulseaudio
  setup-pulseaudio &> /dev/null || exit;

  # Build the Source Code
  cmake --build "$BUILD"
}

# Self-test (STAGE_SELFTEST=1): prove the capture pipeline end to end without a
# meeting. Bring up Xvfb + Chromium on a local test page, give it a moment to
# paint, then XShm-grab one frame to a PNG via the shmcap_test tool.
selftest() {
  start-xvfb || exit 1

  # A simple, self-contained page so the proof needs no external server.
  cat > out/selftest.html <<'HTML'
<!doctype html><html><head><meta charset="utf-8"><style>
  html,body{margin:0;height:100%;font-family:'Liberation Sans',sans-serif}
  body{background:linear-gradient(135deg,#0b3d2e,#13808a);color:#fff;
       display:flex;align-items:center;justify-content:center;flex-direction:column}
  h1{font-size:72px;margin:0} p{font-size:32px;opacity:.85}
</style></head><body>
  <h1>STAGE CAPTURE OK ✅</h1>
  <p>Chromium on Xvfb :99 — XShm self-test</p>
</body></html>
HTML

  start-chromium "file://$PWD/out/selftest.html"
  sleep 4  # let Chromium paint the page before grabbing

  echo "running shmcap_test"
  ./"$BUILD"/shmcap_test out/stage_capture_test.png
  local rc=$?
  echo "shmcap_test exit=$rc"
  return $rc
}

run() {
    export QT_LOGGING_RULES="*.debug=false;*.warning=false"

    # Stage mode needs the Xvfb display (the bot captures it) and Chromium drawing
    # on it. Text mode needs neither, so skip them and let the bot render
    # out/share_text.txt.
    if [[ "$SHARE_MODE" != "text" ]]; then
      start-xvfb || echo "WARNING: continuing without Xvfb; stage capture will fall back to text" >&2
      start-chromium "$STAGE_URL"
    else
      echo "SHARE_MODE=text: skipping Xvfb/Chromium; bot renders out/share_text.txt"
    fi

    exec ./"$BUILD"/zoomsdk
}

build || exit;

if [[ "${STAGE_SELFTEST:-0}" == "1" ]]; then
  selftest
  exit $?
fi

run

exit $?
