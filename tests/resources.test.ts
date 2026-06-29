import { describe, it, expect } from 'vitest';
import { DeliverableRecord, SubAgentTaskRecord } from '@meeting-agent/protocol';
import type {
  DeliverableRecord as DeliverableRecordT,
  SubAgentTaskRecord as SubAgentTaskRecordT,
} from '@meeting-agent/protocol';
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

  it('reset() clears entries (seqNo restarts at 0) and keeps live subscribers', () => {
    const log = createAppendLog<string>();
    const live: string[] = [];
    log.subscribe((e) => live.push(`${e.seqNo}:${e.data}`));
    log.append('a'); // 0
    log.append('b'); // 1
    expect(log.head()).toBe(1);

    log.reset();
    expect(log.head()).toBe(-1);
    expect(log.snapshot()).toEqual([]);
    expect(log.since(-1)).toEqual([]);

    // The subscriber survived the reset, and seqNo restarts at 0 for the next append.
    expect(log.append('c')).toBe(0);
    expect(live).toEqual(['0:a', '1:b', '0:c']);
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

describe('SubAgentTaskRecord', () => {
  it('parses a minimal record and fills the nullable/array defaults', () => {
    const rec = SubAgentTaskRecord.parse({
      id: 'a1',
      status: 'running',
      task: 'investigate the cache',
      startedAt: 100,
    });
    expect(rec.endedAt).toBeNull();
    expect(rec.progress).toEqual([]);
    expect(rec.deliverableId).toBeNull();
    expect(rec.error).toBeNull();
  });

  it('round-trips a full record through parse() unchanged', () => {
    const full: SubAgentTaskRecordT = {
      id: 'a1',
      status: 'done',
      task: 'investigate the cache',
      startedAt: 100,
      endedAt: 200,
      progress: ['read cache.ts', 'found stale TTL'],
      deliverableId: 'd1',
      error: null,
    };
    expect(SubAgentTaskRecord.parse(full)).toEqual(full);
  });

  it('rejects an unknown status', () => {
    expect(
      SubAgentTaskRecord.safeParse({ id: 'a1', status: 'paused', task: 't', startedAt: 1 }).success,
    ).toBe(false);
  });

  it('the subAgents resource log appends + snapshots status records (append-only, keyed by id)', () => {
    const { subAgents } = createResources();
    const seen: SubAgentTaskRecordT[] = [];
    const unsub = subAgents.subscribe((e) => seen.push(e.data));

    subAgents.append(SubAgentTaskRecord.parse({ id: 'a1', status: 'running', task: 'dig', startedAt: 1 }));
    subAgents.append(
      SubAgentTaskRecord.parse({ id: 'a1', status: 'done', task: 'dig', startedAt: 1, deliverableId: 'd1' }),
    );

    // Append-only: BOTH records are retained (the read-side fold collapses them to latest-per-id).
    expect(subAgents.snapshot().map((e) => e.data.status)).toEqual(['running', 'done']);
    expect(seen.map((s) => s.status)).toEqual(['running', 'done']);
    unsub();
  });
});
