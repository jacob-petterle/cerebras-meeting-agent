#!/usr/bin/env bash
# 04 — The Mac->container TTS path works, independent of the Zoom SDK.
#
# Stands up a local TCP listener on the container's mic port, runs the REAL
# orchestrator sender (triage_bot.tts) against it, and confirms every synthesized
# byte arrives. This proves the localhost:3001 transport without a meeting.
#
# Run with the container STOPPED (it would otherwise own port 3001). Override the
# port with PREFLIGHT_TTS_PORT if needed.
source "$(dirname "$0")/_common.sh"

PORT="${PREFLIGHT_TTS_PORT:-3001}"
echo "## Pre-flight 04: Mac -> TCP :$PORT TTS path (SDK-independent)"
cd "$TRIAGE_BOT" || fail "triage-bot not found at $TRIAGE_BOT"

info "Synthesizing + streaming through a local listener on port $PORT…"
uv run python - "$PORT" <<'PY' || fail "TTS TCP round-trip failed"
import socket, sys, threading, time
from triage_bot.tts import synthesize_pcm, PCMSender, BYTES_PER_SECOND

port = int(sys.argv[1])
received = bytearray()
ready, done = threading.Event(), threading.Event()

def server():
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    try:
        s.bind(("127.0.0.1", port)); s.listen(1)
    except OSError as e:
        print(f"could not bind 127.0.0.1:{port} ({e}) — stop the container first")
        ready.set(); done.set(); return
    ready.set()
    conn, _ = s.accept()
    while (b := conn.recv(8192)):
        received.extend(b)
    done.set(); conn.close(); s.close()

threading.Thread(target=server, daemon=True).start()
ready.wait(2.0)

pcm = synthesize_pcm("Pre-flight four. The transport path is working.")
if not pcm:
    raise SystemExit("synthesis produced no audio")

t0 = time.monotonic()
sender = PCMSender("127.0.0.1", port); ok = sender.send(pcm); sender.close()
wall = time.monotonic() - t0
done.wait(3.0)

audio_s = len(pcm) / BYTES_PER_SECOND
print(f"   synthesized={len(pcm)}B  received={len(received)}B  "
      f"audio={audio_s:.2f}s  wallclock={wall:.2f}s")
assert ok, "sender reported failure (could not connect?)"
assert len(received) == len(pcm), "byte count mismatch (data lost in transit)"
# Paced at ~real time so the container's ~200ms jitter buffer never overflows.
assert wall >= audio_s * 0.6, "sent far faster than real time — would overflow the jitter buffer"
print("   round-trip OK, paced ~real-time")
PY

pass "TTS synthesized and streamed to TCP :$PORT, all bytes received, real-time paced"
