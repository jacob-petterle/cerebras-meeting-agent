# RUNBOOK — Headless Zoom bot end-to-end demo

This is the **single live-meeting test**. Meeting minutes are scarce, so the goal
is: do everything you can without a meeting first (the pre-flight harness), then
spend **one** meeting run that yields maximum diagnostic info via a per-channel
checklist.

## The loop being demonstrated

```
You speak ─▶ bot captures per-speaker audio ─▶ Mac STT (Parakeet)
        ─▶ echo "agent": "I heard you say: <text>"
        ─▶ macOS `say` ─▶ 32k mono s16le PCM ─▶ TCP :3001 ─▶ bot SPEAKS it
        └▶ also writes out/share_text.txt ─▶ bot SHOWS it on screen share
```

No real LLM — a hardcoded echo. The point is to prove every transport channel:
**capture → STT → speak (mic) → show (share)**.

Two processes, two machines-in-one:
- **Container** (`meetingsdk-headless-linux-sample`, amd64/Rosetta): the Zoom bot.
- **Mac host** (`triage-bot`): STT + echo + TTS + share-text writer.

They meet at the bind-mounted `out/` directory and TCP `localhost:3001`.

---

## STEP 0 — Pre-flight (NO meeting needed). Do this first, every time.

Run all five. **Every one must print `✅ PASS`** before you book a meeting.
First runs download the Parakeet model and an OpenCV wheel (cached after).

```sh
cd ~/triage-bot
./preflight/01_build.sh        # container builds; binary has --send-audio + --screen-share
./preflight/02_stt_file.sh     # Parakeet transcribes out/verify_32k.wav correctly
./preflight/03_say_format.sh   # `say` outputs exactly 32k mono s16le
./preflight/04_tts_tcp.sh      # Mac → TCP :3001 PCM path works (run with container STOPPED)
./preflight/05_share_render.sh # share text overlay renders legibly (eyeball the PNGs)
```

After 05, **open the PNGs and look at them** — confirm the wrapped text is
readable and high-contrast:
- `preflight/out/share_text.png` (a wrapped echo line)
- `preflight/out/share_placeholder.png` (the "listening…" idle state)

If any pre-flight fails, fix it **before** the meeting — see the cause table below.

---

## STEP 1 — Host / Zoom-side setup (do once, before starting anything)

These are settings only the meeting **host** controls. Getting them wrong wastes
the run:

- [ ] **Regular meeting, NOT a webinar.** Raw screen-share returns `UNKNOWN(13)`
      in webinars. Use a normal meeting.
- [ ] **Screen share allowed for participants** — either set *Share Screen →
      Advanced → "All Participants"*, or plan to **make the bot a co-host** once
      it joins. Otherwise the bot can't share (`onFailedToStartShare`, reason
      `Locked`).
- [ ] **Be ready to grant recording.** The bot requests *local recording
      privilege* on join (needed to capture per-speaker audio for STT). As host,
      **approve the prompt** (or pre-grant the bot recording rights).
- [ ] **Don't force mute-on-entry / don't keep the bot muted.** The bot unmutes
      itself to speak; if the host hard-mutes it, no one hears it.
- [ ] Use a real second human/device to **hear and see** the bot.

---

## STEP 2 — Exact start order

> Order matters: container first (it must be in the meeting and listening on
> :3001 before the Mac streams audio), then the Mac orchestrator.

### 2a. Put a FRESH join-url in the bot config

Edit `~/meetingsdk-headless-linux-sample/config.toml` and set a **current**
`join-url=` for this meeting. Confirm these are present (they ship enabled):

```toml
send-audio=true
audio-send-port=3001
screen-share=true
[RawAudio]
separate-participants=true
```

### 2b. Start the container (the bot joins the meeting)

```sh
cd ~/meetingsdk-headless-linux-sample
docker compose up --build
```

Watch the logs for, in order:
- `connected` (bot reached `MEETING_STATUS_INMEETING`)
- `audio send (virtual mic) ready on TCP port 3001`
- `screen share started ...` and then `share status: Sharing_Self_Send_Begin`
- (recording) a request for local recording privilege — **host approves it**

As host: **admit the bot** from the waiting room if present, **approve
recording**, and **promote to co-host** if your account requires that to share.

### 2c. Start the Mac orchestrator (STT + echo + speak + show)

```sh
cd ~/triage-bot
uv run python demo_orchestrator.py
```

Wait for:
- `Loading Parakeet model ... Model loaded.`
- `Echo responder ready. Share text -> .../out/share_text.txt | TTS -> 127.0.0.1:3001`
- `Watching .../out/node-*.pcm ...`

Now the bot's share should flip from "listening…" to echoes as you speak.

---

## STEP 3 — What to say, and what to verify

Say one clear sentence, then **pause ~3 seconds and stay in the meeting**:

> "Hello bot, can you hear me? This is the end to end test."

**Latency is expected (~10–15 s).** STT uses a fixed ~8 s window per speaker, so
the bot won't react until ~8 s of your audio has accumulated, plus STT (~1–2 s) +
TTS synth + playback. Speak a full sentence; don't expect an instant reply.

