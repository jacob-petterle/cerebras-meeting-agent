import { describe, expect, it } from 'vitest';
import { parseServerMessage } from './validate';

/**
 * Boundary parser tests. The WS feed is untrusted, so the contract is: a frame
 * that matches the schema parses into the typed union; anything else returns
 * null (never throws, never coerces). Covers one valid frame per `type` plus the
 * failure modes (bad JSON, non-string input, wrong-shape entries) and the flat
 * `stats` frame the server now emits.
 */

/** Frames cross the wire as JSON strings; the parser rejects non-strings. */
const frame = (value: unknown): string => JSON.stringify(value);

const transcriptEntry = {
  seqNo: 0,
  ts: 1,
  data: { participantId: 'u1', senderKind: 'human', text: 'hi', timestamp: 10 },
};

const deliverableEntry = {
  seqNo: 0,
  ts: 1,
  data: { id: 'd1', kind: 'html', title: 'Findings', producedAt: 1, registeredAt: 2 },
};

const subAgentEntry = {
  seqNo: 0,
  ts: 1,
  data: { id: 'a1', status: 'running', task: 'dig', startedAt: 100 },
};

describe('parseServerMessage — valid frames per type', () => {
  it('parses a transcript catch_up', () => {
    const out = parseServerMessage(
      frame({ type: 'catch_up', resource: 'transcript', entries: [transcriptEntry] }),
    );
    expect(out?.type).toBe('catch_up');
    if (out?.type === 'catch_up') {
      expect(out.resource).toBe('transcript');
      expect(out.entries).toHaveLength(1);
    }
  });

  it('parses a deliverables catch_up (record defaults fill in)', () => {
    const out = parseServerMessage(
      frame({ type: 'catch_up', resource: 'deliverables', entries: [deliverableEntry] }),
    );
    expect(out?.type).toBe('catch_up');
    if (out?.type === 'catch_up' && out.resource === 'deliverables') {
      expect(out.entries[0]?.data.description).toBe('');
      expect(out.entries[0]?.data.filePath).toBeNull();
    }
  });

  it('parses an append', () => {
    const out = parseServerMessage(
      frame({ type: 'append', resource: 'transcript', entry: transcriptEntry }),
    );
    expect(out?.type).toBe('append');
  });

  it('parses a subAgents catch_up (record defaults fill in)', () => {
    const out = parseServerMessage(
      frame({ type: 'catch_up', resource: 'subAgents', entries: [subAgentEntry] }),
    );
    expect(out?.type).toBe('catch_up');
    if (out?.type === 'catch_up' && out.resource === 'subAgents') {
      expect(out.entries[0]?.data.status).toBe('running');
      expect(out.entries[0]?.data.progress).toEqual([]);
      expect(out.entries[0]?.data.deliverableId).toBeNull();
    }
  });

  it('parses a subAgents append', () => {
    const out = parseServerMessage(
      frame({ type: 'append', resource: 'subAgents', entry: subAgentEntry }),
    );
    expect(out?.type).toBe('append');
    if (out?.type === 'append' && out.resource === 'subAgents') {
      expect(out.entry.data.task).toBe('dig');
    }
  });

  it('returns null when a subAgents entry has an unknown status', () => {
    const bad = { seqNo: 0, ts: 1, data: { id: 'a1', status: 'paused', task: 't', startedAt: 1 } };
    expect(
      parseServerMessage(frame({ type: 'append', resource: 'subAgents', entry: bad })),
    ).toBeNull();
  });

  it('parses an older batch and carries hasMore', () => {
    const out = parseServerMessage(
      frame({ type: 'older', resource: 'transcript', entries: [transcriptEntry], hasMore: true }),
    );
    expect(out?.type).toBe('older');
    if (out?.type === 'older') expect(out.hasMore).toBe(true);
  });

  it('defaults hasMore to false when absent', () => {
    const out = parseServerMessage(
      frame({ type: 'older', resource: 'transcript', entries: [] }),
    );
    expect(out?.type).toBe('older');
    if (out?.type === 'older') expect(out.hasMore).toBe(false);
  });

  it('parses a render command', () => {
    const out = parseServerMessage(
      frame({ type: 'render', cmd: { kind: 'markdown', payload: '# hi', title: 'T' } }),
    );
    expect(out?.type).toBe('render');
    if (out?.type === 'render') expect(out.cmd.kind).toBe('markdown');
  });

  it('parses a play frame', () => {
    const out = parseServerMessage(frame({ type: 'play', sampleRate: 24000, pcm: [1, 2, 3] }));
    expect(out?.type).toBe('play');
    if (out?.type === 'play') {
      expect(out.sampleRate).toBe(24000);
      expect(out.pcm).toEqual([1, 2, 3]);
    }
  });

  it('parses the flat stats frame', () => {
    const out = parseServerMessage(
      frame({ type: 'stats', tokensPerSec: 812.5, promptTokens: 1200, completionTokens: 64 }),
    );
    expect(out?.type).toBe('stats');
    if (out?.type === 'stats') {
      expect(out.stats.tokensPerSec).toBe(812.5);
      expect(out.stats.promptTokens).toBe(1200);
      expect(out.stats.completionTokens).toBe(64);
    }
  });

  it('parses a stats frame with a null tokensPerSec (no rate yet)', () => {
    const out = parseServerMessage(
      frame({ type: 'stats', tokensPerSec: null, promptTokens: 0, completionTokens: 0 }),
    );
    expect(out?.type).toBe('stats');
    if (out?.type === 'stats') expect(out.stats.tokensPerSec).toBeNull();
  });

  it('parses a decision frame (incl. no_op)', () => {
    const out = parseServerMessage(
      frame({ type: 'decision', name: 'no_op', detail: 'staying silent', ts: 5 }),
    );
    expect(out?.type).toBe('decision');
    if (out?.type === 'decision') {
      expect(out.name).toBe('no_op');
      expect(out.detail).toBe('staying silent');
      expect(out.ts).toBe(5);
    }
  });

  it('rejects a decision frame missing required fields', () => {
    expect(parseServerMessage(frame({ type: 'decision', name: 'speak' }))).toBeNull();
  });

  it('parses a reset frame', () => {
    const out = parseServerMessage(frame({ type: 'reset' }));
    expect(out?.type).toBe('reset');
  });
});

