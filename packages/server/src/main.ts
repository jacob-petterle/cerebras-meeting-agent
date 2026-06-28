import { createResources } from './core/resources';
import { createCerebrasClient } from './core/cerebras';
import { createDecide } from './core/decide';
import { createOrchestrator, intervalScheduler } from './core/orchestrator';
import { createRegistry } from './core/tools/registry';
import { createCallAgentMock } from './core/tools/callAgent/mock';
import { createVad, createStt, createTts } from './media';
import { createWsServer } from './ws';
import { createAudioInWs } from './adapters/local/audioInWs';
import { createAudioOutWs } from './adapters/local/audioOutWs';
import { createDisplayWs } from './adapters/local/displayWs';
import type { Ports } from './core/ports';

/**
 * Local harness entrypoint — wires the transport-agnostic core to the LOCAL adapter set:
 *   browser mic (WS pcm) → VAD → STT → transcript
 *   5s heartbeat → Gemma decides → tools (speak/share_screen/call_agent/no_op)
 *   speak → TTS → browser speakers ·  share_screen → browser stage
 * Attaching Zoom later swaps `adapters/local/*` for `adapters/zoom/*` here; nothing else changes.
 */

const PORT = Number(process.env.PORT ?? 8787);
/** Verbose per-frame pipeline logging (high-frequency). Off by default; `DEBUG_PIPE=1` to enable. */
const DEBUG_PIPE = process.env.DEBUG_PIPE === '1';
const SESSION_CONTEXT =
  process.env.SESSION_CONTEXT ??
  'A local test session. One human participant ("me") is speaking into a microphone. No specific project is in scope yet — be a generally helpful collaborator.';

async function main(): Promise<void> {
  // Load .env if present (Node >= 20.12 / 22). Absent file is fine.
  try {
    process.loadEnvFile?.('.env');
  } catch {
    /* no .env — rely on the ambient environment */
  }

  const apiKey = process.env.CEREBRAS_API_KEY ?? '';

  // Resource spine (transcript + deliverables append-logs).
  const resources = createResources();

  // Media leg — on-device only (Moonshine / kokoro / Silero). No hosted providers, no fallbacks.
  const vad = createVad({});
  const stt = createStt();
  const tts = createTts();

  // Transport: AudioIn source + WS server + AudioOut/Display adapters over the same socket.
  const { port: audioIn, deliver } = createAudioInWs();
  const ws = createWsServer({ resources, onPcm: deliver, port: PORT });
  const ports: Ports = {
    audioIn,
    audioOut: createAudioOutWs(ws),
    display: createDisplayWs(ws),
  };

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
