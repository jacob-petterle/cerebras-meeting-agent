import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * The harness is served by Vite (default :5173); the agent server's WS host is a
 * separate process. Configure its URL with VITE_WS_URL, a `?ws=` query param, or
 * fall back to `ws://<host>:8787`. See src/ws.ts (resolveWsUrl).
 */
export default defineConfig({
  plugins: [react()],
  server: { port: 5173 },
  build: { target: 'es2022' },
});
