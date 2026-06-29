import type { RenderCommand } from '@meeting-agent/protocol';
import type { DisplayPort } from '../../core/ports';
import type { WsServerHandle } from '../../ws';

/**
 * Zoom Display adapter — and the punchline of the screenshare design: there is nothing Zoom-specific
 * here. The bot runs a headless Chromium that loads the `packages/web` stage over the SAME WebSocket
 * the dev browser uses, then screen-shares that window. So a render command reaches the bot's stage
 * by the identical `ws.broadcastRender` path as the local browser — we never talk to the bot for
 * display. This mirrors `createDisplayWs`; it exists separately only so the ZOOM wiring in main.ts
 * reads symmetrically with the other two zoom adapters.
 */
export function createDisplayShare(ws: WsServerHandle): DisplayPort {
  return {
    async render(cmd: RenderCommand) {
      ws.broadcastRender(cmd);
    },
  };
}
