import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    // control/data holds the local node's Browser profiles, whose locked files break the watcher.
    watch: { ignored: ['**/data/**', '**/dist/**'] },
    proxy: { '/api': { target: 'http://127.0.0.1:3001', ws: true } },
  },
  build: {
    target: 'chrome89',
    cssTarget: 'chrome89',
    outDir: 'dist/client',
    emptyOutDir: true,
  },
});
