import { describe, it, expect } from 'vitest';
import {
  buildResourceMessages,
  foldLatestById,
  renderDeliverablesResource,
  renderResources,
  renderSubAgentsResource,
  renderTranscriptResource,
  toDecision,
} from '../packages/server/src/core/decide';
import type { AssembledToolCall } from '../packages/server/src/core/cerebras';
import {
  type DeliverableRecord,
  type LogEntry,
  SubAgentTaskRecord,
  type TranscriptEntry,
} from '@meeting-agent/protocol';

/**
 * decide.ts `toDecision` — the off-contract → no_op funnel. The model can emit an unknown tool, bad
 * JSON, or args that don't satisfy the tool's Zod schema; every such case must collapse to no_op
 * rather than dispatch a malformed action. A well-formed call passes through with parsed args.
 */

const call = (over: Partial<AssembledToolCall>): AssembledToolCall => ({
  index: 0,
  id: 'c0',
  name: 'no_op',
  arguments: '{}',
  ...over,
});

describe('toDecision (bias to no_op on anything off-contract)', () => {
  it('a valid tool call → that decision, with Zod-parsed args', () => {
    const d = toDecision(call({ name: 'speak', arguments: '{"text":"hello"}' }));
    expect(d).toEqual({ name: 'speak', args: { text: 'hello' } });
  });

  it('a valid share_screen call keeps its optional fields (deliverableId)', () => {
    const d = toDecision(
      call({ name: 'share_screen', arguments: '{"kind":"json","payload":"{}","deliverableId":"d1"}' }),
    );
    expect(d).toEqual({
      name: 'share_screen',
      args: { kind: 'json', payload: '{}', deliverableId: 'd1' },
    });
  });

  it('an undefined call (no tool emitted) → no_op', () => {
    expect(toDecision(undefined)).toEqual({ name: 'no_op', args: {} });
  });

  it('an unknown tool name → no_op', () => {
    const d = toDecision(call({ name: 'delete_everything', arguments: '{"yes":true}' }));
    expect(d).toEqual({ name: 'no_op', args: {} });
  });

  it('unparsable JSON args → no_op', () => {
    const d = toDecision(call({ name: 'speak', arguments: '{"text": "unterminated' }));
    expect(d).toEqual({ name: 'no_op', args: {} });
  });

  it('args that fail the per-tool Zod schema → no_op', () => {
    // speak requires { text: string }; a number must fail the schema and fall back to no_op.
    const d = toDecision(call({ name: 'speak', arguments: '{"text": 42}' }));
    expect(d).toEqual({ name: 'no_op', args: {} });
  });

  it('a call_agent with an empty task fails the .min(1) schema → no_op', () => {
    const d = toDecision(call({ name: 'call_agent', arguments: '{"task":""}' }));
    expect(d).toEqual({ name: 'no_op', args: {} });
  });

  it('empty argument string is treated as {} and validated (no_op with empty args is valid)', () => {
    const d = toDecision(call({ name: 'no_op', arguments: '' }));
    expect(d).toEqual({ name: 'no_op', args: {} });
  });
});

/**
 * The architectural invariant Jacob locked in: the conversation is a RESOURCE the model observes,
 * never an in-band turn addressed to it. These tests guard the rendering — if anyone reverts to a
 * bare "[human:me] ..." user message, they break here.
 */
const tline = (over: Partial<TranscriptEntry>, seqNo = 0): LogEntry<TranscriptEntry> => ({
  seqNo,
  ts: 1,
  data: { participantId: 'me', senderKind: 'human', text: 'hi', timestamp: 1, ...over },
});

const dline = (over: Partial<DeliverableRecord>, seqNo = 0): LogEntry<DeliverableRecord> => ({
  seqNo,
  ts: 1,
  data: {
    id: 'd1',
    kind: 'html',
    title: 'Findings',
    description: '',
    filePath: null,
    assetId: null,
    mimeType: null,
    producedAt: 1,
    registeredAt: 2,
    ...over,
  },
});

