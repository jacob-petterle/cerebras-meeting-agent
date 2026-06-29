import { describe, it, expect, vi } from 'vitest';
import { DeliverableRecord, SubAgentTaskRecord } from '@meeting-agent/protocol';
import type { LogEntry, SubAgentTaskRecord as SubAgentTaskRecordT, TranscriptEntry } from '@meeting-agent/protocol';
import { createOrchestrator } from '../packages/server/src/core/orchestrator';
import type { Scheduler } from '../packages/server/src/core/orchestrator';
import { foldLatestById, type Decision } from '../packages/server/src/core/decide';
import { createAppendLog } from '../packages/server/src/core/resources';
import { createRegistry } from '../packages/server/src/core/tools/registry';
import type { Ports } from '../packages/server/src/core/ports';

/** A manual scheduler: captures the heartbeat callback so the test drives ticks itself. */
function fakeScheduler() {
  let cb: (() => void | Promise<void>) | null = null;
  const scheduler: Scheduler = {
    every(_ms, fn) {
      cb = fn;
      return () => {
        cb = null;
      };
    },
  };
  return {
    scheduler,
    tick: async (): Promise<void> => {
      if (cb) await cb();
    },
  };
}

const entry = (text: string): TranscriptEntry => ({
  participantId: 'u1',
  senderKind: 'human',
  text,
  timestamp: Date.now(),
});

const flush = () => new Promise<void>((r) => setImmediate(r));

