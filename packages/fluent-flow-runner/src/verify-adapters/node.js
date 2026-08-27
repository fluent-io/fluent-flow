import { assertSafeRelPath } from '../verify-paths.js';
import { detectFramework } from './index.js';

function flattenNodeResults(json) {
  const out = [];
  function visit(node, file) {
    if (!node) return;
    const nextFile = node.name?.endsWith('.js') || node.name?.endsWith('.mjs') || node.name?.endsWith('.cjs') || node.name?.endsWith('.ts')
      ? node.name
      : file;
    if (Array.isArray(node.tests) && node.tests.length) {
      for (const child of node.tests) visit(child, nextFile);
      if (!node.tests.length && (node.failureType || node.error)) {
        out.push({ file: nextFile ?? '', name: node.name ?? nextFile ?? '', status: 'suite-error', message: String(node.error?.cause?.message ?? node.error?.message ?? node.details?.error?.cause?.message ?? '') });
      }
      return;
    }
    if (node.skip || node.todo) {
      out.push({ file: nextFile ?? '', name: node.name ?? '', status: 'skip', message: '' });
      return;
    }
    if (node.details?.error || node.failureType || node.error) {
      const message = String(node.error?.cause?.message ?? node.error?.message ?? node.details?.error?.cause?.message ?? '');
      out.push({ file: nextFile ?? '', name: node.name ?? '', status: Array.isArray(node.tests) && node.tests.length === 0 ? 'suite-error' : 'assertion-fail', message });
      return;
    }
    out.push({ file: nextFile ?? '', name: node.name ?? '', status: 'pass', message: '' });
  }
  for (const suite of json?.tests ?? []) visit(suite, suite.name);
  return out;
}

export default {
  detect(worktreePath) {
    return detectFramework(worktreePath, {
      id: 'node',
      configFiles: [],
      scriptPattern: /node\s+--test|--test/,
      deps: [],
      extraMatch: (dir, pkg) => typeof pkg?.scripts?.test === 'string' && /node\s+--test|--test/.test(pkg.scripts.test),
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
    const argv = ['test', '--test-reporter=json'];
    if (files && files.length) {
      for (const file of files.map(assertSafeRelPath)) argv.push(file);
    }
    return ['node', ...argv];
  },
  parseResults(json) {
    return flattenNodeResults(json);
  },
};
