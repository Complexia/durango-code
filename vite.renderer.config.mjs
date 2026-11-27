import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { buildRendererCsp, rewriteIndexHtmlCsp } from './src/renderer-csp.js';

const devServerUrlsFromContext = (ctx) => {
  const urls = [];
  const resolved = ctx?.server?.resolvedUrls;
  if (Array.isArray(resolved?.local)) urls.push(...resolved.local);
  if (Array.isArray(resolved?.network)) urls.push(...resolved.network);
  if (urls.length > 0) return urls;
  const addr = ctx?.server?.httpServer?.address?.();
  if (addr && typeof addr === 'object' && addr.port) {
    const protocol = ctx?.server?.config?.server?.https ? 'https' : 'http';
    const host =
      addr.address === '::' || addr.address === '0.0.0.0'
        ? 'localhost'
        : addr.address.includes(':')
          ? `[${addr.address}]`
          : addr.address;
    urls.push(`${protocol}://${host}:${addr.port}`);
  }
  return urls;
};

// During `vite serve`, relax only `connect-src` in the index.html meta CSP so
// Vite HMR WebSockets work (including IPv6, HTTPS, and custom dev hosts);
// production builds keep the strict policy verbatim.
export const rendererDevCspPlugin = () => ({
  name: 'durango-renderer-dev-csp',
  transformIndexHtml(html, ctx) {
    if (!ctx?.server) return html;
    const devServerUrls = devServerUrlsFromContext(ctx);
    const csp = buildRendererCsp({ devServerUrls, devMode: true });
    return rewriteIndexHtmlCsp(html, csp);
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
