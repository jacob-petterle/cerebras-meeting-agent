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

export type ResourceName = 'transcript' | 'deliverables';

/** Client → server. `subscribe{sinceSeqNo}` mirrors channel-protocol.ts:287. */
export type ClientMsg =
  | { type: 'subscribe'; resource: ResourceName; sinceSeqNo: number }
  | { type: 'fetch_older'; resource: ResourceName; beforeSeqNo: number; limit: number }
  | { type: 'pcm'; participantId: string; sampleRate: number; ts: number; pcm: number[] }
  /** Clear the session: wipe the transcript + deliverables logs and reset the brain's cursor. */
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
  /** Broadcast after a `reset` so every client clears its view. */
  | { type: 'reset' };