describe('orchestrator heartbeat', () => {
  it('reads transcript.since(cursor) and invokes decide with the delta', async () => {
    const transcript = createAppendLog<TranscriptEntry>();
    transcript.append(entry('hello'));
    transcript.append(entry('world'));

    const decide = vi.fn(
      async (_delta: LogEntry<TranscriptEntry>[]): Promise<Decision> => ({
        name: 'no_op',
        args: {},
      }),
    );
    const dispatch = vi.fn(async (_d: Decision) => {});
    const { scheduler, tick } = fakeScheduler();

    const orch = createOrchestrator({ transcript, decide, dispatch, scheduler });
    orch.start();
    await tick();

    expect(decide).toHaveBeenCalledTimes(1);
    expect(decide.mock.calls[0]![0].map((e) => e.data.text)).toEqual(['hello', 'world']);
  });

  it('does NOT invoke decide when there is no new transcript', async () => {
    const transcript = createAppendLog<TranscriptEntry>();
    const decide = vi.fn(async (_delta: LogEntry<TranscriptEntry>[]): Promise<Decision> => ({
      name: 'no_op',
      args: {},
    }));
    const dispatch = vi.fn(async (_d: Decision) => {});
    const { scheduler, tick } = fakeScheduler();

    const orch = createOrchestrator({ transcript, decide, dispatch, scheduler });
    orch.start();
    await tick();

    expect(decide).not.toHaveBeenCalled();
    expect(orch.getCursor().transcript).toBe(-1);
  });

  it('decide → no_op advances the cursor and dispatches NO tool', async () => {
    const transcript = createAppendLog<TranscriptEntry>();
    transcript.append(entry('a')); // seqNo 0
    transcript.append(entry('b')); // seqNo 1

    const decide = vi.fn(async (_delta: LogEntry<TranscriptEntry>[]): Promise<Decision> => ({
      name: 'no_op',
      args: { reason: 'nothing to add' },
    }));
    const dispatch = vi.fn(async (_d: Decision) => {});
    const { scheduler, tick } = fakeScheduler();

    const orch = createOrchestrator({ transcript, decide, dispatch, scheduler });
    orch.start();
    await tick();

    expect(dispatch).not.toHaveBeenCalled();
    expect(orch.getCursor().transcript).toBe(1);

    // No new content → next tick must not re-decide.
    await tick();
    expect(decide).toHaveBeenCalledTimes(1);
  });

  it('holds a busy lock: a slow FAST action in-flight blocks the next tick from firing a second action', async () => {
    // The busy-lock double-fire guard applies to FAST actions (speak/share_screen). call_agent is now
    // fire-and-forget (a separate test below), so this uses `speak` to keep the original intent intact.
    const transcript = createAppendLog<TranscriptEntry>();
    transcript.append(entry('say something')); // seqNo 0

    const decide = vi.fn(async (_delta: LogEntry<TranscriptEntry>[]): Promise<Decision> => ({
      name: 'speak',
      args: { text: 'on it' },
    }));

    // A slow dispatch we control: the speak action stays in-flight until released.
    let release!: () => void;
    const gate = new Promise<void>((res) => {
      release = res;
    });
    const dispatch = vi.fn(async (d: Decision) => {
      if (d.name === 'speak') await gate;
    });

    const { scheduler, tick } = fakeScheduler();
    const orch = createOrchestrator({ transcript, decide, dispatch, scheduler });
    orch.start();

    // Tick 1: starts speak; dispatch is pending on the gate.
    await tick();
    expect(decide).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledTimes(1);

    // More transcript arrives while the action is in-flight.
    transcript.append(entry('and also Y')); // seqNo 1

    // Tick 2: busy lock holds — no second decide, no second dispatch.
    await tick();
    expect(decide).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledTimes(1);

    // Release the in-flight action: lock frees and the cursor advances ONLY past the claimed span.
    release();
    await flush();
    expect(orch.getCursor().transcript).toBe(0);

    // Tick 3: the content that arrived during the action is now processed fresh.
    await tick();
    expect(decide).toHaveBeenCalledTimes(2);
    expect(decide.mock.calls[1]![0].map((e) => e.data.text)).toEqual(['and also Y']);
  });

  it('a call_agent decision is FIRE-AND-FORGET: it does NOT block the next tick (the brain keeps ticking)', async () => {
    // The non-blocking fix (#16). A slow research sub-agent must not hold the busy lock for its whole
    // run. The orchestrator advances the cursor + releases busy the instant it dispatches call_agent,
    // so the very next tick decides again WHILE the sub-agent is still "in flight".
    const transcript = createAppendLog<TranscriptEntry>();
    transcript.append(entry('please research X')); // seqNo 0

    let calls = 0;
    const decide = vi.fn(async (_delta: LogEntry<TranscriptEntry>[]): Promise<Decision> => {
      calls += 1;
      // First beat dispatches research; afterwards the brain stays silent.
      return calls === 1
        ? { name: 'call_agent', args: { task: 'research X' } }
        : { name: 'no_op', args: {} };
    });

    // The research run never resolves within the test — it stays "in flight" the whole time.
    const dispatch = vi.fn((d: Decision) => (d.name === 'call_agent' ? new Promise<void>(() => {}) : Promise.resolve()));

    const { scheduler, tick } = fakeScheduler();
    const orch = createOrchestrator({ transcript, decide, dispatch, scheduler });
    orch.start();

    // Tick 1: dispatches call_agent (detached, never resolves). Cursor advances + busy released NOW.
    await tick();
    await flush();
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(orch.getCursor().transcript).toBe(0);

    // New content arrives while the sub-agent is still running.
    transcript.append(entry('meanwhile, another point')); // seqNo 1

    // Tick 2: the brain DECIDES AGAIN even though the sub-agent run is still in flight — not blocked.
    await tick();
    await flush();
    expect(decide).toHaveBeenCalledTimes(2);
    expect(decide.mock.calls[1]![0].map((e) => e.data.text)).toEqual(['meanwhile, another point']);
    expect(orch.getCursor().transcript).toBe(1);
  });

  it('a decide() that rejects releases the busy lock and the next tick runs again (no wedge)', async () => {
    // Regression: if `decide` throws, `busy` must STILL be released and the cursor must advance,
    // or the heartbeat wedges forever (busy stuck true → every future tick early-returns) and the
    // same delta is re-decided on a loop. We make the first decide reject, the second succeed.
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const transcript = createAppendLog<TranscriptEntry>();
      transcript.append(entry('first')); // seqNo 0

      let calls = 0;
      const decide = vi.fn(async (_delta: LogEntry<TranscriptEntry>[]): Promise<Decision> => {
        calls += 1;
        if (calls === 1) throw new Error('brain exploded');
        return { name: 'no_op', args: {} };
      });
      const dispatch = vi.fn(async (_d: Decision) => {});
      const { scheduler, tick } = fakeScheduler();

      const orch = createOrchestrator({ transcript, decide, dispatch, scheduler });
      orch.start();

      // Tick 1: decide rejects. Busy must release; cursor advances past the claimed span.
      await tick();
      await flush();
      expect(decide).toHaveBeenCalledTimes(1);
      expect(orch.getCursor().transcript).toBe(0);

      // New content arrives, proving the next tick is NOT wedged.
      transcript.append(entry('second')); // seqNo 1

      // Tick 2: runs again (busy was released) and now sees only the new line.
      await tick();
      expect(decide).toHaveBeenCalledTimes(2);
      expect(decide.mock.calls[1]![0].map((e) => e.data.text)).toEqual(['second']);
      expect(orch.getCursor().transcript).toBe(1);
    } finally {
      errSpy.mockRestore();
    }
  });

  it('a dispatch that rejects logs + advances the cursor + releases busy (no re-fire loop)', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const transcript = createAppendLog<TranscriptEntry>();
      transcript.append(entry('do the thing')); // seqNo 0

      const decide = vi.fn(async (_delta: LogEntry<TranscriptEntry>[]): Promise<Decision> => ({
        name: 'speak',
        args: { text: 'on it' },
      }));
      let dispatches = 0;
      const dispatch = vi.fn(async (_d: Decision) => {
        dispatches += 1;
        throw new Error('dispatch boom');
      });
      const { scheduler, tick } = fakeScheduler();

      const orch = createOrchestrator({ transcript, decide, dispatch, scheduler });
      orch.start();

      await tick();
      await flush();

      // Logged with the exact prefix the QA spec requires.
      expect(errSpy).toHaveBeenCalledWith('[orchestrator] dispatch failed:', expect.any(Error));
      // Cursor advanced past the claimed span so we don't re-fire forever, and busy is released.
      expect(orch.getCursor().transcript).toBe(0);
      expect(dispatches).toBe(1);

      // No new content → next tick must not re-dispatch the same (already-claimed) span.
      await tick();
      expect(decide).toHaveBeenCalledTimes(1);
      expect(dispatches).toBe(1);
    } finally {
      errSpy.mockRestore();
    }
  });

  it('stop() halts the heartbeat', async () => {
    const transcript = createAppendLog<TranscriptEntry>();
    transcript.append(entry('hi'));
    const decide = vi.fn(async (_delta: LogEntry<TranscriptEntry>[]): Promise<Decision> => ({
      name: 'no_op',
      args: {},
    }));
    const dispatch = vi.fn(async (_d: Decision) => {});
    const { scheduler, tick } = fakeScheduler();

    const orch = createOrchestrator({ transcript, decide, dispatch, scheduler });
    const stop = orch.start();
    stop();
    await tick();
    expect(decide).not.toHaveBeenCalled();
  });
});

