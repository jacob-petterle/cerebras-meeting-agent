import { readFileSync } from 'node:fs';
import type {
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from 'openai/resources/chat/completions';
import {
  type DeliverableRecord,
  type LogEntry,
  type SubAgentTaskRecord,
  type ToolName,
  TOOL_ARGS,
  type TranscriptEntry,
} from '@meeting-agent/protocol';
import { buildSystemPrompt } from './identity';
import type { AppendLog } from './resources';
import type { ActiveShare } from './screen-state';
import { ageOf, quantizeNow } from './time';
import type { AssembledResult, AssembledToolCall, CerebrasClient } from './cerebras';

/**
 * decide.ts — turn the observed resources into exactly one tool decision.
 *
 * The agent is an OBSERVER, not a chatbot: the human conversation is NEVER injected as an in-band
 * `user` message addressed to the model. Instead, each heartbeat the loop renders the resources it
 * watches — the transcript delta and the current sub-agent deliverables — as labeled `<transcript>`
 * / `<deliverables>` blocks inside one neutral "tick" turn (mirrors how a Shipyard agent observes
 * its `<task-metadata>`). The model reads that ambient state and picks one tool.
 *
 * The brain (Cerebras/Gemma) is injected so the orchestrator/tests can drive `decide` without a
 * network. We hand the model the 4 tool JSON-schemas (derived from the protocol Zod shapes), parse
 * the streamed tool call, and bias hard to `no_op`: any ambiguity — no tool call, an unknown tool,
 * or unparsable arguments — resolves to `no_op` rather than a noisy interjection.
 */

/** Cap how many of the most-recent deliverables are folded into the loop, to keep the prompt lean. */
const MAX_DELIVERABLES_IN_CONTEXT = 8;

/**
 * Per-deliverable safety cap on the inlined findings markdown (chars). The sub-agent is told to be terse,
 * so a normal findings doc sits well under this — the cap only guards against a runaway agent ballooning
 * every beat's prompt. Past it we truncate and point at the on-disk file rather than drop the finding.
 */
const DELIVERABLE_CONTENT_MAX = 12_000;

/** Cap how many of the most-recent sub-agent tasks (latest-per-id) are folded into the loop. */
const MAX_SUB_AGENTS_IN_CONTEXT = 8;
/** Truncate the longest column values in the compact <sub_agents> table so the prompt stays lean. */
const SUB_AGENT_TASK_MAX = 80;
const SUB_AGENT_PROGRESS_MAX = 80;
/** Short id prefix shown in the table — enough to disambiguate, not the full UUID. */
const SUB_AGENT_ID_LEN = 8;

/**
 * Cap how many of the most-recent utterances we render. The model now sees the FULL conversation each
 * beat (not just the delta) so it keeps memory of earlier context; this bound keeps the prompt sane on
 * a long session. The newest utterances are always kept (we slice the tail).
 */
const MAX_TRANSCRIPT_IN_CONTEXT = 100;

/** One parsed decision: which tool + its raw args (validated downstream by the registry). */
export interface Decision {
  name: ToolName;
  args: unknown;
}

/** Hand-written JSON-schemas for the 5 tools (zod-to-json-schema avoided to keep deps lean). */
export const TOOL_SCHEMAS: ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'speak',
      description:
        'Say something concise and useful out loud. For quick answers, acknowledgements, or surfacing a fact. Keep it short — this is a live conversation.',
      parameters: {
        type: 'object',
        properties: { text: { type: 'string', description: 'What to say out loud.' } },
        required: ['text'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'share_screen',
      description:
        'Put an artifact YOU authored on the shared screen — compose what is shown from what you know or what your agents found. Do NOT forward a sub-agent findings file; that file is for you to read, and you re-express what matters here. Use when a visual conveys something better than speech.',
      parameters: {
        type: 'object',
        properties: {
          kind: {
            type: 'string',
            enum: ['html', 'mermaid', 'image', 'json', 'log', 'markdown'],
          },
          payload: {
            type: 'string',
            description: 'Inline source (html/mermaid/markdown/json/log) or a URL/path for image.',
          },
          title: { type: 'string' },
        },
        required: ['kind', 'payload'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'call_agent',
      description:
        'Hand a self-contained investigation brief to one of your research agents — a capable coding agent loose in the repo that reads code, queries data, and writes back a markdown findings doc YOU read, all while you keep participating. It runs OUT OF BAND in the background (depth is fine; it never blocks you). Dispatch deliberately, not eagerly: only for a genuine, specific need that truly requires digging — not something you can answer directly, and not trivial. The agent CANNOT hear the room and knows ONLY what this task says, so write it as a COMPLETE brief: the precise question, the context/names/paths it cannot see, the scope boundary, whether it is a wide map or a deep dive, and the grounding bar (cite file:line, real counts). Go WIDE first (one breadth task that maps and counts), then fan out NARROW deep-dive tasks as findings come back — prefer several focused agents over one "investigate everything" task. NEVER dispatch a task already shown as status=running in <sub_agents>; it is already in flight.',
      parameters: {
        type: 'object',
        properties: {
          task: {
            type: 'string',
            description:
              'A clear, specific, well-scoped task with enough context for the assistant to dig without guessing.',
          },
        },
        required: ['task'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'no_op',
      description:
        'Do nothing this turn. The right choice most of the time — prefer silence over a wrong or noisy interjection.',
      parameters: {
        type: 'object',
        properties: { reason: { type: 'string' } },
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'sleep',
      description:
        'Deliberately step back for a stretch: end your turn AND pause your idle heartbeat for `seconds`, so you are not re-prompted every beat while you have nothing to add. Use it when you want to stand down for a bit — e.g. you just put a diagram up and want to let it sit, or the room is quiet and self-checking would only be noise. A person speaking (or a research result landing) wakes you early. Use no_op to yield a single beat; use sleep to stand down for a few seconds up to ~2 minutes.',
      parameters: {
        type: 'object',
        properties: {
          seconds: { type: 'number', description: 'How long to stand down (clamped to ~2–120s).' },
          reason: { type: 'string' },
        },
        required: ['seconds'],
        additionalProperties: false,
      },
    },
  },
];

/** Narrow an arbitrary string to a ToolName without an assertion (used after the `in` guard). */
function toToolName(name: string): ToolName {
  switch (name) {
    case 'speak':
      return 'speak';
    case 'share_screen':
      return 'share_screen';
    case 'call_agent':
      return 'call_agent';
    case 'sleep':
      return 'sleep';
    default:
      return 'no_op';
  }
}

function parseArgs(raw: string): unknown {
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Map an assembled tool call to a validated Decision. Anything off-contract (unknown tool, bad
 * JSON, args that fail the tool's Zod schema) collapses to `no_op`.
 */
export function toDecision(call: AssembledToolCall | undefined): Decision {
  const noOp: Decision = { name: 'no_op', args: {} };
  /**
   * Gate on the tool table directly: an unknown name isn't a key of TOOL_ARGS → no_op. (The old
   * isToolName guard was a tautology — toToolName collapses unknowns to 'no_op', which is itself a
   * known tool, so the guard always passed.)
   */
  if (!call || !call.name || !(call.name in TOOL_ARGS)) return noOp;

  const name = toToolName(call.name);
  const args = parseArgs(call.arguments);
  if (args === null) return noOp;

  const parsed = TOOL_ARGS[name].safeParse(args);
  if (!parsed.success) return noOp;
  return { name, args: parsed.data };
}

/** Pick the decision from a completed brain result: bias to no_op, take the first tool call. */
export function decisionFromResult(result: AssembledResult): Decision {
  return toDecision(result.toolCalls[0]);
}

/**
 * Shared XML tag names — one source of truth so the system-prompt framing (identity.ts) and the
 * emitters here never drift. Mirrors Shipyard's `apps/daemon/src/shared/xml-tag-names.ts`.
 */
const XML_TAGS = {
  MEETING: 'meeting',
  CONVERSATION: 'conversation',
  SCREEN: 'screen',
  DELIVERABLES: 'deliverables',
  SUB_AGENTS: 'sub_agents',
} as const;

/** Escape text/attribute content so an utterance can never break out of its XML envelope. */
function xmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Render the FULL transcript as an OBSERVED resource block — a named XML envelope, the same shape
 * Shipyard emits for <task-metadata>/<branch> (task-metadata-resolver.ts `renderEnvelope`). The
 * speakers are talking to each other; the model is an observer, so this is NEVER a message addressed
 * to it. `kind` distinguishes a human, the model's own prior turns (agent), and tool side effects.
 *
 * The model sees the WHOLE conversation each beat (full memory), but only utterances whose seqNo is
 * `>= newSinceSeqNo` carry `new="true"` — those are the ones that arrived since the last beat. The
 * model reads everything for context but should only ACT on the new openings. This is how we keep
 * memory while the orchestrator's cursor keeps advancing past no_op'd content: the cursor is just the
 * boundary that decides which utterances are marked new, not what the model is allowed to remember.
 *
 * Bounded to the most-recent {@link MAX_TRANSCRIPT_IN_CONTEXT} utterances so the prompt stays sane on
 * a long session; the cap is surfaced on the envelope so the model knows older lines may be elided.
 */
export function renderConversationResource(
  entries: LogEntry<TranscriptEntry>[],
  newSinceSeqNo: number,
  now: number = Date.now(),
): string {
  const T = XML_TAGS.CONVERSATION;
  if (entries.length === 0) {
    return `<${T} note="the conversation is empty so far" />`;
  }
  const capped = entries.slice(-MAX_TRANSCRIPT_IN_CONTEXT);
  const elided = entries.length - capped.length;
  const lines = capped
    .map((e) => {
      /** Mark utterances new since the last beat so the model knows what to consider acting on. */
      const isNew = e.seqNo >= newSinceSeqNo ? ' new="true"' : '';
      /** A human-readable AGE relative to this beat's `now` — the model can't reason about epoch ms. */
      const age = ageOf(e.data.timestamp, now);
      return `  <utterance speaker="${xmlEscape(e.data.participantId)}" kind="${e.data.senderKind}" age="${age}"${isNew}>${xmlEscape(e.data.text)}</utterance>`;
    })
    .join('\n');
  const cap = elided > 0 ? ` showing-last="${capped.length}" elided-older="${elided}"` : '';
  return (
    `<${T} new-since="${newSinceSeqNo}"${cap} note="the full conversation so far, live room audio transcribed — the speakers are talking to each other, not to you; utterances tagged as new arrived since you last observed, act only on those; age is how long ago each was said">\n` +
    lines +
    `\n</${T}>`
  );
}

/**
 * Render the shared SCREEN as an observed resource (inside <meeting>). This is what lets the model
 * reason about "how long to keep a diagram up": it sees what's currently shown and for how long.
 * `mine` is the honesty bit — true when WE put it up (the model can trust its artifact is visible),
 * false when another participant is presenting (the model must NOT assume its own artifact is on screen).
 */
export function renderScreenResource(screen: ActiveShare | null, now: number): string {
  const S = XML_TAGS.SCREEN;
  if (!screen) {
    return `<${S} note="nothing is on the shared screen right now" />`;
  }
  const age = ageOf(screen.since, now);
  if (!screen.mine) {
    return `<${S} showing="${xmlEscape(screen.label)}" mine="false" since="${age}" note="another participant is presenting — your last artifact is NOT what is on screen" />`;
  }
  const kindAttr = screen.kind ? ` kind="${xmlEscape(screen.kind)}"` : '';
  return `<${S} showing="${xmlEscape(screen.label)}"${kindAttr} mine="true" up-for="${age}" note="this is what YOU put on the shared screen; a later share_screen replaces it — keep it up while relevant, refresh it as the discussion moves, clear it when it no longer fits" />`;
}

/**
 * The <meeting> envelope — the live meeting as ONE resource with two channels: what's being SAID
 * (<conversation>) and what's being SHOWN (<screen>). Mirrors how Shipyard wraps shared state. Carries
 * the beat's authoritative `now` (quantized to 5s so it holds steady between beats), `elapsed` (how long
 * the meeting has run), and `room-quiet-for` (how long since a PERSON last spoke — the key pacing signal:
 * a lull is the moment to act, take a stale diagram down, or sleep). The agent's own workshop
 * (<sub_agents>, <deliverables>) stays OUTSIDE this envelope — that's its side, not the room's.
 */
export function renderMeetingResource(args: {
  transcript: LogEntry<TranscriptEntry>[];
  newSinceSeqNo: number;
  screen: ActiveShare | null;
  now: number;
}): string {
  const M = XML_TAGS.MEETING;
  const nowIso = new Date(quantizeNow(args.now)).toISOString();
  const firstHuman = args.transcript.find((e) => e.data.senderKind === 'human');
  const lastHuman = [...args.transcript].reverse().find((e) => e.data.senderKind === 'human');
  const elapsed = firstHuman ? ` elapsed="${ageOf(firstHuman.data.timestamp, args.now)}"` : '';
  const quiet = lastHuman ? ` room-quiet-for="${ageOf(lastHuman.data.timestamp, args.now)}"` : '';
  const conversation = renderConversationResource(args.transcript, args.newSinceSeqNo, args.now);
  const screen = renderScreenResource(args.screen, args.now);
  return (
    `<${M} now="${nowIso}"${elapsed}${quiet} note="the live meeting — what's being SAID (conversation) and SHOWN (screen); time is RELATIVE: an age like &quot;40s ago&quot; or &quot;just now&quot;, gaps under ~2s read as simultaneous">\n` +
    `${conversation}\n${screen}\n` +
    `</${M}>`
  );
}

/**
 * Read a deliverable's findings file for inlining into the resource — the markdown the brain READS (it
 * is never displayed). Returns null when there is no file, it's empty, or it can't be read; past the
 * size cap it truncates and points at the on-disk path so the finding is never silently dropped.
 */
function readDeliverableContent(filePath: string | null): string | null {
  if (!filePath) return null;
  try {
    const text = readFileSync(filePath, 'utf-8');
    if (text.trim().length === 0) return null;
    return text.length > DELIVERABLE_CONTENT_MAX
      ? `${text.slice(0, DELIVERABLE_CONTENT_MAX)}\n\n…[truncated — full findings on disk at ${filePath}]`
      : text;
  } catch {
    return null;
  }
}

/**
 * Render the sub-agent FINDINGS as an observed resource block (bounded to the most recent few), with
 * each finding's MARKDOWN CONTENT inlined — not just metadata — so the brain can actually READ it. This
 * is the input to the brain's job as the room's representative: it reads what its agents found and then
 * decides, for the room, whether and how to communicate it (a visual it authors, a spoken line, both, or
 * nothing). Findings are NEVER displayed raw — there is deliberately no "share this by id" path here.
 */
export function renderDeliverablesResource(
  items: LogEntry<DeliverableRecord>[],
  now: number = Date.now(),
): string {
  const D = XML_TAGS.DELIVERABLES;
  const recent = items.slice(-MAX_DELIVERABLES_IN_CONTEXT);
  if (recent.length === 0) {
    return `<${D} note="no sub-agent findings yet" />`;
  }
  const lines = recent
    .map((e) => {
      const d = e.data;
      const path = d.filePath ? ` path="${xmlEscape(d.filePath)}"` : '';
      const desc = d.description ? ` description="${xmlEscape(d.description)}"` : '';
      /** How long ago it was produced — so a stale finding isn't surfaced as if it were fresh. */
      const produced = ` produced="${ageOf(d.producedAt, now)}"`;
      const attrs = `id="${xmlEscape(d.id)}" kind="${d.kind}" title="${xmlEscape(d.title)}"${path}${desc}${produced}`;
      /** Inline the findings markdown (xml-escaped so it can't break the envelope) for the brain to READ. */
      const content = readDeliverableContent(d.filePath);
      if (!content) return `  <deliverable ${attrs} />`;
      return `  <deliverable ${attrs}>\n${xmlEscape(content)}\n  </deliverable>`;
    })
    .join('\n');
  return (
    `<${D} note="the findings your sub-agents produced — research written FOR YOU TO READ, not to display. You are the room's representative: read each, then decide whether and how to communicate it — a visual you AUTHOR, a spoken line, both, or nothing. NEVER put a finding on screen raw; re-express what matters in your own words/visuals">\n` +
    lines +
    `\n</${D}>`
  );
}

/**
 * Fold an append-only sub-agent log to its CURRENT state: one record per `id`, the LAST append for
 * that id winning (status is modeled as successive appends keyed by id — running → progress → terminal).
 * Insertion order is preserved (a Map keeps first-seen order), so the table stays stable beat to beat
 * while each row reflects the freshest status. This is the read-side fold the heartbeat + web both use.
 */
export function foldLatestById(items: SubAgentTaskRecord[]): SubAgentTaskRecord[] {
  const byId = new Map<string, SubAgentTaskRecord>();
  for (const item of items) byId.set(item.id, item);
  return [...byId.values()];
}

/** Truncate a single-lined string to `max` chars with an ellipsis (for the compact table columns). */
function truncate(s: string, max: number): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/**
 * Render the live sub-agent tasks as an observed resource block — the Shipyard sub-task view. Status
 * is folded latest-per-id (a slow Cursor run streams running → progress → done/error as appends), then
 * rendered as a compact table the model reads each beat WITHOUT blocking on any run. The `running`
 * count is surfaced on the envelope so the model can see at a glance whether research is already in
 * flight — the signal that backs the hard re-fire rule ("never call_agent for a task already running").
 */
export function renderSubAgentsResource(
  items: SubAgentTaskRecord[],
  now: number = Date.now(),
): string {
  const S = XML_TAGS.SUB_AGENTS;
  const latest = foldLatestById(items).slice(-MAX_SUB_AGENTS_IN_CONTEXT);
  const running = latest.filter((t) => t.status === 'running').length;
  if (latest.length === 0) {
    return `<${S} running="0" note="no sub-agent research is in flight" />`;
  }
  const rows = latest
    .map((t) => {
      const shortId = t.id.slice(0, SUB_AGENT_ID_LEN);
      const lastProgress = t.progress.at(-1) ?? '';
      const deliverable = t.deliverableId ? ` deliverable="${xmlEscape(t.deliverableId)}"` : '';
      const detail = t.status === 'error' && t.error ? truncate(t.error, SUB_AGENT_PROGRESS_MAX) : truncate(lastProgress, SUB_AGENT_PROGRESS_MAX);
      /** For a live run, how long it's been going — so the brain can say "still digging, ~1 min in". */
      const runningFor = t.status === 'running' ? ` running-for="${ageOf(t.startedAt, now)}"` : '';
      return `  <task id="${xmlEscape(shortId)}" status="${t.status}" task="${xmlEscape(truncate(t.task, SUB_AGENT_TASK_MAX))}"${runningFor} last_progress="${xmlEscape(detail)}"${deliverable} />`;
    })
    .join('\n');
  return (
    `<${S} running="${running}" note="research sub-agents you dispatched and their live status; a task with status=running is ALREADY in flight — never call_agent for it again, just keep participating until it finishes">\n` +
    rows +
    `\n</${S}>`
  );
}

/**
 * The full set of observed resources for one beat: the <meeting> envelope (conversation + screen) plus
 * the agent's own workshop (<sub_agents>, <deliverables>). Injected into the SYSTEM channel (see
 * buildResourceMessages) so NOTHING the model reads as conversation is in-band. One authoritative `now`
 * (epoch ms) threads through so EVERY age in the beat is computed against the same instant.
 */
export function renderResources(args: {
  transcript: LogEntry<TranscriptEntry>[];
  newSinceSeqNo: number;
  deliverables: LogEntry<DeliverableRecord>[];
  subAgents: LogEntry<SubAgentTaskRecord>[];
  /** The current shared-screen state (what's shown + since when). Omitted ⇒ nothing on screen. */
  screen?: ActiveShare | null;
  /** This beat's authoritative clock (epoch ms). Defaults to now; injected for deterministic tests. */
  now?: number;
}): string {
  const now = args.now ?? Date.now();
  return [
    renderMeetingResource({
      transcript: args.transcript,
      newSinceSeqNo: args.newSinceSeqNo,
      screen: args.screen ?? null,
      now,
    }),
    renderSubAgentsResource(args.subAgents.map((e) => e.data), now),
    renderDeliverablesResource(args.deliverables, now),
  ].join('\n');
}

/**
 * The heartbeat pulse — the loop's clock and the ONLY user-role turn. It carries NO conversation:
 * the room's words live entirely inside the <transcript> resource in the system channel. This is the
 * concrete meaning of "Gemma has nothing in band" — the user turn is a content-free trigger to act.
 */
const HEARTBEAT_PULSE =
  '[heartbeat] You have just observed the live state resources in your context. Think briefly first: in one sentence, what (if anything) genuinely needs you right now? Then choose exactly one action for this beat — speak, share_screen, call_agent, no_op, or sleep. Default HARD to no_op: only act on a clear, specific opening where you add value the room does not already have. Do not call_agent for anything you can answer directly, anything trivial, or any task already shown as running in <sub_agents>.';

/**
 * Assemble the model input so observed state is NEVER in-band. Mirrors Shipyard's pattern (resources
 * are the daemon-tracked truth the system prompt declares) but takes the stronger reading of "nothing
 * in band": the resource envelopes go in the SYSTEM channel, not a user turn. Two system messages
 * (static identity+convention, then the dynamic resources) degrade safely — a server that collapses
 * system turns just merges them, still never in-band. The single user turn is the heartbeat pulse.
 */
export function buildResourceMessages(args: {
  system: string;
  /** The FULL transcript snapshot — the model observes the whole conversation each beat. */
  transcript: LogEntry<TranscriptEntry>[];
  /** Boundary seqNo: utterances with seqNo >= this are marked new (arrived since the last beat). */
  newSinceSeqNo: number;
  deliverables: LogEntry<DeliverableRecord>[];
  /** Live sub-agent tasks (append-log; folded latest-per-id at render). */
  subAgents: LogEntry<SubAgentTaskRecord>[];
  /** Current shared-screen state — the <screen> block inside <meeting>. Omitted ⇒ nothing shared. */
  screen?: ActiveShare | null;
  /** This beat's authoritative clock (epoch ms). Defaults to now; injected for deterministic tests. */
  now?: number;
}): ChatCompletionMessageParam[] {
  const resources = renderResources({
    transcript: args.transcript,
    newSinceSeqNo: args.newSinceSeqNo,
    deliverables: args.deliverables,
    subAgents: args.subAgents,
    screen: args.screen ?? null,
    now: args.now,
  });
  return [
    { role: 'system', content: args.system },
    { role: 'system', content: resources },
    { role: 'user', content: HEARTBEAT_PULSE },
  ];
}

/** Live inference stats emitted once per brain call, for the HUD (tok/s + token counts). */
export interface DecideStats {
  tokensPerSec: number | null;
  promptTokens: number;
  completionTokens: number;
}

export interface DecideDeps {
  cerebras: CerebrasClient;
  /** Per-session context (who's here, what's in scope) folded into the system prompt. */
  context: string;
  /**
   * The deliverables resource. Read (a bounded snapshot) on every tick and injected as the
   * `<deliverables>` block so the model observes sub-agent artifacts as a resource — the same way
   * it observes the transcript. The orchestrator's heartbeat stays transcript-delta-driven; this is
   * ambient context the model sees once a tick fires.
   */
  deliverables: AppendLog<DeliverableRecord>;
  /**
   * The sub-agent-task resource. Read (a bounded latest-per-id fold) on every tick and injected as the
   * `<sub_agents>` block so the model observes in-flight research as a resource — the same way it
   * observes the transcript. This is what lets the heartbeat keep ticking while a slow Cursor run is in
   * flight AND lets the brain SEE a task is already running so it won't re-dispatch it (the re-fire rule).
   */
  subAgents: AppendLog<SubAgentTaskRecord>;
  /**
   * The transcript resource. The model now observes the FULL conversation every beat (not just the
   * heartbeat delta) so it keeps memory of earlier context. The orchestrator still triggers on the
   * delta and hands `decide` the delta; `decide` uses the delta's first seqNo as the new-boundary and
   * reads the full snapshot HERE for context. Marking new-since-last-beat utterances is what lets the
   * model remember everything while still acting only on the fresh openings.
   */
  transcript: AppendLog<TranscriptEntry>;
  /**
   * The shared-screen state, read each beat (a getter so it always reflects the latest share) and
   * injected as the <screen> block inside <meeting>. This is what lets the model reason about what's on
   * screen and for how long ("keep the diagram up?"). Optional — when absent the screen renders empty.
   */
  screen?: () => ActiveShare | null;
  /**
   * Optional sink for live inference stats. Called after each `cerebras.complete` with the
   * assembled result's usage + wall-clock tok/s, so the wiring can broadcast it to the web HUD
   * (the rate is otherwise computed in cerebras.ts and discarded). Errors here are not propagated.
   */
  onStats?: (stats: DecideStats) => void;
}

/**
 * Build a decide() the orchestrator can call with just the transcript delta. The brain client and
 * session context are injected here so the hot path stays `(delta) => Promise<Decision>`.
 */
export function createDecide(deps: DecideDeps): (delta: LogEntry<TranscriptEntry>[]) => Promise<Decision> {
  const system = buildSystemPrompt(deps.context);
  return async (delta) => {
    /**
     * The new-boundary for THIS beat: the seqNo of the first delta entry (what the orchestrator just
     * handed us as "new since last observed"). When the delta is empty (decide called outside the
     * orchestrator), fall back to one past the current head so nothing is marked new.
     */
    const newSinceSeqNo = delta[0]?.seqNo ?? deps.transcript.head() + 1;
    /** One authoritative `now` for the whole beat, so every age is computed against the same instant. */
    const now = Date.now();
    /**
     * Assemble the beat so nothing is in-band: identity+convention and the observed resource
     * envelopes go in the SYSTEM channel; the only user turn is a content-free heartbeat pulse. The
     * <meeting> block is the FULL conversation snapshot (new utterances marked) plus the current screen.
     */
    const messages = buildResourceMessages({
      system,
      transcript: deps.transcript.snapshot(),
      newSinceSeqNo,
      deliverables: deps.deliverables.snapshot(),
      subAgents: deps.subAgents.snapshot(),
      screen: deps.screen?.() ?? null,
      now,
    });
    const result = await deps.cerebras.complete({
      messages,
      tools: TOOL_SCHEMAS,
    });
    deps.onStats?.({
      tokensPerSec: result.tokensPerSec,
      promptTokens: result.usage?.promptTokens ?? 0,
      completionTokens: result.usage?.completionTokens ?? 0,
    });
    return decisionFromResult(result);
  };
}
