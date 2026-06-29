import { describe, it, expect, vi } from 'vitest';
import type { LogEntry, TranscriptEntry } from '@meeting-agent/protocol';
import { createOrchestrator } from '../packages/server/src/core/orchestrator';
import type { Scheduler } from '../packages/server/src/core/orchestrator';
import type { Decision } from '../packages/server/src/core/decide';
import { createAppendLog } from '../packages/server/src/core/resources';

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
  participantId: 'me',
  senderKind: 'human',
  text,
  timestamp: Date.now(),
});

/**
 * The correction step is step ONE of each heartbeat: it runs BEFORE the delta read, under the busy
 * lock, and whatever it appends to the transcript is what the brain decides on this same tick. A
 * correct() that throws must be caught (never wedge the loop). These guard exactly that.
 */
describe('orchestrator: correction step (heartbeat step one)', () => {
  it('runs correct() before decide, and decide sees the lines correct() just appended', async () => {
    const transcript = createAppendLog<TranscriptEntry>();
    /** Simulate the real correct closure: drain+correct+append a cleaned line each beat. */
    const correct = vi.fn(async () => {
      transcript.append(entry('corrected line'));
    });
    const decide = vi.fn(
      async (_d: LogEntry<TranscriptEntry>[]): Promise<Decision> => ({ name: 'no_op', args: {} }),
    );
    const dispatch = vi.fn(async (_d: Decision) => {});
    const { scheduler, tick } = fakeScheduler();

    const orch = createOrchestrator({ transcript, correct, decide, dispatch, scheduler });
    orch.start();
    await tick();

    expect(correct).toHaveBeenCalledTimes(1);
    expect(decide).toHaveBeenCalledTimes(1);
    // decide acted on the line correction appended THIS tick — proves correct ran first.
    expect(decide.mock.calls[0]![0].map((e) => e.data.text)).toEqual(['corrected line']);
  });

  it('a correct() that rejects is caught and does not wedge the heartbeat', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const transcript = createAppendLog<TranscriptEntry>();
      transcript.append(entry('already here')); // seqNo 0

      let calls = 0;
      const correct = vi.fn(async () => {
        calls += 1;
        if (calls === 1) throw new Error('correct boom');
      });
      const decide = vi.fn(
        async (_d: LogEntry<TranscriptEntry>[]): Promise<Decision> => ({ name: 'no_op', args: {} }),
      );
      const dispatch = vi.fn(async (_d: Decision) => {});
      const { scheduler, tick } = fakeScheduler();

      const orch = createOrchestrator({ transcript, correct, decide, dispatch, scheduler });
      orch.start();

      // Tick 1: correct throws — but the tick still decides on the existing transcript and frees busy.
      await tick();
      expect(errSpy).toHaveBeenCalledWith('[orchestrator] correct failed:', expect.any(Error));
      expect(decide).toHaveBeenCalledTimes(1);
      expect(orch.getCursor().transcript).toBe(0);

      // Tick 2: not wedged — runs again (busy was released).
      await tick();
      expect(correct).toHaveBeenCalledTimes(2);
    } finally {
      errSpy.mockRestore();
    }
  });

  it('correct() that appends nothing + empty transcript → no decide, and no wedge', async () => {
    const transcript = createAppendLog<TranscriptEntry>();
    const correct = vi.fn(async () => {});
    const decide = vi.fn(
      async (_d: LogEntry<TranscriptEntry>[]): Promise<Decision> => ({ name: 'no_op', args: {} }),
    );
    const dispatch = vi.fn(async (_d: Decision) => {});
    const { scheduler, tick } = fakeScheduler();

    const orch = createOrchestrator({ transcript, correct, decide, dispatch, scheduler });
    orch.start();
    await tick();

    expect(correct).toHaveBeenCalledTimes(1);
    expect(decide).not.toHaveBeenCalled();

    // Busy was released: a later tick with real content still decides.
    transcript.append(entry('hi'));
    await tick();
    expect(decide).toHaveBeenCalledTimes(1);
  });
});
