import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The dashboard is served by the platform server (Express static) under
// `/platform/dashboard/` behind the Caddy reverse proxy. `base` must match the
// production URL prefix so asset <script>/<link> URLs resolve correctly (a
// wrong base made the browser request `/dashboard/...` at the app, not the
// platform). Override with `VITE_BASE` for a different mount path or local dev.
const base = process.env.VITE_BASE || '/platform/dashboard/';

export default defineConfig({
  plugins: [react()],
  base,
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    // Dev-time proxy to the platform API + SSE.
    proxy: {
      '/api': 'http://localhost:8080',
    },
  },
});
