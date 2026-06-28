import {
  DeliverableRecord,
  type LogEntry,
  type RenderCommand,
  type RenderKind,
  type ResourceName,
  TranscriptEntry,
} from '@meeting-agent/protocol';
import { z } from 'zod';
import { isRecord } from './lib/is-record';

/**
 * Boundary validation for everything arriving over the WS. The protocol exports
 * Zod schemas for the resource payloads (TranscriptEntry, DeliverableRecord);
 * we reuse them and add local schemas for the wire envelope. Per the project's
 * "Zod at boundaries" rule, nothing here uses a type assertion -- a frame that
 * fails validation is dropped (returns null), never coerced.
 */

/**
 * Server-reported inference stats. NOT part of the locked
 * @meeting-agent/protocol ServerMsg union -- this is the one extra frame the
 * server emits so the HUD shows real tok/s instead of the transcript-derived
 * estimate. Flat shape (no nested `stats` object): the server sends
 * `{ type: 'stats', tokensPerSec, promptTokens, completionTokens }`.
 * `tokensPerSec` is null until the first completion produces a measurable rate.
 */
export interface ServerStats {
  tokensPerSec: number | null;
  promptTokens: number;
  completionTokens: number;
}

const RENDER_KINDS = ['html', 'mermaid', 'image', 'json', 'log', 'markdown'] as const;
/** Type-level guarantee the local tuple stays in lockstep with the protocol union. */
const _kindParity: readonly RenderKind[] = RENDER_KINDS;
void _kindParity;

const zRenderCommand = z.object({
  kind: z.enum(RENDER_KINDS),
  payload: z.string(),
  title: z.string().optional(),
  deliverableId: z.string().optional(),
});

const logEntry = <S extends z.ZodTypeAny>(data: S) =>
  z.object({ seqNo: z.number(), ts: z.number(), data });

const zTranscriptEntry = logEntry(TranscriptEntry);
const zDeliverableEntry = logEntry(DeliverableRecord);
const zTranscriptEntries = z.array(zTranscriptEntry);
const zDeliverableEntries = z.array(zDeliverableEntry);
const zPlay = z.object({ sampleRate: z.number().positive(), pcm: z.array(z.number()) });
/** Flat `stats` frame shape emitted by the server -- see ServerStats above. */
const zStats = z.object({
  tokensPerSec: z.number().nullable(),
  promptTokens: z.number(),
  completionTokens: z.number(),
});

/** A validated, typed inbound frame. Closed union -- ws.ts handles it exhaustively. */
export type Incoming =
  | { type: 'catch_up'; resource: 'transcript'; entries: LogEntry<TranscriptEntry>[] }
  | { type: 'catch_up'; resource: 'deliverables'; entries: LogEntry<DeliverableRecord>[] }
  | { type: 'append'; resource: 'transcript'; entry: LogEntry<TranscriptEntry> }
  | { type: 'append'; resource: 'deliverables'; entry: LogEntry<DeliverableRecord> }
  | { type: 'older'; resource: 'transcript'; entries: LogEntry<TranscriptEntry>[]; hasMore: boolean }
  | {
      type: 'older';
      resource: 'deliverables';
      entries: LogEntry<DeliverableRecord>[];
      hasMore: boolean;
    }
  | { type: 'render'; cmd: RenderCommand }
  | { type: 'play'; sampleRate: number; pcm: number[] }
  | { type: 'stats'; stats: ServerStats };

function parseResource(value: unknown): ResourceName | null {
  return value === 'transcript' || value === 'deliverables' ? value : null;
}

function parseBatch(
  type: 'catch_up' | 'older',
  json: Record<string, unknown>,
): Incoming | null {
  const resource = parseResource(json.resource);
  if (!resource) return null;
  const hasMore = json.hasMore === true;

  if (resource === 'transcript') {
    const r = zTranscriptEntries.safeParse(json.entries);
    if (!r.success) return null;
    return type === 'older'
      ? { type: 'older', resource, entries: r.data, hasMore }
      : { type: 'catch_up', resource, entries: r.data };
  }
  const r = zDeliverableEntries.safeParse(json.entries);
  if (!r.success) return null;
  return type === 'older'
    ? { type: 'older', resource, entries: r.data, hasMore }
    : { type: 'catch_up', resource, entries: r.data };
}

function parseAppend(json: Record<string, unknown>): Incoming | null {
  const resource = parseResource(json.resource);
  if (!resource) return null;
  if (resource === 'transcript') {
    const r = zTranscriptEntry.safeParse(json.entry);
    return r.success ? { type: 'append', resource, entry: r.data } : null;
  }
  const r = zDeliverableEntry.safeParse(json.entry);
  return r.success ? { type: 'append', resource, entry: r.data } : null;
}

/** Parse + validate a raw WS message. Returns null for anything unrecognized. */
export function parseServerMessage(raw: unknown): Incoming | null {
  if (typeof raw !== 'string') return null;
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(json) || typeof json.type !== 'string') return null;

  switch (json.type) {
    case 'catch_up':
      return parseBatch('catch_up', json);
    case 'older':
      return parseBatch('older', json);
    case 'append':
      return parseAppend(json);
    case 'render': {
      const r = zRenderCommand.safeParse(json.cmd);
      return r.success ? { type: 'render', cmd: r.data } : null;
    }
    case 'play': {
      const r = zPlay.safeParse(json);
      return r.success ? { type: 'play', sampleRate: r.data.sampleRate, pcm: r.data.pcm } : null;
    }
    case 'stats': {
      const r = zStats.safeParse(json);
      return r.success ? { type: 'stats', stats: r.data } : null;
    }
    default:
      return null;
  }
}
