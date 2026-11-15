import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// https://vitejs.dev/config
export default defineConfig({
  plugins: [react()],
  optimizeDeps: {
    exclude: ['monaco-editor'],
  },
  // Module workers, so a worker can load chunks on demand (the code
  // highlighter's grammars); the default (iife) can't be code-split.
  worker: {
    format: 'es',
  },
});
