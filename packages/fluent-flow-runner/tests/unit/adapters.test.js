import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import adapters, { detectFramework, vitest, jest, node } from '../../src/verify-adapters/index.js';
import { assertSafeRelPath, sha256File, containsRealPath } from '../../src/verify-paths.js';

const adapterEntries = [
  ['vitest', vitest],
  ['jest', jest],
  ['node', node],
];

function makeRepo() {
  const root = mkdtempSync(join(tmpdir(), 'ff-runner-'));
  mkdirSync(join(root, 'packages', 'app'), { recursive: true });
  mkdirSync(join(root, 'packages', 'nested', 'pkg'), { recursive: true });
  return root;
}

function writeJson(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function setupPackage(root, pkgJson, extra = {}) {
  writeJson(join(root, 'package.json'), pkgJson);
  for (const [rel, contents] of Object.entries(extra)) {
    const file = join(root, rel);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, contents);
  }
}

describe('adapter detection', () => {
  it('exports adapters by id', () => {
    expect(adapters.get('vitest')).toBe(vitest);
    expect(adapters.get('jest')).toBe(jest);
    expect(adapters.get('node')).toBe(node);
  });

  it('detects vitest from config, deps, scripts, and nested walk-up roots', () => {
    const repo = makeRepo();
    setupPackage(repo, {
      name: 'repo',
      type: 'module',
      scripts: { test: 'vitest run' },
      devDependencies: { vitest: '^4.1.0' },
    }, {
      'vitest.config.ts': 'export default {};\n',
      'pnpm-lock.yaml': 'lockfileVersion: 9\n',
    });

    const nested = join(repo, 'packages', 'nested', 'pkg');
    expect(detectFramework(nested)).toEqual({
      id: 'vitest',
      packageManager: 'pnpm',
      root: repo,
    });
  });

  it('detects jest from config and package metadata with package-lock preference', () => {
    const repo = makeRepo();
    setupPackage(repo, {
      name: 'repo',
      scripts: { test: 'jest --runInBand' },
      dependencies: { jest: '^29.0.0' },
    }, {
      'jest.config.mjs': 'export default {};\n',
      'package-lock.json': '{}\n',
    });

    expect(detectFramework(join(repo, 'packages', 'app'))).toEqual({
      id: 'jest',
      packageManager: 'npm',
      root: repo,
    });
  });

  it('detects node:test from package config and fallback npm when no lockfile exists', () => {
    const repo = makeRepo();
    setupPackage(repo, {
      name: 'repo',
      scripts: { test: 'node --test' },
      packageManager: 'node',
    });

    expect(detectFramework(join(repo, 'packages', 'app'))).toEqual({
      id: 'node',
      packageManager: 'npm',
      root: repo,
    });
  });

  it('returns null for unsupported packages', () => {
    const repo = makeRepo();
    setupPackage(repo, { name: 'repo', scripts: { test: 'echo ok' } });
    expect(detectFramework(repo)).toBeNull();
  });
});

describe('command generation', () => {
  it('produces exact install argv', () => {
    expect(vitest.installCommand('/repo', 'pnpm')).toEqual(['pnpm', 'install', '--frozen-lockfile']);
    expect(jest.installCommand('/repo', 'npm')).toEqual(['npm', 'ci']);
    expect(node.installCommand('/repo', 'yarn')).toEqual(['yarn', 'install', '--immutable']);
  });

  it('produces exact full-suite test argv', () => {
    expect(vitest.testCommand({ root: '/repo', files: null })).toEqual(['vitest', '--run', '--reporter=json']);
    expect(jest.testCommand({ root: '/repo', files: null })).toEqual(['jest', '--json', '--ci']);
    expect(node.testCommand({ root: '/repo', files: null })).toEqual(['node', '--test', '--test-reporter=json']);
  });

  it.each(adapterEntries)('%s testCommand validates explicit files', (_name, adapter) => {
    const argv = adapter.testCommand({ root: '/repo', files: ['tests/unit/a.spec.js', 'packages/b/test.cjs'] });
    expect(argv.slice(-2)).toEqual(['tests/unit/a.spec.js', 'packages/b/test.cjs']);
    expect(argv).not.toContain('test');
  });
});

describe('path safety', () => {
  it.each([
    '../x',
    '/abs',
    'a\\b',
    '',
    'a/../b',
    'a/../../b',
    './x',
    'a/./b',
    'a b',
    'a:b',
    'a*b',
    'a$b',
    'a\nb',
  ])('rejects %s', (input) => {
    expect(() => assertSafeRelPath(input)).toThrow();
  });

  it('accepts repo-relative POSIX paths', () => {
    expect(assertSafeRelPath('packages/app/test.spec.js')).toBe('packages/app/test.spec.js');
  });

  it('hashes file contents with sha256', () => {
    const repo = makeRepo();
    const file = join(repo, 'data.txt');
    writeFileSync(file, 'fluent-flow\n');
    const expected = createHash('sha256').update('fluent-flow\n').digest('hex');
    expect(sha256File(file)).toBe(expected);
  });

  it('contains real paths without allowing symlink escapes', () => {
    const repo = makeRepo();
    const outside = mkdtempSync(join(tmpdir(), 'ff-outside-'));
    const inner = join(repo, 'inside');
    mkdirSync(inner, { recursive: true });
    symlinkSync(outside, join(repo, 'linked'));
    expect(containsRealPath(repo, inner)).toBe(true);
    expect(containsRealPath(repo, join(repo, 'linked'))).toBe(false);
  });
});

describe('reporter parsing', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('classifies vitest results', async () => {
    const { default: adapter } = await import('../../src/verify-adapters/vitest.js');
    const fixture = (await import('../fixtures/reporter/vitest.json')).default;
    expect(adapter.parseResults(fixture)).toMatchObject([
      { file: 'tests/a.test.js', name: 'passes', status: 'pass', message: '' },
      { file: 'tests/a.test.js', name: 'assertion failure', status: 'assertion-fail' },
      { file: 'tests/b.test.js', status: 'suite-error' },
      { file: 'tests/c.test.js', name: 'skipped', status: 'skip', message: '' },
    ]);
  });

  it('classifies jest results', async () => {
    const { default: adapter } = await import('../../src/verify-adapters/jest.js');
    const fixture = (await import('../fixtures/reporter/jest.json')).default;
    expect(adapter.parseResults(fixture)).toMatchObject([
      { file: 'tests/a.test.js', name: 'passes', status: 'pass', message: '' },
      { file: 'tests/a.test.js', name: 'assertion failure', status: 'assertion-fail' },
      { file: 'tests/b.test.js', status: 'suite-error' },
      { file: 'tests/c.test.js', name: 'skipped', status: 'skip', message: '' },
    ]);
  });

  it('classifies node:test results', async () => {
    const { default: adapter } = await import('../../src/verify-adapters/node.js');
    const fixture = (await import('../fixtures/reporter/node.json')).default;
    expect(adapter.parseResults(fixture)).toMatchObject([
      { file: 'tests/a.test.js', name: 'passes', status: 'pass', message: '' },
      { file: 'tests/a.test.js', name: 'assertion failure', status: 'assertion-fail' },
      { file: 'tests/b.test.js', status: 'suite-error' },
      { file: 'tests/c.test.js', name: 'skipped', status: 'skip', message: '' },
    ]);
  });
});