/**
 * The transcript write-back wiring main.ts installs: dispatch the action, then append the registry's
 * TurnOutcome to the transcript so the model gains memory + the web console lights up. This proves
 * the loop self-terminates (no runaway): the model speaks once, sees its own line next tick, no_ops.
 */
describe('orchestrator + transcript write-back (the main.ts dispatch wrapper)', () => {
  it('appends the agent turn to the transcript, then no_ops on its own line (no runaway)', async () => {
    const transcript = createAppendLog<TranscriptEntry>();
    transcript.append(entry('what is 2+2?')); // seqNo 0, human

    const played: Array<{ pcm: Int16Array; sampleRate: number }> = [];
    const ports: Ports = {
      audioIn: { onPcm: () => () => {} },
      audioOut: { play: async (pcm, sampleRate) => void played.push({ pcm, sampleRate }) },
      display: { render: async () => {} },
    };
    const registry = createRegistry({
      ports,
      tts: async () => ({ pcm: Int16Array.from([1]), sampleRate: 24000 }),
      callAgent: async () =>
        DeliverableRecord.parse({ id: 'x', kind: 'html', title: 't', producedAt: 1, registeredAt: 2 }),
    });

    // Speak once on the human's question, then no_op forever after (mirrors a sane model).
    let spoke = false;
    const decide = vi.fn(async (_delta: LogEntry<TranscriptEntry>[]): Promise<Decision> => {
      if (!spoke) {
        spoke = true;
        return { name: 'speak', args: { text: 'four' } };
      }
      return { name: 'no_op', args: {} };
    });

    // The EXACT wrapper main.ts wires: run the tool, append its outcome to the transcript.
    const dispatch = async (decision: Decision): Promise<void> => {
      const outcome = await registry.dispatch(decision);
      if (!outcome) return;
      transcript.append({
        participantId: outcome.senderKind === 'agent' ? 'agent' : decision.name,
        senderKind: outcome.senderKind,
        text: outcome.text,
        timestamp: Date.now(),
      });
    };

    const { scheduler, tick } = fakeScheduler();
    const orch = createOrchestrator({ transcript, decide, dispatch, scheduler });
    orch.start();

    // Tick 1: speak → TTS played → the agent's line is appended to the transcript.
    await tick();
    await flush();
    expect(played).toHaveLength(1);
    const afterSpeak = transcript.snapshot();
    expect(afterSpeak).toHaveLength(2);
    expect(afterSpeak[1]!.data).toMatchObject({
      participantId: 'agent',
      senderKind: 'agent',
      text: 'four',
    });

    // Tick 2: the model now sees its OWN prior turn in the delta and no_ops — the loop self-terminates.
    await tick();
    await flush();
    expect(decide).toHaveBeenCalledTimes(2);
    // The second decide saw exactly the agent's self-authored line (memory of its prior turn).
    expect(decide.mock.calls[1]![0].map((e) => e.data.text)).toEqual(['four']);
    // No further append (no_op writes nothing back) → no runaway growth.
    expect(transcript.snapshot()).toHaveLength(2);
  });
});

