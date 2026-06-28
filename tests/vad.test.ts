import { describe, it, expect, vi } from 'vitest';
import type { PcmFrame } from '@meeting-agent/protocol';
import { createVad } from '../packages/server/src/media/vad';
import type {
  FrameResampler,
  VadEngine,
  VadEngineDeps,
  VadFrameProcessor,
} from '../packages/server/src/media/vad';
import type { Utterance } from '../packages/server/src/media/interface';

/**
 * VAD via the `VadEngineDeps` injection seam — no Silero model load. The class is private; we drive
 * it through `createVad(config, deps)` with fake engine + resampler, exactly as production does
 * minus the real onnx engine.
 */

const frame = (pcm: number[]): PcmFrame => ({
  participantId: 'u1',
  pcm: Int16Array.from(pcm),
  sampleRate: 16_000,
  ts: Date.now(),
});

/** A resampler that emits exactly one 16 kHz frame per input (1:1), so process() calls are countable. */
function oneToOneResampler(): FrameResampler {
  return { process: (f) => [f] };
}

describe('vad fault tolerance (injection seam)', () => {
  it('a processFrame that throws once does not wedge the chain — subsequent frames still process', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const processed: number[] = []; // records the call index reaching the engine
      let call = 0;
      const fp: VadFrameProcessor = {
        resume: () => {},
        process: async () => {
          const i = call++;
          processed.push(i);
          if (i === 0) throw new Error('silero exploded on the first frame');
          // The 3rd frame closes a segment with audio so we can prove the gate still emits post-error.
          if (i === 2) return { msg: 'SPEECH_END', audio: Float32Array.from([0.5, -0.5, 0.5]) };
          return {};
        },
        endSegment: () => ({}),
      };
      const engine: VadEngine = { frameProcessor: fp };
      const deps: VadEngineDeps = {
        createEngine: async () => engine,
        createResampler: () => oneToOneResampler(),
      };

      // minUtteranceMs: 0 so the tiny 3-sample segment isn't floored out.
      const vad = createVad({ minUtteranceMs: 0 }, deps);
      const utterances: Utterance[] = [];
      vad.onUtterance((u) => utterances.push(u));

      vad.pushFrame(frame([1, 2, 3])); // call 0 → throws
      vad.pushFrame(frame([4, 5, 6])); // call 1 → ok
      vad.pushFrame(frame([7, 8, 9])); // call 2 → SPEECH_END + audio

      // flush drains the per-participant tail (and force-closes); it must not reject.
      await vad.flush('u1');

      // All three frames reached the engine despite the first one throwing.
      expect(processed).toEqual([0, 1, 2]);
      // And the post-error segment was emitted as an utterance.
      expect(utterances).toHaveLength(1);
      expect(utterances[0]!.participantId).toBe('u1');
      expect(utterances[0]!.sampleRate).toBe(16_000);
    } finally {
      errSpy.mockRestore();
    }
  });

  it('flush does not reject when the engine fails to load (it clears the participant instead)', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const deps: VadEngineDeps = {
        createEngine: async () => {
          throw new Error('engine load failed');
        },
        createResampler: () => oneToOneResampler(),
      };
      const vad = createVad({}, deps);

      // Touch the participant so state exists, then flush — the load rejection must be contained.
      vad.pushFrame(frame([1, 2, 3]));
      await expect(vad.flush('u1')).resolves.toBeUndefined();
    } finally {
      errSpy.mockRestore();
    }
  });
});
