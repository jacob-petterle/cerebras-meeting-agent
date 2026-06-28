/**
 * Streaming Silero VAD utterance gate via `@ricky0123/vad-node`.
 *
 * Frames are pushed in continuously (`pushFrame`) and the gate emits a complete {@link Utterance}
 * the moment Silero detects speech-end — no external "flush" caller is required for utterances to
 * flow (that was the trap in a batch/`run()`-on-flush design: nothing emits until someone flushes).
 *
 * How it works (verified against @ricky0123/vad-node 0.0.3 source):
 *   - `NonRealTimeVAD.new(opts)` builds a `frameProcessor` with a Silero model bound and `resume()`d.
 *   - We feed it exact 16 kHz frames (1536 samples) produced by vad-node's own `Resampler`, and read
 *     `process(frame)`'s `{ msg, audio }`: `SPEECH_END` carries the full utterance (incl. pre-pad).
 *   - Each participant gets its OWN engine, so independent Silero LSTM state never crosses speakers,
 *     and per-participant frame processing is serialised on a promise chain (a Silero session must
 *     never be `process()`-ed concurrently).
 *
 * `flush(participantId)` force-closes any in-flight speech (e.g. on disconnect) via `endSegment()`.
 */

import { NonRealTimeVAD, Resampler } from '@ricky0123/vad-node';
import type { PcmFrame } from '@meeting-agent/protocol';
import { TARGET_SAMPLE_RATE, type Utterance, type Vad, type VadConfig } from './interface';
import { float32ToInt16, int16ToFloat32 } from './pcm';

/** Silero message string values (mirror vad-node's `Message` enum; kept local to avoid the import). */
const SPEECH_START = 'SPEECH_START';
const SPEECH_END = 'SPEECH_END';

/** Samples per Silero frame at 16 kHz. 1536 is the model's recommended value (frame-processor.ts). */
const FRAME_SAMPLES = 1536;
const DEFAULT_MIN_UTTERANCE_MS = 250;

/** The slice of vad-node's FrameProcessor we drive (lets us inject a fake in unit tests). */
export interface VadFrameProcessor {
  resume(): void;
  process(frame: Float32Array): Promise<{ msg?: string; audio?: Float32Array }>;
  endSegment(): { msg?: string; audio?: Float32Array };
}

/** A wired Silero engine — a `NonRealTimeVAD` exposes its `frameProcessor` publicly. */
export interface VadEngine {
  frameProcessor?: VadFrameProcessor;
}

/** Buffers arbitrary-size input into exact 16 kHz frames (matches vad-node's `Resampler`). */
export interface FrameResampler {
  process(frame: Float32Array): Float32Array[];
}

/** Injection seam: how to build a Silero engine + resampler. Defaults to the real vad-node ones. */
export interface VadEngineDeps {
  createEngine: () => Promise<VadEngine>;
  createResampler: (inputRate: number) => FrameResampler;
}

interface ParticipantState {
  engine: Promise<VadEngine>;
  resampler: FrameResampler;
  inputRate: number;
  speaking: boolean;
  /** serialises process() calls so the single Silero session is never run concurrently */
  tail: Promise<void>;
}

function defaultEngineDeps(config: VadConfig): VadEngineDeps {
  const options = {
    frameSamples: FRAME_SAMPLES,
    positiveSpeechThreshold: config.positiveSpeechThreshold ?? 0.5,
    negativeSpeechThreshold: config.negativeSpeechThreshold ?? 0.35,
    redemptionFrames: config.redemptionFrames ?? 8,
    minSpeechFrames: config.minSpeechFrames ?? 3,
    preSpeechPadFrames: config.preSpeechPadFrames ?? 1,
  };
  return {
    createEngine: () => NonRealTimeVAD.new(options),
    createResampler: (inputRate: number) =>
      new Resampler({
        nativeSampleRate: inputRate,
        targetSampleRate: TARGET_SAMPLE_RATE,
        targetFrameSize: FRAME_SAMPLES,
      }),
  };
}

