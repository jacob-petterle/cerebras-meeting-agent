import type {
  DeliverableRecord,
  LogEntry,
  RenderCommand,
  TranscriptEntry,
} from '@meeting-agent/protocol';
import { create } from 'zustand';
import type { ServerStats } from './validate';

/**
 * The append-log consumer, modeled on Shipyard's channel-store.ts. Two resources
 * (transcript, deliverables) instead of channel-keyed messages, but the same
 * three invariants:
 *   - entries ordered by seqNo,
 *   - dedupe by seqNo (drop anything with seqNo <= highWaterMark),
 *   - highWaterMark = max seqNo ever seen (advances even past dropped dupes, so a
 *     reconnect resubscribes from the true tail).
 *
 * Selectors stay coarse: components read whole arrays (stable references that only
 * change on a real append) and derive filtered/aggregated views with useMemo. This
 * keeps re-renders tied to actual data changes, not to selector identity.
 */

export type ConnState = 'connecting' | 'open' | 'closed';

interface Merge<T> {
  entries: LogEntry<T>[];
  hwm: number;
}

/** Single live push. Drop if already seen (seqNo <= hwm); else append + advance hwm. */
export function mergeAppend<T>(entries: LogEntry<T>[], hwm: number, entry: LogEntry<T>): Merge<T> {
  if (entry.seqNo <= hwm) return { entries, hwm };
  return { entries: [...entries, entry], hwm: entry.seqNo };
}

/** Catch-up batch. Keep seqNo > hwm, dedupe against what we hold, sort, append. */
export function mergeCatchUp<T>(entries: LogEntry<T>[], hwm: number, incoming: LogEntry<T>[]): Merge<T> {
  // Single pass: collect entries past the hwm and track the new hwm together.
  const fresh: LogEntry<T>[] = [];
  let nextHwm = hwm;
  for (const e of incoming) {
    if (e.seqNo > hwm) fresh.push(e);
    if (e.seqNo > nextHwm) nextHwm = e.seqNo;
  }
  if (fresh.length === 0) return { entries, hwm: nextHwm };

  const seen = new Set(entries.map((e) => e.seqNo));
  const deduped = fresh.filter((e) => !seen.has(e.seqNo)).sort((a, b) => a.seqNo - b.seqNo);
  if (deduped.length === 0) return { entries, hwm: nextHwm };
  return { entries: [...entries, ...deduped], hwm: nextHwm };
}

/** `fetch_older` reply -- prepend entries below the current lowest, deduped + sorted. */
export function mergeOlder<T>(entries: LogEntry<T>[], incoming: LogEntry<T>[]): LogEntry<T>[] {
  const lowest = entries[0]?.seqNo ?? Number.POSITIVE_INFINITY;
  const seen = new Set(entries.map((e) => e.seqNo));
  const add = incoming
    .filter((e) => e.seqNo < lowest && !seen.has(e.seqNo))
    .sort((a, b) => a.seqNo - b.seqNo);
  if (add.length === 0) return entries;
  return [...add, ...entries];
}

interface HarnessState {
  transcript: LogEntry<TranscriptEntry>[];
  deliverables: LogEntry<DeliverableRecord>[];
  hwm: { transcript: number; deliverables: number };

  connection: ConnState;
  connectedSince: number | null;

  render: RenderCommand | null;
  renderCount: number;
  playCount: number;
  lastPlayAt: number | null;
  stats: ServerStats | null;

  micOn: boolean;
  micLevel: number;

  setConnection: (state: ConnState) => void;

  applyTranscriptAppend: (entry: LogEntry<TranscriptEntry>) => void;
  applyTranscriptCatchUp: (entries: LogEntry<TranscriptEntry>[]) => void;
  applyTranscriptOlder: (entries: LogEntry<TranscriptEntry>[]) => void;

  applyDeliverableAppend: (entry: LogEntry<DeliverableRecord>) => void;
  applyDeliverableCatchUp: (entries: LogEntry<DeliverableRecord>[]) => void;
  applyDeliverableOlder: (entries: LogEntry<DeliverableRecord>[]) => void;

  setRender: (cmd: RenderCommand) => void;
  notePlay: () => void;
  setStats: (stats: ServerStats) => void;

  setMicOn: (on: boolean) => void;
  setMicLevel: (level: number) => void;
}

export const useHarnessStore = create<HarnessState>()((set) => ({
  transcript: [],
  deliverables: [],
  hwm: { transcript: -1, deliverables: -1 },

  connection: 'connecting',
  connectedSince: null,

  render: null,
  renderCount: 0,
  playCount: 0,
  lastPlayAt: null,
  stats: null,

  micOn: false,
  micLevel: 0,

  setConnection: (state) =>
    set((prev) => ({
      connection: state,
      connectedSince:
        state === 'open' ? (prev.connection === 'open' ? prev.connectedSince : Date.now()) : null,
    })),

  applyTranscriptAppend: (entry) =>
    set((prev) => {
      const merged = mergeAppend(prev.transcript, prev.hwm.transcript, entry);
      if (merged.entries === prev.transcript && merged.hwm === prev.hwm.transcript) return prev;
      return { transcript: merged.entries, hwm: { ...prev.hwm, transcript: merged.hwm } };
    }),

  applyTranscriptCatchUp: (entries) =>
    set((prev) => {
      const merged = mergeCatchUp(prev.transcript, prev.hwm.transcript, entries);
      if (merged.entries === prev.transcript && merged.hwm === prev.hwm.transcript) return prev;
      return { transcript: merged.entries, hwm: { ...prev.hwm, transcript: merged.hwm } };
    }),

  applyTranscriptOlder: (entries) =>
    set((prev) => {
      const next = mergeOlder(prev.transcript, entries);
      return next === prev.transcript ? prev : { transcript: next };
    }),

  applyDeliverableAppend: (entry) =>
    set((prev) => {
      const merged = mergeAppend(prev.deliverables, prev.hwm.deliverables, entry);
      if (merged.entries === prev.deliverables && merged.hwm === prev.hwm.deliverables) return prev;
      return { deliverables: merged.entries, hwm: { ...prev.hwm, deliverables: merged.hwm } };
    }),

  applyDeliverableCatchUp: (entries) =>
    set((prev) => {
      const merged = mergeCatchUp(prev.deliverables, prev.hwm.deliverables, entries);
      if (merged.entries === prev.deliverables && merged.hwm === prev.hwm.deliverables) return prev;
      return { deliverables: merged.entries, hwm: { ...prev.hwm, deliverables: merged.hwm } };
    }),

  applyDeliverableOlder: (entries) =>
    set((prev) => {
      const next = mergeOlder(prev.deliverables, entries);
      return next === prev.deliverables ? prev : { deliverables: next };
    }),

  setRender: (cmd) => set((prev) => ({ render: cmd, renderCount: prev.renderCount + 1 })),

  notePlay: () => set((prev) => ({ playCount: prev.playCount + 1, lastPlayAt: Date.now() })),

  setStats: (stats) => set({ stats }),

  setMicOn: (on) => set({ micOn: on, micLevel: 0 }),
  setMicLevel: (level) => set({ micLevel: level }),
}));
