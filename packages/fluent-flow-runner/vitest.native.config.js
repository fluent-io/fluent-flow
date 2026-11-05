import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/native/*.native.test.js'],
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
