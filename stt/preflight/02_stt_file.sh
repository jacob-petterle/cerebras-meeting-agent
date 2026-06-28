#!/usr/bin/env bash
# 02 — Parakeet STT transcribes the known sample WAV to the expected text.
#
# Proves the Mac STT half of the loop works offline (loads the model; downloads
# weights on first run). Sample: out/verify_32k.wav == "Hello TriageBot, how are
# you, stinky boy?" — we assert the salient content words survive ASR.
source "$(dirname "$0")/_common.sh"

echo "## Pre-flight 02: Parakeet transcribes verify_32k.wav"
WAV="$ZOOM_REPO/out/verify_32k.wav"
[ -f "$WAV" ] || fail "sample WAV missing: $WAV"

cd "$TRIAGE_BOT" || fail "triage-bot not found at $TRIAGE_BOT"

info "Transcribing $WAV (first run downloads the model)…"
TEXT="$(uv run python -c "
from triage_bot.config import AudioConfig
from triage_bot.stt import ParakeetSTT
audio = AudioConfig(sample_rate=32000, channels=1, sample_width=2)
print(ParakeetSTT('mlx-community/parakeet-tdt-0.6b-v3', audio).transcribe_file('$WAV'))
")" || fail "transcription raised"

echo "   Transcript: $TEXT"
LOWER="$(printf '%s' "$TEXT" | tr 'A-Z' 'a-z')"
missing=""
for w in hello how are you stinky boy; do
  printf '%s' "$LOWER" | grep -qw "$w" || missing="$missing $w"
done
[ -z "$missing" ] || fail "transcript missing expected word(s):$missing"

pass "Parakeet transcribed the sample to the expected content words"
