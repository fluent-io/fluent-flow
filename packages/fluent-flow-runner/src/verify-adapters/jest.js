import { assertSafeRelPath } from '../verify-paths.js';
import { detectFrameworkFor } from './shared.js';

function flattenJestResults(json) {
  const suites = json?.testResults ?? [];
  const out = [];
  for (const suite of suites) {
    const file = suite.name ?? suite.testFilePath ?? '';
    const assertions = suite.assertionResults ?? [];
    if (!assertions.length) {
      if (suite.failureMessage || suite.failureMessages?.length || suite.status === 'failed') {
        out.push({ file, name: suite.name ?? file, status: 'suite-error', message: String(suite.failureMessage ?? suite.failureMessages?.[0] ?? '') });
      }
      continue;
    }
    for (const test of assertions) {
      if (test.status === 'pending' || test.status === 'skipped' || test.status === 'todo') {
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
    return detectFrameworkFor(worktreePath, {
      id: 'jest',
      configFiles: ['jest.config.js', 'jest.config.mjs', 'jest.config.cjs', 'jest.config.ts'],
      scriptPattern: /\bjest\b/,
      deps: ['jest'],
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
    const argv = ['--json', '--ci'];
    if (files && files.length) {
      for (const file of files.map(assertSafeRelPath)) argv.push(file);
    }
    return ['jest', ...argv];
  },
  parseResults(json) {
    return flattenJestResults(json);
  },
};
