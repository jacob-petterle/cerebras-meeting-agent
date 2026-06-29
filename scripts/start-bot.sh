#!/usr/bin/env bash
# scripts/start-bot.sh '<zoom-join-url>'
#
# One command to run the whole Zoom triage-bot stack from a clone of this repo:
#   • writes the join-url into bot/config.toml
#   • stops any previous bot + clears stale capture
#   • brings up the web stage (:5173) and the brain/adapters (:8787, ZOOM mode)
#   • starts the bot in the foreground (Ctrl-C to stop; web+brain keep running)
#
# One-time prereqs (see bot/lib/zoomsdk/README.md + .env.example):
#   • Zoom Meeting SDK (x86_64) extracted into  bot/lib/zoomsdk/
#   • bot/config.toml with your Client ID/Secret   (cp bot/sample.config.toml bot/config.toml)
#   • .env at the repo root with CEREBRAS_API_KEY (and CURSOR_API_KEY for the sub-agent)
#   • Docker, pnpm (Node >= 22.13)
#
# The only manual bits are Zoom host-UI actions (no API): admit the bot + grant recording.
set -uo pipefail

JOIN_URL="${1:-}"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BOT="$REPO/bot"

if [ -z "$JOIN_URL" ]; then
  echo "usage: scripts/start-bot.sh '<zoom-join-url>'"
  exit 1
fi
if [ ! -f "$BOT/config.toml" ]; then
  cp "$BOT/sample.config.toml" "$BOT/config.toml"
  echo "created bot/config.toml from sample — fill in client-id/client-secret, then re-run."
  exit 1
fi

echo "▶ join-url → bot/config.toml"
ESC=$(printf '%s' "$JOIN_URL" | sed 's/[&|]/\\&/g')               # escape sed-replacement specials
tmp=$(mktemp); sed "s|^join-url=.*|join-url=\"$ESC\"|" "$BOT/config.toml" > "$tmp" && mv "$tmp" "$BOT/config.toml"

echo "▶ stopping any previous bot + clearing stale capture"
( cd "$BOT" && docker compose down >/dev/null 2>&1 ) || true
rm -f "$BOT"/out/node-*.pcm "$BOT"/out/share_text.txt "$BOT"/out/meeting-audio.pcm "$BOT"/out/*.log 2>/dev/null || true

echo "▶ web stage (:5173, debug UI for the operator)"
# Run the dev server with VITE_DEBUG_UI=1 so YOUR browser at http://localhost:5173/ shows the full
# operator console (transcript/HUD/tabs). The bot loads ?view=stage, which forces deliverable-only
# regardless of this flag — so the screenshare stays clean while you still get the console to watch.
lsof -ti tcp:5173 >/dev/null 2>&1 && echo "   already up" || ( cd "$REPO" && nohup pnpm web:debug >/tmp/zoom-web.log 2>&1 & )

echo "▶ brain + zoom adapters (:8787)"
lsof -ti tcp:8787 2>/dev/null | xargs kill -9 2>/dev/null || true
# ZOOM mode + bot paths passed inline so this works regardless of .env contents (keys still come from .env).
( cd "$REPO" && ZOOM=1 BOT_OUT_DIR="$BOT/out" BOT_TTS_PORT=3001 nohup pnpm --filter server dev >/tmp/zoom-server.log 2>&1 & )

printf "   waiting for web+brain to listen "
for _ in $(seq 1 40); do
  lsof -ti tcp:5173 >/dev/null 2>&1 && lsof -ti tcp:8787 >/dev/null 2>&1 && break
  printf "."; sleep 1
done
echo " ready"
grep -E "ZOOM mode|brain enabled" /tmp/zoom-server.log 2>/dev/null | tail -2 || true

cat <<'NEXT'

── after the bot joins, do these in Zoom (host-UI only) ───────────────────
   1. admit "Atlas" from the waiting room (or disable Waiting Room to skip)
   2. grant it RECORDING permission (Participants → Atlas → ⋯ → Allow Record)
   3. allow screen share — then talk.   logs: tail -f /tmp/zoom-server.log
   blank share?  Ctrl-C, then:  cd bot && SHARE_MODE=text docker compose up
───────────────────────────────────────────────────────────────────────────

▶ starting the bot (Ctrl-C stops it; web+brain keep running)
NEXT

cd "$BOT" && exec docker compose up
