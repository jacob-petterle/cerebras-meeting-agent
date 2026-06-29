import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { createResources } from './core/resources';
import { createScreenState } from './core/screen-state';
import { describeCodebase } from './core/codebase';
import { createCerebrasClient } from './core/cerebras';
import { createDecide, foldLatestById, type Decision } from './core/decide';
import { createOrchestrator, intervalScheduler, type Orchestrator } from './core/orchestrator';
import { isRecord } from './lib/is-record';
import { createRegistry } from './core/tools/registry';
import { createCallAgentMock, type CallAgentFn } from './core/tools/callAgent/mock';
import { createCallAgentCursor } from './core/tools/callAgent/cursor';
import { createVad, createStt, createTts } from './media';
import { createWsServer, type WsServerHandle } from './ws';
import { createAudioInWs } from './adapters/local/audioInWs';
import { createAudioOutWs } from './adapters/local/audioOutWs';
import { createDisplayWs } from './adapters/local/displayWs';
import { createAudioInBridge } from './adapters/zoom/audioInBridge';
import { createAudioOutUplink } from './adapters/zoom/audioOutUplink';
import { createDisplayShare } from './adapters/zoom/displayShare';
import type { AudioInPort, AudioOutPort, DisplayPort, Ports } from './core/ports';

// Load .env FIRST — before the env-derived consts below are read at module-load time. Doing this
// inside main() (as it was) runs too late: ZOOM/BOT_OUT_DIR/BOT_TTS_PORT/EXCLUDE_NODE_ID would have
// already read an empty process.env, so `.env` silently never set them (only the ambient shell did).
for (const candidate of ['.env', fileURLToPath(new URL('../../../.env', import.meta.url))]) {
  try {
    process.loadEnvFile?.(candidate);
    break;
  } catch {
    /* not at this path — try the next candidate (ambient env still applies) */
  }
}

/**
 * Entrypoint — wires the transport-agnostic core to an adapter set:
 *   browser mic (WS pcm) → VAD → STT → transcript (raw STT goes straight in — no corrector pass)
 *   heartbeat / utterance poke → Gemma decides → tools (speak/share_screen/call_agent/no_op)
 *   speak → TTS → browser speakers ·  share_screen → browser stage
 *
 * Two adapter sets, selected by `ZOOM`:
 *   - LOCAL (default): browser mic over WS, browser Web Audio speakers, in-app browser stage.
 *   - ZOOM (`ZOOM=1`): file-tailer over the bot's per-speaker PCM dumps, TCP uplink to the bot's
 *     virtual mic, and the SAME WS broadcast for the stage (the bot's headless Chromium loads the
 *     web stage over WS and screen-shares it). The WS server runs in both modes — in ZOOM mode it
 *     still serves the stage + HUD, we just don't wire its inbound mic `pcm` to the pipeline.
 */

const PORT = Number(process.env.PORT ?? 8787);
/** Swap the local browser harness for the Zoom bot adapters. Default off (local mode unchanged). */
const ZOOM = process.env.ZOOM === '1';
/** Directory the bot appends `node-<userid>.pcm` files to (the bind-mounted `out/`). ZOOM mode. */
const BOT_OUT_DIR = process.env.BOT_OUT_DIR ?? 'out';
/** TCP port the bot's virtual mic listens on for TTS PCM. ZOOM mode. */
const BOT_TTS_PORT = Number(process.env.BOT_TTS_PORT ?? 3001);
/** The bot's own user-id — its capture stream is silent; exclude it. Empty ⇒ no exclusion. */
const EXCLUDE_NODE_ID = process.env.EXCLUDE_NODE_ID || undefined;
/** Verbose per-frame pipeline logging (high-frequency). Off by default; `DEBUG_PIPE=1` to enable. */
const DEBUG_PIPE = process.env.DEBUG_PIPE === '1';
/**
 * Heartbeat FALLBACK interval (ms) — NOT the primary driver. The brain is VAD-driven: a new utterance
 * pokes it to decide ~500ms after the speaker pauses. This slow timer is only a safety net: it catches
 * a delta that landed while the brain was mid-decision (the poke is a no-op while busy) and non-speech
 * events (e.g. a finished sub-agent's deliverable to share). Override with HEARTBEAT_MS.
 */