describe('parseServerMessage — rejections', () => {
  it('returns null for malformed JSON', () => {
    expect(parseServerMessage('this is not json {{{')).toBeNull();
  });

  it('returns null for non-string input', () => {
    expect(parseServerMessage({ type: 'append' })).toBeNull();
    expect(parseServerMessage(42)).toBeNull();
    expect(parseServerMessage(null)).toBeNull();
  });

  it('returns null for an unknown type', () => {
    expect(parseServerMessage(frame({ type: 'totally-unknown' }))).toBeNull();
  });

  it('returns null for a missing type field', () => {
    expect(parseServerMessage(frame({ resource: 'transcript', entries: [] }))).toBeNull();
  });

  it('returns null for an unknown resource', () => {
    expect(
      parseServerMessage(frame({ type: 'catch_up', resource: 'nope', entries: [] })),
    ).toBeNull();
  });

  it('returns null when a transcript entry is the wrong shape', () => {
    const bad = { seqNo: 0, ts: 1, data: { senderKind: 'human' } }; // missing fields
    expect(
      parseServerMessage(frame({ type: 'append', resource: 'transcript', entry: bad })),
    ).toBeNull();
  });

  it('returns null for a stats frame missing required token counts', () => {
    // Old nested-shape / partial frames must no longer parse.
    expect(parseServerMessage(frame({ type: 'stats', tokensPerSec: 100 }))).toBeNull();
    expect(
      parseServerMessage(frame({ type: 'stats', stats: { tokensPerSec: 100 } })),
    ).toBeNull();
  });

  it('returns null for a render frame with an unknown kind', () => {
    expect(
      parseServerMessage(frame({ type: 'render', cmd: { kind: 'gif', payload: 'x' } })),
    ).toBeNull();
  });
});
