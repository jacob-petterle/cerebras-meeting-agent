import type {
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from 'openai/resources/chat/completions';
import {
  type DeliverableRecord,
  type LogEntry,
  type ToolName,
  TOOL_ARGS,
  type TranscriptEntry,
} from '@meeting-agent/protocol';
import { buildSystemPrompt } from './identity';
import type { AppendLog } from './resources';
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

/** One parsed decision: which tool + its raw args (validated downstream by the registry). */
export interface Decision {
  name: ToolName;
  args: unknown;
}

/** Hand-written JSON-schemas for the 4 tools (zod-to-json-schema avoided to keep deps lean). */
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
        'Put an artifact on the shared screen. Use when a visual conveys it better than speech, or to show a sub-agent result.',
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
          deliverableId: {
            type: 'string',
            description: 'Optional id of a sub-agent deliverable this artifact corresponds to.',
          },
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
        'Dispatch a sub-agent to research or investigate something that needs real work (reading code, querying data, producing a findings document). Use when the answer requires digging, not recall. It takes time.',
      parameters: {
        type: 'object',
        properties: {
          task: { type: 'string', description: 'A clear, specific task for the sub-agent.' },
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
  TRANSCRIPT: 'transcript',
  DELIVERABLES: 'deliverables',
  CURRENT_TIME: 'current-time',
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
 * Render the transcript delta as an OBSERVED resource block — a named XML envelope, the same shape
 * Shipyard emits for <task-metadata>/<branch> (task-metadata-resolver.ts `renderEnvelope`). The
 * speakers are talking to each other; the model is an observer, so this is NEVER a message addressed
 * to it. `kind` distinguishes a human, the model's own prior turns (agent), and tool side effects.
 */
export function renderTranscriptResource(delta: LogEntry<TranscriptEntry>[]): string {
  const T = XML_TAGS.TRANSCRIPT;
  if (delta.length === 0) {
    return `<${T} note="no new utterances since you last observed" />`;
  }
  const since = delta[0]?.seqNo ?? 0;
  const lines = delta
    .map(
      (e) =>
        `  <utterance speaker="${xmlEscape(e.data.participantId)}" kind="${e.data.senderKind}" ts="${e.data.timestamp}">${xmlEscape(e.data.text)}</utterance>`,
    )
    .join('\n');
  return (
    `<${T} since="${since}" note="live room audio, transcribed — the speakers are talking to each other, not to you; only utterances new since you last observed are shown">\n` +
    lines +
    `\n</${T}>`
  );
}

/**
 * Render the current sub-agent deliverables as an observed resource block (bounded to the most
 * recent few). This is what lets the model choose to `share_screen` a result by its `deliverableId`.
 */
export function renderDeliverablesResource(items: LogEntry<DeliverableRecord>[]): string {
  const D = XML_TAGS.DELIVERABLES;
  const recent = items.slice(-MAX_DELIVERABLES_IN_CONTEXT);
  if (recent.length === 0) {
    return `<${D} note="no sub-agent artifacts have been produced yet" />`;
  }
  const lines = recent
    .map((e) => {
      const d = e.data;
      const path = d.filePath ? ` path="${xmlEscape(d.filePath)}"` : '';
      const desc = d.description ? ` description="${xmlEscape(d.description)}"` : '';
      return `  <deliverable id="${xmlEscape(d.id)}" kind="${d.kind}" title="${xmlEscape(d.title)}"${path}${desc} />`;
    })
    .join('\n');
  return (
    `<${D} note="artifacts your sub-agents produced; to put one on the shared screen, call share_screen with its deliverableId">\n` +
    lines +
    `\n</${D}>`
  );
}

/** The wall-clock for this beat — a live agent should know the time (mirrors Shipyard's <current-time/>). */
function renderCurrentTime(): string {
  return `<${XML_TAGS.CURRENT_TIME} iso="${new Date().toISOString()}" />`;
}

/**
 * The full set of observed resources for one beat. Injected into the SYSTEM channel (see
 * buildResourceMessages) so NOTHING the model reads as conversation is in-band.
 */
export function renderResources(args: {
  transcript: LogEntry<TranscriptEntry>[];
  deliverables: LogEntry<DeliverableRecord>[];
}): string {
  return [
    renderCurrentTime(),
    renderTranscriptResource(args.transcript),
    renderDeliverablesResource(args.deliverables),
  ].join('\n');
}

/**
 * The heartbeat pulse — the loop's clock and the ONLY user-role turn. It carries NO conversation:
 * the room's words live entirely inside the <transcript> resource in the system channel. This is the
 * concrete meaning of "Gemma has nothing in band" — the user turn is a content-free trigger to act.
 */
const HEARTBEAT_PULSE =
  '[heartbeat] You have just observed the live state resources in your context. Choose exactly one action for this beat — speak, share_screen, call_agent, or no_op. Default to no_op unless there is a clear, specific opening where you can genuinely help.';

/**
 * Assemble the model input so observed state is NEVER in-band. Mirrors Shipyard's pattern (resources
 * are the daemon-tracked truth the system prompt declares) but takes the stronger reading of "nothing
 * in band": the resource envelopes go in the SYSTEM channel, not a user turn. Two system messages
 * (static identity+convention, then the dynamic resources) degrade safely — a server that collapses
 * system turns just merges them, still never in-band. The single user turn is the heartbeat pulse.
 */
export function buildResourceMessages(args: {
  system: string;
  transcript: LogEntry<TranscriptEntry>[];
  deliverables: LogEntry<DeliverableRecord>[];
}): ChatCompletionMessageParam[] {
  const resources = renderResources({ transcript: args.transcript, deliverables: args.deliverables });
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
     * Assemble the beat so nothing is in-band: identity+convention and the observed resource
     * envelopes go in the SYSTEM channel; the only user turn is a content-free heartbeat pulse.
     */
    const messages = buildResourceMessages({
      system,
      transcript: delta,
      deliverables: deps.deliverables.snapshot(),
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
