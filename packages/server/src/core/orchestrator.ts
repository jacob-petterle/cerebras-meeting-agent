import type { LogEntry, TranscriptEntry } from '@meeting-agent/protocol';
import type { AppendLog } from './resources';
import type { Decision } from './decide';

/**
 * The 4s heartbeat loop — the agent's clock.
 *
 * Injectable scheduler (never a real timer in tests). Each tick:
 *   0. correct: drain freshly-buffered raw STT and append the CORRECTED lines to the transcript (a
 *      separate Gemma call, injected as `correct`). Runs FIRST, under the busy lock, so the brain
 *      only ever decides on corrected text — raw STT never reaches the transcript.
 *   1. read the delta `transcript.since(cursor)`; empty → return (no decide).
 *   2. claim the span: remember `claimedHead = delta.at(-1).seqNo` BEFORE deciding.
 *   3. decide on the delta. `no_op` → advance cursor to claimedHead, dispatch nothing.
 *   4. for a FAST action (speak/share_screen): dispatch DETACHED and hold the busy lock so the next
 *      tick can't fire a second action while this one is in-flight (the SEV-1 double-fire, guarded by
 *      a test). When it resolves, advance the cursor to claimedHead ONLY — content that arrived during
 *      the action stays unread and is reprocessed next tick.
 *   5. for `call_agent` (the SLOW research sub-agent, tens of seconds to minutes): FIRE-AND-FORGET.
 *      Dispatch detached, but advance the cursor AND release the busy lock IMMEDIATELY — do NOT hold
 *      the lock for the whole run. This is the non-blocking fix: the heartbeat keeps ticking while the
 *      sub-agent works, so the brain keeps correcting/observing/speaking and never freezes. Re-firing
 *      the SAME research is prevented NOT by the busy lock here but by the live <sub_agents> resource
 *      (the model sees status=running) plus a hard re-fire guard in the dispatch wrapper.
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
  /**
   * Step ONE of each heartbeat, run BEFORE the transcript delta is read: drain freshly-buffered raw
   * STT segments, correct them (a separate Gemma call), and append the CORRECTED lines to the
   * transcript. This ordering is the gate — the brain only ever decides on corrected text. Awaited
   * under the busy lock (no overlapping corrections) and bounded by its own internal timeout. It owns
   * its errors; the tick guards anyway. Optional: tests and the no-key path omit it.
   */
  correct?: () => Promise<void>;
  /**
   * Observe EVERY decision the brain makes, including `no_op` (which dispatches nothing). UI-only —
   * the wiring broadcasts it to the console so a heartbeat that chose silence is still visible.
   */
  onDecision?: (decision: Decision) => void;
  /** Heartbeat period; defaults to 4s. Tests inject a manual scheduler and ignore this. */
  intervalMs?: number;
}

export interface Orchestrator {
  /** Register the heartbeat; returns a stop function (also reachable via `stop()`). */
  start(): () => void;
  stop(): void;
  getCursor(): Cursor;
  /**
   * Clear the brain's place in the transcript (cursor → -1) and invalidate any in-flight tick so its
   * completion can't advance the cursor past a span that no longer exists (the logs were just wiped).
   */
  reset(): void;
}

const HEARTBEAT_MS = 4000;

export function createOrchestrator(deps: OrchestratorDeps): Orchestrator {
  const { transcript, decide, dispatch, scheduler, correct } = deps;
  const intervalMs = deps.intervalMs ?? HEARTBEAT_MS;

  let cursor = -1;
  let busy = false;
  let unsubscribe: (() => void) | null = null;
  /** Bumped by reset(); an in-flight tick captures it and only writes the cursor if it still matches. */
  let generation = 0;

  async function tick(): Promise<void> {
    /** Busy lock: a correction or an action is in-flight — do not start another tick. */
    if (busy) return;
    busy = true;

    /**
     * Snapshot the generation up front: a reset() during the correction OR a later await must NOT let
     * this tick write the cursor or decide on a wiped span.
     */
    const gen = generation;

    /**
     * Step ONE — correction. Drain buffered raw STT, correct it, and append the CORRECTED lines to the
     * transcript so the delta read below already reflects them. `correct` owns its own errors and
     * timeout; we still guard so a throw can't wedge the loop (busy stuck true).
     */
    try {
      await correct?.();
    } catch (err) {
      console.error('[orchestrator] correct failed:', err);
    }

    /**
     * A reset() landed during correction: the transcript was wiped and the cursor rewound. Abort this
     * beat rather than decide on a span that no longer exists (mirrors the gen-guard on cursor writes).
     */
    if (gen !== generation) {
      busy = false;
      return;
    }

    const delta = transcript.since(cursor);
    if (delta.length === 0) {
      busy = false;
      return;
    }

    /** Claim the span now, before deciding, so we only ever advance past what we considered. */
    const claimedHead = delta[delta.length - 1]?.seqNo ?? cursor;

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
      if (gen === generation) cursor = claimedHead;
      busy = false;
      return;
    }

    /** Report EVERY decision (incl. no_op) for the console. UI-only — never written to the transcript. */
    deps.onDecision?.(decision);

    if (decision.name === 'no_op') {
      if (gen === generation) cursor = claimedHead;
      busy = false;
      return;
    }

    if (decision.name === 'call_agent') {
      /**
       * FIRE-AND-FORGET — the non-blocking fix. The research sub-agent runs for tens of seconds to
       * minutes; holding the busy lock for its whole run is exactly what froze the brain. Instead we
       * advance the cursor past the claimed span and RELEASE the lock NOW, so the very next tick keeps
       * the heartbeat alive while the sub-agent works in the background. The dispatch is detached and
       * owns its own errors (it appends running→done/error status to the <sub_agents> resource); we
       * only log if it rejects. Re-firing the same task is prevented by that resource + the re-fire
       * guard in the dispatch wrapper, NOT by this lock. A reset() that lands before this line bumps
       * `generation`, so the cursor write is skipped (the span it pointed at was wiped).
       */
      if (gen === generation) cursor = claimedHead;
      busy = false;
      void dispatch(decision).catch((err: unknown) => {
        console.error('[orchestrator] call_agent dispatch failed (detached):', err);
      });
      return;
    }

    /**
     * Detach the dispatch: a FAST action (speak/share_screen) is quick, but the busy lock stays held
     * until it resolves so no second action fires on the claimed span (the SEV-1 double-fire). The
     * cursor advances to claimedHead only — not to the current head — so anything that arrived
     * mid-action is reprocessed next tick. A reset() during the action bumps `generation`, so the
     * cursor write below is skipped (the span it pointed at was wiped).
     */
    void dispatch(decision)
      .then(() => {
        if (gen === generation) cursor = claimedHead;
      })
      .catch((err: unknown) => {
        /** Action failed: still advance past the claimed span so we don't re-fire it forever. */
        console.error('[orchestrator] dispatch failed:', err);
        if (gen === generation) cursor = claimedHead;
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
    reset() {
      /**
       * Invalidate any in-flight tick (so its deferred cursor write is dropped) and rewind to the
       * start. We deliberately do NOT clear `busy`: a dispatch may still be running, and clearing it
       * would let the next tick start a second action concurrently (the SEV-1 double-fire). The
       * in-flight action's `.finally` releases `busy` normally; its cursor write is skipped by `gen`.
       */
      generation += 1;
      cursor = -1;
    },
  };
}
