import type { AudioInPort } from '../../core/ports';

/**
 * Zoom AudioIn adapter — Phase 2 (Dylan's track). Per-participant raw PCM from the Meeting SDK,
 * bridged to the host over localhost. Swapping this in for the local browser-mic adapter is the
 * entire "attach Zoom" change on the input side. Not implemented for the local harness.
 * See ZOOM-SETUP.md.
 */
export function createAudioInBridge(): AudioInPort {
  return {
    onPcm() {
      throw new Error('Zoom audioIn adapter not implemented (Phase 2 — see ZOOM-SETUP.md)');
    },
  };
}