class SileroVad implements Vad {
  private readonly deps: VadEngineDeps;
  private readonly minUtteranceSamples: number;
  private readonly states = new Map<string, ParticipantState>();
  private readonly subscribers = new Set<(u: Utterance) => void>();

  constructor(config: VadConfig = {}, deps: VadEngineDeps = defaultEngineDeps(config)) {
    this.deps = deps;
    const minMs = config.minUtteranceMs ?? DEFAULT_MIN_UTTERANCE_MS;
    this.minUtteranceSamples = Math.floor((minMs / 1000) * TARGET_SAMPLE_RATE);
  }

  onUtterance(cb: (u: Utterance) => void): () => void {
    this.subscribers.add(cb);
    return () => {
      this.subscribers.delete(cb);
    };
  }

  pushFrame(frame: PcmFrame): void {
    const state = this.ensureState(frame.participantId, frame.sampleRate);
    /**
     * Fire-and-forget, but serialised per participant so the Silero session runs frames in order.
     * The `.catch` is load-bearing: a rejected processFrame must resolve the tail anyway, or the
     * promise chain stays permanently rejected and every later frame for this participant is
     * silently dropped. Swallow (optionally log) and keep the gate alive.
     */
    state.tail = state.tail.then(() => this.processFrame(state, frame)).catch((err: unknown) => {
      console.error('[vad] processFrame failed:', err);
    });
  }

  private ensureState(participantId: string, inputRate: number): ParticipantState {
    const existing = this.states.get(participantId);
    if (existing) {
      if (existing.inputRate !== inputRate) {
        existing.resampler = this.deps.createResampler(inputRate);
        existing.inputRate = inputRate;
      }
      return existing;
    }
    const state: ParticipantState = {
      engine: this.deps.createEngine().then((engine) => {
        engine.frameProcessor?.resume();
        return engine;
      }),
      resampler: this.deps.createResampler(inputRate),
      inputRate,
      speaking: false,
      tail: Promise.resolve(),
    };
    this.states.set(participantId, state);
    return state;
  }

  private async processFrame(state: ParticipantState, frame: PcmFrame): Promise<void> {
    const fp = (await state.engine).frameProcessor;
    if (!fp) return;
    const float = int16ToFloat32(frame.pcm);
    for (const frame16k of state.resampler.process(float)) {
      const { msg, audio } = await fp.process(frame16k);
      if (msg === SPEECH_START) {
        state.speaking = true;
      } else if (msg === SPEECH_END) {
        state.speaking = false;
        if (audio) this.maybeEmit(frame.participantId, audio);
      }
    }
  }

  async flush(participantId: string): Promise<void> {
    const state = this.states.get(participantId);
    if (!state) return;
    /**
     * flush is called on disconnect/turn-end — it must never reject. If the engine failed to load
     * (or any in-flight frame rejected), there's nothing to force-close: drop the participant's
     * state and return cleanly rather than surfacing the load error to the caller.
     */
    try {
      await state.tail;
      const fp = (await state.engine).frameProcessor;
      if (!fp) return;
      const { msg, audio } = fp.endSegment();
      if (msg === SPEECH_END && audio) this.maybeEmit(participantId, audio);
      state.speaking = false;
    } catch (err) {
      console.error('[vad] flush failed:', err);
      this.states.delete(participantId);
    }
  }

  private maybeEmit(participantId: string, audio16k: Float32Array): void {
    if (audio16k.length < this.minUtteranceSamples) return;
    const utterance: Utterance = {
      participantId,
      pcm: float32ToInt16(audio16k),
      sampleRate: TARGET_SAMPLE_RATE,
      ts: Date.now(),
    };
    for (const cb of this.subscribers) {
      cb(utterance);
    }
  }
}

/**
 * Build the VAD gate. `deps` is the {@link VadEngineDeps} injection seam — production omits it (the
 * real vad-node Silero engine + resampler are used); tests pass fakes so the gate can be exercised
 * with no model load. `SileroVad` itself stays private, mirroring stt.ts/tts.ts.
 */
export function createVad(config?: VadConfig, deps?: VadEngineDeps): Vad {
  return deps ? new SileroVad(config ?? {}, deps) : new SileroVad(config);
}
