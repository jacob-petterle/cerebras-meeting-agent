import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { createResources } from './core/resources';
import { createCerebrasClient } from './core/cerebras';
import { createDecide, foldLatestById, type Decision } from './core/decide';
import { createCorrector, type RawUtterance } from './core/correct';
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

/**
 * Entrypoint — wires the transport-agnostic core to an adapter set:
 *   browser mic (WS pcm) → VAD → STT → raw buffer (corrected on the heartbeat) → transcript
 *   4s heartbeat → correct buffered STT → Gemma decides → tools (speak/share_screen/call_agent/no_op)
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
 * Where the Cursor research sub-agent runs. Default = the HOME directory so it can read ANY repo on
 * the machine (e.g. ~/repos/shipyard) — not just this one. Starting it in the meeting-agent repo
 * (process.cwd()) is why "investigate the Shipyard codebase" timed out: it couldn't see those files.
 * Override with CURSOR_AGENT_CWD (e.g. point it at ~/repos for a tighter scope).
 */
const CURSOR_AGENT_CWD = process.env.CURSOR_AGENT_CWD || homedir();
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
  // Load env (Node >= 20.12 / 22). `pnpm dev` runs with cwd=packages/server (pnpm --filter), so the
  // repo-root .env is NOT at cwd — try cwd first, then the repo-root .env resolved relative to this
  // module (../../../ from packages/server/src/main.ts). First file that loads wins; absent is fine.
  for (const candidate of ['.env', fileURLToPath(new URL('../../../.env', import.meta.url))]) {
    try {
      process.loadEnvFile?.(candidate);
      break;
    } catch {
      /* not at this path — try the next candidate (ambient env still applies) */
    }
  }

  const apiKey = process.env.CEREBRAS_API_KEY ?? '';
  /** With a brain (key present) STT is buffered + corrected on the heartbeat; without one it streams raw. */
  const brainEnabled = apiKey.length > 0;
  /** Cursor account key for the real sub-agent. Absent → the mock call_agent (no-key path) is used. */
  const cursorKey = process.env.CURSOR_API_KEY ?? '';

  // Resource spine (transcript + deliverables append-logs).
  const resources = createResources();

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
  /**
   * Raw STT segments awaiting correction. With the brain enabled the VAD/STT path appends HERE (not
   * straight to the transcript); the heartbeat's correct-step drains it, corrects the batch, and
   * appends the CORRECTED lines. `sessionEpoch` lets an in-flight correction notice a reset that
   * raced it and drop its now-stale batch.
   */
  const rawBuffer: RawUtterance[] = [];
  let sessionEpoch = 0;
  const onReset = (): void => {
    sessionEpoch += 1;
    rawBuffer.length = 0;
    resources.transcript.reset();
    resources.deliverables.reset();
    resources.subAgents.reset();
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

  const ports: Ports = { audioIn, audioOut, display };

  // AudioIn → VAD → STT → (raw buffer, corrected on the heartbeat) → transcript. The per-utterance
  // VAD/STT lines are kept as terminal-side observability (the meeting agent's pipeline is meant to be
  // watchable); the high-frequency per-frame pcm log is gated behind DEBUG_PIPE so output stays readable.
  let pcmFrames = 0;
  audioIn.onPcm((frame) => {
    if (DEBUG_PIPE && pcmFrames++ % 40 === 0) {
      console.log(`[pipe] pcm #${pcmFrames} ${frame.participantId} @${frame.sampleRate}Hz ${frame.pcm.length}smp`);
    }
    vad.pushFrame(frame);
  });
  vad.onUtterance((u) => {
    // The VAD invokes this un-awaited (fire-and-forget per participant), so a throw here would become
    // an UNHANDLED REJECTION that takes the whole process down (exit 1) mid-session — the crash that
    // killed a live mic test. Own the rejection: log and drop this one utterance, never propagate.
    void (async () => {
      console.log(`[pipe] VAD→utterance ${u.pcm.length}smp @${u.sampleRate}Hz`);
      const text = (await stt.transcribe(u.pcm, u.sampleRate)).trim();
      console.log(`[pipe] STT→ "${text}"`);
      if (!text) return;
      if (brainEnabled) {
        /**
         * Buffer the RAW segment. The heartbeat's correct-step (a Gemma pass) cleans the batch and
         * appends the corrected line — so raw STT never reaches the transcript while the brain is on,
         * and the brain only ever observes corrected text.
         */
        rawBuffer.push({ participantId: u.participantId, text, timestamp: u.ts });
      } else {
        /**
         * No brain (no key) → no corrector. Stream the raw line straight to the transcript so the web
         * app still shows a live transcript even with the agent disabled.
         */
        resources.transcript.append({
          participantId: u.participantId,
          senderKind: 'human',
          text,
          timestamp: u.ts,
        });
      }
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
      /** Live tok/s + token counts → the web HUD (otherwise computed in cerebras.ts and discarded). */
      onStats: (stats) => ws.broadcastStats(stats),
    });
    /**
     * Transcript corrector — step ONE of each heartbeat. Drains the raw STT buffer, corrects the
     * batch against the prior (already-corrected) conversation as context, and appends the cleaned
     * lines to the transcript BEFORE `decide` reads it. A separate Gemma call, walled off from the
     * brain: its own static system prompt + frozen-history prefix keep Cerebras's prompt cache warm.
     */
    const corrector = createCorrector({ cerebras, transcript: resources.transcript });
    const correct = async (): Promise<void> => {
      if (rawBuffer.length === 0) return;
      const epoch = sessionEpoch;
      /** Drain everything buffered so far; segments that arrive mid-correction wait for the next beat. */
      const batch = rawBuffer.splice(0, rawBuffer.length);
      const corrected = await corrector.correct(batch);
      /** A reset() raced this correction (session cleared mid-call) → drop the now-stale batch. */
      if (epoch !== sessionEpoch) return;
      for (let i = 0; i < batch.length; i++) {
        const seg = batch[i];
        if (!seg) continue;
        resources.transcript.append({
          participantId: seg.participantId,
          senderKind: 'human',
          text: corrected[i] ?? seg.text,
          timestamp: seg.timestamp,
        });
      }
      console.log(`[correct] ${batch.length} raw segment(s) → corrected → transcript`);
    };
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
          outDir: '.deliverables',
          apiKey: cursorKey,
          cwd: CURSOR_AGENT_CWD,
          onProgress: (l) => console.log(l),
        })
      : createCallAgentMock({
          deliverables: resources.deliverables,
          outDir: '.deliverables',
        });
    console.log(
      `[main] call_agent: ${cursorKey ? `real Cursor SDK (cwd=${CURSOR_AGENT_CWD})` : 'mock'}`,
    );
    const registry = createRegistry({
      ports,
      tts: (text) => tts.synthesize(text),
      callAgent,
      /** Resolve share_screen{deliverableId} to the real findings file so the stage shows it (Task C). */
      deliverables: resources.deliverables,
    });
    const orchestrator = createOrchestrator({
      transcript: resources.transcript,
      decide,
      /**
       * Dispatch wrapper: run the tool, then write the outcome back to the transcript so (a) the
       * model sees its own prior turns next heartbeat (memory) and (b) the web console's Tools/Agent
       * tabs + HUD light up. `no_op` returns null → nothing appended. The participantId is 'agent'
       * for spoken turns, else the tool name. The orchestrator already advances its cursor to the
       * claimed head only, so these self-authored entries don't cause a runaway self-trigger (and
       * the model's strong no_op bias holds for agent-authored lines).
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
        const outcome = await registry.dispatch(decision);
        if (!outcome) return;
        resources.transcript.append({
          participantId: outcome.senderKind === 'agent' ? 'agent' : decision.name,
          senderKind: outcome.senderKind,
          text: outcome.text,
          timestamp: Date.now(),
        });
      },
      /** Surface EVERY decision (incl. no_op) to the console's decision feed — UI-only, not the transcript. */
      onDecision: (decision) =>
        ws.broadcastDecision({ name: decision.name, detail: summarizeDecision(decision), ts: Date.now() }),
      scheduler: intervalScheduler(),
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
