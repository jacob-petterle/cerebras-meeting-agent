import type { LogEntry, SubAgentTaskRecord, TranscriptEntry } from '@meeting-agent/protocol';
import type { AppendLog } from './resources';
import type { Decision } from './decide';

/**
 * The heartbeat loop — the agent's clock.
 *
 * Injectable scheduler (never a real timer in tests). The two load-bearing rules:
 *
 *   • EVERY tool is FIRE-AND-FORGET. No tool — TTS, a screen render, or a tens-of-minutes research
 *     run — may block the heartbeat. The instant the brain picks a non-no_op action we advance the
 *     cursor, release the busy lock, and dispatch the tool DETACHED; the heartbeat keeps ticking while
 *     the tool works in the background. Holding the lock for a tool's whole run is exactly what froze
 *     the brain. Re-deciding the same span is prevented by the IMMEDIATE cursor advance, not by holding
 *     the lock.
 *   • A turn ends ONLY on no_op. Acting earns another beat: after any non-no_op action we set
 *     `pendingWake` so the next beat fires even with no new transcript — that's the "acknowledge → act →
 *     follow up" / parallel-fan-out flow. The brain keeps getting beats until IT chooses no_op to yield
 *     the floor. (A runaway guard caps consecutive actions with no human input, see MAX_TURN_ACTIONS.)
 *
 * Each tick:
 *   1. read the delta `transcript.since(cursor)`. Empty AND no pending wake → return (no decide).
 *   2. claim the span: remember `claimedHead = delta.at(-1).seqNo` BEFORE deciding.
 *   3. decide. `no_op` → advance cursor, end the turn, dispatch nothing.
 *   4. any other tool → advance cursor + release lock + dispatch DETACHED + set `pendingWake` (continue
 *      the turn). A finished/failed sub-agent later WAKES a fresh turn via the subAgents subscription,
 *      so a background result (or a timeout) always gets a reaction instead of silence-until-next-speech.
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
  /**
   * Run the brain over the transcript delta. Returns a BATCH of decisions: the model may emit several
   * tool calls in one beat (parallel fan-out). A single `Decision` is accepted too (treated as a
   * one-element batch) so callers/tests that hand back one decision keep working unchanged.
   */
  decide: (delta: LogEntry<TranscriptEntry>[]) => Promise<Decision | Decision[]>;
  dispatch: (decision: Decision) => Promise<void>;
  scheduler: Scheduler;
  /**
   * The live sub-agent-task log. Optional (tests that drive tick() manually omit it). When present,
   * the orchestrator subscribes to it and WAKES the brain when a research sub-agent reaches a terminal
   * state (done/error) — events that never touch the transcript. Without this the brain would stay
   * silent after a research finishes or TIMES OUT until the next person happens to speak. This is the
   * non-transcript wake source that makes the agent respond to its own background work.
   */
  subAgents?: AppendLog<SubAgentTaskRecord>;
  /**
   * Observe EVERY decision the brain makes, including `no_op` (which dispatches nothing). UI-only —
   * the wiring broadcasts it to the console so a heartbeat that chose silence is still visible.
   */
  onDecision?: (decision: Decision) => void;
  /**
   * The brain's "thinking" pulse: `true` right before the (network) `decide` call, `false` when it
   * resolves or errors. UI-only — the wiring broadcasts it so the agent-state visualizer can show a
   * thinking animation while the brain is mid-decide. Bounded strictly to the decide() await.
   */
  onThinkingChange?: (thinking: boolean) => void;
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
  /**
   * Run a beat NOW if idle — an event-driven trigger (e.g. fired right after a new utterance lands) so
   * the brain reacts within ~a debounce of someone finishing a sentence instead of waiting up to a full
   * interval. A no-op if a beat is already in flight (the busy lock), so it can be called freely.
   */
  poke(): void;
}

const HEARTBEAT_MS = 4000;

/**
 * Runaway guard. Acting continues the turn (only no_op ends it), and every tool is fire-and-forget,
 * so a misbehaving model that keeps acting on empty context could spin the loop and spam speech / burn
 * API tokens. We cap how many consecutive actions a turn may take WITHOUT new human input; past the cap
 * we force a no_op to yield. Normal turns are 1–4 actions (acknowledge → research → share → yield), so
 * this only ever trips on pathology. Reset to 0 whenever a human speaks (new turn) or the brain no_ops.
 */
const MAX_TURN_ACTIONS = 12;

