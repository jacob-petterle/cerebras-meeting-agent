/**
 * Text-to-speech — kokoro-js (82M params) on onnxruntime-node CPU, ON-DEVICE ONLY. No hosted
 * provider, no fallback.
 *
 * kokoro specifics (verified against kokoro-js 1.2.1 source):
 *   - `KokoroTTS.from_pretrained(model_id, { dtype, device })`; device on Node is `cpu`.
 *   - `generate(text, { voice, speed })` → `RawAudio { audio: Float32Array; sampling_rate: 24000 }`.
 *   - output is ALWAYS 24 kHz (hardcoded `new RawAudio(data, 24e3)`); callers resample for playback.
 *   - `voice` must be one of kokoro's 28 ids; unknown voices throw inside `_validate_voice`.
 */

import { z } from 'zod';
import { KokoroTTS } from 'kokoro-js';
import type { Tts, TtsConfig } from './interface';
import { float32ToInt16 } from './pcm';

const DEFAULT_MODEL = 'onnx-community/Kokoro-82M-v1.0-ONNX';
const DEFAULT_VOICE = 'af_heart';

/**
 * kokoro's 28 voice ids. A Zod enum lets us `.parse()` a config string into the exact union
 * `from_pretrained` expects — no type assertion, and an unknown voice fails loudly at construction.
 */
const KokoroVoice = z.enum([
  'af_heart', 'af_alloy', 'af_aoede', 'af_bella', 'af_jessica', 'af_kore', 'af_nicole', 'af_nova',
  'af_river', 'af_sarah', 'af_sky', 'am_adam', 'am_echo', 'am_eric', 'am_fenrir', 'am_liam',
  'am_michael', 'am_onyx', 'am_puck', 'am_santa', 'bf_emma', 'bf_isabella', 'bm_george', 'bm_lewis',
  'bf_alice', 'bf_lily', 'bm_daniel', 'bm_fable',
]);
type KokoroVoice = z.infer<typeof KokoroVoice>;

/** kokoro always emits 24 kHz; validate that invariant so a model change can't silently break it. */
const RawAudioShape = z.object({
  audio: z.instanceof(Float32Array),
  sampling_rate: z.number().positive(),
});

class LocalKokoroTts implements Tts {
  private readonly model: string;
  private readonly voice: KokoroVoice;
  private readonly dtype: NonNullable<TtsConfig['dtype']>;
  private tts: KokoroTTS | undefined;
  private loading: Promise<KokoroTTS> | undefined;

  constructor(config: TtsConfig) {
    this.model = config.model ?? DEFAULT_MODEL;
    this.voice = KokoroVoice.parse(config.voice ?? DEFAULT_VOICE);
    this.dtype = config.dtype ?? 'q8';
  }

  async warmup(): Promise<void> {
    await this.load();
  }

  private async load(): Promise<KokoroTTS> {
    if (this.tts) {
      return this.tts;
    }
    if (!this.loading) {
      this.loading = KokoroTTS.from_pretrained(this.model, {
        dtype: this.dtype,
        device: 'cpu',
      }).then((instance) => {
        this.tts = instance;
        return instance;
      });
    }
    return this.loading;
  }

  async synthesize(text: string): Promise<{ pcm: Int16Array; sampleRate: number }> {
    const trimmed = text.trim();
    if (trimmed.length === 0) {
      // Nothing to say — return empty PCM at kokoro's native rate rather than invoking the model.
      return { pcm: new Int16Array(0), sampleRate: 24_000 };
    }
    const tts = await this.load();
    const raw = RawAudioShape.parse(await tts.generate(trimmed, { voice: this.voice }));
    return { pcm: float32ToInt16(raw.audio), sampleRate: raw.sampling_rate };
  }
}

/** Construct the on-device kokoro TTS. No mode, no provider — local is the only path. */
export function createTts(config: TtsConfig = {}): Tts {
  return new LocalKokoroTts(config);
}
