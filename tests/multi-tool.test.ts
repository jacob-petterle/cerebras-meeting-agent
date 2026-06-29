import { describe, it, expect, vi } from 'vitest';
import { decisionsFromResult, type Decision } from '../packages/server/src/core/decide';
import type { AssembledResult, AssembledToolCall } from '../packages/server/src/core/cerebras';
import { createOrchestrator, type Scheduler } from '../packages/server/src/core/orchestrator';
import { createAppendLog } from '../packages/server/src/core/resources';
import type { TranscriptEntry } from '@meeting-agent/protocol';

/**
 * Multiple tool calls per beat (#37) — the brain may emit SEVERAL tool calls in one response (true
 * parallel fan-out, e.g. three research agents at once). decisionsFromResult takes them all (de-duped);
 * the orchestrator dispatches every action. A single call is just a one-element batch, so the common
 * case is unchanged.
 */

const result = (toolCalls: AssembledToolCall[]): AssembledResult => ({
  toolCalls,
  content: '',
  finishReason: 'tool_calls',
  usage: null,
  tokensPerSec: null,
  elapsedMs: 1,
});
const tc = (name: string, args: object, index = 0): AssembledToolCall => ({
  index,
  id: `c${index}`,
  name,
  arguments: JSON.stringify(args),
});

describe('decisionsFromResult — all tool calls, de-duped', () => {
  it('returns every valid tool call as a batch (parallel fan-out)', () => {
    const out = decisionsFromResult(
      result([
        tc('call_agent', { task: 'map the auth module' }, 0),
        tc('call_agent', { task: 'where is the db schema' }, 1),
        tc('speak', { text: 'on it' }, 2),
      ]),
    );
    expect(out).toHaveLength(3);
    expect(out.map((d) => d.name)).toEqual(['call_agent', 'call_agent', 'speak']);
  });

  it('de-dupes byte-identical calls so a repeat fires once', () => {
    const out = decisionsFromResult(
      result([tc('call_agent', { task: 'same task' }, 0), tc('call_agent', { task: 'same task' }, 1)]),
    );
    expect(out).toHaveLength(1);
  });

  it('an empty result yields a single no_op (the safe yield)', () => {
    expect(decisionsFromResult(result([]))).toEqual([{ name: 'no_op', args: {} }]);
  });

  it('off-contract calls collapse to no_op (and de-dupe together)', () => {
    const out = decisionsFromResult(
      result([tc('delete_everything', { x: 1 }, 0), tc('also_bad', { y: 2 }, 1)]),
    );
    expect(out).toEqual([{ name: 'no_op', args: {} }]);
  });
});

function fakeScheduler(): { scheduler: Scheduler; tick: () => void | Promise<void> } {
  let cb: (() => void | Promise<void>) | null = null;
  return {
    scheduler: {
      every(_ms, fn) {
        cb = fn;
        return () => {
          cb = null;
        };
      },
    },
    tick: () => cb?.(),
  };
}
const human = (text: string): TranscriptEntry => ({
  participantId: 'me',
  senderKind: 'human',
  text,
  timestamp: Date.now(),
});
/** Flush microtasks + the queued eager continue-beat. */
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe('orchestrator — dispatches a whole batch (parallel fan-out)', () => {
  it('dispatches every action in the batch, in order', async () => {
    const transcript = createAppendLog<TranscriptEntry>();
    const { scheduler, tick } = fakeScheduler();
    const batch: Decision[] = [
      { name: 'call_agent', args: { task: 'a' } },
      { name: 'call_agent', args: { task: 'b' } },
    ];
    // Fire the batch once, then yield (no_op) so the eager continue-beat doesn't re-fire the mock.
    const decide = vi.fn<() => Promise<Decision[]>>().mockResolvedValueOnce(batch).mockResolvedValue([
      { name: 'no_op', args: {} },
    ]);
    const dispatched: string[] = [];
    const dispatch = vi.fn(async (d: Decision) => {
      dispatched.push((d.args as { task: string }).task);
    });
    const orch = createOrchestrator({ transcript, decide, dispatch, scheduler });
    orch.start();
    transcript.append(human('look into a and b'));
    await tick();
    await flush();
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(dispatched).toEqual(['a', 'b']);
  });

  it('a no_op in the batch ends the turn after the actions dispatch', async () => {
    const transcript = createAppendLog<TranscriptEntry>();
    const { scheduler, tick } = fakeScheduler();
    const decide = vi.fn(async (): Promise<Decision[]> => [
      { name: 'speak', args: { text: 'hi' } },
      { name: 'no_op', args: {} },
    ]);
    const dispatch = vi.fn(async () => {});
    const orch = createOrchestrator({ transcript, decide, dispatch, scheduler });
    orch.start();
    transcript.append(human('hello'));
    await tick();
    await flush();
    expect(dispatch).toHaveBeenCalledTimes(1); // the speak dispatched
    // The turn ended (no eager beat): an idle tick with an empty delta must not re-decide.
    decide.mockClear();
    await tick();
    expect(decide).not.toHaveBeenCalled();
  });

  it('still accepts a single Decision (back-compat) and dispatches it', async () => {
    const transcript = createAppendLog<TranscriptEntry>();
    const { scheduler, tick } = fakeScheduler();
    const decide = vi.fn(async (): Promise<Decision> => ({ name: 'speak', args: { text: 'one' } }));
    const dispatch = vi.fn(async () => {});
    const orch = createOrchestrator({ transcript, decide, dispatch, scheduler });
    orch.start();
    transcript.append(human('hey'));
    await tick();
    await flush();
    expect(dispatch).toHaveBeenCalledTimes(1);
  });
});
