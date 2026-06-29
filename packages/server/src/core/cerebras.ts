import OpenAI from 'openai';
import type {
  ChatCompletionCreateParamsStreaming,
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from 'openai/resources/chat/completions';
import type { ReasoningEffort } from 'openai/resources/shared';

/**
 * Cerebras (Gemma-4) brain client + the streamed-tool_call accumulator.
 *
 * THE QUIRK (guarded by tests/cerebras.test.ts): a single tool call is streamed across many
 * chunks; only `index` ties the argument fragments together. `name`/`id` arrive on the first
 * delta for that index; `arguments` arrive as a string split across later deltas. We accumulate
 * by index and emit complete calls ordered by index — `assembleStream` is a PURE function over
 * an async iterable so a fixture stream can drive it with no network.
 */

/** The subset of an OpenAI streaming chunk we depend on (Cerebras emits the same shape). */
export interface StreamChunkToolCall {
  index: number;
  id?: string;
  type?: 'function';
  function?: { name?: string; arguments?: string };
}

export interface StreamChunkDelta {
  role?: string;
  content?: string | null;
  tool_calls?: StreamChunkToolCall[];
}

export interface StreamChunkChoice {
  delta: StreamChunkDelta;
  finish_reason?: 'stop' | 'length' | 'tool_calls' | 'content_filter' | 'function_call' | null;
}

export interface StreamChunkUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

export interface StreamChunk {
  choices: StreamChunkChoice[];
  usage?: StreamChunkUsage | null;
}

/** One fully-assembled tool call. */
export interface AssembledToolCall {
  index: number;
  id: string;
  name: string;
  /** Concatenated raw JSON argument string. Validate before use — the model can emit bad JSON. */
  arguments: string;
}

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface AssembledResult {
  toolCalls: AssembledToolCall[];
  content: string;
  finishReason: StreamChunkChoice['finish_reason'];
  usage: TokenUsage | null;
  /** Wall-clock tok/s for the completion, when usage + elapsed are available. */
  tokensPerSec: number | null;
  elapsedMs: number;
}

interface ToolCallAccumulator {
  index: number;
  id: string;
  name: string;
  arguments: string;
}

/**
 * Pure accumulator over a stream of chunks. Drives off `index` to stitch fragmented tool calls;
 * concatenates `arguments`; first non-empty `name`/`id` per index wins; output is ordered by index
 * regardless of fragment arrival order.
 */
export async function assembleStream(stream: AsyncIterable<StreamChunk>): Promise<AssembledResult> {
  const startedAt = Date.now();
  const byIndex = new Map<number, ToolCallAccumulator>();
  let content = '';
  let finishReason: StreamChunkChoice['finish_reason'] = null;
  let usage: TokenUsage | null = null;

  for await (const chunk of stream) {
    if (chunk.usage) {
      usage = {
        promptTokens: chunk.usage.prompt_tokens ?? 0,
        completionTokens: chunk.usage.completion_tokens ?? 0,
        totalTokens: chunk.usage.total_tokens ?? 0,
      };
    }

    for (const choice of chunk.choices) {
      if (choice.finish_reason) finishReason = choice.finish_reason;

      const delta = choice.delta;
      if (typeof delta.content === 'string') content += delta.content;

      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          /** Defend the accumulator key: a malformed/missing index would corrupt the by-index map. */
          if (!Number.isInteger(tc.index) || tc.index < 0) continue;
          const acc = byIndex.get(tc.index) ?? {
            index: tc.index,
            id: '',
            name: '',
            arguments: '',
          };
          if (tc.id && !acc.id) acc.id = tc.id;
          if (tc.function?.name && !acc.name) acc.name = tc.function.name;
          if (tc.function?.arguments) acc.arguments += tc.function.arguments;
          byIndex.set(tc.index, acc);
        }
      }
    }
  }

  const elapsedMs = Date.now() - startedAt;
  const toolCalls: AssembledToolCall[] = [...byIndex.values()]
    .sort((a, b) => a.index - b.index)
    .map((a) => ({ index: a.index, id: a.id, name: a.name, arguments: a.arguments }));

  /** tok/s is only meaningful with completion tokens AND elapsed time; otherwise null, never 0. */
  const tokensPerSec =
    usage && usage.completionTokens > 0 && elapsedMs > 0
      ? (usage.completionTokens / elapsedMs) * 1000
      : null;

  return { toolCalls, content, finishReason, usage, tokensPerSec, elapsedMs };
}

export const CEREBRAS_BASE_URL = 'https://api.cerebras.ai/v1';
export const CEREBRAS_MODEL = 'gemma-4-31b';

export interface CerebrasClient {
  /** Stream a completion, accumulating tool_calls by index. */
  complete(args: {
    messages: ChatCompletionMessageParam[];
    tools?: ChatCompletionTool[];
  }): Promise<AssembledResult>;
}

export interface CerebrasOptions {
  apiKey: string;
  baseURL?: string;
  model?: string;
  /**
   * Native reasoning-effort, threaded onto the OpenAI-compat `reasoning_effort` param when set. Gemma
   * is not a native reasoning model, so Cerebras may reject or ignore this for `gemma-4-31b`; left
   * unset by default so tool-calling is never disturbed. We rely on a PROMPT-level "think briefly
   * first" instruction (decide.ts) for the actual think-before-you-act behavior. Opt in via env if a
   * future model/endpoint supports it.
   */
  reasoningEffort?: ReasoningEffort;
}

/** Real Cerebras-backed client. Tests never construct this — they drive `assembleStream` directly. */
export function createCerebrasClient(opts: CerebrasOptions): CerebrasClient {
  const client = new OpenAI({ apiKey: opts.apiKey, baseURL: opts.baseURL ?? CEREBRAS_BASE_URL });
  const model = opts.model ?? CEREBRAS_MODEL;

  return {
    async complete({ messages, tools }) {
      const params: ChatCompletionCreateParamsStreaming = {
        model,
        messages,
        stream: true,
        stream_options: { include_usage: true },
        ...(opts.reasoningEffort ? { reasoning_effort: opts.reasoningEffort } : {}),
        ...(tools && tools.length > 0 ? { tools, tool_choice: 'auto' } : {}),
      };
      const stream = await client.chat.completions.create(params);
      return assembleStream(stream);
    },
  };
}
