import { z } from 'zod';
import type { RenderCommand } from './events';

/**
 * Resource model — mirrors Shipyard's seqNo append-stream (NOT Loro).
 * seqNo == array index, exactly like jsonl-conversation-store.ts:58 ("seqNo == line index").
 * The orchestrator's heartbeat delta-read is `log.since(cursor)`.
 */

/** One entry in an append-only resource log. */
export interface LogEntry<T> {
  seqNo: number;
  ts: number;
  data: T;
}

export const SenderKind = z.enum(['human', 'agent', 'tool']);
export type SenderKind = z.infer<typeof SenderKind>;

/** Transcript entry — mirrors Shipyard Message (schema.ts:346), speaker-tagged. */
export const TranscriptEntry = z.object({
  participantId: z.string(),
  senderKind: SenderKind,
  text: z.string(),
  timestamp: z.number(),
});
export type TranscriptEntry = z.infer<typeof TranscriptEntry>;

/** Mirrors Shipyard deliverable-schemas.ts:23 DELIVERABLE_KINDS. */
export const DeliverableKind = z.enum([
  'screenshot',
  'video',
  'log',
  'markdown',
  'html',
  'json',
  'ax-tree',
  'dom-snapshot',
  'other',
]);
export type DeliverableKind = z.infer<typeof DeliverableKind>;

/** Mirrors Shipyard DeliverableRecord (deliverable-schemas.ts:45), trimmed for local use. */
export const DeliverableRecord = z.object({
  id: z.string(),
  kind: DeliverableKind,
  title: z.string().min(1),
  description: z.string().default(''),
  filePath: z.string().nullable().default(null),
  assetId: z.string().nullable().default(null),
  mimeType: z.string().nullable().default(null),
  producedAt: z.number(),
  registeredAt: z.number(),
});
export type DeliverableRecord = z.infer<typeof DeliverableRecord>;

/**
 * A live sub-agent task — the Shipyard sub-task pattern. The Cursor research sub-agent runs for tens
 * of seconds to minutes; modeling it as a RESOURCE (append-log, exactly like transcript/deliverables)
 * is what lets the 5s heartbeat keep ticking while it runs instead of blocking on the dispatch.
 *
 * Status is modeled as successive APPENDS keyed by `id` (append-only — the log never mutates a prior
 * entry): a `running` record on dispatch, fresh `running` records as progress streams in, then a
 * terminal `done`/`error`. Readers fold latest-per-id (last append wins) to get the current state.
 * `progress` carries the streamed partial output (bounded) so the brain — and the web — can SEE what
 * the sub-agent is doing each beat. `deliverableId` links the terminal record to the produced artifact.
 */
export const SubAgentTaskRecord = z.object({
  id: z.string(),
  status: z.enum(['running', 'done', 'error']),
  task: z.string(),
  startedAt: z.number(),
  endedAt: z.number().nullable().default(null),
  progress: z.array(z.string()).default([]),
  deliverableId: z.string().nullable().default(null),
  error: z.string().nullable().default(null),
});
export type SubAgentTaskRecord = z.infer<typeof SubAgentTaskRecord>;

export type ResourceName = 'transcript' | 'deliverables' | 'subAgents';

/** Client → server. `subscribe{sinceSeqNo}` mirrors channel-protocol.ts:287. */
export type ClientMsg =
  | { type: 'subscribe'; resource: ResourceName; sinceSeqNo: number }
  | { type: 'fetch_older'; resource: ResourceName; beforeSeqNo: number; limit: number }
  | { type: 'pcm'; participantId: string; sampleRate: number; ts: number; pcm: number[] }
  /** Clear the session: wipe the transcript + deliverables + subAgents logs and reset the brain's cursor. */
  | { type: 'reset' };

/** Server → client. `catch_up`/`older` mirror schema.ts:330-363; `append` is the live push. */
export type ServerMsg =
  | { type: 'catch_up'; resource: ResourceName; entries: LogEntry<unknown>[] }
  | { type: 'append'; resource: ResourceName; entry: LogEntry<unknown> }
  | { type: 'older'; resource: ResourceName; entries: LogEntry<unknown>[]; hasMore: boolean }
  | { type: 'render'; cmd: RenderCommand }
  | { type: 'play'; sampleRate: number; pcm: number[] }
  | { type: 'stats'; tokensPerSec: number | null; promptTokens: number; completionTokens: number }
  /** Every heartbeat decision (incl. no_op) for the observability console. UI-only — never the transcript. */
  | { type: 'decision'; name: string; detail: string; ts: number }
  /**
   * Live "thinking" pulse — the brain is mid-decide (a network call to Gemma). Drives the agent-state
   * visualizer's thinking animation. UI-only; the other states (listening/speaking/researching) the web
   * derives from existing signals (mic, play frames, the subAgents log).
   */
  | { type: 'agent_state'; thinking: boolean }
  /** Broadcast after a `reset` so every client clears its view. */
  | { type: 'reset' };
