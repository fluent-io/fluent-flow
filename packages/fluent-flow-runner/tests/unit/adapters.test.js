import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import adapters, { detectFramework, vitest, jest, node } from '../../src/verify-adapters/index.js';
import { assertSafeRelPath, sha256File, containsRealPath } from '../../src/verify-paths.js';
import { spawnSync } from 'node:child_process';

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

function writeGitDir(root, gitdir = '.git') {
  mkdirSync(join(root, gitdir), { recursive: true });
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

  it('does not walk above the git worktree boundary', () => {
    const outer = makeRepo();
    const worktree = join(outer, 'worktree');
    const nested = join(worktree, 'packages', 'app');
    mkdirSync(nested, { recursive: true });
    writeGitDir(worktree);
    writeJson(join(outer, 'package.json'), {
      name: 'outer',
      scripts: { test: 'vitest run' },
      devDependencies: { vitest: '^4.1.0' },
    });
    expect(detectFramework(nested)).toBeNull();
  });

  it('detects inside a nested worktree that has a git boundary', () => {
    const worktree = makeRepo();
    writeGitDir(worktree);
    setupPackage(join(worktree, 'packages', 'app'), {
      name: 'app',
      scripts: { test: 'vitest run' },
      devDependencies: { vitest: '^4.1.0' },
    }, {
      'vitest.config.ts': 'export default {};\n',
    });
    expect(detectFramework(join(worktree, 'packages', 'app', 'tests'))).toEqual({
      id: 'vitest',
      packageManager: 'npm',
      root: join(worktree, 'packages', 'app'),
    });
  });

  it('does not let worktree Yarn Berry metadata override nearer npm lockfiles', () => {
    const worktree = makeRepo();
    writeGitDir(worktree);
    writeFileSync(join(worktree, '.yarnrc.yml'), 'nodeLinker: node-modules\n');
    const root = join(worktree, 'packages', 'app');
    setupPackage(root, {
      name: 'app',
      scripts: { test: 'vitest run' },
      devDependencies: { vitest: '^4.1.0' },
    }, {
      'package-lock.json': '{}\n',
    });
    expect(detectFramework(join(root, 'tests'))).toEqual({
      id: 'vitest',
      packageManager: 'npm',
      root,
    });
  });

  it('throws on malformed package.json instead of walking to a parent', () => {
    const repo = makeRepo();
    writeGitDir(repo);
    mkdirSync(join(repo, 'packages', 'app'), { recursive: true });
    writeFileSync(join(repo, 'packages', 'app', 'package.json'), '{\n');
    expect(() => detectFramework(join(repo, 'packages', 'app'))).toThrow();
  });
});

