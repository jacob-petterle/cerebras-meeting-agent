/**
 * The media leg's seam. VAD + STT + TTS sit BETWEEN the AudioIn port and the transcript resource,
 * and between the `speak` tool and the AudioOut port. Everything here is transport-agnostic: the
 * same `Vad`/`Stt`/`Tts` run whether audio arrives from the browser mic (now) or Zoom (later).
 *
 * ON-DEVICE ONLY — Moonshine (STT), kokoro (TTS), Silero (VAD). No hosted providers and no
 * fallbacks: the only off-device dependency in the whole system is the Cerebras LLM.
 */

import type { PcmFrame } from '@meeting-agent/protocol';

/** The audio format every component speaks internally: 16 kHz mono signed 16-bit PCM. */
export const TARGET_SAMPLE_RATE = 16_000;

/**
 * Utterance gate over raw PCM. Feeds frames in, emits a callback once per detected utterance with
 * the full speech segment (already 16 kHz mono) ready to hand to STT. Implementations buffer and
 * run Silero VAD; the gate — not the caller — decides where an utterance starts and ends.
 */
export interface Vad {
  /** Push one raw, speaker-tagged frame. Frames may be any sample rate; the Vad resamples. */
  pushFrame(frame: PcmFrame): void;
  /** Register a per-utterance handler. Returns an unsubscribe fn. */
  onUtterance(cb: (utterance: Utterance) => void): () => void;
  /**
   * Flush any buffered audio for a participant as a final utterance (e.g. on disconnect, or when an
   * adapter knows the speaker turn ended). Safe to call with no pending audio.
   */
  flush(participantId: string): Promise<void>;
}

/** A gated speech segment: one participant's contiguous utterance at {@link TARGET_SAMPLE_RATE}. */
export interface Utterance {
  participantId: string;
  /** 16 kHz mono signed 16-bit PCM. */
  pcm: Int16Array;
  sampleRate: number;
  /** Wall-clock ms when this utterance was emitted. */
  ts: number;
}

/** Speech-to-text. Takes 16 kHz mono PCM, returns the recognized text (may be empty for silence). */
export interface Stt {
  transcribe(pcm: Int16Array, sampleRate: number): Promise<string>;
  /** Eagerly load the model so the first real request isn't cold. Idempotent. */
  warmup(): Promise<void>;
}

/** Text-to-speech. Returns PCM at the engine's native rate (kokoro = 24 kHz); caller resamples. */
export interface Tts {
  synthesize(text: string): Promise<{ pcm: Int16Array; sampleRate: number }>;
  /** Eagerly load the model so the first real request isn't cold. Idempotent. */
  warmup(): Promise<void>;
}

/**
 * Local STT execution target. NOTE: transformers.js v3.8 has no `coreml` *device* (its device list
 * is cpu|wasm|webgpu|... ). `coreml` here is routed through onnxruntime-node's bundled CoreML
 * execution provider via `session_options.executionProviders`. Default `cpu`. This is on-device
 * acceleration — NOT a hosted fallback.
 */
export type SttDevice = 'cpu' | 'coreml';

export interface SttConfig {
  /** transformers.js model id for Moonshine. */
  model?: string;
  /** ONNX weight precision; `q8` is the speed/quality default for Moonshine on CPU. */
  dtype?: 'fp32' | 'fp16' | 'q8' | 'q4';
  /** Local execution target; defaults to `cpu`. See {@link SttDevice}. */
  device?: SttDevice;
}

export interface TtsConfig {
  /** kokoro-js model id. */
  model?: string;
  /** kokoro voice id (see `tts.list_voices()`); defaults to `af_heart`. */
  voice?: string;
  dtype?: 'fp32' | 'fp16' | 'q8' | 'q4' | 'q4f16';
}

export interface VadConfig {
  /**
   * Discard gated segments shorter than this (ms) — guards against the VAD firing on a cough or a
   * single click being sent to STT. Silero's own `minSpeechFrames` handles the in-model case; this
   * is a belt-and-suspenders floor at the boundary.
   */
  minUtteranceMs?: number;
  /** Silero score (0..1) above which a frame counts as speech. Default 0.5. */
  positiveSpeechThreshold?: number;
  /** Silero score below which a frame counts as silence. Default 0.35. */
  negativeSpeechThreshold?: number;
  /** Frames of sub-threshold audio tolerated before declaring speech-end. Default 8. */
  redemptionFrames?: number;
  /** Minimum speech frames for a segment to count (else a misfire). Default 3. */
  minSpeechFrames?: number;
  /** Frames of audio to prepend to an utterance so onsets aren't clipped. Default 1. */
  preSpeechPadFrames?: number;
}
