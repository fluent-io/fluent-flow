import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  oxc: { jsx: { runtime: 'automatic' } },
  test: {
    fileParallelism: false,
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
});
