import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// A second Control instance (UI QA, isolated data) can be targeted without editing this file.
const control = process.env.REMOTEKIT_VITE_CONTROL ?? 'http://127.0.0.1:3001';

export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    // control/data holds the local node's Browser profiles, whose locked files break the watcher.
    watch: { ignored: ['**/data/**', '**/dist/**'] },
    proxy: { '/api': { target: control, ws: true } },
  },
  build: {
    target: 'chrome89',
    cssTarget: 'chrome89',
    outDir: 'dist/client',
    emptyOutDir: true,
    // The Viewer core is MUI + React + the stage (~1.06 MB); rarely used screens are lazy chunks.
    // Warn once the core grows past that instead of on every build.
    chunkSizeWarningLimit: 1100,
  },
});