/**
 * The decision feed + reset (tasks #13/#14). onDecision must fire for EVERY decision, including
 * no_op (which dispatches nothing and is otherwise invisible). reset() must rewind the cursor and
 * invalidate any in-flight tick so its deferred cursor write can't resurrect a wiped span.
 */
describe('orchestrator: decision feed + reset', () => {
  it('onDecision fires for every decision, including no_op (which dispatches nothing)', async () => {
    const transcript = createAppendLog<TranscriptEntry>();
    transcript.append(entry('hi')); // seqNo 0
    const seen: Decision[] = [];
    const decide = vi.fn(async (_d: LogEntry<TranscriptEntry>[]): Promise<Decision> => ({
      name: 'no_op',
      args: {},
    }));
    const dispatch = vi.fn(async (_d: Decision) => {});
    const { scheduler, tick } = fakeScheduler();

    const orch = createOrchestrator({
      transcript,
      decide,
      dispatch,
      scheduler,
      onDecision: (d) => seen.push(d),
    });
    orch.start();
    await tick();

    expect(dispatch).not.toHaveBeenCalled(); // no_op acts on nothing…
    expect(seen).toEqual([{ name: 'no_op', args: {} }]); // …but is still reported to the feed.
  });

  it('reset() rewinds the cursor to -1 and a guarded in-flight dispatch cannot clobber it', async () => {
    // Uses a FAST action (speak) parked on a gate: the cursor only advances when the dispatch resolves,
    // so the reset's generation-guard has a window to invalidate the deferred cursor write. (call_agent
    // is fire-and-forget and advances the cursor synchronously, so it can't exercise this race.)
    const transcript = createAppendLog<TranscriptEntry>();
    transcript.append(entry('say X')); // seqNo 0 → claimedHead 0

    let release!: () => void;
    const gate = new Promise<void>((res) => {
      release = res;
    });
    const decide = vi.fn(async (_d: LogEntry<TranscriptEntry>[]): Promise<Decision> => ({
      name: 'speak',
      args: { text: 'X' },
    }));
    const dispatch = vi.fn(async (d: Decision) => {
      if (d.name === 'speak') await gate;
    });
    const { scheduler, tick } = fakeScheduler();
    const orch = createOrchestrator({ transcript, decide, dispatch, scheduler });
    orch.start();

    // Tick 1: starts speak; it parks on the gate, so the cursor has NOT advanced yet.
    await tick();
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(orch.getCursor().transcript).toBe(-1);

    // Reset while the action is in-flight: cursor → -1 and the generation is bumped.
    orch.reset();
    expect(orch.getCursor().transcript).toBe(-1);

    // The in-flight dispatch resolves. WITHOUT the guard it would advance the cursor to claimedHead
    // (0); the reset's generation bump must make that deferred write a no-op, leaving the cursor at -1.
    release();
    await flush();
    expect(orch.getCursor().transcript).toBe(-1);
  });
});

