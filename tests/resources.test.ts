import { describe, it, expect } from 'vitest';
import { DeliverableRecord } from '@meeting-agent/protocol';
import type { DeliverableRecord as DeliverableRecordT } from '@meeting-agent/protocol';
import { createAppendLog, createResources } from '../packages/server/src/core/resources';

describe('AppendLog', () => {
  it('append assigns seqNo = prior length (0,1,2…)', () => {
    const log = createAppendLog<string>();
    expect(log.append('a')).toBe(0);
    expect(log.append('b')).toBe(1);
    expect(log.append('c')).toBe(2);
    expect(log.head()).toBe(2);
    expect(log.snapshot().map((e) => e.data)).toEqual(['a', 'b', 'c']);
    expect(log.snapshot().map((e) => e.seqNo)).toEqual([0, 1, 2]);
  });

  it('head() is -1 when the log is empty', () => {
    expect(createAppendLog<string>().head()).toBe(-1);
  });

  it('since(cursor) returns only entries with seqNo > cursor', () => {
    const log = createAppendLog<string>();
    log.append('a');
    log.append('b');
    log.append('c');
    expect(log.since(-1).map((e) => e.data)).toEqual(['a', 'b', 'c']);
    expect(log.since(0).map((e) => e.data)).toEqual(['b', 'c']);
    expect(log.since(1).map((e) => e.data)).toEqual(['c']);
    expect(log.since(2)).toEqual([]);
  });

  it('subscribe delivers a catch_up of existing entries then live append pushes', () => {
    const log = createAppendLog<string>();
    log.append('a');
    log.append('b');

    // catch_up is the existing entries — the WS layer materialises this via since().
    const catchUp = log.since(-1);
    expect(catchUp.map((e) => e.data)).toEqual(['a', 'b']);

    // a live subscriber then receives only NEW appends, in order.
    const live: string[] = [];
    const unsub = log.subscribe((e) => live.push(e.data));
    log.append('c');
    log.append('d');
    expect(live).toEqual(['c', 'd']);

    // unsubscribe stops further delivery.
    unsub();
    log.append('e');
    expect(live).toEqual(['c', 'd']);
  });

  it('snapshot() returns a defensive copy (caller mutation cannot corrupt the log)', () => {
    const log = createAppendLog<string>();
    log.append('a');
    const snap = log.snapshot();
    snap.pop();
    expect(log.snapshot().map((e) => e.data)).toEqual(['a']);
  });
});

describe('deliverables resource', () => {
  const rec = (id: string): DeliverableRecordT =>
    DeliverableRecord.parse({
      id,
      kind: 'html',
      title: 'Findings',
      producedAt: 1,
      registeredAt: 2,
      filePath: `/tmp/${id}.html`,
    });

  it('registering surfaces to existing subscribers and a fresh subscriber gets the full snapshot', () => {
    const { deliverables } = createResources();

    const seen: string[] = [];
    const unsub = deliverables.subscribe((e) => seen.push(e.data.id));

    // register → existing subscriber is notified live.
    deliverables.append(rec('d1'));
    expect(seen).toEqual(['d1']);

    deliverables.append(rec('d2'));
    expect(seen).toEqual(['d1', 'd2']);

    // a fresh subscriber gets the full snapshot via catch_up (since(-1)).
    const snapshot = deliverables.since(-1);
    expect(snapshot.map((e) => e.data.id)).toEqual(['d1', 'd2']);
    expect(snapshot.map((e) => e.seqNo)).toEqual([0, 1]);

    unsub();
  });
});
