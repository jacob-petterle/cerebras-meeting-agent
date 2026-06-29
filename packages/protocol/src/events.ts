/**
 * I/O event payloads that cross the port boundary.
 * Kept as plain interfaces (no runtime validation needed — they originate in our own code).
 */

/** Raw, speaker-tagged PCM coming in from an AudioIn adapter (mic or, later, Zoom). */
export interface PcmFrame {
  participantId: string;
  pcm: Int16Array;
  sampleRate: number;
  ts: number;
}

export type RenderKind = 'html' | 'mermaid' | 'image' | 'json' | 'log' | 'markdown';

/** What the `share_screen` tool sends to a Display adapter (the stage). */
export interface RenderCommand {
  kind: RenderKind;
  /** inline source for html/mermaid/markdown/json/log; a URL or file path for image */
  payload: string;
  title?: string;
}

/** What the `speak` tool sends to TTS → an AudioOut adapter. */
export interface SpeakCommand {
  text: string;
}
