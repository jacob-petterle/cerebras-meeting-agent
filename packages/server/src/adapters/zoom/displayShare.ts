import type { DisplayPort } from '../../core/ports';

/**
 * Zoom Display adapter — Phase 2. Render command → Chromium/Xvfb framebuffer → Meeting SDK
 * screenshare. Not implemented for the local harness. See ZOOM-SETUP.md (R3 screenshare-send risk).
 */
export function createDisplayShare(): DisplayPort {
  return {
    async render() {
      throw new Error('Zoom display adapter not implemented (Phase 2 — see ZOOM-SETUP.md)');
    },
  };
}
