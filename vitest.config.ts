import { defineConfig } from 'vitest/config';

// Separate from vite.config.ts, whose `root: 'web'` would hide tests/ from vitest.
export default defineConfig({
  test: { root: '.', include: ['tests/**/*.test.ts'] },
});
