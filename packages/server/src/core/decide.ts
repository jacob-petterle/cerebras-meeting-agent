import type { ChatCompletionTool } from 'openai/resources/chat/completions';
import {
  type LogEntry,
  type ToolName,
  TOOL_ARGS,
  type TranscriptEntry,
} from '@meeting-agent/protocol';
import { buildSystemPrompt } from './identity';
import type { AssembledResult, AssembledToolCall, CerebrasClient } from './cerebras';

/**
 * decide.ts — turn the transcript delta into exactly one tool decision.
 *
 * The brain (Cerebras/Gemma) is injected so the orchestrator/tests can drive `decide` without a
 * network. We hand the model the 4 tool JSON-schemas (derived from the protocol Zod shapes), parse
 * the streamed tool call, and bias hard to `no_op`: any ambiguity — no tool call, an unknown tool,
 * or unparsable arguments — resolves to `no_op` rather than a noisy interjection.
 */

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

/** Render the transcript delta into a compact user turn for the model. */
export function renderDelta(delta: LogEntry<TranscriptEntry>[]): string {
  if (delta.length === 0) return '(no new conversation since you last acted)';
  return delta
    .map((e) => `[${e.data.senderKind}:${e.data.participantId}] ${e.data.text}`)
    .join('\n');
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
    const result = await deps.cerebras.complete({
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: renderDelta(delta) },
      ],
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
