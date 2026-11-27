import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // Each test file starts its own server on its own temporary database, so files can run in parallel.
    fileParallelism: true,
  },
});
