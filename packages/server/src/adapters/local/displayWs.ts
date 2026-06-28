import type { RenderCommand } from '@meeting-agent/protocol';
import type { DisplayPort } from '../../core/ports';
import type { WsServerHandle } from '../../ws';

/**
 * Local Display adapter. The `share_screen` tool calls `render` — here we broadcast the render
 * command to the browser stage. The Zoom adapter (Phase 2) renders the same command through
 * Chromium/Xvfb into the screenshare.
 */
export function createDisplayWs(ws: WsServerHandle): DisplayPort {
  return {
    async render(cmd: RenderCommand) {
      ws.broadcastRender(cmd);
    },
  };
}
