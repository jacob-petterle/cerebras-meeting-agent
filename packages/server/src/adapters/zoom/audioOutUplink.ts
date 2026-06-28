import type { AudioOutPort } from '../../core/ports';

/**
 * Zoom AudioOut adapter — Phase 2. TTS PCM → Meeting SDK audio uplink. Not implemented for the
 * local harness. See ZOOM-SETUP.md.
 */
export function createAudioOutUplink(): AudioOutPort {
  return {
    async play() {
      throw new Error('Zoom audioOut adapter not implemented (Phase 2 — see ZOOM-SETUP.md)');
    },
  };
}
