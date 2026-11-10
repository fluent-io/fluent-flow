import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  oxc: { jsx: { runtime: 'automatic' } },
  test: {
    fileParallelism: false,
    projects: [
      {
        extends: true,
        test: {
          name: 'node',
          environment: 'node',
          exclude: ['tests/collab/claim-execution.test.tsx', 'tests/components/**/*.test.tsx'],
        },
      },
      {
        extends: true,
        test: {
          name: 'claim-execution',
          environment: 'jsdom',
          include: ['tests/collab/claim-execution.test.tsx'],
        },
      },
      {
        extends: true,
        test: {
          name: 'components',
          environment: 'jsdom',
          include: ['tests/components/**/*.test.tsx'],
        },
      },
    ],
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
});
