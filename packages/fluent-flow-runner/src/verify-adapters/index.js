import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { readPackageJson, walkUp } from '../verify-paths.js';

const LOCKFILES = [
  ['pnpm-lock.yaml', 'pnpm'],
  ['yarn.lock', 'yarn'],
  ['package-lock.json', 'npm'],
];

export function detectPackageManager(startDir) {
  const found = walkUp(startDir, (dir) => LOCKFILES.some(([file]) => existsSync(join(dir, file))));
  if (!found) return 'npm';
  return LOCKFILES.find(([file]) => existsSync(join(found, file)))?.[1] ?? 'npm';
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

export function findPackageRoot(startDir, matcher) {
  return walkUp(startDir, (dir) => {
    const pkg = readPackageJson(dir);
    return !!pkg && matcher(dir, pkg);
  });
}

export function detectFramework(startDir, { id, configFiles, scriptPattern, deps, extraMatch }) {
  const root = findPackageRoot(startDir, (dir, pkg) => {
    return hasFile(dir, configFiles) ||
      scriptContains(pkg, scriptPattern) ||
      depExists(pkg, deps) ||
      (extraMatch ? extraMatch(dir, pkg) : false);
  });
  if (!root) return null;
  return { id, root, packageManager: detectPackageManager(root) };
}
