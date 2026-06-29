import { describe, it, expect } from 'vitest';
import { formatElapsed, ageOf, quantizeNow, QUANTUM_MS } from '../packages/server/src/core/time';

describe('formatElapsed — floor, quantum, minute coarsening', () => {
  it('renders sub-2s gaps as "just now" (the floor — conversational micro-gaps are noise)', () => {
    expect(formatElapsed(0)).toBe('just now');
    expect(formatElapsed(800)).toBe('just now');
    expect(formatElapsed(1999)).toBe('just now');
  });

  it('rounds 2s–<60s to the nearest 5s, never collapsing past-floor gaps below one bucket', () => {
    expect(formatElapsed(2000)).toBe('5s'); // just past the floor → smallest bucket
    expect(formatElapsed(2400)).toBe('5s');
    expect(formatElapsed(3000)).toBe('5s');
    expect(formatElapsed(7000)).toBe('5s'); // round(1.4) = 1 → 5s
    expect(formatElapsed(7500)).toBe('10s'); // round(1.5) = 2 → 10s
    expect(formatElapsed(12000)).toBe('10s');
    expect(formatElapsed(38000)).toBe('40s');
    expect(formatElapsed(52000)).toBe('50s');
  });

  it('coarsens ≥60s to the nearest 30s, rendered as minutes', () => {
    expect(formatElapsed(58000)).toBe('1m'); // rounds up across the minute boundary
    expect(formatElapsed(60000)).toBe('1m');
    expect(formatElapsed(62000)).toBe('1m');
    expect(formatElapsed(75000)).toBe('1m30s');
    expect(formatElapsed(90000)).toBe('1m30s');
    expect(formatElapsed(105000)).toBe('2m');
    expect(formatElapsed(120000)).toBe('2m');
    expect(formatElapsed(330000)).toBe('5m30s');
  });

  it('treats negative / non-finite input (clock skew) as "just now"', () => {
    expect(formatElapsed(-500)).toBe('just now');
    expect(formatElapsed(Number.NaN)).toBe('just now');
    expect(formatElapsed(Number.POSITIVE_INFINITY)).toBe('just now');
  });

  it('is STABLE within a bucket (the whole point of quantizing — no beat-to-beat jitter)', () => {
    // The same event observed 38s, 40s, 42s after it all land in the one 5s bucket and read
    // identically — that stability is what keeps the model from churning and busting the prompt cache
    // every beat. The value only moves when the age genuinely crosses a 5s boundary (once per 5s, not
    // once per beat).
    expect(formatElapsed(38000)).toBe('40s');
    expect(formatElapsed(40000)).toBe('40s');
    expect(formatElapsed(42000)).toBe('40s');
  });
});

describe('ageOf — elapsed between two instants', () => {
  it('formats the gap between a past event and now', () => {
    const now = 1_751_177_500_000;
    expect(ageOf(now - 40_000, now)).toBe('40s');
    expect(ageOf(now - 90_000, now)).toBe('1m30s');
    expect(ageOf(now - 500, now)).toBe('just now');
  });

  it('collapses future timestamps (skew) to "just now" rather than a negative age', () => {
    const now = 1_751_177_500_000;
    expect(ageOf(now + 5_000, now)).toBe('just now');
  });
});

describe('quantizeNow — stable stamped clock', () => {
  it('floors an instant to the step so the stamped now holds steady for the whole step', () => {
    expect(quantizeNow(12_345, 5_000)).toBe(10_000);
    expect(quantizeNow(10_000, 5_000)).toBe(10_000);
    expect(quantizeNow(9_999, 5_000)).toBe(5_000);
  });

  it('defaults to the 5s quantum', () => {
    expect(quantizeNow(13_999)).toBe(10_000);
    expect(QUANTUM_MS).toBe(5_000);
  });
});
