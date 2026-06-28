/**
 * Autonomous end-to-end smoke for the local meeting-agent loop — NO microphone.
 *
 * Boots the REAL server (main.ts) on a private port with the brain enabled, connects a headless WS
 * client, synthesizes speech with kokoro, and streams it as `pcm` frames over the WS exactly as the
 * browser mic would. Then it observes the whole loop on the WS surface — the same surface the web
 * app sees:
 *
 *   pcm frames → VAD → STT → transcript(append) → 5s heartbeat → Gemma decides
 *             → speak(TTS→`play`) | share_screen(`render`) | call_agent(`deliverable`)
 *
 * It captures every observable event with timestamps, prints a JSON summary between
 * ===E2E_SUMMARY_BEGIN/END=== markers, and exits non-zero if the audio→transcript leg never fired.
 *
 * Run (from repo root):  node_modules/.bin/tsx packages/server/scripts/e2e-live.mts
 * Imports (ws, kokoro-js) resolve from packages/server/node_modules via the script's own location.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { KokoroTTS } from 'kokoro-js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '../../..');
const PORT = Number(process.env.E2E_PORT ?? 8799);
const WS_URL = `ws://127.0.0.1:${PORT}`;
const SERVER_LOG = path.join(REPO_ROOT, 'docs', 'e2e-server.log');
const SUMMARY_JSON = path.join(REPO_ROOT, 'docs', 'e2e-summary.json');

const SESSION_CONTEXT =
  'A live pair-programming session on the cerebras-meeting-agent repo. Jacob is the human ' +
  'participant. He may ask the agent to answer quickly, investigate code via a sub-agent, or put a ' +
  'result on the shared screen. Help when there is a clear opening.';

/** The two things we say. #1 is a quick question; #2 is an explicit investigate-and-show request. */
const UTTERANCES = [
  'Hey, quick question. What is the capital of France?',
  'Can you investigate the double audio playback bug in the websocket client and put a short summary of the fix on the screen?',
];

interface Event {
  t: number; // ms since client start
  kind: string;
  detail: unknown;
}
const events: Event[] = [];
const T0 = Date.now();
function log(kind: string, detail: unknown = null): void {
  const e = { t: Date.now() - T0, kind, detail };
  events.push(e);
  const d = detail === null ? '' : ' ' + JSON.stringify(detail);
  console.log(`[e2e +${(e.t / 1000).toFixed(1)}s] ${kind}${d}`);
}

// ──────────────────────────────────────────────────────────────────────────────
// 1. Boot the real server (fresh process → exercises the UPDATED decide.ts / ws.ts).
// ──────────────────────────────────────────────────────────────────────────────
function bootServer(): ChildProcessWithoutNullStreams {
  log('server.spawn', { port: PORT, entry: 'packages/server/src/main.ts' });
  const env = { ...process.env, PORT: String(PORT), SESSION_CONTEXT };
  delete env.NODE_ENV; // never let production mode leak in
  const child = spawn(
    path.join(REPO_ROOT, 'node_modules', '.bin', 'tsx'),
    ['packages/server/src/main.ts'],
    { cwd: REPO_ROOT, env },
  );
  const logFile = createWriteStream(SERVER_LOG, { flags: 'w' });
  child.stdout.pipe(logFile);
  child.stderr.pipe(logFile);
  child.stdout.on('data', (b: Buffer) => {
    for (const line of b.toString().split('\n')) {
      const s = line.trim();
      if (s) console.log(`  [srv] ${s}`);
    }
  });
  child.stderr.on('data', (b: Buffer) => {
    const s = b.toString().trim();
    if (s) console.log(`  [srv:err] ${s.split('\n')[0]}`);
  });
  return child;
}

