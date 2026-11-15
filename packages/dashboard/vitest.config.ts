import { defineConfig } from 'vitest/config';
import path from 'path';

const collabDomTests = [
  'tests/collab/claim-execution.test.tsx',
  'tests/collab/chat-session.test.tsx',
  'tests/collab/chat-settings.test.tsx',
  'tests/collab/new-session.test.tsx',
  'tests/collab/start-work.test.tsx',
  'tests/collab/task-drawer.test.tsx',
];

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
          exclude: [...collabDomTests, 'tests/components/**/*.test.tsx'],
        },
      },
      {
        extends: true,
        test: {
          name: 'claim-execution',
          environment: 'jsdom',
          include: collabDomTests,
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
