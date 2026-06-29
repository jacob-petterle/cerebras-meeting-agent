import { describe, it, expect } from 'vitest';
import {
  createPacedSender,
  int16ToLEBytes,
} from '../packages/server/src/adapters/zoom/audioOutUplink';

/**
 * A controllable clock: `now()` returns virtual ms, `sleep(ms)` advances it and resolves on the
 * microtask queue. This lets us drive the pump deterministically and assert the release cadence
 * without real timers — the pump's only timing dependency is these injected functions.
 */
function fakeClock() {
  let t = 0;
  const sleeps: number[] = [];
  return {
    now: () => t,
    sleep: (ms: number) => {
      sleeps.push(ms);
      t += ms;
      return Promise.resolve();
    },
    /** Every delay the pump asked to sleep, in order. */
    sleeps,
  };
}

/** Drain the microtask queue so the pump's awaited sleeps settle. */
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('int16ToLEBytes', () => {
  it('encodes samples little-endian', () => {
    const buf = int16ToLEBytes(Int16Array.from([0x0102, -1]));
    expect(Array.from(buf)).toEqual([0x02, 0x01, 0xff, 0xff]);
  });
});

describe('createPacedSender', () => {
  it('splits an utterance into full ~20 ms frames plus a short tail', async () => {
    const clock = fakeClock();
    const frames: Buffer[] = [];
    const sender = createPacedSender({
      write: (f) => frames.push(f),
      now: clock.now,
      sleep: clock.sleep,
    });
    // 32 kHz, 20 ms ⇒ 640 samples/frame.
    expect(sender.frameSamples).toBe(640);

    // 1500 samples ⇒ two full 640 frames + one 220-sample tail.
    sender.enqueue(new Int16Array(1500));
    await flush();

    const sampleCounts = frames.map((b) => b.length / 2);
    expect(sampleCounts).toEqual([640, 640, 220]);
  });

  it('paces frames in real time against a monotonic schedule (no faster than ~20 ms/frame)', async () => {
    const clock = fakeClock();
    const frames: Buffer[] = [];
    const sender = createPacedSender({
      write: (f) => frames.push(f),
      now: clock.now,
      sleep: clock.sleep,
    });

    sender.enqueue(new Int16Array(640 * 3)); // exactly three full frames
    await flush();

    expect(frames).toHaveLength(3);
    // After writing each frame it schedules +20 ms and sleeps the remainder. With an instant write,
    // each requested sleep is ~20 ms (the frame's true duration).
    expect(clock.sleeps).toEqual([20, 20, 20]);
  });

  it('does not run ahead of real time when writes stall (schedule is cumulative, not wall-clock)', async () => {
    let t = 0;
    const sleeps: number[] = [];
    // Simulate a 5 ms stall on the FIRST write: advance the clock inside write before the sleep.
    let firstWrite = true;
    const sender = createPacedSender({
      write: () => {
        if (firstWrite) {
          firstWrite = false;
          t += 5; // the write itself took 5 ms
        }
      },
      now: () => t,
      sleep: (ms) => {
        sleeps.push(ms);
        t += ms;
        return Promise.resolve();
      },
    });

    sender.enqueue(new Int16Array(640 * 2));
    await flush();

    // Frame 1: scheduled=20, but 5 ms already elapsed in the write ⇒ sleep 15 (catch-up, not 20).
    // Frame 2: scheduled=40, clock now 20 ⇒ sleep 20. Total elapsed = 40 ms for 40 ms of audio.
    expect(sleeps).toEqual([15, 20]);
    expect(t).toBe(40);
  });

  it('flush() drops pending audio (barge-in) so queued frames stop being written', async () => {
    const clock = fakeClock();
    const frames: Buffer[] = [];
    const sender = createPacedSender({
      write: (f) => {
        frames.push(f);
        // Cut the agent off after the first frame, mid-utterance.
        if (frames.length === 1) sender.flush();
      },
      now: clock.now,
      sleep: clock.sleep,
    });

    sender.enqueue(new Int16Array(640 * 5)); // five frames queued
    await flush();

    // Only the first frame escaped; flush emptied the queue before the rest were released.
    expect(frames).toHaveLength(1);
  });

  it('restarts cleanly for a new utterance after the queue drains', async () => {
    const clock = fakeClock();
    const frames: Buffer[] = [];
    const sender = createPacedSender({
      write: (f) => frames.push(f),
      now: clock.now,
      sleep: clock.sleep,
    });

    sender.enqueue(new Int16Array(640));
    await flush();
    sender.enqueue(new Int16Array(640));
    await flush();

    expect(frames.map((b) => b.length / 2)).toEqual([640, 640]);
  });
});
