import { assertSafeRelPath } from '../verify-paths.js';
import { detectFramework } from './index.js';

function flattenVitestResults(json) {
  const suites = json?.testResults ?? json?.results ?? [];
  const out = [];
  for (const suite of suites) {
    const file = suite.testFilePath ?? suite.name ?? suite.file ?? '';
    const assertions = suite.assertionResults ?? [];
    if (!assertions.length) {
      if (suite.failureMessage || suite.failureMessages?.length || suite.errors?.length) {
        out.push({ file, name: suite.name ?? file, status: 'suite-error', message: String(suite.failureMessage ?? suite.failureMessages?.[0] ?? suite.errors?.[0] ?? '') });
      }
      continue;
    }
    for (const test of assertions) {
      const status = test.status;
      if (status === 'pending' || status === 'skipped' || status === 'todo') {
        out.push({ file, name: test.fullName ?? test.title ?? test.name ?? '', status: 'skip', message: '' });
      } else if (test.failureMessages?.length) {
        out.push({ file, name: test.fullName ?? test.title ?? test.name ?? '', status: 'assertion-fail', message: test.failureMessages.join('\n') });
      } else {
        out.push({ file, name: test.fullName ?? test.title ?? test.name ?? '', status: 'pass', message: '' });
      }
    }
  }
  return out;
}

export default {
  detect(worktreePath) {
    return detectFramework(worktreePath, {
      id: 'vitest',
      configFiles: ['vitest.config.js', 'vitest.config.mjs', 'vitest.config.cjs', 'vitest.config.ts'],
      scriptPattern: /\bvitest\b/,
      deps: ['vitest'],
    });
  },
  installCommand(root, pm) {
    return pm === 'pnpm'
      ? ['pnpm', 'install', '--frozen-lockfile']
      : pm === 'yarn'
        ? ['yarn', 'install', '--immutable']
        : ['npm', 'ci'];
  },
  testCommand({ files, root }) {
    const argv = ['test', '--reporter=json', '--run'];
    if (files && files.length) {
      for (const file of files.map(assertSafeRelPath)) argv.push(file);
    }
    return ['vitest', ...argv];
  },
  parseResults(json) {
    return flattenVitestResults(json);
  },
};
