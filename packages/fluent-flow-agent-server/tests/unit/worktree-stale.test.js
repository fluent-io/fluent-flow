import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockExecFile = vi.fn();

vi.mock('node:child_process', () => ({
  execFile: (...args) => mockExecFile(...args),
}));

const { cleanStaleWorktrees, prepareWorktree } = await import('../../src/worktree.js');

const SECRET_GITHUB_TOKEN = `ghs_${'Zy9'.repeat(12)}`;
const BASE_ENVIRONMENT = Object.freeze({ PATH: '/portable/bin', HOME: '/slot/home', LANG: 'C.UTF-8' });

let workDir;

function logger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

function callbackFrom(options, callback) {
  return typeof options === 'function' ? options : callback;
}

function repositoryDirectory(owner, name) {
  return join(workDir, '.fluent-flow', 'repos', owner, name);
}

function makeRepository(owner, name, worktrees = []) {
  const base = repositoryDirectory(owner, name);
  mkdirSync(join(base, '.git'), { recursive: true });
  for (const worktree of worktrees) {
    mkdirSync(join(base, '.worktrees', worktree), { recursive: true });
    writeFileSync(join(base, '.worktrees', worktree, 'marker.txt'), 'leftover\n');
  }
  return base;
}

function pruneCalls() {
  return mockExecFile.mock.calls.filter(([command, args]) => command === 'git' && args[0] === 'worktree' && args[1] === 'prune');
}

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

beforeEach(() => {
  vi.clearAllMocks();
  workDir = mkdtempSync(join(tmpdir(), 'ff-stale-worktrees-'));
  mockExecFile.mockImplementation((_command, _args, options, callback) => {
    callbackFrom(options, callback)(null, '', '');
  });
});

afterEach(() => {
  chmodSync(workDir, 0o700);
  rmSync(workDir, { recursive: true, force: true });
});

