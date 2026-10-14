import { realpathSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, isAbsolute, relative, resolve } from 'node:path';

export function assertSafeRelPath(p) {
  if (typeof p !== 'string' || p.length === 0) {
    throw new Error('Path must be a non-empty repo-relative path');
  }
  if (!/^[A-Za-z0-9._/-]+$/.test(p)) {
    throw new Error('Path contains unsafe characters');
  }
  if (p.includes('\\')) {
    throw new Error('Path must use POSIX separators');
  }
  if (isAbsolute(p)) {
    throw new Error('Path must be repo-relative');
  }
  const parts = p.split('/');
  if (parts.some((part) => part.length === 0 || part === '.' || part === '..')) {
    throw new Error('Path contains unsafe segments');
  }
  return p;
}

export function sha256File(path) {
  const data = readFileSync(path);
  return createHash('sha256').update(data).digest('hex');
}

export function containsRealPath(root, candidate) {
  const rootReal = realpathSync(root);
  const candidateReal = realpathSync(candidate);
  const rel = relative(rootReal, candidateReal);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

export function readJsonIfExists(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    if (err?.code === 'ENOENT') return null;
    if (err instanceof SyntaxError) {
      throw new Error(`Invalid JSON in ${path}`);
    }
    throw err;
  }
}

export function walkUp(start, predicate, { stopAt } = {}) {
  let current = resolve(start);
  while (true) {
    if (predicate(current)) return current;
    if (stopAt && current === resolve(stopAt)) return null;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

export function findNearestFile(start, names) {
  return walkUp(start, (dir) => names.some((name) => {
    try {
      return !!realpathSync(resolve(dir, name));
    } catch {
      return false;
    }
  }));
}

export function readPackageJson(dir) {
  return readJsonIfExists(resolve(dir, 'package.json'));
}

export function hasAny(obj, keys) {
  return keys.some((key) => obj && Object.prototype.hasOwnProperty.call(obj, key));
}

