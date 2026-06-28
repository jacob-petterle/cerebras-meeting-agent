/**
 * Guarded media smoke. Loads the REAL local models (Silero VAD, Moonshine STT, kokoro TTS) and runs
 * one pass each. Skipped by default — these download model weights on first run and take seconds —
 * so `pnpm vitest run` stays fast and offline. Enable with `RUN_MEDIA_SMOKE=1`.
 *
 *   RUN_MEDIA_SMOKE=1 pnpm vitest run tests/media-smoke.test.ts
 *
 * This is a liveness check ("does it load and produce output"), not an accuracy/fidelity test —
 * STT/TTS quality is benched manually (see the plan's "Explicitly not testing").
 */

import { describe, it, expect } from 'vitest';
import { createVad } from '../packages/server/src/media/vad';
import { createStt } from '../packages/server/src/media/stt';
import { createTts } from '../packages/server/src/media/tts';
import { float32ToInt16 } from '../packages/server/src/media/pcm';
import { TARGET_SAMPLE_RATE } from '../packages/server/src/media/interface';

const RUN = process.env.RUN_MEDIA_SMOKE === '1';
const suite = RUN ? describe : describe.skip;
// Cold model load + inference: be generous (weights may download on first run).
const TIMEOUT = 180_000;

/** Synthetic 16 kHz tone with an envelope — not real speech, but a non-trivial buffer for STT. */
function syntheticTone(seconds: number, freq = 220): Int16Array {
  const n = Math.floor(seconds * TARGET_SAMPLE_RATE);
  const f = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / TARGET_SAMPLE_RATE;
    const env = Math.sin((Math.PI * i) / n); // fade in/out
    f[i] = 0.3 * env * Math.sin(2 * Math.PI * freq * t);
  }
  return float32ToInt16(f);
}

suite('media smoke (local models)', () => {
  it(
    'STT transcribes a synthetic 16k buffer to SOME string',
    async () => {
      const stt = createStt();
      const t0 = Date.now();
      const text = await stt.transcribe(syntheticTone(1.5), TARGET_SAMPLE_RATE);
      const ms = Date.now() - t0;
      console.info(`[smoke] STT returned ${JSON.stringify(text)} in ${ms}ms`);
      // A tone isn't words; we only assert the pipeline ran and returned a (possibly empty) string.
      expect(typeof text).toBe('string');
    },
    TIMEOUT,
  );

  it(
    'TTS synthesizes a word to non-empty 24k PCM',
    async () => {
      const tts = createTts();
      const t0 = Date.now();
      const { pcm, sampleRate } = await tts.synthesize('hello');
      const ms = Date.now() - t0;
      console.info(`[smoke] TTS produced ${pcm.length} samples @ ${sampleRate}Hz in ${ms}ms`);
      expect(sampleRate).toBe(24_000);
      expect(pcm).toBeInstanceOf(Int16Array);
      expect(pcm.length).toBeGreaterThan(0);
    },
    TIMEOUT,
  );

  it(
    'VAD gate round-trips: TTS speech in → at least one utterance out',
    async () => {
      // Use real synthesized speech (kokoro) as VAD input so Silero has actual voice to detect.
      const tts = createTts();
      const spoken = await tts.synthesize('the quick brown fox jumps over the lazy dog');

      const vad = createVad();
      const utterances: number[] = [];
      vad.onUtterance((u) => utterances.push(u.pcm.length));

      // Feed kokoro's 24k PCM in; the gate resamples to 16k internally.
      vad.pushFrame({
        participantId: 'p1',
        pcm: spoken.pcm,
        sampleRate: spoken.sampleRate,
        ts: Date.now(),
      });
      const t0 = Date.now();
      await vad.flush('p1');
      console.info(
        `[smoke] VAD gated ${utterances.length} utterance(s) from ${spoken.pcm.length} ` +
          `samples in ${Date.now() - t0}ms`,
      );
      expect(utterances.length).toBeGreaterThanOrEqual(1);
    },
    TIMEOUT,
  );

  it(
    'end-to-end: TTS → VAD gate → STT yields SOME text',
    async () => {
      const tts = createTts();
      const stt = createStt();
      const phrase = 'testing one two three';
      const spoken = await tts.synthesize(phrase);

      const vad = createVad();
      const collected: Int16Array[] = [];
      vad.onUtterance((u) => collected.push(u.pcm));
      vad.pushFrame({
        participantId: 'p1',
        pcm: spoken.pcm,
        sampleRate: spoken.sampleRate,
        ts: Date.now(),
      });
      await vad.flush('p1');

      const first = collected[0];
      expect(first).toBeDefined();
      if (!first) {
        return;
      }
      const text = await stt.transcribe(first, TARGET_SAMPLE_RATE);
      console.info(`[smoke] e2e TTS("${phrase}") → STT => ${JSON.stringify(text)}`);
      expect(typeof text).toBe('string');
      expect(text.length).toBeGreaterThan(0);
    },
    TIMEOUT,
  );
});
