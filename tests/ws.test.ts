import { describe, it, expect } from 'vitest';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { z } from 'zod';
import type { PcmFrame, TranscriptEntry } from '@meeting-agent/protocol';
import { createResources } from '../packages/server/src/core/resources';
import { createWsServer } from '../packages/server/src/ws';

const entry = (text: string): TranscriptEntry => ({
  participantId: 'u1',
  senderKind: 'human',
  text,
  timestamp: Date.now(),
});

/** Minimal validator so the test reads server→client frames without `as`. */
const ServerFrame = z.object({ type: z.string() }).passthrough();

/** Buffer incoming frames and hand them out in arrival order. */
function frameQueue(ws: WebSocket) {
  const buffer: Array<Record<string, unknown>> = [];
  const waiters: Array<(v: Record<string, unknown>) => void> = [];
  ws.on('message', (raw: Buffer) => {
    const parsed = ServerFrame.parse(JSON.parse(raw.toString()));
    const next = waiters.shift();
    if (next) next(parsed);
    else buffer.push(parsed);
  });
  return {
    next(): Promise<Record<string, unknown>> {
      const buffered = buffer.shift();
      if (buffered) return Promise.resolve(buffered);
      return new Promise((resolve) => waiters.push(resolve));
    },
  };
}

const TranscriptText = z.object({ text: z.string() });
const textOf = (data: unknown): string => TranscriptText.parse(data).text;

async function waitFor(pred: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe('ws resource protocol', () => {
  it('serves subscribe→catch_up, live append, fetch_older, inbound pcm, and render/play broadcast', async () => {
    const resources = createResources();
    const pcmFrames: PcmFrame[] = [];
    const handle = createWsServer({ resources, onPcm: (f) => pcmFrames.push(f), port: 0 });
    const port = await handle.whenReady;

    const client = new WebSocket(`ws://127.0.0.1:${port}`);
    await once(client, 'open');
    const frames = frameQueue(client);

    try {
      // a pre-existing entry should arrive in catch_up.
      resources.transcript.append(entry('first'));
      client.send(JSON.stringify({ type: 'subscribe', resource: 'transcript', sinceSeqNo: -1 }));

      const catchUp = await frames.next();
      expect(catchUp.type).toBe('catch_up');
      const catchUpEntries = z
        .array(z.object({ data: z.unknown() }))
        .parse(catchUp.entries);
      expect(catchUpEntries.map((e) => textOf(e.data))).toEqual(['first']);

      // a new append is pushed live.
      resources.transcript.append(entry('second'));
      const live = await frames.next();
      expect(live.type).toBe('append');
      const liveEntry = z.object({ data: z.unknown() }).parse(live.entry);
      expect(textOf(liveEntry.data)).toBe('second');

      // inbound pcm is decoded and handed to onPcm.
      client.send(
        JSON.stringify({ type: 'pcm', participantId: 'u9', sampleRate: 16000, ts: 7, pcm: [1, 2, 3] }),
      );
      await waitFor(() => pcmFrames.length === 1);
      expect(pcmFrames[0]!.participantId).toBe('u9');
      expect(Array.from(pcmFrames[0]!.pcm)).toEqual([1, 2, 3]);
      expect(pcmFrames[0]!.sampleRate).toBe(16000);

      // server→client render + play broadcasts.
      handle.broadcastRender({ kind: 'html', payload: '<b>x</b>', title: 'T' });
      const render = await frames.next();
      expect(render.type).toBe('render');

      handle.broadcastPlay(Int16Array.from([9, 8, 7]), 24000);
      const play = await frames.next();
      expect(play.type).toBe('play');
      expect(z.object({ pcm: z.array(z.number()) }).parse(play).pcm).toEqual([9, 8, 7]);

      // a malformed frame must NOT crash the server — a follow-up request still works.
      client.send('this is not json {{{');
      client.send(JSON.stringify({ type: 'totally-unknown' }));
      client.send(JSON.stringify({ type: 'fetch_older', resource: 'transcript', beforeSeqNo: 999, limit: 10 }));
      const older = await frames.next();
      expect(older.type).toBe('older');
      const olderEntries = z.array(z.object({ data: z.unknown() })).parse(older.entries);
      expect(olderEntries.map((e) => textOf(e.data))).toEqual(['first', 'second']);
    } finally {
      client.close();
      await handle.close();
    }
  });

  it('a second subscribe to the same resource replaces the first → an append delivers ONCE', async () => {
    // Regression: each subscribe used to push a NEW subscriber, so a client that subscribed twice
    // (e.g. on reconnect) got every append fanned out N times. Now the per-resource subscription
    // is replaced. We subscribe twice, then assert a single append arrives exactly once.
    const resources = createResources();
    const handle = createWsServer({ resources, port: 0 });
    const port = await handle.whenReady;

    const client = new WebSocket(`ws://127.0.0.1:${port}`);
    await once(client, 'open');

    // Count only `append` frames; the two `catch_up` replies are drained separately.
    let appendCount = 0;
    let catchUps = 0;
    client.on('message', (raw: Buffer) => {
      const frame = ServerFrame.parse(JSON.parse(raw.toString()));
      if (frame.type === 'append') appendCount += 1;
      if (frame.type === 'catch_up') catchUps += 1;
    });

    try {
      client.send(JSON.stringify({ type: 'subscribe', resource: 'transcript', sinceSeqNo: -1 }));
      client.send(JSON.stringify({ type: 'subscribe', resource: 'transcript', sinceSeqNo: -1 }));
      // Both subscribes are processed (two catch_up replies) before we append.
      await waitFor(() => catchUps === 2);

      resources.transcript.append(entry('only once'));

      // Give any duplicate push a chance to arrive, then assert exactly one append was delivered.
      await waitFor(() => appendCount >= 1);
      await new Promise((r) => setTimeout(r, 30));
      expect(appendCount).toBe(1);
    } finally {
      client.close();
      await handle.close();
    }
  });
});