/** The `sleep` tool's stand-down window is clamped to this range (seconds) — long enough to matter, never indefinite. */
const SLEEP_MIN_SECONDS = 2;
const SLEEP_MAX_SECONDS = 120;

export function createOrchestrator(deps: OrchestratorDeps): Orchestrator {
  const { transcript, decide, dispatch, scheduler } = deps;
  const intervalMs = deps.intervalMs ?? HEARTBEAT_MS;

  let cursor = -1;
  let busy = false;
  let unsubscribe: (() => void) | null = null;
  /** Bumped by reset(); an in-flight tick captures it and only writes the cursor if it still matches. */
  let generation = 0;
  /**
   * Continue-the-turn signal. Set after any non-no_op action (and by the subAgents terminal wake), it
   * lets a beat fire even with an empty transcript delta. Consumed (cleared) once per beat. This is the
   * "a turn ends only on no_op" mechanism AND the "react to a finished/failed research" mechanism.
   */
  let pendingWake = false;
  /** Consecutive non-no_op actions since the last human utterance / no_op — bounded by MAX_TURN_ACTIONS. */
  let turnActions = 0;
  /**
   * Idle-heartbeat mute. The `sleep` tool sets this to `Date.now() + seconds*1000`; while now < mutedUntil
   * the INTERVAL beat is suppressed — the agent deliberately stood down instead of being re-prompted every
   * beat. It is cleared early when a person speaks (poke) or a research result settles (both zero it before
   * waking), and on reset. This is the "yield WITH a duration" that sleep layers on top of no_op's single-beat yield.
   */
  let mutedUntil = 0;

  /** Fire the next beat soon, off the current call stack. The busy lock + empty-delta gate make it safe. */
  function scheduleBeat(): void {
    queueMicrotask(() => {
      void tick();
    });
  }

  async function tick(): Promise<void> {
    /** Busy lock: a decide() is in-flight — do not start a second (it would double-dispatch). */
    if (busy) return;
    busy = true;

    /**
     * Sleeping: the `sleep` tool muted the idle clock — suppress this beat. Only the INTERVAL reaches here
     * while muted; poke() and the sub-agent wake clear `mutedUntil` before waking, so a person speaking or
     * a research result still gets through. The mute only stops the agent re-pinging ITSELF on the fallback clock.
     */
    if (Date.now() < mutedUntil) {
      busy = false;
      return;
    }

    /**
     * Snapshot the generation up front: a reset() during the decide() await must NOT let this tick write
     * the cursor or act on a wiped span.
     */
    const gen = generation;

    const delta = transcript.since(cursor);
    /**
     * Wake reasons: new transcript OR a pending continue/terminal-event wake. With neither there is
     * nothing to decide — release and return (the brain stays silent; no wasted Gemma call). Consume
     * the wake here so a signal that lands while we're busy isn't lost (it re-arms pendingWake).
     */
    const woken = pendingWake;
    pendingWake = false;
    if (delta.length === 0 && !woken) {
      busy = false;
      return;
    }

    /** A human speaking starts a fresh turn — reset the runaway counter. */
    if (delta.some((e) => e.data.senderKind === 'human')) turnActions = 0;

    /** Claim the span now, before deciding, so we only ever advance past what we considered. */
    const claimedHead = delta[delta.length - 1]?.seqNo ?? cursor;

    /**
     * `decide` runs the brain (network). If it throws, the busy lock MUST still release and the cursor
     * MUST advance past the claimed span — otherwise the heartbeat wedges forever and the same delta is
     * re-decided on a loop. On a decide error we fall through to the no-op path: advance, release, return.
     */
    let decisions: Decision[];
    deps.onThinkingChange?.(true);
    try {
      const raw = await decide(delta);
      /** `decide` may return ONE decision or a BATCH (parallel tool calls in a single response). */
      decisions = Array.isArray(raw) ? raw : [raw];
    } catch (err) {
      console.error('[orchestrator] decide failed:', err);
      deps.onThinkingChange?.(false);
      if (gen === generation) cursor = claimedHead;
      busy = false;
      return;
    }
    deps.onThinkingChange?.(false);

    /** Report EVERY decision (incl. no_op) for the console. UI-only — never written to the transcript. */
    for (const d of decisions) deps.onDecision?.(d);

    /**
     * Split the batch: ACTIONS (speak/share_screen/call_agent) get dispatched; a no_op or sleep is a
     * YIELD. The model may now fire SEVERAL actions in one beat — true parallel fan-out, e.g. three
     * research agents at once. A single decision is just a one-element batch, so the common case is
     * unchanged.
     */
    const actions = decisions.filter((d) => d.name !== 'no_op' && d.name !== 'sleep');
    const sleepDecision = decisions.find((d) => d.name === 'sleep');

    /** Runaway guard: too many back-to-back actions with no human input → force a yield this beat. */
    if (actions.length > 0 && turnActions >= MAX_TURN_ACTIONS) {
      console.warn(`[orchestrator] turn action cap (${MAX_TURN_ACTIONS}) reached — forcing no_op to yield`);
      turnActions = 0;
      if (gen === generation) cursor = claimedHead;
      busy = false;
      return;
    }

    /**
     * Advance the cursor + release the lock BEFORE dispatching: every tool is FIRE-AND-FORGET, so
     * nothing here blocks the heartbeat. A reset() during decide() bumps `generation`, so the cursor
     * write is skipped (the span it pointed at was wiped). Each action is dispatched DETACHED, in order.
     */
    turnActions += actions.length;
    if (gen === generation) cursor = claimedHead;
    busy = false;
    for (const action of actions) {
      void dispatch(action).catch((err: unknown) => {
        console.error('[orchestrator] dispatch failed (detached):', err);
      });
    }

    /**
     * Turn end vs continue:
     *   • `sleep` in the batch → mute the idle heartbeat for its window and END the turn.
     *   • a `no_op` in the batch, or NO actions at all → END the turn (an explicit yield).
     *   • otherwise (≥1 action, no yield) the turn continues. A call_agent in the batch eagerly arms the
     *     next beat so the brain can keep fanning out WHILE runs work in the background; speak/share
     *     continue via their transcript write-back poke (main.ts) — no memory-less echo beat.
     */
    if (sleepDecision) {
      const requested = Number((sleepDecision.args as { seconds?: unknown }).seconds);
      const seconds = Number.isFinite(requested)
        ? Math.min(SLEEP_MAX_SECONDS, Math.max(SLEEP_MIN_SECONDS, requested))
        : SLEEP_MIN_SECONDS;
      mutedUntil = Date.now() + seconds * 1000;
      console.log(`[orchestrator] sleep ${seconds}s — idle heartbeat muted until a person speaks or research lands`);
      turnActions = 0;
      return;
    }
    if (actions.length === 0 || decisions.some((d) => d.name === 'no_op')) {
      turnActions = 0;
      return;
    }
    if (actions.some((d) => d.name === 'call_agent')) {
      pendingWake = true;
      scheduleBeat();
    }
  }

  return {
    start() {
      unsubscribe?.();
      const stops: Array<() => void> = [scheduler.every(intervalMs, tick)];
      /**
       * Wake the brain when a research sub-agent SETTLES (done/error) — events the transcript never
       * carries. `done` also surfaces a deliverable to share; `error` (incl. a timeout) is otherwise
       * invisible, so without this wake the agent would never acknowledge a research that failed. We
       * ignore `running`/progress appends (too chatty); the brain reads those ambiently when it next
       * decides for another reason.
       */
      if (deps.subAgents) {
        stops.push(
          deps.subAgents.subscribe((entry) => {
            if (entry.data.status === 'done' || entry.data.status === 'error') {
              /** A research result landing wakes the brain even if it was sleeping. */
              mutedUntil = 0;
              pendingWake = true;
              scheduleBeat();
            }
          }),
        );
      }
      unsubscribe = () => {
        for (const stop of stops) stop();
      };
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
       * Invalidate any in-flight tick (so a cursor write from a decide() that's still awaiting is
       * dropped) and rewind to the start. A queued continue/terminal wake for the wiped session is
       * meaningless, so clear it and end any turn in progress. We deliberately do NOT clear `busy`: a
       * decide() may still be awaiting, and clearing it would let the next tick run concurrently; its
       * own release path clears `busy` normally, and its cursor write is skipped by the `gen` guard.
       */
      generation += 1;
      cursor = -1;
      pendingWake = false;
      turnActions = 0;
      mutedUntil = 0;
    },
    poke() {
      /**
       * A person speaking ends any sleep — clear the mute so this beat actually runs. tick() already
       * guards on the busy lock + empty delta, so an extra call is always safe.
       */
      mutedUntil = 0;
      void tick();
    },
  };
}