describe('cleanStaleWorktrees', () => {
  it('removes leftover claim worktree directories and prunes every base repository', async () => {
    const one = makeRepository('owner', 'one', ['claim-11', 'claim-12-verify-red', 'keep-me']);
    const two = makeRepository('owner', 'two', ['claim-13']);
    makeRepository('other', 'three');
    const log = logger();

    await cleanStaleWorktrees({ workDir, environment: BASE_ENVIRONMENT, log });

    expect(existsSync(join(one, '.worktrees', 'claim-11'))).toBe(false);
    expect(existsSync(join(one, '.worktrees', 'claim-12-verify-red'))).toBe(false);
    expect(existsSync(join(one, '.worktrees', 'keep-me'))).toBe(true);
    expect(existsSync(join(two, '.worktrees', 'claim-13'))).toBe(false);
    expect(existsSync(join(one, '.git'))).toBe(true);
    const prunes = pruneCalls();
    expect(prunes.map(([, , options]) => options.cwd).sort()).toEqual([
      one,
      two,
      repositoryDirectory('other', 'three'),
    ].sort());
    expect(log.info).toHaveBeenCalledWith('Stale worktrees cleaned', expect.objectContaining({
      event: 'stale_worktrees_cleaned',
      repositories: 3,
      removed: 3,
      failed: 0,
    }));
  });

  it('runs git with an isolated environment and no claim credential', async () => {
    makeRepository('owner', 'one', ['claim-21']);

    await cleanStaleWorktrees({ workDir, environment: BASE_ENVIRONMENT, log: logger() });

    const [, , options] = pruneCalls()[0];
    expect(options.env).toEqual(expect.objectContaining({
      ...BASE_ENVIRONMENT,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: expect.any(String),
    }));
    expect(options.env).not.toHaveProperty('GH_TOKEN');
    expect(options.env).not.toHaveProperty('GITHUB_TOKEN');
  });

  it('ignores a work directory that has never held repositories', async () => {
    const log = logger();

    await cleanStaleWorktrees({ workDir: join(workDir, 'missing'), environment: BASE_ENVIRONMENT, log });

    expect(pruneCalls()).toHaveLength(0);
    expect(log.info).toHaveBeenCalledWith('Stale worktrees cleaned', expect.objectContaining({ repositories: 0, removed: 0, failed: 0 }));
  });

  it('skips entries that are not repositories', async () => {
    mkdirSync(join(repositoryDirectory('owner', 'plain'), 'sub'), { recursive: true });
    writeFileSync(join(workDir, '.fluent-flow', 'repos', 'owner', 'stray-file'), 'x');

    await cleanStaleWorktrees({ workDir, environment: BASE_ENVIRONMENT, log: logger() });

    expect(pruneCalls()).toHaveLength(0);
  });

  it('logs a redacted reason and continues when one repository fails to prune', async () => {
    const bad = makeRepository('owner', 'bad', ['claim-31']);
    const good = makeRepository('owner', 'good', ['claim-32']);
    mockExecFile.mockImplementation((_command, _args, options, callback) => {
      const done = callbackFrom(options, callback);
      if (options.cwd === bad) {
        const error = new Error(`prune failed for ${SECRET_GITHUB_TOKEN}`);
        error.stderr = SECRET_GITHUB_TOKEN;
        done(error, '', error.stderr);
        return;
      }
      done(null, '', '');
    });
    const log = logger();

    await cleanStaleWorktrees({ workDir, environment: BASE_ENVIRONMENT, log });

    expect(existsSync(join(good, '.worktrees', 'claim-32'))).toBe(false);
    expect(log.warn).toHaveBeenCalledWith('Stale worktree cleanup failed', expect.objectContaining({
      event: 'stale_worktree_cleanup_failed',
      repo: 'owner/bad',
      reason: 'prune failed for [REDACTED]',
    }));
    expect(JSON.stringify([log.info.mock.calls, log.warn.mock.calls, log.error.mock.calls])).not.toContain(SECRET_GITHUB_TOKEN);
    expect(log.info).toHaveBeenCalledWith('Stale worktrees cleaned', expect.objectContaining({ failed: 1 }));
  });

  it('fails loudly when the repository root cannot be read', async () => {
    writeFileSync(join(workDir, '.fluent-flow'), 'not a directory');

    await expect(cleanStaleWorktrees({ workDir, environment: BASE_ENVIRONMENT, log: logger() })).rejects.toThrow();
    expect(pruneCalls()).toHaveLength(0);
  });

  it('waits for an in-flight preparation of the same repository and never blocks another repository', async () => {
    const busy = makeRepository('owner', 'busy');
    makeRepository('owner', 'idle', ['claim-41']);
    const fetchStarted = deferred();
    let releaseFetch;
    mockExecFile.mockImplementation((_command, args, options, callback) => {
      const done = callbackFrom(options, callback);
      if (args[0] === 'fetch' && options.cwd === busy) {
        releaseFetch = () => done(null, '', '');
        fetchStarted.resolve();
        return;
      }
      done(null, args[0] === 'rev-parse' ? `${'0'.repeat(40)}\n` : '', '');
    });

    const preparation = prepareWorktree({
      workDir,
      repo: 'owner/busy',
      branch: 'main',
      claimId: 51,
      environment: BASE_ENVIRONMENT,
    });
    await fetchStarted.promise;
    const cleaning = cleanStaleWorktrees({ workDir, environment: BASE_ENVIRONMENT, log: logger() });
    await vi.waitFor(() => {
      expect(pruneCalls().some(([, , options]) => options.cwd === repositoryDirectory('owner', 'idle'))).toBe(true);
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(pruneCalls().some(([, , options]) => options.cwd === busy)).toBe(false);

    releaseFetch();
    await Promise.all([preparation, cleaning]);
    expect(pruneCalls().some(([, , options]) => options.cwd === busy)).toBe(true);
  });
});
