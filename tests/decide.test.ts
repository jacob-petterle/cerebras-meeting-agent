import { describe, it, expect } from 'vitest';
import {
  buildResourceMessages,
  renderDeliverablesResource,
  renderResources,
  renderTranscriptResource,
  toDecision,
} from '../packages/server/src/core/decide';
import type { AssembledToolCall } from '../packages/server/src/core/cerebras';
import type { DeliverableRecord, LogEntry, TranscriptEntry } from '@meeting-agent/protocol';

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
    const out = renderTranscriptResource([tline({ text: "what's the weather" })]);
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
    const out = renderTranscriptResource([tline({ senderKind: 'agent', participantId: 'agent', text: 'four' })]);
    expect(out).toContain('<utterance speaker="agent" kind="agent"');
    expect(out).toContain('>four</utterance>');
  });

  it('marks tool turns kind="tool"', () => {
    const out = renderTranscriptResource([
      tline({ senderKind: 'tool', participantId: 'call_agent', text: 'researched X' }),
    ]);
    expect(out).toContain('<utterance speaker="call_agent" kind="tool"');
  });

  it('escapes utterance text so it cannot break out of the envelope', () => {
    const out = renderTranscriptResource([tline({ text: 'use <script> & "quotes"' })]);
    expect(out).toContain('use &lt;script&gt; &amp; &quot;quotes&quot;');
    expect(out).not.toContain('<script>');
  });

  it('renders an empty transcript as a self-closing block (still a resource)', () => {
    const out = renderTranscriptResource([]);
    expect(out).toMatch(/^<transcript\b[^>]*\/>$/);
    expect(out).toContain('no new utterances');
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

  it('renderResources carries current-time + transcript + deliverables', () => {
    const out = renderResources({ transcript: [tline({ text: 'hi' })], deliverables: [dline({})] });
    expect(out).toContain('<current-time iso=');
    expect(out).toContain('<transcript');
    expect(out).toContain('<deliverables');
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
    deliverables: [dline({ title: 'Risk memo' })],
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
    expect(String(msgs[1]!.content)).toContain('<deliverables');
  });
});
