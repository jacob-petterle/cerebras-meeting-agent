import { WebSocketServer, type WebSocket } from 'ws';
import { z } from 'zod';
import type {
  LogEntry,
  PcmFrame,
  RenderCommand,
  ResourceName,
  ServerMsg,
} from '@meeting-agent/protocol';
import type { Resources } from './core/resources';
import type { AppendLog } from './core/resources';

/**
 * WebSocket host for the resource protocol (subscribe / catch_up / append / fetch_older / older)
 * plus the inbound PCM hook and outbound render/play broadcasts.
 *
 * Boundary discipline: every inbound frame is Zod-validated. Malformed JSON, an unknown `type`, or
 * a frame that fails validation is dropped silently — it can never crash the server or wedge a
 * connection (a test fires garbage then a valid request and expects the valid one to still work).
 * Catch_up is materialised from `log.since(sinceSeqNo)`; live pushes come from `log.subscribe`.
 */

const SubscribeMsg = z.object({
  type: z.literal('subscribe'),
  resource: z.enum(['transcript', 'deliverables']),
  sinceSeqNo: z.number(),
});

const FetchOlderMsg = z.object({
  type: z.literal('fetch_older'),
  resource: z.enum(['transcript', 'deliverables']),
  beforeSeqNo: z.number(),
  limit: z.number(),
});

const PcmMsg = z.object({
  type: z.literal('pcm'),
  participantId: z.string(),
  sampleRate: z.number(),
  ts: z.number(),
  pcm: z.array(z.number()),
});

const ClientMsg = z.discriminatedUnion('type', [SubscribeMsg, FetchOlderMsg, PcmMsg]);

export interface WsServerDeps {
  resources: Resources;
  /** Inbound speaker-tagged PCM (mic now; Zoom later). */
  onPcm?: (frame: PcmFrame) => void;
  /** 0 ⇒ ephemeral port; the chosen port is resolved via `whenReady`. */
  port: number;
  host?: string;
}

export interface WsServerHandle {
  /** Resolves with the bound port once the server is listening. */
  whenReady: Promise<number>;
  broadcastRender(cmd: RenderCommand): void;
  broadcastPlay(pcm: Int16Array, sampleRate: number): void;
  /** Push live inference stats (tok/s + token counts) to the web HUD. */
  broadcastStats(stats: {
    tokensPerSec: number | null;
    promptTokens: number;
    completionTokens: number;
  }): void;
  close(): Promise<void>;
}

function resourceLog(resources: Resources, name: ResourceName): AppendLog<unknown> {
  return name === 'transcript' ? resources.transcript : resources.deliverables;
}

function send(ws: WebSocket, msg: ServerMsg): void {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

/** Entries with seqNo < beforeSeqNo, last `limit` of them; hasMore if more existed before the page. */
function olderPage(
  log: AppendLog<unknown>,
  beforeSeqNo: number,
  limit: number,
): { entries: LogEntry<unknown>[]; hasMore: boolean } {
  if (limit <= 0) return { entries: [], hasMore: false };
  const filtered = log.snapshot().filter((e) => e.seqNo < beforeSeqNo);
  const page = filtered.slice(-limit);
  return { entries: page, hasMore: filtered.length > page.length };
}

export function createWsServer(deps: WsServerDeps): WsServerHandle {
  const wss = new WebSocketServer({ port: deps.port, host: deps.host ?? '127.0.0.1' });
  const clients = new Set<WebSocket>();

  const whenReady = new Promise<number>((resolve, reject) => {
    wss.once('listening', () => {
      const addr = wss.address();
      const port = typeof addr === 'object' && addr !== null ? addr.port : deps.port;
      resolve(port);
    });
    wss.once('error', reject);
  });

  wss.on('connection', (ws: WebSocket) => {
    clients.add(ws);
    /**
     * One live-append subscription PER resource for this socket. Re-subscribing to a resource
     * replaces the prior subscription (its unsub is called first), so a client that subscribes
     * twice — e.g. on reconnect/catch-up — never accumulates duplicate appends. (Without this,
     * each subscribe pushed a new subscriber and every append fanned out N times.)
     */
    const resourceUnsubs = new Map<ResourceName, () => void>();

    ws.on('message', (raw: Buffer | ArrayBuffer | Buffer[]) => {
      const text = Buffer.isBuffer(raw)
        ? raw.toString('utf-8')
        : Array.isArray(raw)
          ? Buffer.concat(raw).toString('utf-8')
          : Buffer.from(raw).toString('utf-8');

      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        return; /** malformed JSON — drop, never crash */
      }

      const parsed = ClientMsg.safeParse(json);
      if (!parsed.success) return; /** unknown/invalid frame — drop */
      const msg = parsed.data;

      switch (msg.type) {
        case 'subscribe': {
          const log = resourceLog(deps.resources, msg.resource);
          send(ws, { type: 'catch_up', resource: msg.resource, entries: log.since(msg.sinceSeqNo) });
          /** Evict any prior subscription for this resource before adding the new one. */
          resourceUnsubs.get(msg.resource)?.();
          /** Live push of every subsequent append on this resource. */
          const unsub = log.subscribe((entry) => {
            send(ws, { type: 'append', resource: msg.resource, entry });
          });
          resourceUnsubs.set(msg.resource, unsub);
          return;
        }
        case 'fetch_older': {
          const log = resourceLog(deps.resources, msg.resource);
          const { entries, hasMore } = olderPage(log, msg.beforeSeqNo, msg.limit);
          send(ws, { type: 'older', resource: msg.resource, entries, hasMore });
          return;
        }
        case 'pcm': {
          deps.onPcm?.({
            participantId: msg.participantId,
            pcm: Int16Array.from(msg.pcm),
            sampleRate: msg.sampleRate,
            ts: msg.ts,
          });
          return;
        }
      }
    });

    ws.on('close', () => {
      clients.delete(ws);
      for (const u of resourceUnsubs.values()) u();
      resourceUnsubs.clear();
    });
    ws.on('error', () => {
      /** Per-connection transport error: drop the socket; the close handler cleans up. */
    });
  });

  return {
    whenReady,
    broadcastRender(cmd: RenderCommand): void {
      for (const ws of clients) send(ws, { type: 'render', cmd });
    },
    broadcastPlay(pcm: Int16Array, sampleRate: number): void {
      const arr = Array.from(pcm);
      for (const ws of clients) send(ws, { type: 'play', sampleRate, pcm: arr });
    },
    broadcastStats(stats): void {
      for (const ws of clients) {
        send(ws, {
          type: 'stats',
          tokensPerSec: stats.tokensPerSec,
          promptTokens: stats.promptTokens,
          completionTokens: stats.completionTokens,
        });
      }
    },
    close(): Promise<void> {
      /**
       * `terminate()` (not `close()`): a graceful close handshake races the `wss.close()` below —
       * the server can finish closing before clients ACK the close frame, leaving sockets half-open
       * and the test/process hanging. Terminate drops them immediately and deterministically.
       */
      for (const ws of clients) ws.terminate();
      return new Promise<void>((resolve, reject) => {
        wss.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}
