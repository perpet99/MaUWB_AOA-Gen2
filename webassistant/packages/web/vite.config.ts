import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const API_TARGET = process.env.MAUWB_SERVER ?? 'http://127.0.0.1:8787';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: API_TARGET, changeOrigin: true },
      '/ws': { target: API_TARGET.replace(/^http/, 'ws'), ws: true },
      '/camera.mjpeg': { target: API_TARGET, changeOrigin: true },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
    /*
     * Without an explicit target the CSS minifier rewrites `max-width: 760px`
     * into the Level 4 range syntax `(width <= 760px)`, which iOS Safari only
     * understands from 16.4. That would silently drop the entire phone
     * breakpoint on exactly the devices it exists for. These targets all
     * support `aspect-ratio` but predate the range syntax, so it is kept
     * verbatim.
     */
    cssTarget: ['chrome100', 'edge100', 'firefox100', 'safari15.4'],
  },
});
