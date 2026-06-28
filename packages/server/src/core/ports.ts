import type { PcmFrame, RenderCommand } from '@meeting-agent/protocol';

/**
 * The four seams. The core (orchestrator, tools, resources) depends ONLY on these interfaces —
 * never on a concrete adapter. Local adapters wire them to the browser harness; Zoom adapters
 * (later) wire the same interfaces to the Meeting SDK. Swapping transports = swapping adapters.
 */

/** Raw, speaker-tagged audio in (mic now; Zoom per-participant PCM later). Media (VAD+STT) consumes it. */
export interface AudioInPort {
  onPcm(cb: (frame: PcmFrame) => void): () => void;
}

/** Audio out — the `speak` tool runs TTS, then hands PCM here (browser speakers now; Zoom uplink later). */
export interface AudioOutPort {
  play(pcm: Int16Array, sampleRate: number): Promise<void>;
}

/** The stage — `share_screen` renders an artifact here (in-app panel now; Zoom screenshare later). */
export interface DisplayPort {
  render(cmd: RenderCommand): Promise<void>;
}

/** Optional drop-link channel (in-app panel now; Zoom chat later). */
export interface ChatPort {
  dropLink(url: string, note?: string): Promise<void>;
}

export interface Ports {
  audioIn: AudioInPort;
  audioOut: AudioOutPort;
  display: DisplayPort;
  chat?: ChatPort;
}