/** Wait for the server's "listening on ws://" line (model warmup happens in the background). */
async function waitForListening(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<void> {
  let resolved = false;
  return new Promise<void>((resolve, reject) => {
    const onData = (b: Buffer) => {
      if (b.toString().includes('listening on ws://')) {
        resolved = true;
        child.stdout.off('data', onData);
        resolve();
      }
    };
    child.stdout.on('data', onData);
    child.once('exit', (code) => {
      if (!resolved) reject(new Error(`server exited before listening (code ${code})`));
    });
    void sleep(timeoutMs).then(() => {
      if (!resolved) {
        child.stdout.off('data', onData);
        reject(new Error(`timed out after ${timeoutMs}ms waiting for the server to listen`));
      }
    });
  });
}

// ──────────────────────────────────────────────────────────────────────────────
// 2. Synthesize speech (kokoro) → Int16 PCM @24k → pcm frames over the WS.
// ──────────────────────────────────────────────────────────────────────────────
function f32ToI16(f32: Float32Array): number[] {
  const out = new Array<number>(f32.length);
  for (let i = 0; i < f32.length; i += 1) {
    const s = Math.max(-1, Math.min(1, f32[i] ?? 0));
    out[i] = s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff);
  }
  return out;
}

async function streamUtterance(ws: WebSocket, tts: KokoroTTS, text: string): Promise<void> {
  log('synthesize.start', { text });
  const raw = await tts.generate(text, { voice: 'af_heart' });
  const rate = raw.sampling_rate; // 24000
  const samples = f32ToI16(raw.audio);
  log('synthesize.done', { sampleRate: rate, samples: samples.length, approxSec: +(samples.length / rate).toFixed(2) });

  // ~30ms frames, paced loosely (VAD serialises; faster-than-real-time is fine).
  const frame = Math.round(rate * 0.03);
  const send = (pcm: number[]) =>
    ws.send(JSON.stringify({ type: 'pcm', participantId: 'me', sampleRate: rate, ts: Date.now(), pcm }));
  for (let i = 0; i < samples.length; i += frame) {
    send(samples.slice(i, i + frame));
    await sleep(8);
  }
  // ~1.5s of trailing silence so Silero crosses redemption → emits SPEECH_END → utterance flushes.
  const silence = new Array<number>(frame).fill(0);
  for (let i = 0; i < Math.ceil((rate * 1.5) / frame); i += 1) {
    send(silence);
    await sleep(8);
  }
  log('stream.done', { text });
}

// ──────────────────────────────────────────────────────────────────────────────
// 3. Observe the loop on the WS surface.
// ──────────────────────────────────────────────────────────────────────────────
const transcript: Array<{ seqNo: number; senderKind: string; participantId: string; text: string }> = [];
const deliverables: Array<{ id: string; kind: string; title: string }> = [];
const plays: Array<{ samples: number; sampleRate: number }> = [];
const renders: Array<{ kind: string; title?: string }> = [];
let lastStats: { tokensPerSec: number | null; promptTokens: number; completionTokens: number } | null = null;

function onMessage(raw: WebSocket.RawData): void {
  let m: any;
  try {
    m = JSON.parse(raw.toString());
  } catch {
    return;
  }
  switch (m.type) {
    case 'catch_up':
      if (m.resource === 'transcript') for (const e of m.entries) noteTranscript(e);
      if (m.resource === 'deliverables') for (const e of m.entries) noteDeliverable(e);
      break;
    case 'append':
      if (m.resource === 'transcript') noteTranscript(m.entry);
      if (m.resource === 'deliverables') noteDeliverable(m.entry);
      break;
    case 'play':
      plays.push({ samples: m.pcm?.length ?? 0, sampleRate: m.sampleRate });
      log('⟵ play (TTS)', { samples: m.pcm?.length ?? 0, sampleRate: m.sampleRate, approxSec: +(((m.pcm?.length ?? 0) / m.sampleRate) || 0).toFixed(2) });
      break;
    case 'render':
      renders.push({ kind: m.cmd?.kind, title: m.cmd?.title });
      log('⟵ render (share_screen)', { kind: m.cmd?.kind, title: m.cmd?.title });
      break;
    case 'stats':
      lastStats = { tokensPerSec: m.tokensPerSec, promptTokens: m.promptTokens, completionTokens: m.completionTokens };
      log('⟵ stats', lastStats);
      break;
    default:
      break;
  }
}
function noteTranscript(e: any): void {
  if (transcript.some((x) => x.seqNo === e.seqNo)) return;
  const row = { seqNo: e.seqNo, senderKind: e.data.senderKind, participantId: e.data.participantId, text: e.data.text };
  transcript.push(row);
  log('⟵ transcript', row);
}
function noteDeliverable(e: any): void {
  if (deliverables.some((x) => x.id === e.data.id)) return;
  const row = { id: e.data.id, kind: e.data.kind, title: e.data.title };
  deliverables.push(row);
  log('⟵ deliverable (call_agent)', row);
}

