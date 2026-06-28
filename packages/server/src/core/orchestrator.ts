import type { LogEntry, TranscriptEntry } from '@meeting-agent/protocol';
import type { AppendLog } from './resources';
import type { Decision } from './decide';

/**
 * The 5s heartbeat loop — the agent's clock.
 *
 * Injectable scheduler (never a real timer in tests). Each tick:
 *   1. read the delta `transcript.since(cursor)`; empty → return (no decide).
 *   2. claim the span: remember `claimedHead = delta.at(-1).seqNo` BEFORE deciding.
 *   3. decide on the delta. `no_op` → advance cursor to claimedHead, dispatch nothing.
 *   4. otherwise dispatch the action DETACHED and hold a busy lock so the next tick can't fire a
 *      second action while this one is in-flight (the SEV-1 double-fire, guarded by a test).
 *   5. when the in-flight action resolves, advance the cursor to claimedHead ONLY — content that
 *      arrived during the action stays unread and is processed fresh on the next tick.
 */

/** The injectable clock. `every` registers a periodic callback and returns an unsubscribe. */
export interface Scheduler {
  every(ms: number, fn: () => void | Promise<void>): () => void;
}

/** A real setInterval-backed scheduler for production wiring. */
export function intervalScheduler(): Scheduler {
  return {
    every(ms, fn) {
      const handle = setInterval(() => {
        void fn();
      }, ms);
      /** Don't keep the process alive solely for the heartbeat. */
      if (typeof handle.unref === 'function') handle.unref();
      return () => clearInterval(handle);
    },
  };
}

export interface Cursor {
  transcript: number;
}

export interface OrchestratorDeps {
  transcript: AppendLog<TranscriptEntry>;
  decide: (delta: LogEntry<TranscriptEntry>[]) => Promise<Decision>;
  dispatch: (decision: Decision) => Promise<void>;
  scheduler: Scheduler;
  /** Heartbeat period; defaults to 5s. Tests inject a manual scheduler and ignore this. */
  intervalMs?: number;
}

export interface Orchestrator {
  /** Register the heartbeat; returns a stop function (also reachable via `stop()`). */
  start(): () => void;
  stop(): void;
  getCursor(): Cursor;
}

const HEARTBEAT_MS = 5000;

export function createOrchestrator(deps: OrchestratorDeps): Orchestrator {
  const { transcript, decide, dispatch, scheduler } = deps;
  const intervalMs = deps.intervalMs ?? HEARTBEAT_MS;

  let cursor = -1;
  let busy = false;
  let unsubscribe: (() => void) | null = null;

  async function tick(): Promise<void> {
    /** Busy lock: an action is in-flight — do not start another. */
    if (busy) return;

    const delta = transcript.since(cursor);
    if (delta.length === 0) return;

    /** Claim the span now, before deciding, so we only ever advance past what we considered. */
    const claimedHead = delta[delta.length - 1]?.seqNo ?? cursor;

    busy = true;

    /**
     * `decide` runs the brain (network). If it throws, the busy lock MUST still release and the
     * cursor MUST advance past the claimed span — otherwise the heartbeat wedges forever (no
     * tick ever clears `busy`) and the same delta is re-decided on a loop. On a decide error we
     * fall through to the no-op path: advance, release, return.
     */
    let decision: Decision;
    try {
      decision = await decide(delta);
    } catch (err) {
      console.error('[orchestrator] decide failed:', err);
      cursor = claimedHead;
      busy = false;
      return;
    }

    if (decision.name === 'no_op') {
      cursor = claimedHead;
      busy = false;
      return;
    }

    /**
     * Detach the dispatch: a slow action (e.g. call_agent) must not block the heartbeat, but the
     * busy lock stays held until it resolves so no second action fires on the claimed span. The
     * cursor advances to claimedHead only — not to the current head — so anything that arrived
     * mid-action is reprocessed next tick.
     */
    void dispatch(decision)
      .then(() => {
        cursor = claimedHead;
      })
      .catch((err: unknown) => {
        /** Action failed: still advance past the claimed span so we don't re-fire it forever. */
        console.error('[orchestrator] dispatch failed:', err);
        cursor = claimedHead;
      })
      .finally(() => {
        busy = false;
      });
  }

  return {
    start() {
      unsubscribe?.();
      unsubscribe = scheduler.every(intervalMs, tick);
      return () => {
        unsubscribe?.();
        unsubscribe = null;
      };
    },
    stop() {
      unsubscribe?.();
      unsubscribe = null;
    },
    getCursor() {
      return { transcript: cursor };
    },
  };
}
