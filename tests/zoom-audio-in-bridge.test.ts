import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, appendFile, truncate } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PcmFrame } from '@meeting-agent/protocol';
import {
  createAudioInBridge,
  splitInt16LE,
} from '../packages/server/src/adapters/zoom/audioInBridge';

/** Little-endian byte buffer for a list of int16 samples — what the bot appends to the .pcm files. */
function le(...samples: number[]): Buffer {
  const buf = Buffer.allocUnsafe(samples.length * 2);
  samples.forEach((s, i) => buf.writeInt16LE(s, i * 2));
  return buf;
}

describe('splitInt16LE (odd-byte carry)', () => {
  it('decodes whole samples and carries no byte when the chunk is even', () => {
    const { samples, carry } = splitInt16LE(Buffer.alloc(0), le(1, 2, 3));
    expect(Array.from(samples)).toEqual([1, 2, 3]);
    expect(carry.length).toBe(0);
  });

  it('carries the trailing odd byte and completes it on the next chunk', () => {
    const full = le(0x0102, 0x0304); // bytes: 02 01 04 03
    const first = full.subarray(0, 3); // 02 01 04  → one whole sample + leftover 04
    const second = full.subarray(3); // 03          → completes the second sample

    const a = splitInt16LE(Buffer.alloc(0), first);
    expect(Array.from(a.samples)).toEqual([0x0102]);
    expect(a.carry.length).toBe(1);

    const b = splitInt16LE(a.carry, second);
    expect(Array.from(b.samples)).toEqual([0x0304]);
    expect(b.carry.length).toBe(0);
  });

  it('handles a single leftover byte with an empty new chunk', () => {
    const { samples, carry } = splitInt16LE(Buffer.from([0xaa]), Buffer.alloc(0));
    expect(samples.length).toBe(0);
    expect(carry.length).toBe(1);
  });
});

describe('createAudioInBridge (file tailer)', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'zoom-bridge-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /** Collect frames the bridge emits, with a poll() helper bound to it. */
  function attach(excludeNodeId?: string) {
    const frames: PcmFrame[] = [];
    const bridge = createAudioInBridge({ outDir: dir, excludeNodeId });
    bridge.onPcm((f) => frames.push(f));
    return { bridge, frames };
  }

  it('emits samples appended since the last poll, tagged with the node id and 32 kHz', async () => {
    const { bridge, frames } = attach();
    await writeFile(join(dir, 'node-42.pcm'), le(10, 20));
    await bridge.poll();

    expect(frames).toHaveLength(1);
    expect(frames[0]!.participantId).toBe('42');
    expect(frames[0]!.sampleRate).toBe(32_000);
    expect(Array.from(frames[0]!.pcm)).toEqual([10, 20]);

    // Second poll with no growth emits nothing.
    await bridge.poll();
    expect(frames).toHaveLength(1);

    // Append more → only the delta is emitted.
    await appendFile(join(dir, 'node-42.pcm'), le(30));
    await bridge.poll();
    expect(frames).toHaveLength(2);
    expect(Array.from(frames[1]!.pcm)).toEqual([30]);
  });

  it('carries an odd trailing byte across polls (a poll landing mid-sample)', async () => {
    const { bridge, frames } = attach();
    const path = join(dir, 'node-7.pcm');
    const full = le(0x1122, 0x3344); // 22 11 44 33

    // Write 3 bytes (one whole sample + one leftover byte), poll mid-sample.
    await writeFile(path, full.subarray(0, 3));
    await bridge.poll();
    expect(Array.from(frames.flatMap((f) => Array.from(f.pcm)))).toEqual([0x1122]);

    // Write the 4th byte; the carried byte completes the second sample.
    await appendFile(path, full.subarray(3));
    await bridge.poll();
    expect(frames.flatMap((f) => Array.from(f.pcm))).toEqual([0x1122, 0x3344]);
  });

  it('resets the offset when a file is truncated (cleared between runs)', async () => {
    const { bridge, frames } = attach();
    const path = join(dir, 'node-1.pcm');
    await writeFile(path, le(1, 2, 3));
    await bridge.poll();
    expect(frames.flatMap((f) => Array.from(f.pcm))).toEqual([1, 2, 3]);

    // Truncate to empty, then write fresh content. The tailer must re-read from 0, not from the
    // stale (larger) offset — otherwise the new bytes would be skipped.
    await truncate(path, 0);
    await writeFile(path, le(9));
    await bridge.poll();
    expect(frames.flatMap((f) => Array.from(f.pcm))).toEqual([1, 2, 3, 9]);
  });

  it('picks up a new file that appears mid-run', async () => {
    const { bridge, frames } = attach();
    await writeFile(join(dir, 'node-1.pcm'), le(1));
    await bridge.poll();

    // A second speaker joins → a new file appears; the next poll starts tailing it.
    await writeFile(join(dir, 'node-2.pcm'), le(2));
    await bridge.poll();

    const byNode = Object.fromEntries(
      frames.map((f) => [f.participantId, Array.from(f.pcm)]),
    );
    expect(byNode).toEqual({ '1': [1], '2': [2] });
  });

  it('excludes the bot’s own node id', async () => {
    const { bridge, frames } = attach('99');
    await writeFile(join(dir, 'node-99.pcm'), le(1, 2, 3)); // bot's own (silent) stream
    await writeFile(join(dir, 'node-5.pcm'), le(7));
    await bridge.poll();

    expect(frames).toHaveLength(1);
    expect(frames[0]!.participantId).toBe('5');
  });

  it('ignores non-matching files and a missing outDir without throwing', async () => {
    const { bridge, frames } = attach();
    await writeFile(join(dir, 'README.txt'), 'not pcm');
    await writeFile(join(dir, 'share_text.txt'), 'overlay');
    await bridge.poll();
    expect(frames).toHaveLength(0);

    const missing = createAudioInBridge({ outDir: join(dir, 'does-not-exist') });
    await expect(missing.poll()).resolves.toBeUndefined();
  });
});