/** Wait until `pred()` or timeout; polls every 250ms. Returns whether it became true. */
async function waitUntil(pred: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return true;
    await sleep(250);
  }
  return pred();
}

// ──────────────────────────────────────────────────────────────────────────────
// Main
// ──────────────────────────────────────────────────────────────────────────────
async function main(): Promise<number> {
  const server = bootServer();
  let ws: WebSocket | null = null;
  try {
    await waitForListening(server, 60_000);
    log('server.listening');

    ws = new WebSocket(WS_URL);
    await new Promise<void>((res, rej) => {
      ws!.once('open', () => res());
      ws!.once('error', rej);
    });
    ws.on('message', onMessage);
    log('ws.open');
    ws.send(JSON.stringify({ type: 'subscribe', resource: 'transcript', sinceSeqNo: -1 }));
    ws.send(JSON.stringify({ type: 'subscribe', resource: 'deliverables', sinceSeqNo: -1 }));

    // Load kokoro in THIS process to synthesize the input audio.
    log('kokoro.load.start');
    const tts = await KokoroTTS.from_pretrained('onnx-community/Kokoro-82M-v1.0-ONNX', { dtype: 'q8', device: 'cpu' });
    log('kokoro.load.done');

    // ── Utterance 1: quick question ──
    const t1Before = transcript.length;
    await streamUtterance(ws, tts, UTTERANCES[0]!);
    const got1 = await waitUntil(() => transcript.length > t1Before, 90_000); // cold STT can be slow
    log('utterance1.transcribed', { ok: got1 });
    // Give the heartbeat (5s) + Gemma a window to react.
    await waitUntil(() => plays.length > 0 || renders.length > 0 || transcript.length > t1Before + 1, 20_000);

    // ── Utterance 2: investigate + show ──
    const t2Before = transcript.length;
    const dBefore = deliverables.length;
    await streamUtterance(ws, tts, UTTERANCES[1]!);
    await waitUntil(() => transcript.length > t2Before, 60_000);
    log('utterance2.transcribed', { ok: transcript.length > t2Before });
    // call_agent (mock <1s) → deliverable, then possibly a share_screen on a later tick.
    await waitUntil(() => deliverables.length > dBefore, 20_000);
    await waitUntil(() => renders.length > 0, 15_000);

    // Settle.
    await sleep(3000);

    const transcribedHuman = transcript.filter((x) => x.senderKind === 'human').length;
    const summary = {
      ok: transcribedHuman > 0,
      audioToTranscript: transcribedHuman > 0,
      counts: {
        transcript: transcript.length,
        humanLines: transcribedHuman,
        agentLines: transcript.filter((x) => x.senderKind === 'agent').length,
        toolLines: transcript.filter((x) => x.senderKind === 'tool').length,
        deliverables: deliverables.length,
        plays: plays.length,
        renders: renders.length,
      },
      lastStats,
      transcript,
      deliverables,
      renders,
      plays: plays.map((p) => ({ approxSec: +(p.samples / p.sampleRate).toFixed(2) })),
    };
    await writeFile(SUMMARY_JSON, JSON.stringify(summary, null, 2));
    console.log('\n===E2E_SUMMARY_BEGIN===');
    console.log(JSON.stringify(summary, null, 2));
    console.log('===E2E_SUMMARY_END===');
    return summary.ok ? 0 : 1;
  } finally {
    ws?.close();
    server.kill('SIGTERM');
    await sleep(500);
    if (!server.killed) server.kill('SIGKILL');
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    log('fatal', { error: String(err) });
    console.error(err);
    process.exit(2);
  });
