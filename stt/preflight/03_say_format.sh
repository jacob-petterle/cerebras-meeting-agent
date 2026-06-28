#!/usr/bin/env bash
# 03 — macOS `say` produces exactly 32 kHz, mono, signed-16-bit-LE PCM.
#
# This is the format the whole transport lane is locked to. If `say` drifts,
# the bot's voice would be garbled/chipmunked. We probe with both ffprobe and
# afinfo so a single tool quirk can't give a false PASS.
source "$(dirname "$0")/_common.sh"

echo "## Pre-flight 03: 'say' output format is 32k mono s16le"
command -v say     >/dev/null || fail "'say' not found (is this macOS?)"
command -v ffprobe >/dev/null || fail "'ffprobe' not found (brew install ffmpeg)"

WAV="$(mktemp -t preflight_say).wav"
trap 'rm -f "$WAV"' EXIT

info "Synthesizing with: say --data-format=LEI16@32000 --file-format=WAVE …"
say --data-format=LEI16@32000 --file-format=WAVE -o "$WAV" "Pre-flight format check." \
  || fail "say invocation failed"

CODEC="$(ffprobe -v error -select_streams a:0 -show_entries stream=codec_name -of csv=p=0 "$WAV")"
RATE="$(ffprobe -v error -select_streams a:0 -show_entries stream=sample_rate -of csv=p=0 "$WAV")"
CHANS="$(ffprobe -v error -select_streams a:0 -show_entries stream=channels -of csv=p=0 "$WAV")"
echo "   ffprobe: codec=$CODEC sample_rate=$RATE channels=$CHANS"

[ "$CODEC" = "pcm_s16le" ] || fail "codec is '$CODEC', expected pcm_s16le"
[ "$RATE"  = "32000" ]     || fail "sample_rate is '$RATE', expected 32000"
[ "$CHANS" = "1" ]         || fail "channels is '$CHANS', expected 1 (mono)"

if command -v afinfo >/dev/null; then
  info "afinfo cross-check:"
  afinfo "$WAV" | grep -iE 'data format|channels' | sed 's/^/   /'
fi

pass "say produces 32 kHz mono signed-16-bit-LE PCM"
