/**
 * Speech-to-text — Moonshine via transformers.js on onnxruntime-node, ON-DEVICE ONLY. No hosted
 * provider, no fallback.
 *
 * Moonshine specifics (verified against @huggingface/transformers 3.8.1 source):
 *   - task `automatic-speech-recognition`, model `onnx-community/moonshine-base-ONNX`.
 *   - the pipeline takes a Float32Array at the model's 16 kHz rate and returns `{ text }`.
 *   - `_call_moonshine` derives `max_new_tokens` from audio length internally; no extra opts needed.
 *
 * NOTE on device: transformers.js 3.8.1 device types are auto|gpu|cpu|wasm|webgpu|cuda|dml|webnn*.
 * There is NO `coreml` device. Default is `cpu` (onnxruntime-node CPU EP). `device: 'coreml'` is
 * honoured via `session_options.executionProviders: ['coreml']`, which onnxruntime-node's bundled
 * CoreML EP picks up (transformers keeps a user-supplied executionProviders — models.js:253 `??=`).
 * Moonshine ops unsupported by CoreML fall back to CPU, so treat 'coreml' as opportunistic on-device
 * acceleration (still local — not a hosted fallback).
 */

import { z } from 'zod';
import { env, pipeline } from '@huggingface/transformers';
import { type Stt, type SttConfig, TARGET_SAMPLE_RATE } from './interface';
import { int16ToFloat32, resampleFloat32 } from './pcm';

const DEFAULT_MODEL = 'onnx-community/moonshine-base-ONNX';

/** Moonshine returns `{ text }` (or an array of them for batched input). Validate at the boundary. */
const AsrOutput = z.union([
  z.object({ text: z.string() }),
  z.array(z.object({ text: z.string() })).min(1),
]);

/** The transformers ASR pipeline is an async-callable object; this is the slice we depend on. */
type AsrPipeline = (audio: Float32Array) => Promise<unknown>;

class LocalMoonshineStt implements Stt {
  private readonly model: string;
  private readonly dtype: NonNullable<SttConfig['dtype']>;
  private readonly device: NonNullable<SttConfig['device']>;
  private asr: AsrPipeline | undefined;
  private loading: Promise<AsrPipeline> | undefined;

  constructor(config: SttConfig) {
    this.model = config.model ?? DEFAULT_MODEL;
    this.dtype = config.dtype ?? 'q8';
    this.device = config.device ?? 'cpu';
    // Allow loading model weights from the local HF cache and from the Hub (first run downloads).
    env.allowLocalModels = true;
    env.allowRemoteModels = true;
  }

  async warmup(): Promise<void> {
    await this.load();
  }

  private async load(): Promise<AsrPipeline> {
    if (this.asr) {
      return this.asr;
    }
    if (!this.loading) {
      // transformers throws on an unknown `device`, so CoreML is requested via the EP escape hatch
      // (session_options.executionProviders) while `device` stays a valid 'cpu'.
      this.loading = pipeline('automatic-speech-recognition', this.model, {
        device: 'cpu',
        dtype: this.dtype,
        ...(this.device === 'coreml'
          ? { session_options: { executionProviders: ['coreml'] } }
          : {}),
      }).then((pipe): AsrPipeline => {
        // The pipeline instance is itself callable; narrow to our minimal call signature.
        const callable: AsrPipeline = (audio) => pipe(audio);
        this.asr = callable;
        return callable;
      });
    }
    return this.loading;
  }

  async transcribe(pcm: Int16Array, sampleRate: number): Promise<string> {
    if (pcm.length === 0) {
      return '';
    }
    const asr = await this.load();
    const float = resampleFloat32(int16ToFloat32(pcm), sampleRate, TARGET_SAMPLE_RATE);
    const raw = await asr(float);
    const parsed = AsrOutput.parse(raw);
    const text = Array.isArray(parsed) ? (parsed[0]?.text ?? '') : parsed.text;
    return text.trim();
  }
}

/** Construct the on-device Moonshine STT. No mode, no provider — local is the only path. */
export function createStt(config: SttConfig = {}): Stt {
  return new LocalMoonshineStt(config);
}
