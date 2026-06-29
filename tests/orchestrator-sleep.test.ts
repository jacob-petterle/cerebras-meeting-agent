import { describe, it, expect, vi } from 'vitest';
import { createOrchestrator, type Scheduler } from '../packages/server/src/core/orchestrator';
import { createAppendLog } from '../packages/server/src/core/resources';
import type { Decision } from '../packages/server/src/core/decide';
import type { TranscriptEntry } from '@meeting-agent/protocol';

/**
 * The `sleep` tool's orchestrator contract (#35): like no_op it ends the turn and dispatches nothing,
 * but it ALSO mutes the idle heartbeat for its window — so the fallback interval stops re-deciding —
 * while a person speaking (poke) clears the mute and wakes a fresh beat.
 */

/** A manual scheduler: captures the interval callback so the test drives ticks itself. */
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

describe('orchestrator — sleep mutes the idle heartbeat until woken', () => {
  it('sleep ends the turn (no dispatch) and suppresses idle beats; poke() wakes it', async () => {
    const transcript = createAppendLog<TranscriptEntry>();
    const { scheduler, tick } = fakeScheduler();
    const decide = vi.fn(async (): Promise<Decision> => ({ name: 'sleep', args: { seconds: 60 } }));
    const dispatch = vi.fn(async () => {});
    const orch = createOrchestrator({ transcript, decide, dispatch, scheduler });
    orch.start();

    // A person speaks; the first beat decides → sleep. sleep dispatches nothing and mutes the clock.
    transcript.append(human('hold on, let me think'));
    await tick();
    expect(decide).toHaveBeenCalledTimes(1);
    expect(dispatch).not.toHaveBeenCalled();

    // Idle interval keeps firing while muted → the brain is NOT re-invoked (the whole point of sleep).
    await tick();
    await tick();
    expect(decide).toHaveBeenCalledTimes(1);

    // A person speaking pokes the orchestrator → the mute clears and a fresh beat runs.
    transcript.append(human('you still there?'));
    orch.poke();
    await Promise.resolve();
    expect(decide).toHaveBeenCalledTimes(2);
  });

  it('reset() clears the mute so the next beat runs immediately', async () => {
    const transcript = createAppendLog<TranscriptEntry>();
    const { scheduler, tick } = fakeScheduler();
    const decide = vi.fn(async (): Promise<Decision> => ({ name: 'sleep', args: { seconds: 60 } }));
    const orch = createOrchestrator({ transcript, decide, dispatch: vi.fn(async () => {}), scheduler });
    orch.start();

    transcript.append(human('sleeping now'));
    await tick();
    expect(decide).toHaveBeenCalledTimes(1);

    // While muted an idle tick is a no-op…
    await tick();
    expect(decide).toHaveBeenCalledTimes(1);

    // …but a reset clears the mute (and rewinds the cursor), so the next beat decides again.
    orch.reset();
    transcript.append(human('fresh session'));
    await tick();
    expect(decide).toHaveBeenCalledTimes(2);
  });
});
