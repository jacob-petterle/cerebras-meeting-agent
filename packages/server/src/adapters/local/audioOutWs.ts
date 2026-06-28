import type { AudioOutPort } from '../../core/ports';
import type { WsServerHandle } from '../../ws';

/**
 * Local AudioOut adapter. The `speak` tool runs TTS, then calls `play` — here we broadcast that PCM
 * to the browser harness, which plays it through Web Audio (the local "speakers"). The Zoom adapter
 * (Phase 2) implements the same port by writing to the SDK audio uplink.
 */
export function createAudioOutWs(ws: WsServerHandle): AudioOutPort {
  return {
    async play(pcm, sampleRate) {
      ws.broadcastPlay(pcm, sampleRate);
    },
  };
}
