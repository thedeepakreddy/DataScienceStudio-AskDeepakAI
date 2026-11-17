import { defineConfig } from 'vitest/config';

// Unit tests for browser-side logic (stores, maths, data helpers). Kept apart
// from vite.config.ts so tests don't load the React/Tailwind build plugins.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
