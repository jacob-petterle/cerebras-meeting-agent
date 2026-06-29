import { readdir, open, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { PcmFrame } from '@meeting-agent/protocol';
import type { AudioInPort } from '../../core/ports';

/**
 * Zoom AudioIn adapter — a poll-based tailer over the bot's per-speaker PCM dumps.
 *
 * The bot (a native container) appends raw 32 kHz mono s16le PCM to `${outDir}/node-<userid>.pcm`,
 * one file per speaker. We tail those files and emit a `PcmFrame` per chunk to the same media
 * pipeline the local mic adapter feeds (VAD → STT). This is the entire "attach Zoom" change on the
 * input side; downstream is identical.
 *
 * Why polling, not fs.watch: the files live on a bind-mounted Docker VirtioFS share, where inotify
 * events are unreliable / not delivered to the host. So we re-stat + seek every `pollMs`, tracking a
 * per-file byte offset. Three things the naive version gets wrong, handled here:
 *   - **Odd trailing byte:** a poll can land mid-sample (the bot wrote an odd number of new bytes).
 *     We only decode whole 16-bit samples and carry the leftover byte to the next poll.
 *   - **Truncation:** if a file shrinks (cleared between runs while we're attached), reset its offset.
 *   - **New files mid-run:** Zoom assigns user-ids as speakers join, so files appear over time — we
 *     re-glob each poll and start tailing newcomers.
 *
 * The bot's OWN user-id stream is silent but still written (and grows large); `excludeNodeId` skips
 * it to avoid self-transcription. We do NOT resample here — downstream VAD/STT own that.
 */

const DEFAULT_POLL_MS = 250;
const BOT_SAMPLE_RATE = 32_000;
const FILE_RE = /^node-(.+)\.pcm$/;

/** Per-file tail cursor: how far we've consumed, plus any leftover odd byte to prepend next read. */
interface FileCursor {
  offset: number;
  /** 0 or 1 trailing byte from the previous read that didn't complete a 16-bit sample. */
  carry: Buffer;
}

export interface AudioInBridgeOptions {
  /** Directory the bot writes `node-<userid>.pcm` files into (the bind-mounted `out/`). */
  outDir: string;
  /** The bot's own user-id — its stream is silent; exclude it to avoid self-transcription. */
  excludeNodeId?: string;
  /** Poll interval (re-stat + seek). Default 250 ms. */
  pollMs?: number;
  /** Source sample rate the bot writes. Default 32 kHz (the fixed bot contract). */
  sampleRate?: number;
}

export interface AudioInBridge extends AudioInPort {
  /** Begin the poll loop. Idempotent. */
  start(): void;
  /** Stop the poll loop (for graceful shutdown / tests). */
  stop(): void;
  /** Run one tail pass now and await it. Exposed for deterministic tests. */
  poll(): Promise<void>;
}

/**
 * Split a byte buffer into whole little-endian int16 samples, carrying any trailing odd byte.
 * Pure and allocation-light — the core of the odd-byte invariant, unit-tested directly.
 */
export function splitInt16LE(carry: Buffer, chunk: Buffer): { samples: Int16Array; carry: Buffer } {
  const combined = carry.length === 0 ? chunk : Buffer.concat([carry, chunk]);
  const sampleCount = combined.length >> 1; // floor(len / 2)
  const usableBytes = sampleCount << 1;
  const samples = new Int16Array(sampleCount);
  for (let i = 0; i < sampleCount; i++) {
    samples[i] = combined.readInt16LE(i << 1);
  }
  // Keep the trailing byte (if any) to prepend to the next chunk. Copy so we don't pin `combined`.
  const leftover = combined.length - usableBytes;
  const nextCarry = leftover === 0 ? EMPTY : Buffer.from(combined.subarray(usableBytes));
  return { samples, carry: nextCarry };
}

const EMPTY = Buffer.alloc(0);

export function createAudioInBridge(opts: AudioInBridgeOptions): AudioInBridge {
  const pollMs = opts.pollMs ?? DEFAULT_POLL_MS;
  const sampleRate = opts.sampleRate ?? BOT_SAMPLE_RATE;
  const cbs = new Set<(frame: PcmFrame) => void>();
  const cursors = new Map<string, FileCursor>();
  let timer: ReturnType<typeof setInterval> | null = null;
  /** Guard against overlapping passes when a poll runs longer than `pollMs` (slow disk). */
  let polling = false;

  function emit(nodeId: string, samples: Int16Array): void {
    if (samples.length === 0) return;
    const frame: PcmFrame = { participantId: nodeId, pcm: samples, sampleRate, ts: Date.now() };
    for (const cb of [...cbs]) cb(frame);
  }

  /** Tail a single file from its cursor to current EOF, emitting whole samples. */
  async function tailFile(nodeId: string, path: string): Promise<void> {
    let size: number;
    try {
      size = (await stat(path)).size;
    } catch {
      return; // file vanished between glob and stat — ignore this pass
    }

    let cursor = cursors.get(nodeId);
    if (!cursor) {
      cursor = { offset: 0, carry: EMPTY };
      cursors.set(nodeId, cursor);
    }

    // Truncation: the file shrank (cleared mid-run). Restart from the top, dropping any odd carry.
    if (size < cursor.offset) {
      cursor.offset = 0;
      cursor.carry = EMPTY;
    }

    const toRead = size - cursor.offset;
    if (toRead <= 0) return;

    let chunk: Buffer;
    const fh = await open(path, 'r');
    try {
      const buf = Buffer.allocUnsafe(toRead);
      const { bytesRead } = await fh.read(buf, 0, toRead, cursor.offset);
      chunk = bytesRead === toRead ? buf : buf.subarray(0, bytesRead);
      cursor.offset += bytesRead;
    } finally {
      await fh.close();
    }

    const { samples, carry } = splitInt16LE(cursor.carry, chunk);
    cursor.carry = carry;
    emit(nodeId, samples);
  }

  async function poll(): Promise<void> {
    if (polling) return;
    polling = true;
    try {
      let names: string[];
      try {
        names = await readdir(opts.outDir);
      } catch {
        return; // outDir not present yet (bot not up) — try again next tick
      }
      for (const name of names) {
        const m = FILE_RE.exec(name);
        if (!m) continue;
        const nodeId = m[1]!;
        if (opts.excludeNodeId && nodeId === opts.excludeNodeId) continue;
        await tailFile(nodeId, join(opts.outDir, name));
      }
    } finally {
      polling = false;
    }
  }

  return {
    onPcm(cb) {
      cbs.add(cb);
      return () => {
        cbs.delete(cb);
      };
    },
    start() {
      if (timer) return;
      timer = setInterval(() => void poll(), pollMs);
      // Don't let the poll timer keep the process alive on its own.
      if (typeof timer.unref === 'function') timer.unref();
    },
    stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
    poll,
  };
}
