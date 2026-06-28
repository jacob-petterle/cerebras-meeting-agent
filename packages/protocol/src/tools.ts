import { z } from 'zod';

/**
 * The 4 tools Gemma can call. Zod schemas double as the source for the
 * OpenAI tool JSON-schema (decide.ts converts them) and for runtime arg validation
 * in the tool registry.
 */

export const SpeakArgs = z.object({ text: z.string() });
export type SpeakArgs = z.infer<typeof SpeakArgs>;

export const ShareScreenArgs = z.object({
  kind: z.enum(['html', 'mermaid', 'image', 'json', 'log', 'markdown']),
  payload: z.string(),
  title: z.string().optional(),
  deliverableId: z.string().optional(),
});
export type ShareScreenArgs = z.infer<typeof ShareScreenArgs>;

export const CallAgentArgs = z.object({ task: z.string().min(1) });
export type CallAgentArgs = z.infer<typeof CallAgentArgs>;

export const NoOpArgs = z.object({ reason: z.string().optional() });
export type NoOpArgs = z.infer<typeof NoOpArgs>;

export type ToolName = 'speak' | 'share_screen' | 'call_agent' | 'no_op';

export interface ToolCall {
  name: ToolName;
  /** Raw args from the model; validated per-tool by the registry against TOOL_ARGS. */
  args: unknown;
}

/** Per-tool arg validators, keyed by tool name. */
export const TOOL_ARGS = {
  speak: SpeakArgs,
  share_screen: ShareScreenArgs,
  call_agent: CallAgentArgs,
  no_op: NoOpArgs,
} as const;