### The three things to verify

1. **HEARD** — within ~15 s the bot **speaks**: *"I heard you say: hello bot can
   you hear me…"* in a macOS voice. (This proves capture → STT → TTS → mic.)
2. **SEEN** — the bot's **screen share** shows that same echo text, wrapped and
   centered, with a moving accent bar at the bottom. (Proves the share channel.)
3. **TRANSCRIPT** — `~/triage-bot/transcripts/session-<ts>.md` contains your line
   with the right words and a `[mm:ss] Speaker A:` label. (Proves STT accuracy.)

---

## STEP 4 — Per-channel PASS/FAIL checklist (fill during the run)

| # | Channel | How to confirm | PASS / FAIL |
|---|---------|----------------|-------------|
| 1 | **Capture** (audio in) | `out/node-*.pcm` files appear and grow while people talk | |
| 2 | **STT** | `transcripts/session-*.md` shows your words, correctly | |
| 3 | **Echo agent** | orchestrator logs `ECHO: I heard you say: …` | |
| 4 | **Speak** (TTS→mic) | a human in the meeting **hears** the bot say the echo | |
| 5 | **Show** (screen share) | a human **sees** the echo text on the bot's share | |
| 6 | **No feedback loop** | bot does NOT echo its own echo repeatedly | |

One run fills all six. If a channel fails, the cause table points at the fix so
the *next* run (if needed) is targeted.

---

## STEP 5 — Where every log lives

| What | Where |
|------|-------|
| Bot (container) logs | the `docker compose up` terminal (join, VoIP, mic, share status) |
| Mic/share status | look for `onMicStartSend`, `Sharing_Self_Send_Begin`, `sendShareFrame failed` |
| Orchestrator logs | the `uv run python demo_orchestrator.py` terminal (`ECHO:`, connect, send) |
| Transcript (machine) | `~/triage-bot/transcripts/session-<ts>.jsonl` (one segment/line) |
| Transcript (readable) | `~/triage-bot/transcripts/session-<ts>.md` (`[mm:ss] Speaker A: …`) |
| Per-speaker raw audio | `~/meetingsdk-headless-linux-sample/out/node-<id>.pcm` |
| What the bot is showing | `~/meetingsdk-headless-linux-sample/out/share_text.txt` (the live text) |
| Pre-flight render PNGs | `~/triage-bot/preflight/out/*.png` |

---

## STEP 6 — "If X is broken, likely cause" table

| Symptom | Likely cause → fix |
|---------|--------------------|
| Bot never joins | stale/expired `join-url`; waiting room not admitted → refresh URL, admit bot |
| No `out/node-*.pcm`, empty transcript | recording privilege not granted → host approves the recording prompt; confirm `[RawAudio] separate-participants=true` |
| Transcript wrong/garbled | bad mic/room audio, or model issue → re-run `02_stt_file.sh` (proves STT offline) |
| Orchestrator: `could not connect to 127.0.0.1:3001` | container not up yet, or started Mac side first → start container first; confirm `audio send … ready on TCP port 3001` in bot logs |
| Bot is silent (not heard) | `onMicStartSend` never fired → in bot logs check it; **mute then unmute the bot twice** (known SDK handshake quirk); ensure host didn't hard-mute it |
| Bot heard but chipmunk/garbled | wrong sample rate → re-run `03_say_format.sh`; format must be 32k mono s16le end-to-end |
| Share says "Bot is sharing" but blank | the documented blank-frame risk → confirm it's a **regular meeting not a webinar**, no other active share, and `Sharing_Self_Send_Begin` logged. SUCCESS codes ≠ visible frames |
| `onFailedToStartShare` / reason `Locked` | "only host can share" → host enables participant share or promotes bot to co-host |
| Share stuck on "listening…" | orchestrator not writing, or wrong path → check `out/share_text.txt` is changing; confirm `[demo].share_text_file` / `watch_dir` point at the bot's `out/` |
| Bot echoes its own echo repeatedly | self-audio captured back into STT → the orchestrator drops text containing "heard you say"; if your prefix changed, update that guard |
| High CPU / dropped frames | Rosetta cost → share is 1280×720 @ 8 fps already modest; close other load |

---

## STEP 7 — Teardown

- `Ctrl-C` the orchestrator (flushes buffers, drains STT, prints transcript paths).
- `Ctrl-C` / `docker compose down` the container (bot leaves, threads stop cleanly).

---

## What is NOT verifiable without a meeting (be honest)

The pre-flight harness proves: the build, STT accuracy, the `say` format, the
Mac→:3001 transport, and the share render layout. It **cannot** prove, in advance:

- that `sendShareFrame` output is actually **visible** to a participant on
  v7.1.0 (the documented blank-frame risk — needs a human to look);
- that `onMicStartSend` fires and the injected audio is **audible** in a real
  meeting (handshake + noise-suppression caveats);
- that the bot is granted recording/share **privilege** by a real host.

Those three are exactly what STEP 3 + the STEP 4 checklist exist to confirm in
the single meeting run.
