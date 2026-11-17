import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // In development the API runs on :3000; in production Caddy serves both
    // from the same origin.
    proxy: { '/api': 'http://localhost:3000' },
  },
  build: { sourcemap: false, chunkSizeWarningLimit: 1500 },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: './src/test/setup.ts',
  },
});
