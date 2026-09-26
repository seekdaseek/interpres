import { defineConfig } from 'vite';

export default defineConfig({
  root: import.meta.dirname,
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // Per-app prefixed entry, not index.html: many apps share this machine.
    rolldownOptions: { input: 'interpres-index.html' },
  },
  server: {
    port: 5173,
    // In dev the API runs separately; in production both share one origin.
    proxy: { '/api': 'http://127.0.0.1:3030' },
  },
});
