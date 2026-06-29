import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * The harness is served by Vite (default :5173); the agent server's WS host is a
 * separate process. Configure its URL with VITE_WS_URL, a `?ws=` query param, or
 * fall back to `ws://<host>:8787`. See src/ws.ts (resolveWsUrl).
 */
export default defineConfig({
  plugins: [react()],
  // allowedHosts: the bot's headless Chromium loads the stage via http://host.docker.internal:5173,
  // and Vite 5.4+ rejects non-localhost Host headers unless allowlisted. `true` = allow any (dev).
  server: { port: 5173, allowedHosts: true },
  build: { target: 'es2022' },
});
