import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildResourceMessages,
  foldLatestById,
  renderConversationResource,
  renderDeliverablesResource,
  renderMeetingResource,
  renderResources,
  renderScreenResource,
  renderSubAgentsResource,
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
  it('wraps each utterance in an XML <conversation> envelope, never a bare line', () => {
    const out = renderConversationResource([tline({ text: "what's the weather" })], 0);
    expect(out).toMatch(/^<conversation\b/);
    expect(out).toContain('</conversation>');
    expect(out).toContain('<utterance speaker="me" kind="human"');
    expect(out).toContain(">what's the weather</utterance>");
    // Framing that makes it observed-not-addressed.
    expect(out).toContain('not to you');
    // Must NOT look like the old in-band formats.
    expect(out).not.toContain('[human:me]');
    expect(out).not.toContain('me (human):');
  });

  it('marks the agent\'s own prior turns kind="agent" so it recognizes itself', () => {
    const out = renderConversationResource(
      [tline({ senderKind: 'agent', participantId: 'agent', text: 'four' })],
      0,
    );
    expect(out).toContain('<utterance speaker="agent" kind="agent"');
    expect(out).toContain('>four</utterance>');
  });

  it('marks tool turns kind="tool"', () => {
    const out = renderConversationResource(
      [tline({ senderKind: 'tool', participantId: 'call_agent', text: 'researched X' })],
      0,
    );
    expect(out).toContain('<utterance speaker="call_agent" kind="tool"');
  });

  it('escapes utterance text so it cannot break out of the envelope', () => {
    const out = renderConversationResource([tline({ text: 'use <script> & "quotes"' })], 0);
    expect(out).toContain('use &lt;script&gt; &amp; &quot;quotes&quot;');
    expect(out).not.toContain('<script>');
  });

  it('renders an empty conversation as a self-closing block (still a resource)', () => {
    const out = renderConversationResource([], 0);
    expect(out).toMatch(/^<conversation\b[^>]*\/>$/);
    expect(out).toContain('empty');
  });

  it('renders the FULL conversation each beat and marks only new-since utterances new="true"', () => {
    // Three utterances; the boundary is seqNo 2 → only the last one is new this beat.
    const entries = [
      tline({ text: 'old one', participantId: 'me' }, 0),
      tline({ text: 'old two', participantId: 'me' }, 1),
      tline({ text: 'fresh', participantId: 'me' }, 2),
    ];
    const out = renderConversationResource(entries, 2);
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
    const out = renderConversationResource(entries, 150);
    // Oldest are elided; the newest are kept.
    expect(out).not.toContain('>line 0</utterance>');
    expect(out).toContain('>line 149</utterance>');
    expect(out).toContain('elided-older="50"');
    expect(out).toContain('showing-last="100"');
  });

  it('renders deliverables as XML with id + kind + title — findings for the brain to READ, not a display-by-id path', () => {
    const out = renderDeliverablesResource([dline({ id: 'dX', kind: 'markdown', title: 'Incident report' })]);
    expect(out).toMatch(/^<deliverables\b/);
    expect(out).toContain('<deliverable id="dX" kind="markdown" title="Incident report"');
    // No file on disk → self-closing element (no inlined content to read).
    expect(out).toContain('/>');
    // The old "share_screen by deliverableId" DISPLAY path is gone — these are written FOR the brain to READ.
    expect(out).not.toContain('deliverableId');
    expect(out).toContain('FOR YOU TO READ');
  });

  it('inlines the findings file content (xml-escaped) so the brain can actually read it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'deliv-'));
    try {
      const fp = join(dir, 'FINDINGS.md');
      writeFileSync(fp, '# Race in <foo> & bar\n\n17 files import it', 'utf-8');
      const out = renderDeliverablesResource([
        dline({ id: 'dC', kind: 'markdown', title: 'Race', filePath: fp }),
      ]);
      // A file on disk → the element OPENS (not self-closed) and inlines the content, xml-escaped.
      expect(out).toContain('<deliverable id="dC"');
      expect(out).toContain('</deliverable>');
      expect(out).toContain('Race in &lt;foo&gt; &amp; bar');
      expect(out).toContain('17 files import it');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('renders an empty deliverables list as a self-closing block', () => {
    const out = renderDeliverablesResource([]);
    expect(out).toMatch(/^<deliverables\b[^>]*\/>$/);
  });

  it('renderResources carries the <meeting> envelope (conversation + screen) + sub_agents + deliverables', () => {
    const out = renderResources({
      transcript: [tline({ text: 'hi' })],
      newSinceSeqNo: 0,
      deliverables: [dline({})],
      subAgents: [],
      screen: { label: 'Chart', kind: 'html', since: 0, mine: true },
    });
    // The meeting envelope wraps what's SAID + SHOWN; the agent's workshop stays outside it.
    expect(out).toContain('<meeting now=');
    expect(out).toContain('<conversation');
    expect(out).toContain('<screen');
    expect(out).toContain('</meeting>');
    expect(out).toContain('<sub_agents');
    expect(out).toContain('<deliverables');
    // The old flat current-time/transcript tags are gone.
    expect(out).not.toContain('<current-time');
    expect(out).not.toContain('<transcript');
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
    expect(userTurns.every((m) => !String(m.content).includes('<meeting'))).toBe(true);
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
    expect(String(msgs[1]!.content)).toContain('<meeting');
    expect(String(msgs[1]!.content)).toContain('<conversation');
    expect(String(msgs[1]!.content)).toContain('<sub_agents');
    expect(String(msgs[1]!.content)).toContain('<deliverables');
  });
});

