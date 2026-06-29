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
import { assertNever } from './lib/assert-never';

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
  resource: z.enum(['transcript', 'deliverables', 'subAgents']),
  sinceSeqNo: z.number(),
});

const FetchOlderMsg = z.object({
  type: z.literal('fetch_older'),
  resource: z.enum(['transcript', 'deliverables', 'subAgents']),
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

const ResetMsg = z.object({ type: z.literal('reset') });

const ClientMsg = z.discriminatedUnion('type', [SubscribeMsg, FetchOlderMsg, PcmMsg, ResetMsg]);

export interface WsServerDeps {
  resources: Resources;
  /** Inbound speaker-tagged PCM (mic now; Zoom later). */
  onPcm?: (frame: PcmFrame) => void;
  /** Invoked when a client requests a session reset (wipe logs + reset the brain cursor). */
  onReset?: () => void;
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
  /** Push a brain decision (incl. no_op) to the console's decision feed. */
  broadcastDecision(decision: { name: string; detail: string; ts: number }): void;
  /** Push the live "thinking" pulse (brain mid-decide) to the agent-state visualizer. */
  broadcastAgentState(thinking: boolean): void;
  /**
   * Tell every client to clear its view (after a SERVER-INITIATED reset — e.g. a spoken voice command
   * the pipeline recognized). The inbound `reset` MESSAGE path already broadcasts on its own; this is
   * the seam for resets that don't originate from a client frame. Server-state wipe is the caller's job.
   */
  broadcastReset(): void;
  close(): Promise<void>;
}

function resourceLog(resources: Resources, name: ResourceName): AppendLog<unknown> {
  switch (name) {
    case 'transcript':
      return resources.transcript;
    case 'deliverables':
      return resources.deliverables;
    case 'subAgents':
      return resources.subAgents;
    default:
      return assertNever(name);
  }
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
  /**
   * The single AUDIO SINK. TTS `play` frames go to exactly ONE client, never the whole set — otherwise
   * every open client (a second tab, the operator console alongside the stage, a Shipyard webview next
   * to a real browser) schedules the same utterance in its own AudioContext and you hear it doubled,
   * slightly offset. Transcript/render/stats still broadcast to ALL clients (they're idempotent views);
   * audio is the one output that must be single-sink. Latest connection wins (the tab you just opened to
   * listen takes over); on its disconnect we promote the most-recently-connected survivor.
   */
  let audioSink: WebSocket | null = null;

  /** Tell every connected client to clear its view. The single client-broadcast point for a reset. */
  function broadcastReset(): void {
    for (const client of clients) send(client, { type: 'reset' });
  }

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
    /** Newest client becomes the audio sink, so opening a fresh tab to listen takes over playback. */
    audioSink = ws;
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
        case 'reset': {
          /** Wipe server-side state, then tell every client to clear its view. */
          deps.onReset?.();
          broadcastReset();
          return;
        }
      }
    });

    ws.on('close', () => {
      clients.delete(ws);
      /** If the sink dropped, promote the most-recently-connected survivor (insertion-ordered Set). */
      if (audioSink === ws) {
        let next: WebSocket | null = null;
        for (const c of clients) next = c;
        audioSink = next;
      }
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
      /** Audio goes to the single sink only (see `audioSink`) — NOT fanned to every client. */
      if (!audioSink) return;
      send(audioSink, { type: 'play', sampleRate, pcm: Array.from(pcm) });
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
    broadcastDecision(decision): void {
      for (const ws of clients) {
        send(ws, { type: 'decision', name: decision.name, detail: decision.detail, ts: decision.ts });
      }
    },
    broadcastAgentState(thinking): void {
      for (const ws of clients) {
        send(ws, { type: 'agent_state', thinking });
      }
    },
    broadcastReset,
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
