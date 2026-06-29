import { fileURLToPath } from 'node:url';
import { createResources } from './core/resources';
import { createCerebrasClient } from './core/cerebras';
import { createDecide } from './core/decide';
import { createOrchestrator, intervalScheduler } from './core/orchestrator';
import { createRegistry } from './core/tools/registry';
import { createCallAgentMock } from './core/tools/callAgent/mock';
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
 *   browser mic (WS pcm) → VAD → STT → transcript
 *   5s heartbeat → Gemma decides → tools (speak/share_screen/call_agent/no_op)
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
const SESSION_CONTEXT =
  process.env.SESSION_CONTEXT ??
  'A local test session. One human participant ("me") is speaking into a microphone. No specific project is in scope yet — be a generally helpful collaborator.';

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

  // Resource spine (transcript + deliverables append-logs).
  const resources = createResources();

  // Media leg — on-device only (Moonshine / kokoro / Silero). No hosted providers, no fallbacks.
  const vad = createVad({});
  const stt = createStt();
  const tts = createTts();

  // Transport: pick the adapter set, then stand up the WS server (always — it serves the stage + HUD
  // in both modes). In LOCAL mode the WS inbound `pcm` hook feeds the pipeline; in ZOOM mode audio
  // comes from the file-tailer instead, so we leave the WS mic hook unwired.
  let audioIn: AudioInPort;
  let audioOut: AudioOutPort;
  let display: DisplayPort;
  let ws: WsServerHandle;
  /** ZOOM-only teardown (stop the tailer poll loop + close the uplink socket). */
  let stopTransport: (() => void) | null = null;

  if (ZOOM) {
    const bridge = createAudioInBridge({ outDir: BOT_OUT_DIR, excludeNodeId: EXCLUDE_NODE_ID });
    const uplink = createAudioOutUplink({ port: BOT_TTS_PORT });
    // WS server runs with NO mic hook — stage + HUD only; audio comes from the file-tailer.
    ws = createWsServer({ resources, port: PORT });
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
    ws = createWsServer({ resources, onPcm: localIn.deliver, port: PORT });
    audioIn = localIn.port;
    audioOut = createAudioOutWs(ws);
    display = createDisplayWs(ws);
  }

  const ports: Ports = { audioIn, audioOut, display };

  // AudioIn → VAD → STT → transcript. The per-utterance VAD/STT lines are kept as terminal-side
  // observability (the meeting agent's pipeline is meant to be watchable); the high-frequency
  // per-frame pcm log is gated behind DEBUG_PIPE so the default output stays readable.
  let pcmFrames = 0;
  audioIn.onPcm((frame) => {
    if (DEBUG_PIPE && pcmFrames++ % 40 === 0) {
      console.log(`[pipe] pcm #${pcmFrames} ${frame.participantId} @${frame.sampleRate}Hz ${frame.pcm.length}smp`);
    }
    vad.pushFrame(frame);
  });
  vad.onUtterance(async (u) => {
    console.log(`[pipe] VAD→utterance ${u.pcm.length}smp @${u.sampleRate}Hz`);
    const text = (await stt.transcribe(u.pcm, u.sampleRate)).trim();
    console.log(`[pipe] STT→ "${text}"`);
    if (!text) return;
    resources.transcript.append({
      participantId: u.participantId,
      senderKind: 'human',
      text,
      timestamp: u.ts,
    });
  });

  const boundPort = await ws.whenReady;
  console.log(`[main] meeting-agent listening on ws://127.0.0.1:${boundPort}`);

  /** Heartbeat stopper, set when the brain is enabled; invoked by the graceful-shutdown handler. */
  let stopHeartbeat: (() => void) | null = null;

  // Brain + tools + 5s heartbeat — only when a key is present, so the server still binds (and
  // audio/transcript still stream to the web app) without one. The OpenAI client throws on an
  // empty key, so we must not construct it unconditionally.
  if (apiKey) {
    const cerebras = createCerebrasClient({ apiKey });
    const decide = createDecide({
      cerebras,
      context: SESSION_CONTEXT,
      /** The deliverables resource — observed as a `<deliverables>` block each tick (not in-band). */
      deliverables: resources.deliverables,
      /** Live tok/s + token counts → the web HUD (otherwise computed in cerebras.ts and discarded). */
      onStats: (stats) => ws.broadcastStats(stats),
    });
    const callAgent = createCallAgentMock({
      deliverables: resources.deliverables,
      outDir: '.deliverables',
    });
    const registry = createRegistry({
      ports,
      tts: (text) => tts.synthesize(text),
      callAgent,
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
        const outcome = await registry.dispatch(decision);
        if (!outcome) return;
        resources.transcript.append({
          participantId: outcome.senderKind === 'agent' ? 'agent' : decision.name,
          senderKind: outcome.senderKind,
          text: outcome.text,
          timestamp: Date.now(),
        });
      },
      scheduler: intervalScheduler(),
    });
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