const HEARTBEAT_MS = Number(process.env.HEARTBEAT_MS ?? 4000);
/**
 * Wall-clock budget for ONE research sub-agent run (ms). Default 10 minutes (Jacob's directive): a real
 * codebase investigation can take minutes, and a trivial task already measured ~60s, so the old 90s cap
 * killed legitimate work. The heartbeat never blocks on this regardless (call_agent is fire-and-forget),
 * and whatever the run settles to — findings or a timeout — wakes the brain via the <sub_agents> resource.
 */
const CURSOR_AGENT_TIMEOUT_MS = Number(process.env.CURSOR_AGENT_TIMEOUT_MS ?? 600_000);
/** Repo root (…/cerebras-hackathon-prep), three up from packages/server/src/main.ts. */
const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

/** Read a `--flag value` or `--flag=value` CLI arg from argv (first listed name to match wins). */
function cliArg(...names: string[]): string | undefined {
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a) continue;
    for (const name of names) {
      if (a === `--${name}`) return argv[i + 1];
      if (a.startsWith(`--${name}=`)) return a.slice(name.length + 3);
    }
  }
  return undefined;
}

/** Expand a leading `~` and resolve to an absolute path. */
function resolveDir(p: string): string {
  const expanded = p === '~' ? homedir() : p.startsWith('~/') ? join(homedir(), p.slice(2)) : p;
  return resolve(expanded);
}

/**
 * Where the Cursor research sub-agent runs — and what ripgrep searches. Set it AT STARTUP with the
 * `--cursor-cwd <path>` CLI flag (alias `--cwd`); falls back to the CURSOR_AGENT_CWD env var, then to
 * THIS repo. The repo default is a real git tree with a .gitignore that a real task investigates in
 * ~15s; pointing it at a tree with no sane .gitignore (e.g. all of $HOME) makes ripgrep traverse
 * everything and the run drags. A leading `~` is expanded and the path is resolved absolute.
 */
const CURSOR_AGENT_CWD = resolveDir(
  cliArg('cursor-cwd', 'cwd') ?? process.env.CURSOR_AGENT_CWD ?? REPO_ROOT,
);
const SESSION_CONTEXT =
  process.env.SESSION_CONTEXT ??
  'A local test session. One human participant ("me") is speaking into a microphone. No specific project is in scope yet — be a generally helpful collaborator.';

/** Read a string field off a parsed (but `unknown`-typed) tool-args object without an assertion. */
function argField(args: unknown, key: string): string {
  if (!isRecord(args)) return '';
  const value = args[key];
  return typeof value === 'string' ? value : '';
}

/**
 * Normalize a task string for the re-fire comparison: trim, lowercase, collapse internal whitespace.
 * Two tasks that differ only in casing/spacing are treated as the SAME research so a model that
 * rephrases (or ignores the prompt) can't spawn a duplicate Cursor run for work already in flight.
 */
function normalizeTask(task: string): string {
  return task.trim().toLowerCase().replace(/\s+/g, ' ');
}

/** A short, human-readable description of a decision for the console feed (incl. no_op's reason). */
function summarizeDecision(d: Decision): string {
  switch (d.name) {
    case 'no_op':
      return argField(d.args, 'reason') || '(staying silent)';
    case 'speak':
      return argField(d.args, 'text');
    case 'share_screen':
      return argField(d.args, 'title') || argField(d.args, 'kind') || 'artifact';
    case 'call_agent':
      return argField(d.args, 'task');
    case 'sleep': {
      const secs = isRecord(d.args) && typeof d.args.seconds === 'number' ? d.args.seconds : null;
      return secs != null ? `standing down ~${secs}s` : 'standing down';
    }
    default:
      return '';
  }
}

/**
 * Last-resort process guards. A live demo backend must NOT die because one async path threw — a
 * single bad STT chunk or a transient brain hiccup should log, not exit(1) mid-session. These catch
 * what the per-path handlers miss, keep the process alive, and surface the cause in the log.
 */
