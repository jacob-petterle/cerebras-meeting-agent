import { Socket } from 'node:net';
import type { AudioOutPort } from '../../core/ports';
import { resampleInt16 } from '../../media/pcm';

/**
 * Zoom AudioOut adapter — streams TTS PCM to the bot's virtual mic over TCP.
 *
 * The `speak` tool runs kokoro (24 kHz) and hands the PCM here. The bot listens on
 * `127.0.0.1:${port}` for 32 kHz mono s16le PCM and plays it through a virtual mic, buffering
 * ~200 ms of jitter. So we must (a) resample to 32 kHz and (b) feed it *paced* in real time — if we
 * dumped the whole utterance at once we'd blow past the bot's jitter buffer and it would drop audio.
 *
 * Pacing: split into ~20 ms frames and release each one on a monotonic schedule (`scheduled` advances
 * by each frame's true duration, never by wall-clock-at-write), so transient write stalls can't make
 * us run ahead of real time. `flush()` clears the pending audio for barge-in — when a human starts
 * talking the orchestrator can cut the agent off mid-utterance.
 *
 * The socket auto-(re)connects lazily on the next `play`; a dropped connection just means the next
 * utterance reconnects. We never throw out of `play` on a transport error — a missed utterance must
 * not crash the brain.
 */

const DEFAULT_PORT = 3001;
const DEFAULT_HOST = '127.0.0.1';
const BOT_SAMPLE_RATE = 32_000;
const FRAME_MS = 20;

/** Bytes per LE int16 sample. */
const BYTES_PER_SAMPLE = 2;

export interface AudioOutUplinkOptions {
  /** Bot TTS TCP port. Default 3001 (BOT_TTS_PORT). */
  port?: number;
  host?: string;
  /** Target rate the bot expects. Default 32 kHz (the fixed bot contract). */
  sampleRate?: number;
  /** Frame size in ms. Default 20. */
  frameMs?: number;
}

export interface AudioOutUplink extends AudioOutPort {
  /** Drop all pending audio (barge-in). The in-flight frame may still land; the rest is discarded. */
  flush(): void;
  /** Close the socket and stop pacing (graceful shutdown). */
  stop(): void;
}

/** Encode an int16 sample window as a little-endian byte buffer (the wire format the bot reads). */
export function int16ToLEBytes(samples: Int16Array): Buffer {
  const buf = Buffer.allocUnsafe(samples.length * BYTES_PER_SAMPLE);
  for (let i = 0; i < samples.length; i++) {
    buf.writeInt16LE(samples[i]!, i * BYTES_PER_SAMPLE);
  }
  return buf;
}

/**
 * The pure pacing core: accept whole utterances, release ~frameMs frames on a monotonic schedule via
 * the injected `write` / `now` / `sleep`. Separated from the socket so the cadence is unit-testable
 * with a fake clock. `enqueue` appends and (re)starts the pump; `flush` drops everything pending.
 */
export interface PacedSenderDeps {
  write: (frame: Buffer) => void;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  sampleRate?: number;
  frameMs?: number;
}

export function createPacedSender(deps: PacedSenderDeps): {
  enqueue: (pcm: Int16Array) => void;
  flush: () => void;
  /** Samples per full frame — exposed for tests. */
  frameSamples: number;
} {
  const sampleRate = deps.sampleRate ?? BOT_SAMPLE_RATE;
  const frameMs = deps.frameMs ?? FRAME_MS;
  const frameSamples = Math.round((sampleRate * frameMs) / 1000);

  /** Pending samples, consumed from the front. */
  let queue: Int16Array = new Int16Array(0);
  let running = false;

  function append(pcm: Int16Array): void {
    if (pcm.length === 0) return;
    const merged = new Int16Array(queue.length + pcm.length);
    merged.set(queue, 0);
    merged.set(pcm, queue.length);
    queue = merged;
  }

  async function pump(): Promise<void> {
    if (running) return;
    running = true;
    // Anchor the schedule to "now"; each frame advances it by the frame's true duration so a slow
    // write can never make us release the next frame early (we'd only ever fall behind, then catch up
    // by skipping the sleep). This is the standard real-time pacing the local path doesn't need.
    let scheduled = deps.now();
    try {
      while (queue.length > 0) {
        const n = Math.min(frameSamples, queue.length);
        const frame = queue.subarray(0, n);
        deps.write(int16ToLEBytes(frame));
        queue = queue.subarray(n);
        scheduled += (n / sampleRate) * 1000;
        const delay = scheduled - deps.now();
        if (delay > 0) await deps.sleep(delay);
      }
    } finally {
      running = false;
    }
    // A flush() during the final await empties the queue; if audio arrived during the same window the
    // loop already drained it. Either way `running` is false and the next enqueue restarts cleanly.
  }

  return {
    enqueue(pcm: Int16Array): void {
      append(pcm);
      void pump();
    },
    flush(): void {
      queue = new Int16Array(0);
    },
    frameSamples,
  };
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    if (typeof t.unref === 'function') t.unref();
  });

export function createAudioOutUplink(opts: AudioOutUplinkOptions = {}): AudioOutUplink {
  const port = opts.port ?? DEFAULT_PORT;
  const host = opts.host ?? DEFAULT_HOST;
  const targetRate = opts.sampleRate ?? BOT_SAMPLE_RATE;

  let socket: Socket | null = null;
  let connecting: Promise<Socket> | null = null;
  let stopped = false;

  function connect(): Promise<Socket> {
    if (socket && !socket.destroyed) return Promise.resolve(socket);
    if (connecting) return connecting;
    connecting = new Promise<Socket>((resolve, reject) => {
      const s = new Socket();
      s.once('connect', () => {
        socket = s;
        connecting = null;
        resolve(s);
      });
      s.once('error', (err) => {
        connecting = null;
        socket = null;
        s.destroy();
        reject(err);
      });
      // A later transport drop just nulls the socket; the next play reconnects.
      s.on('close', () => {
        if (socket === s) socket = null;
      });
      s.connect(port, host);
    });
    return connecting;
  }

  const sender = createPacedSender({
    write: (frame) => {
      // Best-effort: if the socket dropped mid-utterance, drop the frame rather than throwing into
      // the pump. The next `play` reconnects.
      if (socket && !socket.destroyed) socket.write(frame);
    },
    now: () => performance.now(),
    sleep,
    sampleRate: targetRate,
    frameMs: opts.frameMs ?? FRAME_MS,
  });

  return {
    async play(pcm, sampleRate) {
      if (stopped) return;
      const resampled = resampleInt16(pcm, sampleRate, targetRate);
      try {
        await connect();
      } catch {
        // Bot not listening (not joined yet / restarting). Skip this utterance; don't crash the brain.
        return;
      }
      sender.enqueue(resampled);
    },
    flush() {
      sender.flush();
    },
    stop() {
      stopped = true;
      sender.flush();
      if (socket) {
        socket.destroy();
        socket = null;
      }
    },
  };
}