describe('resource rendering — conversation is a resource, not in-band', () => {
  it('wraps each utterance in an XML <transcript> envelope, never a bare line', () => {
    const out = renderTranscriptResource([tline({ text: "what's the weather" })], 0);
    expect(out).toMatch(/^<transcript\b/);
    expect(out).toContain('</transcript>');
    expect(out).toContain('<utterance speaker="me" kind="human"');
    expect(out).toContain(">what's the weather</utterance>");
    // Framing that makes it observed-not-addressed.
    expect(out).toContain('not to you');
    // Must NOT look like the old in-band formats.
    expect(out).not.toContain('[human:me]');
    expect(out).not.toContain('me (human):');
  });

  it('marks the agent\'s own prior turns kind="agent" so it recognizes itself', () => {
    const out = renderTranscriptResource(
      [tline({ senderKind: 'agent', participantId: 'agent', text: 'four' })],
      0,
    );
    expect(out).toContain('<utterance speaker="agent" kind="agent"');
    expect(out).toContain('>four</utterance>');
  });

  it('marks tool turns kind="tool"', () => {
    const out = renderTranscriptResource(
      [tline({ senderKind: 'tool', participantId: 'call_agent', text: 'researched X' })],
      0,
    );
    expect(out).toContain('<utterance speaker="call_agent" kind="tool"');
  });

  it('escapes utterance text so it cannot break out of the envelope', () => {
    const out = renderTranscriptResource([tline({ text: 'use <script> & "quotes"' })], 0);
    expect(out).toContain('use &lt;script&gt; &amp; &quot;quotes&quot;');
    expect(out).not.toContain('<script>');
  });

  it('renders an empty transcript as a self-closing block (still a resource)', () => {
    const out = renderTranscriptResource([], 0);
    expect(out).toMatch(/^<transcript\b[^>]*\/>$/);
    expect(out).toContain('empty');
  });

  it('renders the FULL conversation each beat and marks only new-since utterances new="true"', () => {
    // Three utterances; the boundary is seqNo 2 → only the last one is new this beat.
    const entries = [
      tline({ text: 'old one', participantId: 'me' }, 0),
      tline({ text: 'old two', participantId: 'me' }, 1),
      tline({ text: 'fresh', participantId: 'me' }, 2),
    ];
    const out = renderTranscriptResource(entries, 2);
    // The whole conversation is present (full memory), not just the delta.
    expect(out).toContain('>old one</utterance>');
    expect(out).toContain('>old two</utterance>');
    expect(out).toContain('>fresh</utterance>');
    // Only the boundary-and-after utterance carries new="true".
    expect(out).toMatch(/new="true"[^>]*>fresh<\/utterance>/);
    expect(out).not.toMatch(/new="true"[^>]*>old one<\/utterance>/);
    expect(out).not.toMatch(/new="true"[^>]*>old two<\/utterance>/);
    // Exactly one utterance is marked new.
    expect(out.match(/new="true"/g)).toHaveLength(1);
    // The framing tells the model it's the full conversation and to act only on the new ones.
    expect(out).toContain('full conversation');
    expect(out).toContain('new-since="2"');
  });

  it('caps the rendered transcript to the most-recent ~100 utterances (keeps newest, notes elision)', () => {
    const entries = Array.from({ length: 150 }, (_v, i) =>
      tline({ text: `line ${i}`, participantId: 'me' }, i),
    );
    const out = renderTranscriptResource(entries, 150);
    // Oldest are elided; the newest are kept.
    expect(out).not.toContain('>line 0</utterance>');
    expect(out).toContain('>line 149</utterance>');
    expect(out).toContain('elided-older="50"');
    expect(out).toContain('showing-last="100"');
  });

  it('renders deliverables as XML with id + kind + title (for share_screen)', () => {
    const out = renderDeliverablesResource([dline({ id: 'dX', kind: 'html', title: 'Incident report' })]);
    expect(out).toMatch(/^<deliverables\b/);
    expect(out).toContain('<deliverable id="dX" kind="html" title="Incident report"');
    expect(out).toContain('deliverableId');
  });

  it('renders an empty deliverables list as a self-closing block', () => {
    const out = renderDeliverablesResource([]);
    expect(out).toMatch(/^<deliverables\b[^>]*\/>$/);
  });

  it('renderResources carries current-time + transcript + sub_agents + deliverables', () => {
    const out = renderResources({
      transcript: [tline({ text: 'hi' })],
      newSinceSeqNo: 0,
      deliverables: [dline({})],
      subAgents: [],
    });
    expect(out).toContain('<current-time iso=');
    expect(out).toContain('<transcript');
    expect(out).toContain('<sub_agents');
    expect(out).toContain('<deliverables');
  });
});

/**
 * The sub-agent resource (Task #16/#18). Status is an APPEND-ONLY log keyed by id (running → progress
 * → done/error); the read side folds latest-per-id (last append wins). The render must surface the
 * running count, the per-task status + latest progress line, and the deliverable link on completion —
 * this is the live <sub_agents> view the brain observes each beat while research runs non-blocking.
 */
const sub = (over: Partial<SubAgentTaskRecord>): SubAgentTaskRecord =>
  SubAgentTaskRecord.parse({ id: 'a1', status: 'running', task: 'dig', startedAt: 1, ...over });

