import type { DeliverableRecord, LogEntry, TranscriptEntry } from '@meeting-agent/protocol';

/**
 * Own seqNo append-log — mirrors Shipyard's jsonl-conversation-store (seqNo == array index),
 * deliberately NOT Loro. Single-writer, append-only, in-memory.
 *
 * Two read shapes the heartbeat + WS layer need:
 *   - `since(cursor)` — the heartbeat delta-read (entries with seqNo > cursor).
 *   - `subscribe(cb)` — live push of each NEW append (the WS layer materialises catch_up
 *     separately via `since(sinceSeqNo)`, so subscribers receive only entries appended
 *     after they subscribed — no replay, no duplication).
 */
export interface AppendLog<T> {
  /** Append one datum; returns its seqNo (== prior length: 0, 1, 2 …). */
  append(data: T): number;
  /** Highest seqNo, or -1 when empty. */
  head(): number;
  /** Entries strictly after `cursor` (seqNo > cursor). The heartbeat delta-read. */
  since(cursor: number): LogEntry<T>[];
  /** Defensive copy of every entry. */
  snapshot(): LogEntry<T>[];
  /** Subscribe to live appends. The callback fires once per future append. Returns an unsubscribe. */
  subscribe(cb: (entry: LogEntry<T>) => void): () => void;
  /** Clear all entries (seqNo restarts at 0 on the next append). Subscribers stay subscribed. */
  reset(): void;
}

export function createAppendLog<T>(): AppendLog<T> {
  const entries: LogEntry<T>[] = [];
  const subscribers = new Set<(entry: LogEntry<T>) => void>();

  return {
    append(data: T): number {
      const seqNo = entries.length;
      const entry: LogEntry<T> = { seqNo, ts: Date.now(), data };
      entries.push(entry);
      /** Snapshot subscribers so an unsubscribe inside a callback can't mutate-during-iterate. */
      for (const cb of [...subscribers]) cb(entry);
      return seqNo;
    },

    head(): number {
      return entries.length - 1;
    },

    since(cursor: number): LogEntry<T>[] {
      if (cursor < -1) return entries.slice();
      /** entries[i].seqNo === i, so the first wanted index is cursor + 1. */
      return entries.slice(cursor + 1);
    },

    snapshot(): LogEntry<T>[] {
      return entries.slice();
    },

    subscribe(cb: (entry: LogEntry<T>) => void): () => void {
      subscribers.add(cb);
      return () => {
        subscribers.delete(cb);
      };
    },

    reset(): void {
      /** Truncate in place; the next append is seqNo 0 again. Clients are told to reset their hwm. */
      entries.length = 0;
    },
  };
}

export interface Resources {
  transcript: AppendLog<TranscriptEntry>;
  deliverables: AppendLog<DeliverableRecord>;
}

/** The shared resource spine: one transcript log + one deliverables log. */
export function createResources(): Resources {
  return {
    transcript: createAppendLog<TranscriptEntry>(),
    deliverables: createAppendLog<DeliverableRecord>(),
  };
}
