import type { ClientMsg, ResourceName } from '@meeting-agent/protocol';
import { assertNever } from './lib/assert-never';
import { playPcm } from './playback';
import { useHarnessStore } from './store';
import { type Incoming, parseServerMessage } from './validate';

/**
 * WS client. Speaks the @meeting-agent/protocol ClientMsg/ServerMsg contract
 * exactly: subscribes both resources on open, consumes catch_up/append/older into
 * the append-log store, plays TTS, and drives the stage. Degrades gracefully --
 * if the server is down it shows "offline" and reconnects with backoff; it never
 * throws on a malformed or unrecognized frame.
 */

let socket: WebSocket | null = null;
let reconnectTimer: number | null = null;
let backoffMs = 500;
const MAX_BACKOFF_MS = 8000;
let stopped = false;

function readEnv(key: string): string | undefined {
  const value = import.meta.env[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** Precedence: `?ws=` query param > VITE_WS_URL > ws://<host>:8787. */
export function resolveWsUrl(): string {
  const fromQuery = new URLSearchParams(window.location.search).get('ws');
  if (fromQuery) return fromQuery;
  const fromEnv = readEnv('VITE_WS_URL');
  if (fromEnv) return fromEnv;
  // `localhost` resolves to ::1 (IPv6) first on macOS, but the server binds 127.0.0.1 (IPv4) —
  // coerce localhost/empty to 127.0.0.1 so the browser hits the IPv4 server instead of an
  // IPv6-refused connection.
  const host = window.location.hostname;
  const resolved = !host || host === 'localhost' ? '127.0.0.1' : host;
  return `ws://${resolved}:8787`;
}

function send(message: ClientMsg): boolean {
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(message));
    return true;
  }
  return false;
}

/** Forward one mic frame. participantId/ts are filled here; the browser stays dumb. */
export function sendPcm(sampleRate: number, pcm: number[]): void {
  send({ type: 'pcm', participantId: 'me', sampleRate, ts: Date.now(), pcm });
}

/** Request a page of older entries (drives the transcript "Load earlier" control). */
export function fetchOlder(resource: ResourceName, beforeSeqNo: number, limit: number): void {
  send({ type: 'fetch_older', resource, beforeSeqNo, limit });
}

/** Clear the session: the server wipes its logs + brain cursor, then broadcasts a reset to all clients. */
export function sendReset(): void {
  // Clear the local view IMMEDIATELY so the button is always responsive even if the server's reset
  // echo is delayed or the socket is mid-reconnect. The server still wipes its logs + broadcasts a
  // reset (which re-clears, harmlessly) so the wipe is durable across reconnects.
  useHarnessStore.getState().resetAll();
  send({ type: 'reset' });
}

function subscribeAll(): void {
  /**
   * On the first connect hwm is -1, so this requests the full history. On a
   * reconnect hwm is the last seqNo we hold, so the server replays only the delta
   * -- the whole point of the seqNo protocol.
   */
  const { hwm } = useHarnessStore.getState();
  send({ type: 'subscribe', resource: 'transcript', sinceSeqNo: hwm.transcript });
  send({ type: 'subscribe', resource: 'deliverables', sinceSeqNo: hwm.deliverables });
  send({ type: 'subscribe', resource: 'subAgents', sinceSeqNo: hwm.subAgents });
}

function dispatch(message: Incoming): void {
  const store = useHarnessStore.getState();
  switch (message.type) {
    case 'catch_up':
      if (message.resource === 'transcript') store.applyTranscriptCatchUp(message.entries);
      else if (message.resource === 'subAgents') store.applySubAgentCatchUp(message.entries);
      else store.applyDeliverableCatchUp(message.entries);
      break;
    case 'append':
      if (message.resource === 'transcript') store.applyTranscriptAppend(message.entry);
      else if (message.resource === 'subAgents') store.applySubAgentAppend(message.entry);
      else store.applyDeliverableAppend(message.entry);
      break;
    case 'older':
      if (message.resource === 'transcript') store.applyTranscriptOlder(message.entries);
      else if (message.resource === 'subAgents') store.applySubAgentOlder(message.entries);
      else store.applyDeliverableOlder(message.entries);
      break;
    case 'render':
      store.setRender(message.cmd);
      break;
    case 'play':
      playPcm(message.sampleRate, message.pcm);
      store.notePlay();
      break;
    case 'stats':
      store.setStats(message.stats);
      break;
    case 'decision':
      store.appendDecision({ name: message.name, detail: message.detail, ts: message.ts });
      break;
    case 'reset':
      store.resetAll();
      break;
    default:
      assertNever(message);
  }
}

/** Advance the backoff one step. Called once per failed/closed connection. */
function ratchetBackoff(): void {
  backoffMs = Math.min(MAX_BACKOFF_MS, Math.round(backoffMs * 1.6));
}

/**
 * Schedule a reconnect at the CURRENT backoff. The backoff is NOT advanced here
 * -- it is advanced exactly once per failed/closed connection (onclose, or the
 * constructor throwing), so a single drop ratchets the delay a single step.
 */
function scheduleReconnect(): void {
  if (stopped || reconnectTimer !== null) return;
  reconnectTimer = window.setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, backoffMs);
}

export function connect(): void {
  /**
   * Idempotent: never hold two live sockets at once. A second connect() while one is already
   * CONNECTING or OPEN would leave BOTH receiving the server's broadcasts — and since every client
   * plays the TTS `play` frame, the same utterance would be scheduled twice and play back-to-back
   * (the double-audio bug). The only legitimate re-entry is after a socket has closed (reconnect
   * nulls `socket` in onclose), so guard on a still-live socket here. This also absorbs an HMR
   * re-eval or an accidental double call without ever spawning a duplicate connection.
   */
  if (
    socket &&
    (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN)
  ) {
    return;
  }

  stopped = false;
  useHarnessStore.getState().setConnection('connecting');

  let next: WebSocket;
  try {
    next = new WebSocket(resolveWsUrl());
  } catch {
    // Constructor threw -> no socket, so onclose won't fire. Count the failure here.
    ratchetBackoff();
    scheduleReconnect();
    return;
  }
  socket = next;

  next.onopen = () => {
    backoffMs = 500;
    useHarnessStore.getState().setConnection('open');
    subscribeAll();
  };

  next.onmessage = (event: MessageEvent) => {
    const parsed = parseServerMessage(event.data);
    if (parsed) dispatch(parsed);
  };

  next.onclose = () => {
    if (socket === next) socket = null;
    useHarnessStore.getState().setConnection('closed');
    // A failed/closed connection ratchets the backoff one step (reset on onopen).
    ratchetBackoff();
    scheduleReconnect();
  };
}

export function disconnect(): void {
  stopped = true;
  if (reconnectTimer !== null) {
    window.clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (socket) {
    socket.onclose = null;
    socket.close();
    socket = null;
  }
  useHarnessStore.getState().setConnection('closed');
}

/**
 * HMR teardown. When Vite hot-replaces this module, the OLD module's WebSocket would otherwise stay
 * open with its `onmessage` still bound to the old module's `playPcm` — a second live socket that
 * double-schedules every TTS frame. Disposing the old socket on hot-replace (and a full reload
 * re-boots a single fresh connection) keeps the invariant "exactly one live socket" across reloads.
 */
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    disconnect();
  });
}
