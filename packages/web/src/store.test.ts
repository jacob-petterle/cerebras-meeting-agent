import type { LogEntry } from '@meeting-agent/protocol';
import { describe, expect, it } from 'vitest';
import { mergeAppend, mergeCatchUp, mergeOlder } from './store';

/**
 * The three append-log merge primitives are pure and carry the store's core
 * invariants (seqNo ordering, dedupe by seqNo, hwm = max seqNo ever seen even
 * past a dropped dupe). These tests lock that contract -- in particular the
 * single-pass mergeCatchUp must stay behaviour-identical to the prior two-pass
 * version.
 */

/** Minimal LogEntry; the payload type is irrelevant to the merge math. */
const e = (seqNo: number): LogEntry<string> => ({ seqNo, ts: seqNo, data: `e${seqNo}` });

describe('mergeAppend', () => {
  it('appends a fresh entry and advances the hwm', () => {
    const { entries, hwm } = mergeAppend([e(0)], 0, e(1));
    expect(entries.map((x) => x.seqNo)).toEqual([0, 1]);
    expect(hwm).toBe(1);
  });

  it('drops a duplicate (seqNo <= hwm) and keeps the array reference stable', () => {
    const start = [e(0), e(1)];
    const out = mergeAppend(start, 1, e(1));
    expect(out.entries).toBe(start);
    expect(out.hwm).toBe(1);
  });

  it('drops a stale entry below the hwm even when not already held', () => {
    // hwm has advanced past 5 (e.g. an earlier dupe), so a re-sent seqNo 5 is dropped.
    const start = [e(10)];
    const out = mergeAppend(start, 12, e(5));
    expect(out.entries).toBe(start);
    expect(out.hwm).toBe(12);
  });
});

describe('mergeCatchUp', () => {
  it('appends entries past the hwm, sorted by seqNo, and advances the hwm', () => {
    // out-of-order incoming batch must land sorted.
    const { entries, hwm } = mergeCatchUp([e(0)], 0, [e(3), e(1), e(2)]);
    expect(entries.map((x) => x.seqNo)).toEqual([0, 1, 2, 3]);
    expect(hwm).toBe(3);
  });

  it('dedupes against entries already held', () => {
    const { entries, hwm } = mergeCatchUp([e(0), e(1)], 1, [e(1), e(2)]);
    expect(entries.map((x) => x.seqNo)).toEqual([0, 1, 2]);
    expect(hwm).toBe(2);
  });

  it('advances the hwm to the max incoming seqNo even when every entry is a dupe', () => {
    // Nothing new to append, but the hwm must still reflect the true tail so a
    // reconnect resubscribes from the right cursor.
    const start = [e(0), e(1)];
    const out = mergeCatchUp(start, 1, [e(0), e(1)]);
    expect(out.entries).toBe(start);
    expect(out.hwm).toBe(1);
  });

  it('keeps fresh filtering anchored to the original hwm, not the running max', () => {
    // seqNo 2 is > the original hwm (1) so it is fresh; the presence of seqNo 5
    // raising nextHwm must NOT retroactively exclude 2.
    const { entries, hwm } = mergeCatchUp([e(0), e(1)], 1, [e(5), e(2)]);
    expect(entries.map((x) => x.seqNo)).toEqual([0, 1, 2, 5]);
    expect(hwm).toBe(5);
  });

  it('returns the same array reference when there is nothing fresh', () => {
    const start = [e(0)];
    const out = mergeCatchUp(start, 0, []);
    expect(out.entries).toBe(start);
    expect(out.hwm).toBe(0);
  });
});

describe('mergeOlder', () => {
  it('prepends older entries below the current lowest, sorted', () => {
    const out = mergeOlder([e(5), e(6)], [e(4), e(2), e(3)]);
    expect(out.map((x) => x.seqNo)).toEqual([2, 3, 4, 5, 6]);
  });

  it('dedupes and ignores entries at or above the current lowest', () => {
    // e(5) is not below lowest (5); e(6) is above; both ignored. e(3) is added.
    const out = mergeOlder([e(5), e(6)], [e(3), e(5), e(6)]);
    expect(out.map((x) => x.seqNo)).toEqual([3, 5, 6]);
  });

  it('returns the same reference when nothing qualifies', () => {
    const start = [e(5)];
    expect(mergeOlder(start, [e(5), e(9)])).toBe(start);
  });

  it('prepends against an empty held list (lowest is +Infinity)', () => {
    const out = mergeOlder([], [e(2), e(1)]);
    expect(out.map((x) => x.seqNo)).toEqual([1, 2]);
  });
});