/**
 * Temporal sense (#34/#36) + the sleep tool (#35). Time reaches the brain as human RELATIVE AGES (not
 * epoch ms); the screen is observable session state with a `mine` honesty bit; sleep is a yield-with-
 * duration that passes the toDecision funnel like any tool.
 */
describe('temporal sense — ages, <screen>, <meeting>, sleep', () => {
  it('renders utterance ages relative to now, never raw epoch ms', () => {
    const now = 1_000_000;
    const out = renderConversationResource([tline({ text: 'hi', timestamp: now - 40_000 })], 0, now);
    expect(out).toContain('age="40s"');
    expect(out).not.toContain('ts=');
  });

  it('floors sub-2s gaps to "just now"', () => {
    const now = 1_000_000;
    const out = renderConversationResource([tline({ timestamp: now - 800 })], 0, now);
    expect(out).toContain('age="just now"');
  });

  it('renders OUR share as mine="true" with an up-for age', () => {
    const now = 1_000_000;
    const out = renderScreenResource({ label: 'ERD', kind: 'html', since: now - 40_000, mine: true }, now);
    expect(out).toMatch(/^<screen\b/);
    expect(out).toContain('showing="ERD"');
    expect(out).toContain('mine="true"');
    expect(out).toContain('up-for="40s"');
  });

  it('renders an external presenter as mine="false" (multi-share honesty)', () => {
    const out = renderScreenResource({ label: 'Dylan is sharing', kind: '', since: 0, mine: false }, 5_000);
    expect(out).toContain('mine="false"');
    expect(out).toContain('Dylan is sharing');
  });

  it('renders an empty screen as a self-closing block', () => {
    expect(renderScreenResource(null, 1_000)).toMatch(/^<screen\b[^>]*\/>$/);
  });

  it('wraps conversation + screen in <meeting> with now/elapsed/room-quiet-for', () => {
    const now = 1_000_000;
    const out = renderMeetingResource({
      transcript: [tline({ text: 'hello', timestamp: now - 60_000 })],
      newSinceSeqNo: 0,
      screen: { label: 'Chart', kind: 'html', since: now - 10_000, mine: true },
      now,
    });
    expect(out).toMatch(/^<meeting\b/);
    expect(out).toContain('now="');
    expect(out).toContain('room-quiet-for="1m"');
    expect(out).toContain('<conversation');
    expect(out).toContain('<screen');
    expect(out).toContain('</meeting>');
  });

  it('a valid sleep call passes the funnel with its seconds', () => {
    const d = toDecision(call({ name: 'sleep', arguments: '{"seconds":30}' }));
    expect(d).toEqual({ name: 'sleep', args: { seconds: 30 } });
  });

  it('a sleep with no seconds fails the schema → no_op', () => {
    const d = toDecision(call({ name: 'sleep', arguments: '{}' }));
    expect(d).toEqual({ name: 'no_op', args: {} });
  });
});
