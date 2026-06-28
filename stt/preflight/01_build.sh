#!/usr/bin/env bash
# 01 — The container builds cleanly with BOTH features (--send-audio + --screen-share).
#
# `docker compose build` only builds the IMAGE; the C++ is compiled at runtime by
# bin/entry.sh. So we build the image, then compile the C++ in a one-off container
# (no meeting join), then confirm both feature flags are actually in the binary.
source "$(dirname "$0")/_common.sh"

echo "## Pre-flight 01: container build with both transport features"
cd "$ZOOM_REPO" || fail "Zoom repo not found at $ZOOM_REPO"

info "Building the Docker image (docker compose build)…"
docker compose build || fail "docker compose build failed"

info "Compiling the C++ in-container (cmake --build; no meeting join)…"
docker compose run --rm --entrypoint /bin/bash zoomsdk -lc \
  'cmake -B build -S . --preset debug >/dev/null 2>&1 || true; cmake --build build' \
  || fail "in-container C++ compile failed"

BIN="$ZOOM_REPO/build/zoomsdk"
[ -f "$BIN" ] || fail "built binary missing at $BIN"

info "Confirming both feature flags are compiled into the binary…"
# grep -a scans the binary as text (the flag string literals live in .rodata).
# We deliberately avoid `strings | grep -q`: grep -q short-circuits, strings then
# takes SIGPIPE, and pipefail would report a false failure.
grep -qa -- '--send-audio'   "$BIN" || fail "'--send-audio' not found in binary (TTS feature missing)"
grep -qa -- '--screen-share' "$BIN" || fail "'--screen-share' not found in binary (screen-share feature missing)"

pass "container builds clean; binary exposes --send-audio and --screen-share"
