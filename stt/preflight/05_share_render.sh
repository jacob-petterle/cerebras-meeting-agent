#!/usr/bin/env bash
# 05 — The screen-share text overlay renders legibly.
#
# Renders one share frame from a sample share_text.txt to a PNG using a faithful
# Python port of the C++ cv::putText layout, so the overlay (wrapping, contrast,
# placeholder) can be eyeballed BEFORE the meeting. Also asserts the frame isn't
# blank. opencv is pulled in ephemerally via `uv run --with` (no permanent dep).
source "$(dirname "$0")/_common.sh"

echo "## Pre-flight 05: screen-share text overlay renders"
cd "$TRIAGE_BOT" || fail "triage-bot not found at $TRIAGE_BOT"

OUT_DIR="$TRIAGE_BOT/preflight/out"
mkdir -p "$OUT_DIR"
SAMPLE="$OUT_DIR/sample_share_text.txt"
echo "I heard you say: please escalate the database outage to the on-call engineer right away" > "$SAMPLE"

UV_WITH=(--with opencv-python-headless --with numpy)

info "Rendering a populated frame (long echo line -> word-wrap)…"
uv run "${UV_WITH[@]}" python preflight/render_share_frame.py \
  --file "$SAMPLE" --out "$OUT_DIR/share_text.png" || fail "render (text) failed"

info "Rendering the empty-file placeholder frame ('listening…')…"
uv run "${UV_WITH[@]}" python preflight/render_share_frame.py \
  --text "" --out "$OUT_DIR/share_placeholder.png" || fail "render (placeholder) failed"

# Sanity: a populated frame must contain meaningfully more drawn pixels than just
# the chrome — i.e. the text actually rendered, not a blank surface.
DREW="$(uv run "${UV_WITH[@]}" python - <<'PY'
import cv2, numpy as np
img = cv2.imread("preflight/out/share_text.png")
bg = np.array((35, 30, 28), dtype=np.uint8)
print(int(np.count_nonzero(np.any(img != bg, axis=2))))
PY
)" || fail "could not inspect rendered PNG"
echo "   drawn non-background pixels: $DREW"
[ "${DREW:-0}" -gt 5000 ] || fail "rendered frame looks blank ($DREW px) — text did not draw"

echo "   Eyeball these before the meeting:"
echo "     $OUT_DIR/share_text.png        (wrapped echo text)"
echo "     $OUT_DIR/share_placeholder.png (listening… placeholder)"
pass "share overlay rendered legibly (text + placeholder PNGs produced)"
