import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The panel is built as static files with relative paths so the same dist/ works as a Chrome
// extension (load unpacked) and from any static server.
export default defineConfig({
  root: 'web',
  base: './',
  plugins: [react()],
  build: { outDir: '../dist', emptyOutDir: true, modulePreload: { polyfill: false } },
});
