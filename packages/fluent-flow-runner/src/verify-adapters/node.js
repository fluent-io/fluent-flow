import { fileURLToPath } from 'node:url';
import { assertSafeRelPath } from '../verify-paths.js';
import { detectFrameworkFor, hasAncestorFile, isYarnBerry, resolveRepoRelativeFile } from './shared.js';

function flattenNodeResults(json) {
  const items = Array.isArray(json) ? json : json?.tests ?? [];
  const out = [];
  for (const item of items) {
    if (!item) continue;
    out.push({
      file: item.file ? item.file.replaceAll('\\', '/') : '',
      name: item.name ?? '',
      status: item.status ?? 'pass',
      message: item.message ?? '',
    });
  }
  return out;
}

function reporterPath() {
  return fileURLToPath(new URL('./node-json-reporter.js', import.meta.url));
}

export default {
  detect(worktreePath) {
    return detectFrameworkFor(worktreePath, {
      id: 'node',
      configFiles: [],
      scriptPattern: /(^|\s)node\s+(?:--\S+\s+)*--test(?:\s|$)/,
      deps: [],
    });
  },
  installCommand(root, pm) {
    if (pm === 'pnpm') return ['pnpm', 'install', '--frozen-lockfile'];
    if (pm === 'yarn') return isYarnBerry(root) ? ['yarn', 'install', '--immutable'] : ['yarn', 'install', '--frozen-lockfile'];
    return hasAncestorFile(root, 'package-lock.json') ? ['npm', 'ci'] : ['npm', 'install', '--no-audit', '--no-fund'];
  },
  testCommand({ files, root, worktreeRoot }) {
    const argv = ['--test', '--test-reporter', reporterPath(), '--test-reporter-destination', 'stdout'];
    for (const file of files ?? []) {
      const rel = resolveRepoRelativeFile({ root, worktreeRoot, file });
      argv.push(rel);
    }
    return ['node', ...argv];
  },
  parseResults(json) {
    return flattenNodeResults(json);
  },
};
