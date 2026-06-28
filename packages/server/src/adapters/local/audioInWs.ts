import type { PcmFrame } from '@meeting-agent/protocol';
import type { AudioInPort } from '../../core/ports';

/**
 * Local AudioIn adapter. The WS server hands every inbound mic `pcm` frame to `deliver`; the media
 * pipeline (VAD→STT) subscribes via the AudioInPort. Fan-out so multiple consumers can listen.
 * The Zoom adapter (Phase 2) implements the same AudioInPort from the Meeting SDK bridge instead.
 */
export function createAudioInWs(): {
  port: AudioInPort;
  deliver: (frame: PcmFrame) => void;
} {
  const cbs = new Set<(frame: PcmFrame) => void>();
  return {
    port: {
      onPcm(cb) {
        cbs.add(cb);
        return () => {
          cbs.delete(cb);
        };
      },
    },
    deliver(frame) {
      for (const cb of [...cbs]) cb(frame);
    },
  };
}
