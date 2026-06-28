import { describe, it, expect } from 'vitest';
import {
  int16ToFloat32,
  float32ToInt16,
  resampleFloat32,
  resampleInt16,
} from '../packages/server/src/media/pcm';

describe('PCM conversion', () => {
  it('int16 → float32 maps full-scale samples into [-1, 1]', () => {
    const f = int16ToFloat32(Int16Array.from([0, 32767, -32768, 16384]));
    expect(f[0]).toBe(0);
    expect(f[1]).toBeCloseTo(1, 5);
    expect(f[2]).toBeCloseTo(-1, 5);
    expect(f[3]).toBeCloseTo(0.5, 3);
  });

  it('float32 → int16 clamps out-of-range values', () => {
    const i = float32ToInt16(Float32Array.from([0, 1, -1, 2, -2, 0.5]));
    expect(i[0]).toBe(0);
    expect(i[1]).toBe(32767);
    expect(i[2]).toBe(-32768);
    expect(i[3]).toBe(32767); // 2.0 clamped to +1
    expect(i[4]).toBe(-32768); // -2.0 clamped to -1
    expect(i[5]).toBeCloseTo(16384, -1);
  });

  it('int16 ↔ float32 round-trips within 1 LSB', () => {
    const original = Int16Array.from([0, 1000, -1000, 32767, -32768, 12345, -6789]);
    const round = float32ToInt16(int16ToFloat32(original));
    for (let k = 0; k < original.length; k++) {
      expect(Math.abs((round[k] ?? 0) - (original[k] ?? 0))).toBeLessThanOrEqual(1);
    }
  });
});

describe('resampling', () => {
  it('returns the input unchanged when rates match (no-op fast path)', () => {
    const f = Float32Array.from([0.1, 0.2, 0.3]);
    expect(resampleFloat32(f, 16000, 16000)).toBe(f);
    const i = Int16Array.from([1, 2, 3]);
    expect(resampleInt16(i, 16000, 16000)).toBe(i);
  });

  it('48k → 16k downsamples length by ~1/3', () => {
    const input = new Float32Array(4800); // 0.1s at 48k
    for (let k = 0; k < input.length; k++) {
      input[k] = Math.sin((2 * Math.PI * 100 * k) / 48000);
    }
    const out = resampleFloat32(input, 48000, 16000);
    expect(out.length).toBe(1600); // 0.1s at 16k
    // endpoints preserved (linear interp keeps first/last sample positions)
    expect(out[0]).toBeCloseTo(input[0] ?? 0, 5);
  });

  it('24k → 48k upsamples length by ~2x', () => {
    const input = new Float32Array(2400); // 0.1s at 24k
    const out = resampleFloat32(input, 24000, 48000);
    expect(out.length).toBe(4800);
  });

  it('preserves a constant (DC) signal under resampling', () => {
    const input = new Float32Array(1000).fill(0.42);
    const out = resampleFloat32(input, 48000, 16000);
    for (const v of out) {
      expect(v).toBeCloseTo(0.42, 5);
    }
  });

  it('handles empty input without throwing', () => {
    expect(resampleFloat32(new Float32Array(0), 48000, 16000).length).toBe(0);
    expect(resampleInt16(new Int16Array(0), 48000, 16000).length).toBe(0);
  });
});
