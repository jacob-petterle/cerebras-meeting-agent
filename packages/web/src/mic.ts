import { unlockPlayback } from './playback';
import { useHarnessStore } from './store';
import { sendPcm } from './ws';

/**
 * The dumb mic source. getUserMedia -> AudioWorklet (native-rate Float32) ->
 * Int16 PCM -> WS. No VAD, no STT, no resampling in the browser; the server does
 * all of that (parity with the future Zoom adapter -- see AGENTS.md). We send the
 * AudioContext's ACTUAL sample rate (e.g. 48000); the server resamples to 16 kHz.
 */

let audioCtx: AudioContext | null = null;
let mediaStream: MediaStream | null = null;
let sourceNode: MediaStreamAudioSourceNode | null = null;
let workletNode: AudioWorkletNode | null = null;
let scriptNode: ScriptProcessorNode | null = null;
let silentSink: GainNode | null = null;

/** Int16 conversion + an RMS level reading for the input meter. */
function frameToPcm(frame: Float32Array): number[] {
  const out = new Array<number>(frame.length);
  let sumSquares = 0;
  for (let i = 0; i < frame.length; i += 1) {
    const sample = Math.max(-1, Math.min(1, frame[i] ?? 0));
    sumSquares += sample * sample;
    out[i] = sample < 0 ? Math.round(sample * 0x8000) : Math.round(sample * 0x7fff);
  }
  const rms = Math.sqrt(sumSquares / frame.length);
  useHarnessStore.getState().setMicLevel(Math.min(1, rms * 3.2));
  return out;
}

function emit(frame: Float32Array, sampleRate: number): void {
  sendPcm(sampleRate, frameToPcm(frame));
}

async function startWorklet(ctx: AudioContext, source: MediaStreamAudioSourceNode): Promise<boolean> {
  if (!ctx.audioWorklet) return false;
  try {
    await ctx.audioWorklet.addModule('/pcm-worklet.js');
  } catch {
    return false;
  }
  const node = new AudioWorkletNode(ctx, 'pcm-capture');
  const rate = ctx.sampleRate;
  node.port.onmessage = (event: MessageEvent) => {
    const data: unknown = event.data;
    if (data instanceof Float32Array) emit(data, rate);
  };
  // Pull the node so process() runs, but route through a muted sink so the mic
  // is never echoed back to the speakers.
  const sink = ctx.createGain();
  sink.gain.value = 0;
  source.connect(node);
  node.connect(sink);
  sink.connect(ctx.destination);
  workletNode = node;
  silentSink = sink;
  return true;
}

function startScriptProcessor(ctx: AudioContext, source: MediaStreamAudioSourceNode): void {
  const node = ctx.createScriptProcessor(4096, 1, 1);
  const rate = ctx.sampleRate;
  node.onaudioprocess = (event: AudioProcessingEvent) => {
    emit(new Float32Array(event.inputBuffer.getChannelData(0)), rate);
  };
  source.connect(node);
  node.connect(ctx.destination);
  scriptNode = node;
}

export async function startMic(): Promise<void> {
  if (audioCtx) return;
  unlockPlayback();

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 },
  });

  try {
    const ctx = new AudioContext();
    // A fresh AudioContext can land in 'suspended' under the browser autoplay policy; resume it
    // inside the mic-button gesture so the capture worklet's process() actually runs and PCM frames
    // flow. This is the difference between "mic on, nothing streams" and a live pipeline (it didn't
    // bite under a trusted automated click, but a real tab — backgrounded, refocused — can). No-op
    // when already running.
    if (ctx.state === 'suspended') await ctx.resume();
    const source = ctx.createMediaStreamSource(stream);
    audioCtx = ctx;
    mediaStream = stream;
    sourceNode = source;

    const viaWorklet = await startWorklet(ctx, source);
    if (!viaWorklet) startScriptProcessor(ctx, source);

    useHarnessStore.getState().setMicOn(true);
  } catch (err) {
    for (const track of stream.getTracks()) track.stop();
    audioCtx = null;
    mediaStream = null;
    sourceNode = null;
    throw err;
  }
}

export function stopMic(): void {
  try {
    if (scriptNode) scriptNode.onaudioprocess = null;
    if (workletNode) workletNode.port.onmessage = null;
    sourceNode?.disconnect();
    workletNode?.disconnect();
    scriptNode?.disconnect();
    silentSink?.disconnect();
    for (const track of mediaStream?.getTracks() ?? []) track.stop();
    void audioCtx?.close();
  } finally {
    audioCtx = null;
    mediaStream = null;
    sourceNode = null;
    workletNode = null;
    scriptNode = null;
    silentSink = null;
    const store = useHarnessStore.getState();
    store.setMicOn(false);
    store.setMicLevel(0);
  }
}
