import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The dashboard is built to `platform/web/dist` and served by the platform
// server (Express static). `base: '/dashboard/'` keeps assets under that
// prefix so the API (mounted at /api) never collides with frontend routes.
export default defineConfig({
  plugins: [react()],
  base: '/dashboard/',
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