/**
 * The re-fire hard guard (#16, belt-and-suspenders) main.ts installs in its dispatch wrapper: before
 * dispatching a call_agent, fold the subAgents log latest-by-id and SKIP if an open running task's
 * normalized name matches. This stops a model that ignores the <sub_agents> prompt from spawning a
 * duplicate Cursor run. We reproduce the exact wrapper logic here (mirroring the write-back-wrapper
 * test above), driving real dispatches through it.
 */
describe('re-fire hard guard (no duplicate call_agent for a task already running)', () => {
  /** Same normalization as main.ts: trim, lowercase, collapse internal whitespace. */
  const normalizeTask = (task: string): string => task.trim().toLowerCase().replace(/\s+/g, ' ');

  const argTask = (args: unknown): string =>
    typeof args === 'object' && args !== null && 'task' in args && typeof args.task === 'string'
      ? args.task
      : '';

  const sub = (over: Partial<SubAgentTaskRecordT>): SubAgentTaskRecordT =>
    SubAgentTaskRecord.parse({ id: 'a1', status: 'running', task: 'research X', startedAt: 1, ...over });

  it('skips a call_agent whose task is already listed as running (normalized match)', async () => {
    const subAgents = createAppendLog<SubAgentTaskRecordT>();
    // A run for "research X" is already in flight (status=running).
    subAgents.append(sub({ id: 'a1', status: 'running', task: 'research X' }));

    const callAgent = vi.fn(async () =>
      DeliverableRecord.parse({ id: 'd', kind: 'html', title: 't', producedAt: 1, registeredAt: 2 }),
    );

    // The exact guarded dispatch wrapper main.ts wires.
    const dispatch = async (decision: Decision): Promise<void> => {
      if (decision.name === 'call_agent') {
        const requested = normalizeTask(argTask(decision.args));
        const alreadyRunning =
          requested.length > 0 &&
          foldLatestById(subAgents.snapshot().map((e) => e.data)).some(
            (t) => t.status === 'running' && normalizeTask(t.task) === requested,
          );
        if (alreadyRunning) return; // SKIP — already in flight.
      }
      await callAgent();
    };

    // A model that re-requests the SAME task, only differing in casing/spacing, must be skipped.
    await dispatch({ name: 'call_agent', args: { task: '  Research   X ' } });
    expect(callAgent).not.toHaveBeenCalled();
  });

  it('still dispatches a NEW task, and re-dispatches once the prior run has finished', async () => {
    const subAgents = createAppendLog<SubAgentTaskRecordT>();
    subAgents.append(sub({ id: 'a1', status: 'running', task: 'research X' }));

    const dispatched: string[] = [];
    const dispatch = async (decision: Decision): Promise<void> => {
      if (decision.name === 'call_agent') {
        const requested = normalizeTask(argTask(decision.args));
        const alreadyRunning =
          requested.length > 0 &&
          foldLatestById(subAgents.snapshot().map((e) => e.data)).some(
            (t) => t.status === 'running' && normalizeTask(t.task) === requested,
          );
        if (alreadyRunning) return;
        dispatched.push(requested);
      }
    };

    // A different task is NOT blocked.
    await dispatch({ name: 'call_agent', args: { task: 'research Y' } });
    expect(dispatched).toEqual(['research y']);

    // The prior run completes (a terminal `done` append for the same id) → folded status is no longer
    // running, so re-dispatching "research X" is now allowed.
    subAgents.append(sub({ id: 'a1', status: 'done', task: 'research X', deliverableId: 'd1', endedAt: 9 }));
    await dispatch({ name: 'call_agent', args: { task: 'research X' } });
    expect(dispatched).toEqual(['research y', 'research x']);
  });
});
