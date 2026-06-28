/**
 * Pure PCM conversion + resampling. The models speak different formats:
 *   - mic in  = 48 kHz Int16  → VAD/STT want 16 kHz Float32 mono
 *   - kokoro out = 24 kHz Float32 → AudioOut wants Int16 (resampled for playback)
 * Resampling lives in the media layer (per AGENTS.md), so it lives here, pure and unit-testable.
 *
 * Linear interpolation is deliberate: it's cheap, allocation-light, and the downstream consumer is
 * a speech model robust to mild resampling artifacts — not an audiophile DAC. A polyphase/sinc
 * resampler would be higher fidelity but is unjustified for VAD/STT input.
 */

/** Int16 sample range. Used to scale to/from the [-1, 1] Float32 range models expect. */
const INT16_MAX = 32_767;
const INT16_MIN = -32_768;

/** Convert signed 16-bit PCM to Float32 in [-1, 1] (the format VAD + transformers.js consume). */
export function int16ToFloat32(int16: Int16Array): Float32Array {
  const out = new Float32Array(int16.length);
  for (let i = 0; i < int16.length; i++) {
    const s = int16[i] ?? 0;
    // Asymmetric range: negative samples reach -32768, positive only +32767.
    out[i] = s < 0 ? s / -INT16_MIN : s / INT16_MAX;
  }
  return out;
}

/** Convert Float32 in [-1, 1] back to signed 16-bit PCM, clamping out-of-range samples. */
export function float32ToInt16(float32: Float32Array): Int16Array {
  const out = new Int16Array(float32.length);
  for (let i = 0; i < float32.length; i++) {
    const v = float32[i] ?? 0;
    const clamped = v > 1 ? 1 : v < -1 ? -1 : v;
    out[i] = Math.round(clamped < 0 ? clamped * -INT16_MIN : clamped * INT16_MAX);
  }
  return out;
}

/**
 * Linearly resample a mono Float32 signal from `fromRate` to `toRate`. Returns the input unchanged
 * (same reference) when the rates already match — the common no-op fast path.
 */
export function resampleFloat32(input: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate === toRate || input.length === 0) {
    return input;
  }
  const ratio = toRate / fromRate;
  const outLength = Math.max(1, Math.round(input.length * ratio));
  const out = new Float32Array(outLength);
  for (let i = 0; i < outLength; i++) {
    // Position in the source signal that output sample i maps to.
    const srcPos = i / ratio;
    const i0 = Math.floor(srcPos);
    const i1 = Math.min(i0 + 1, input.length - 1);
    const frac = srcPos - i0;
    const a = input[i0] ?? 0;
    const b = input[i1] ?? 0;
    out[i] = a + (b - a) * frac;
  }
  return out;
}

/** Resample 16-bit PCM end to end (Int16 → Float32 → resample → Int16). */
export function resampleInt16(input: Int16Array, fromRate: number, toRate: number): Int16Array {
  if (fromRate === toRate) {
    return input;
  }
  return float32ToInt16(resampleFloat32(int16ToFloat32(input), fromRate, toRate));
}
