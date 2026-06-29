import { describe, expect, it } from 'vitest';
import { computeFitScale } from './sandbox';

/**
 * The screenshare backstop math. A stage render is a single, non-scrollable 1280x720 slide, so
 * overflowing content must shrink to fit rather than clip below the fold. The contract:
 *   - content that already fits is never enlarged (returns exactly 1),
 *   - overflowing content scales down by the tighter of the two axis ratios (with a safety margin),
 *   - the scaled content fits BOTH dimensions (the invariant the screenshare depends on),
 *   - degenerate / not-yet-measured sizes are a safe no-op (1).
 */

const VIEW_W = 1280;
const VIEW_H = 720;

describe('computeFitScale', () => {
  it('returns 1 when content already fits (never enlarges)', () => {
    expect(computeFitScale(800, 400, VIEW_W, VIEW_H)).toBe(1);
  });

  it('returns 1 when content is exactly the viewport size', () => {
    expect(computeFitScale(VIEW_W, VIEW_H, VIEW_W, VIEW_H)).toBe(1);
  });

  it('shrinks by the height ratio when only height overflows', () => {
    // Tall document: 1280 wide (fits), 2160 tall (3x the viewport height).
    expect(computeFitScale(1280, 2160, VIEW_W, VIEW_H)).toBeCloseTo((720 / 2160) * 0.98, 10);
  });

  it('shrinks by the width ratio when only width overflows', () => {
    expect(computeFitScale(2560, 720, VIEW_W, VIEW_H)).toBeCloseTo((1280 / 2560) * 0.98, 10);
  });

  it('uses the tighter (smaller) ratio when both axes overflow', () => {
    // width ratio 1280/2560 = 0.5; height ratio 720/2880 = 0.25 -> height governs.
    expect(computeFitScale(2560, 2880, VIEW_W, VIEW_H)).toBeCloseTo((720 / 2880) * 0.98, 10);
  });

  it('produces a scale that fits BOTH dimensions inside the viewport', () => {
    const cases: Array<[number, number]> = [
      [3000, 1000],
      [1400, 5000],
      [1281, 721],
      [9000, 9000],
    ];
    for (const [cw, ch] of cases) {
      const s = computeFitScale(cw, ch, VIEW_W, VIEW_H);
      expect(cw * s).toBeLessThanOrEqual(VIEW_W);
      expect(ch * s).toBeLessThanOrEqual(VIEW_H);
      expect(s).toBeGreaterThan(0);
    }
  });

  it('is a safe no-op (1) for degenerate / unmeasured sizes', () => {
    expect(computeFitScale(0, 500, VIEW_W, VIEW_H)).toBe(1);
    expect(computeFitScale(500, 0, VIEW_W, VIEW_H)).toBe(1);
    expect(computeFitScale(500, 500, 0, VIEW_H)).toBe(1);
    expect(computeFitScale(500, 500, VIEW_W, 0)).toBe(1);
    expect(computeFitScale(-100, -100, VIEW_W, VIEW_H)).toBe(1);
  });
});
