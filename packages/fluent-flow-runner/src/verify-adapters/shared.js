import { existsSync } from 'node:fs';
import { join, resolve, relative, sep } from 'node:path';
import { readPackageJson, walkUp, containsRealPath, assertSafeRelPath } from '../verify-paths.js';

const LOCKFILES = [
  ['pnpm-lock.yaml', 'pnpm'],
  ['yarn.lock', 'yarn'],
  ['package-lock.json', 'npm'],
];

function normalizeBoundary(startDir, stopAt) {
  return stopAt ? resolve(stopAt) : findWorktreeRoot(startDir) ?? null;
}

export function findWorktreeRoot(startDir) {
  return walkUp(startDir, (dir) => existsSync(join(dir, '.git')));
}

export function detectPackageManager(startDir, { stopAt } = {}) {
  const boundary = normalizeBoundary(startDir, stopAt);
  const found = walkUp(startDir, (dir) => LOCKFILES.some(([file]) => existsSync(join(dir, file))), { stopAt: boundary });
  if (!found) return 'npm';
  return LOCKFILES.find(([file]) => existsSync(join(found, file)))?.[1] ?? 'npm';
}

export function hasAncestorFile(startDir, file, { stopAt } = {}) {
  const boundary = normalizeBoundary(startDir, stopAt);
  return !!walkUp(startDir, (dir) => existsSync(join(dir, file)), { stopAt: boundary });
}

export function isYarnBerry(root) {
  const pkg = readPackageJson(root);
  if (pkg?.packageManager) {
    const [name, version = ''] = String(pkg.packageManager).split('@');
    if (name === 'yarn') {
      const major = Number.parseInt(version.split('.')[0], 10);
      if (Number.isFinite(major) && major >= 2) return true;
    }
  }
  const boundary = findWorktreeRoot(root) ?? root;
  return !!walkUp(root, (dir) => existsSync(join(dir, '.yarnrc.yml')), { stopAt: boundary });
}

function scriptContains(pkg, pattern) {
  const scripts = pkg?.scripts ?? {};
  return Object.values(scripts).some((value) => typeof value === 'string' && pattern.test(value));
}

function depExists(pkg, names) {
  const maps = [pkg?.dependencies, pkg?.devDependencies, pkg?.peerDependencies, pkg?.optionalDependencies];
  return maps.some((map) => names.some((name) => map && Object.prototype.hasOwnProperty.call(map, name)));
}

function hasFile(dir, names) {
  return names.some((name) => existsSync(join(dir, name)));
}

export function findPackageRoot(startDir, matcher, { stopAt } = {}) {
  const boundary = normalizeBoundary(startDir, stopAt);
  return walkUp(startDir, (dir) => {
    const pkg = readPackageJson(dir);
    return !!pkg && matcher(dir, pkg);
  }, { stopAt: boundary });
}

export function detectFrameworkFor(startDir, options = {}) {
  const { id, configFiles = [], scriptPattern, deps = [] } = options;
  const boundary = normalizeBoundary(startDir, options.stopAt);
  const root = walkUp(startDir, (dir) => {
    const pkg = readPackageJson(dir);
    if (!pkg) return false;
    return hasFile(dir, configFiles) ||
      scriptContains(pkg, scriptPattern) ||
      depExists(pkg, deps);
  }, { stopAt: boundary });
  if (!root) return null;
  return { id, root, packageManager: detectPackageManager(root, { stopAt: boundary }) };
}

export function resolveRepoRelativeFile({ root, worktreeRoot, file }) {
  const boundary = resolve(worktreeRoot ?? root);
  const packageRoot = resolve(root);
  const safe = assertSafeRelPath(file);
  const candidate = resolve(boundary, safe);
  if (!containsRealPath(boundary, candidate)) {
    throw new Error(`Path escapes worktree: ${file}`);
  }
  if (!containsRealPath(packageRoot, candidate)) {
    throw new Error(`Path escapes adapter root: ${file}`);
  }
  const rel = relative(packageRoot, candidate);
  return rel.split(sep).join('/');
}