describe('command generation', () => {
  it('produces exact install argv', () => {
    const repo = makeRepo();
    writeGitDir(repo);
    writeFileSync(join(repo, 'package-lock.json'), '{}\n');
    expect(vitest.installCommand(repo, 'pnpm')).toEqual(['pnpm', 'install', '--frozen-lockfile']);
    expect(jest.installCommand(repo, 'npm')).toEqual(['npm', 'ci']);
    expect(node.installCommand(repo, 'npm')).toEqual(['npm', 'ci']);
  });

  it('produces exact full-suite test argv', () => {
    expect(vitest.testCommand({ root: '/repo', files: null })).toEqual(['vitest', '--run', '--reporter=json']);
    expect(jest.testCommand({ root: '/repo', files: null })).toEqual(['jest', '--json', '--ci']);
    expect(node.testCommand({ root: '/repo', files: null }).slice(0, 3)).toEqual(['node', '--test', '--test-reporter']);
  });

  it.each(adapterEntries)('%s testCommand validates explicit files', (_name, adapter) => {
    const worktree = mkdtempSync(join(tmpdir(), 'ff-files-'));
    const root = join(worktree, 'packages', 'app');
    mkdirSync(root, { recursive: true });
    writeGitDir(worktree);
    writeJson(join(root, 'package.json'), { name: 'app' });
    mkdirSync(join(worktree, 'packages', 'app', 'tests'), { recursive: true });
    writeFileSync(join(worktree, 'packages', 'app', 'tests', 'a.test.js'), 'export const x = 1;\n');
    const argv = adapter.testCommand({
      root,
      worktreeRoot: worktree,
      files: ['packages/app/tests/a.test.js'],
    });
    expect(argv.at(-1)).toBe('tests/a.test.js');
    expect(argv).not.toContain('test');
  });

  it.each(adapterEntries)('%s testCommand rejects symlink escapes', (_name, adapter) => {
    const worktree = mkdtempSync(join(tmpdir(), 'ff-worktree-'));
    const root = join(worktree, 'packages', 'app');
    const outside = mkdtempSync(join(tmpdir(), 'ff-outside-'));
    mkdirSync(root, { recursive: true });
    writeGitDir(worktree);
    writeJson(join(root, 'package.json'), { name: 'app' });
    writeFileSync(join(outside, 'a.test.js'), 'export const x = 1;\n');
    symlinkSync(outside, join(root, 'tests'));
    expect(() => adapter.testCommand({
      root,
      worktreeRoot: worktree,
      files: ['packages/app/tests/a.test.js'],
    })).toThrow();
  });

  it('chooses npm ci when package-lock exists and npm install without lockfile otherwise', () => {
    const worktree = mkdtempSync(join(tmpdir(), 'ff-install-'));
    writeGitDir(worktree);
    const root = join(worktree, 'packages', 'app');
    mkdirSync(root, { recursive: true });
    writeJson(join(root, 'package.json'), { name: 'app' });
    writeFileSync(join(root, 'package-lock.json'), '{}\n');
    expect(vitest.installCommand(root, 'npm')).toEqual(['npm', 'ci']);
    rmSync(join(root, 'package-lock.json'));
    expect(vitest.installCommand(root, 'npm')).toEqual(['npm', 'install', '--no-audit', '--no-fund']);
  });

  it('distinguishes yarn classic from berry', () => {
    const worktree = mkdtempSync(join(tmpdir(), 'ff-yarn-'));
    writeGitDir(worktree);
    const root = join(worktree, 'packages', 'app');
    mkdirSync(root, { recursive: true });
    writeJson(join(root, 'package.json'), { name: 'app' });
    expect(jest.installCommand(root, 'yarn')).toEqual(['yarn', 'install', '--frozen-lockfile']);
    writeFileSync(join(worktree, '.yarnrc.yml'), 'nodeLinker: node-modules\n');
    expect(jest.installCommand(root, 'yarn')).toEqual(['yarn', 'install', '--immutable']);
  });

  it('rejects node detection for arbitrary testDir flags', () => {
    const repo = makeRepo();
    setupPackage(repo, { name: 'repo', scripts: { test: 'playwright test --testDir=e2e' } });
    expect(detectFramework(join(repo, 'packages', 'app'))).toBeNull();
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
      { status: 'pass' },
      { status: 'assertion-fail' },
      { status: 'suite-error' },
      { status: 'skip' },
    ]);
  });

  it('emits only leaf node:test rows and drops aggregate wrappers', async () => {
    const { default: reporter } = await import('../../src/verify-adapters/node-json-reporter.js');
    const file = join(process.cwd(), 'tests', 'node-reporter.test.js');
    async function* source() {
      yield { type: 'test:pass', data: { file, name: 'pass', details: { type: 'test', passed: true } } };
      yield { type: 'test:complete', data: { file, name: 'pass', details: { type: 'test', passed: true } } };
      yield { type: 'test:complete', data: { file, name: 'nested pass', nesting: 1, details: { type: 'test', passed: true } } };
      yield { type: 'test:complete', data: { file, name: 'passing suite', nesting: 0, details: { type: 'suite', passed: true } } };
      yield { type: 'test:complete', data: { file, name: file, nesting: 0, details: { type: 'test', passed: true } } };
      yield {
        type: 'test:fail',
        data: { file, name: 'assertion failure', details: { type: 'test', error: { message: 'expected 1 to equal 2' } } },
      };
      yield {
        type: 'test:complete',
        data: { file, name: 'assertion failure', details: { type: 'test', error: { message: 'expected 1 to equal 2' } } },
      };
      yield { type: 'test:pass', data: { file, name: 'skipped', details: { type: 'test', skip: 'later' } } };
      yield { type: 'test:complete', data: { file, name: 'skipped', details: { type: 'test', skip: 'later' } } };
      yield {
        type: 'test:complete',
        data: {
          file,
          name: 'failing suite',
          details: { type: 'suite', error: { failureType: 'subtestsFailed', message: 'test failed' } },
        },
      };
      yield {
        type: 'test:complete',
        data: {
          file,
          name: file,
          details: { type: 'test', error: { failureType: 'subtestsFailed', message: 'test failed' } },
        },
      };
    }

    const chunks = [];
    for await (const chunk of reporter(source())) chunks.push(chunk);

    expect(JSON.parse(chunks.join(''))).toEqual([
      { file: 'tests/node-reporter.test.js', name: 'pass', status: 'pass', message: '' },
      { file: 'tests/node-reporter.test.js', name: 'nested pass', status: 'pass', message: '' },
      {
        file: 'tests/node-reporter.test.js',
        name: 'assertion failure',
        status: 'assertion-fail',
        message: 'expected 1 to equal 2',
      },
      { file: 'tests/node-reporter.test.js', name: 'skipped', status: 'skip', message: '' },
    ]);
  });

  it('parses node:test stdout from the custom reporter in an integration-style run', () => {
    const worktree = mkdtempSync(join(tmpdir(), 'ff-node-run-'));
    const root = join(worktree, 'packages', 'app');
    mkdirSync(root, { recursive: true });
    writeJson(join(root, 'package.json'), { name: 'app', type: 'module' });
    const testFile = join(root, 'tests', 'node-adapter.test.js');
    mkdirSync(dirname(testFile), { recursive: true });
    writeFileSync(testFile, `
      import test, { describe } from 'node:test';
      import assert from 'node:assert/strict';
      test('pass', () => {
        console.log('USER LOG');
        assert.equal(1, 1);
      });
      describe('passing suite', () => {
        test('nested pass', () => assert.equal(2, 2));
      });
      test('fail', () => assert.equal(1, 2));
      test('skip', { skip: true }, () => {});
    `);
    const argv = node.testCommand({
      root,
      worktreeRoot: worktree,
      files: ['packages/app/tests/node-adapter.test.js'],
    });
    const run = spawnSync(process.execPath, argv.slice(1), { cwd: root, encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '' } });
    expect(run.status).toBe(1);
    expect(run.stderr).not.toMatch(/ERR_MODULE_NOT_FOUND/);
    const parsed = node.parseResults(JSON.parse(run.stdout));
    expect(parsed).toEqual([
      { file: 'tests/node-adapter.test.js', name: 'pass', status: 'pass', message: '' },
      { file: 'tests/node-adapter.test.js', name: 'nested pass', status: 'pass', message: '' },
      {
        file: 'tests/node-adapter.test.js',
        name: 'fail',
        status: 'assertion-fail',
        message: 'Expected values to be strictly equal:\n\n1 !== 2\n',
      },
      { file: 'tests/node-adapter.test.js', name: 'skip', status: 'skip', message: '' },
    ]);
  });
});