describe('foldLatestById (append-only status → current state)', () => {
  it('keeps the LAST append per id (running → done collapses to done)', () => {
    const items = [
      sub({ id: 'a1', status: 'running', progress: ['reading'] }),
      sub({ id: 'a1', status: 'running', progress: ['reading', 'parsing'] }),
      sub({ id: 'a1', status: 'done', deliverableId: 'd1', endedAt: 9 }),
    ];
    const folded = foldLatestById(items);
    expect(folded).toHaveLength(1);
    expect(folded[0]!.status).toBe('done');
    expect(folded[0]!.deliverableId).toBe('d1');
  });

  it('keeps one row per id, in first-seen order', () => {
    const items = [
      sub({ id: 'a1', task: 'first' }),
      sub({ id: 'a2', task: 'second' }),
      sub({ id: 'a1', status: 'done', task: 'first' }),
    ];
    const folded = foldLatestById(items);
    expect(folded.map((t) => t.id)).toEqual(['a1', 'a2']);
    expect(folded[0]!.status).toBe('done');
  });

  it('returns an empty array for no items', () => {
    expect(foldLatestById([])).toEqual([]);
  });
});

describe('renderSubAgentsResource', () => {
  it('renders an empty list as a self-closing block with running="0"', () => {
    const out = renderSubAgentsResource([]);
    expect(out).toMatch(/^<sub_agents\b[^>]*\/>$/);
    expect(out).toContain('running="0"');
  });

  it('renders the running count, a task row, and the latest progress line', () => {
    const out = renderSubAgentsResource([
      sub({ id: 'abcdef0123', status: 'running', task: 'audit auth', progress: ['read login.ts', 'found a bug'] }),
    ]);
    expect(out).toMatch(/^<sub_agents\b/);
    expect(out).toContain('running="1"');
    // Id is shortened to 8 chars; status + task + last progress are surfaced.
    expect(out).toContain('id="abcdef01"');
    expect(out).toContain('status="running"');
    expect(out).toContain('task="audit auth"');
    expect(out).toContain('last_progress="found a bug"');
    expect(out).toContain('</sub_agents>');
  });

  it('folds latest-per-id so a completed run shows done + its deliverable, not running', () => {
    const out = renderSubAgentsResource([
      sub({ id: 'a1', status: 'running', task: 'dig' }),
      sub({ id: 'a1', status: 'done', task: 'dig', deliverableId: 'deadbeef99', endedAt: 5 }),
    ]);
    expect(out).toContain('running="0"');
    expect(out).toContain('status="done"');
    expect(out).toContain('deliverable="deadbeef99"');
  });

  it('shows the error message for an errored task', () => {
    const out = renderSubAgentsResource([
      sub({ id: 'a1', status: 'error', task: 'dig', error: 'timed out after 180000ms', endedAt: 5 }),
    ]);
    expect(out).toContain('status="error"');
    expect(out).toContain('timed out after 180000ms');
  });

  it('escapes task/progress so a value cannot break out of the envelope', () => {
    const out = renderSubAgentsResource([
      sub({ id: 'a1', task: 'find <script> & "x"', progress: ['<b>hi</b>'] }),
    ]);
    expect(out).not.toContain('<script>');
    expect(out).toContain('&lt;script&gt;');
    expect(out).toContain('&amp;');
  });
});

/**
 * The hard invariant Jacob set: "Gemma should have nothing in band." buildResourceMessages must put
 * every observed resource (incl. the conversation) in the SYSTEM channel, and the ONLY user turn is a
 * content-free heartbeat pulse. If anyone moves the transcript back into a user turn, these fail.
 */
describe('buildResourceMessages — nothing in band', () => {
  const msgs = buildResourceMessages({
    system: 'IDENTITY+CONVENTION',
    transcript: [tline({ text: 'deploy on friday' })],
    newSinceSeqNo: 0,
    deliverables: [dline({ title: 'Risk memo' })],
    subAgents: [],
  });

  it('places the conversation in a system message, never a user turn', () => {
    const userTurns = msgs.filter((m) => m.role === 'user');
    const systemTurns = msgs.filter((m) => m.role === 'system');
    // The utterance text lives in a system message…
    expect(systemTurns.some((m) => String(m.content).includes('deploy on friday'))).toBe(true);
    // …and in NO user message (the crux of "nothing in band").
    expect(userTurns.every((m) => !String(m.content).includes('deploy on friday'))).toBe(true);
    expect(userTurns.every((m) => !String(m.content).includes('<transcript'))).toBe(true);
  });

  it('the only user turn is the content-free heartbeat pulse', () => {
    const userTurns = msgs.filter((m) => m.role === 'user');
    expect(userTurns).toHaveLength(1);
    expect(String(userTurns[0]!.content)).toContain('[heartbeat]');
    // It names the tools to pick but carries none of the room's words.
    expect(String(userTurns[0]!.content)).not.toContain('deploy');
  });

  it('keeps the static identity and the dynamic resources as separate system messages', () => {
    expect(msgs[0]).toMatchObject({ role: 'system', content: 'IDENTITY+CONVENTION' });
    expect(msgs[1]!.role).toBe('system');
    expect(String(msgs[1]!.content)).toContain('<transcript');
    expect(String(msgs[1]!.content)).toContain('<sub_agents');
    expect(String(msgs[1]!.content)).toContain('<deliverables');
  });
});