process.on('unhandledRejection', (reason) => {
  console.error('[main] unhandledRejection (kept alive):', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[main] uncaughtException (kept alive):', err);
});

async function main(): Promise<void> {
  // .env was already loaded at module top (see above) so the env-derived consts picked it up.
  const apiKey = process.env.CEREBRAS_API_KEY ?? '';
  /** With a brain (key present) a new utterance pokes the heartbeat to decide; raw STT always goes straight to the transcript. */
  const brainEnabled = apiKey.length > 0;
  /** Cursor account key for the real sub-agent. Absent → the mock call_agent (no-key path) is used. */
  const cursorKey = process.env.CURSOR_API_KEY ?? '';

  // Resource spine (transcript + deliverables append-logs).
  const resources = createResources();
  /**
   * Shared-screen state — what artifact is currently on the stage and since when. Updated whenever WE
   * render (the Display port is wrapped below), read each beat by the brain as the <screen> resource so
   * it can reason about "how long to keep the diagram up". Cleared on session reset.
   */
  const screen = createScreenState();

  // Media leg — on-device only (Moonshine / kokoro / Silero). No hosted providers, no fallbacks.
  const vad = createVad({});
  const stt = createStt();
  const tts = createTts();

  // Transport: pick the adapter set, then stand up the WS server (always — it serves the stage + HUD
  // in both modes). In LOCAL mode the WS inbound `pcm` hook feeds the pipeline; in ZOOM mode audio
  // comes from the file-tailer instead, so we leave the WS mic hook unwired. The Reset hook (web
  // Reset button) clears the session + rewinds the brain in both modes.
  let audioIn: AudioInPort;
  let audioOut: AudioOutPort;
  let display: DisplayPort;
  let ws: WsServerHandle;
  /** ZOOM-only teardown (stop the tailer poll loop + close the uplink socket). */
  let stopTransport: (() => void) | null = null;
  /** Set once the brain is enabled; the reset handler rewinds its cursor when a client clears the session. */
  let orchestratorRef: Orchestrator | null = null;
  const onReset = (): void => {
    resources.transcript.reset();
    resources.deliverables.reset();
    resources.subAgents.reset();
    screen.clear();
    orchestratorRef?.reset();
  };

  if (ZOOM) {
    const bridge = createAudioInBridge({ outDir: BOT_OUT_DIR, excludeNodeId: EXCLUDE_NODE_ID });
    const uplink = createAudioOutUplink({ port: BOT_TTS_PORT });
    // WS server runs with NO mic hook — stage + HUD only; audio comes from the file-tailer.
    ws = createWsServer({ resources, onReset, port: PORT });
    audioIn = bridge;
    audioOut = uplink;
    display = createDisplayShare(ws);
    bridge.start();
    stopTransport = () => {
      bridge.stop();
      uplink.stop();
    };
    console.log(
      `[main] ZOOM mode — tailing ${BOT_OUT_DIR}/node-*.pcm, TTS uplink → 127.0.0.1:${BOT_TTS_PORT}` +
        (EXCLUDE_NODE_ID ? `, excluding node-${EXCLUDE_NODE_ID}` : ''),
    );
  } else {
    const localIn = createAudioInWs();
    ws = createWsServer({ resources, onPcm: localIn.deliver, onReset, port: PORT });
    audioIn = localIn.port;
    audioOut = createAudioOutWs(ws);
    display = createDisplayWs(ws);
  }

  /**
   * Wrap the Display port so every artifact WE put on screen is recorded as the current shared-screen
   * state (the <screen> resource the brain reads). The local browser and the Zoom bot both render through
   * this identical path, so this captures all of our shares with no adapter-specific code.
   */
  const baseRender = display.render.bind(display);
  display = {
    render: async (cmd) => {
      screen.noteOurShare(cmd, Date.now());
      await baseRender(cmd);
    },
  };

  const ports: Ports = { audioIn, audioOut, display };

  // AudioIn → VAD → STT → transcript (raw STT, straight in — no corrector). The per-utterance
  // VAD/STT lines are kept as terminal-side observability (the meeting agent's pipeline is meant to be
  // watchable); the high-frequency per-frame pcm log is gated behind DEBUG_PIPE so output stays readable.
  let pcmFrames = 0;
  audioIn.onPcm((frame) => {
    if (DEBUG_PIPE && pcmFrames++ % 40 === 0) {
      console.log(`[pipe] pcm #${pcmFrames} ${frame.participantId} @${frame.sampleRate}Hz ${frame.pcm.length}smp`);
    }
    vad.pushFrame(frame);
  });
  /**
   * Event-driven heartbeat. After a new utterance is buffered, nudge the brain to decide ~promptly
   * (debounced so a multi-utterance turn collapses into a single beat) rather than waiting for the
   * fixed fallback interval. `poke()` is a no-op while a beat is already in flight.
   */
  let pokeTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * The brain is VAD-driven: it decides ~this long after a speaker pauses, NOT on a fixed timer. The
   * window is a debounce — back-to-back / overlapping utterances (incl. different speakers) reset it,
   * so a whole multi-utterance turn collapses into ONE decision instead of one-per-utterance.
   */
  const POKE_DEBOUNCE_MS = 500;
  const pokeSoon = (): void => {
    if (pokeTimer) clearTimeout(pokeTimer);
    pokeTimer = setTimeout(() => {
      pokeTimer = null;
      orchestratorRef?.poke();
    }, POKE_DEBOUNCE_MS);
    if (pokeTimer && typeof pokeTimer.unref === 'function') pokeTimer.unref();
  };

  vad.onUtterance((u) => {
    // The VAD invokes this un-awaited (fire-and-forget per participant), so a throw here would become
    // an UNHANDLED REJECTION that takes the whole process down (exit 1) mid-session — the crash that
    // killed a live mic test. Own the rejection: log and drop this one utterance, never propagate.
    void (async () => {
      console.log(`[pipe] VAD→utterance ${u.pcm.length}smp @${u.sampleRate}Hz`);
      const text = (await stt.transcribe(u.pcm, u.sampleRate)).trim();
      console.log(`[pipe] STT→ "${text}"`);
      if (!text) return;
      // Raw STT goes STRAIGHT to the transcript — no corrector / second LLM pass. The brain decides
      // on the raw Moonshine text directly.
      resources.transcript.append({
        participantId: u.participantId,
        senderKind: 'human',
        text,
        timestamp: u.ts,
      });
      if (brainEnabled) pokeSoon(); // VAD-driven: react ~promptly after the speaker pauses.
    })().catch((err) => console.error('[pipe] utterance handler failed (dropped):', err));
  });

  const boundPort = await ws.whenReady;
  console.log(`[main] meeting-agent listening on ws://127.0.0.1:${boundPort}`);

  /** Heartbeat stopper, set when the brain is enabled; invoked by the graceful-shutdown handler. */
  let stopHeartbeat: (() => void) | null = null;

  // Brain + tools + 4s heartbeat — only when a key is present, so the server still binds (and
  // audio/transcript still stream to the web app) without one. The OpenAI client throws on an
  // empty key, so we must not construct it unconditionally.
  if (apiKey) {
    /**
     * Native reasoning-effort is OFF by default. Gemma (`gemma-4-31b`) is not a reasoning model, so
     * Cerebras is expected to reject/ignore `reasoning_effort` for it; the actual think-before-you-act
     * behavior comes from a PROMPT instruction (identity.ts / heartbeat pulse). `CEREBRAS_REASONING`
     * lets the owner opt in IF a future model/endpoint supports it — empty ⇒ unset (tool-calling
     * untouched). Only the documented effort levels are honored; anything else is treated as off.
     */
    const reasoningEnv = process.env.CEREBRAS_REASONING ?? '';
    const reasoningEffort =
      reasoningEnv === 'minimal' || reasoningEnv === 'low' || reasoningEnv === 'medium' || reasoningEnv === 'high'
        ? reasoningEnv
        : undefined;
    const cerebras = createCerebrasClient({ apiKey, reasoningEffort });
    const decide = createDecide({
      cerebras,
      context: SESSION_CONTEXT,
      /** The deliverables resource — observed as a `<deliverables>` block each tick (not in-band). */
      deliverables: resources.deliverables,
      /** The sub-agent-task resource — observed as a `<sub_agents>` block each tick (live research status). */
      subAgents: resources.subAgents,
      /** The transcript resource — the model observes the FULL conversation each beat (new marked). */
      transcript: resources.transcript,
      /**
       * The shared-screen state — read each beat as the <screen> block inside <meeting>, so the model
       * knows what's currently on screen and for how long. Fed by the wrapped Display port (every
       * share_screen records here) — the SAME path the local web app and the Zoom bot both render through.
       */
      screen: () => screen.current(),
      /**
       * The codebase the agent is embedded in — rooted at CURSOR_AGENT_CWD (exactly where the research
       * sub-agents run / ripgrep searches), so the brain knows the real repo its agents can investigate.
       */
      codebase: describeCodebase(CURSOR_AGENT_CWD),
      /** Live tok/s + token counts → the web HUD (otherwise computed in cerebras.ts and discarded). */
      onStats: (stats) => ws.broadcastStats(stats),
    });
    /**
     * call_agent backend: the REAL Cursor SDK when a CURSOR_API_KEY is present (it investigates the
     * working tree and writes a real findings doc), otherwise the mock (the no-key path, keeps the
     * spine exercisable without credentials). Both honour the same `(args) => Promise<DeliverableRecord>`
     * contract and append to the same deliverables log.
     */
    const callAgent: CallAgentFn = cursorKey
      ? createCallAgentCursor({
          deliverables: resources.deliverables,
          /** Live status (running → progress → done/error) so the heartbeat observes the run, never blocks on it. */
          subAgents: resources.subAgents,
          outDir: join(REPO_ROOT, '.deliverables'),
          apiKey: cursorKey,
          cwd: CURSOR_AGENT_CWD,
          /** 10-minute wall-clock budget per run (CURSOR_AGENT_TIMEOUT_MS); the heartbeat never blocks on it. */
          timeoutMs: CURSOR_AGENT_TIMEOUT_MS,
          /** Optional model override; defaults to composer-2.5 (fast mode) in cursor.ts. */
          model: process.env.CURSOR_AGENT_MODEL || undefined,
          onProgress: (l) => console.log(l),
        })
      : createCallAgentMock({
          deliverables: resources.deliverables,
          outDir: join(REPO_ROOT, '.deliverables'),
        });
    console.log(
      `[main] call_agent: ${cursorKey ? `real Cursor SDK — ${process.env.CURSOR_AGENT_MODEL || 'composer-2.5'} (fast), cwd=${CURSOR_AGENT_CWD}` : 'mock'}`,
    );
    const registry = createRegistry({
      ports,
      tts: (text) => tts.synthesize(text),
      callAgent,
    });
    /**
     * Write a completed tool's outcome back to the transcript so (a) the model sees its own prior turns
     * next heartbeat (memory) and (b) the web console's Tools/Agent tabs + HUD light up. `participantId`
     * is 'agent' for spoken turns, else the tool name. The orchestrator advances its cursor to the
     * claimed head only, so these self-authored lines don't cause a runaway (the no_op bias holds for them).
     */
    const writeBack = (outcome: { senderKind: 'agent' | 'tool'; text: string }, name: string): void => {
      resources.transcript.append({
        participantId: outcome.senderKind === 'agent' ? 'agent' : name,
        senderKind: outcome.senderKind,
        text: outcome.text,
        timestamp: Date.now(),
      });
      /**
       * The agent's OWN line just landed. Nudge the heartbeat so it continues the turn promptly — but
       * now WITH memory: the next beat sees this kind="agent"/"tool" line, which the prompt treats as
       * "you already did this, don't repeat yourself". That memory is what keeps the brain from echoing
       * itself (vs. an eager empty-delta beat, which has no such memory). The brain reads its own line
       * and almost always no_ops to yield; the MAX_TURN_ACTIONS cap is the hard backstop if it doesn't.
       */
      orchestratorRef?.poke();
    };
    /**
     * Serial chain for `speak`. Every tool is fire-and-forget (the orchestrator never awaits dispatch),
     * so two quick speaks would otherwise run TTS concurrently and could play out of order. We queue
     * speaks onto one promise chain — the heartbeat stays non-blocking, but audio plays in dispatch
     * order. `.catch` keeps one failed speak from poisoning the chain. (call_agent / share_screen run
     * independently — a long research must NOT sit behind, or hold up, the speak queue.)
     */
    let speakChain: Promise<void> = Promise.resolve();
    const orchestrator = createOrchestrator({
      transcript: resources.transcript,
      decide,
      /**
       * Dispatch wrapper. The orchestrator calls this DETACHED (fire-and-forget) for every action, so
       * nothing here blocks the heartbeat — it just runs the tool and writes the outcome back when done.
       */
      dispatch: async (decision) => {
        /**
         * Re-fire hard guard (belt-and-suspenders). The <sub_agents> resource already tells the model
         * not to re-dispatch a running task, but a model that ignores the prompt could still emit a
         * duplicate call_agent. Before dispatching one, fold the subAgents log latest-by-id; if an OPEN
         * (status=running) task's normalized name matches the requested task, SKIP the dispatch — log
         * it, append nothing — so we never spawn a second Cursor run for work already in flight.
         */
        if (decision.name === 'call_agent') {
          const requested = normalizeTask(argField(decision.args, 'task'));
          const alreadyRunning =
            requested.length > 0 &&
            foldLatestById(resources.subAgents.snapshot().map((e) => e.data)).some(
              (t) => t.status === 'running' && normalizeTask(t.task) === requested,
            );
          if (alreadyRunning) {
            console.log(`[main] call_agent skipped — already running: ${requested}`);
            return;
          }
        }
        if (decision.name === 'speak') {
          speakChain = speakChain
            .then(() => registry.dispatch(decision))
            .then((outcome) => {
              if (outcome) writeBack(outcome, decision.name);
            })
            .catch((err: unknown) => console.error('[main] speak dispatch failed:', err));
          return speakChain;
        }
        const outcome = await registry.dispatch(decision);
        if (!outcome) return;
        writeBack(outcome, decision.name);
      },
      /**
       * The live sub-agent log — the orchestrator subscribes to it and WAKES the brain when a research
       * settles (done/error), so a finished result or a TIMEOUT gets a reaction instead of silence.
       */
      subAgents: resources.subAgents,
      /** Surface EVERY decision (incl. no_op) to the console's decision feed — UI-only, not the transcript. */
      onDecision: (decision) =>
        ws.broadcastDecision({ name: decision.name, detail: summarizeDecision(decision), ts: Date.now() }),
      /** Drive the agent-state visualizer's "thinking" animation while the brain is mid-decide. */
      onThinkingChange: (thinking) => ws.broadcastAgentState(thinking),
      scheduler: intervalScheduler(),
      /** Idle/fallback cadence; the event-driven poke() (on new utterances) drives responsiveness. */
      intervalMs: HEARTBEAT_MS,
    });
    orchestratorRef = orchestrator;
    stopHeartbeat = orchestrator.start();
    console.log('[main] brain enabled (Gemma on Cerebras). Start the web app (pnpm web) and talk.');
  } else {
    console.warn(
      '[main] brain DISABLED — no CEREBRAS_API_KEY. Audio capture + transcript still stream to the ' +
        'web app, but the agent will not act. Put CEREBRAS_API_KEY in .env and restart to enable it.',
    );
  }

  // Warm the models so the first real utterance isn't cold (best-effort, non-blocking).
  void Promise.allSettled([stt.warmup(), tts.warmup()]);

  /**
   * Graceful shutdown. Stop the heartbeat and close the WS server before exiting, so a Ctrl-C or a
   * supervisor's SIGTERM doesn't tear the process down mid-inference — that race is what trips the
   * native onnxruntime "mutex lock failed" abort on exit. Idempotent; forces exit if close hangs.
   */
  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[main] ${signal} received — shutting down gracefully`);
    stopHeartbeat?.();
    stopTransport?.();
    const forced = setTimeout(() => process.exit(0), 2000);
    if (typeof forced.unref === 'function') forced.unref();
    try {
      await ws.close();
    } catch (err) {
      console.error('[main] error closing ws server:', err);
    }
    process.exit(0);
  };
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('[main] fatal:', err);
  // Force exit: the WS server may have already bound, and a listening socket would otherwise keep
  // the crashed process alive (holding the port) instead of exiting.
  process.exit(1);
});
