import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { RENDERER_CSP_DEV } from './src/renderer-csp.js';

// During `vite serve`, relax only `connect-src` in the index.html meta CSP so
// Vite HMR WebSockets work; production builds keep the strict policy verbatim.
const rendererDevCspPlugin = () => ({
  name: 'durango-renderer-dev-csp',
  transformIndexHtml(html, ctx) {
    if (!ctx?.server) return html;
    return html.replace(
      /(<meta\s+http-equiv="Content-Security-Policy"\s+content=")[^"]*(")/i,
      `$1${RENDERER_CSP_DEV}$2`
    );
  },
});

// https://vitejs.dev/config
export default defineConfig({
  plugins: [react(), rendererDevCspPlugin()],
  optimizeDeps: {
    exclude: ['monaco-editor'],
  },
  // Module workers, so a worker can load chunks on demand (the code
  // highlighter's grammars); the default (iife) can't be code-split.
  worker: {
    format: 'es',
  },
});
