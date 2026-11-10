import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockExecFile = vi.fn();
const mockExistsSync = vi.fn();
const mockMkdirSync = vi.fn();
const mockRmSync = vi.fn();
const mockHomedir = vi.fn();

vi.mock('node:child_process', () => ({
  execFile: (...args) => mockExecFile(...args),
}));
vi.mock('node:fs', () => ({
  existsSync: (...args) => mockExistsSync(...args),
  mkdirSync: (...args) => mockMkdirSync(...args),
  rmSync: (...args) => mockRmSync(...args),
}));
vi.mock('node:os', () => ({
  homedir: (...args) => mockHomedir(...args),
}));

const { prepareWorktree, WorktreeRefUnavailableError } = await import('../../src/worktree.js');

const RESOLVED_SHA = '0123456789abcdef0123456789abcdef01234567';
const BASE_ENVIRONMENT = Object.freeze({
  PATH: '/portable/bin',
  HOME: '/slot/home',
  LANG: 'C.UTF-8',
});
const DEFAULT_INPUT = Object.freeze({
  workDir: '/work',
  repo: 'fluent-io/fluent-flow',
  prNumber: null,
  claimId: 123,
  branch: 'fix/something',
  environment: BASE_ENVIRONMENT,
});

function callbackFrom(options, callback) {
  return typeof options === 'function' ? options : callback;
}

function execOptions(call) {
  return typeof call[2] === 'function' ? {} : call[2];
}

function gitConfigEntries(environment) {
  const count = Number(environment.GIT_CONFIG_COUNT);
  expect(Number.isSafeInteger(count)).toBe(true);
  return Array.from({ length: count }, (_, index) => ({
    key: environment[`GIT_CONFIG_KEY_${index}`],
    value: environment[`GIT_CONFIG_VALUE_${index}`],
  }));
}

function expectClaimGitEnvironment(environment, baseEnvironment, githubToken) {
  expect(environment).toEqual(expect.objectContaining({
    ...baseEnvironment,
    GH_TOKEN: githubToken,
    GITHUB_TOKEN: githubToken,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: expect.any(String),
  }));
  const extraHeader = gitConfigEntries(environment).find(
    ({ key }) => key.toLowerCase() === 'http.https://github.com/.extraheader',
  );
  expect(extraHeader).toBeDefined();
  expect(extraHeader.value).toMatch(/^Authorization: Basic /u);
  expect(Buffer.from(extraHeader.value.slice('Authorization: Basic '.length), 'base64').toString('utf8'))
    .toBe(`x-access-token:${githubToken}`);
}

function prepare(overrides = {}) {
  return prepareWorktree({ ...DEFAULT_INPUT, ...overrides });
}

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function waitFor(predicate, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error('Timed out waiting for worktree state');
}

function installSuccessfulGitMock() {
  mockExecFile.mockImplementation((_command, args, options, callback) => {
    const done = callbackFrom(options, callback);
    if (args[0] === 'rev-parse') done(null, `${RESOLVED_SHA}\n`, '');
    else done(null, '', '');
  });
}

describe('prepareWorktree', () => {
  let savedEnvironment;

  beforeEach(() => {
    vi.clearAllMocks();
    savedEnvironment = { ...process.env };
    delete process.env.GH_TOKEN;
    delete process.env.GITHUB_TOKEN;
    delete process.env.SSH_AUTH_SOCK;
    mockHomedir.mockReturnValue('/root');
    mockExistsSync.mockImplementation((path) => String(path).endsWith('.git'));
    installSuccessfulGitMock();
  });

  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in savedEnvironment)) delete process.env[key];
    }
    Object.assign(process.env, savedEnvironment);
  });

  it('fetches an explicit ref, resolves FETCH_HEAD, and keys the detached worktree only by positive claim ID', async () => {
    const result = await prepare({ ref: 'feature/test', branch: undefined, prNumber: null });

    expect(result.worktreePath).toBe('/work/.fluent-flow/repos/fluent-io/fluent-flow/.worktrees/claim-123');
    expect(result.worktreePath).not.toContain('null');
    expect(result.worktreePath).not.toContain('pr-');
    const fetchCall = mockExecFile.mock.calls.find(([, args]) => (
      args[0] === 'fetch' && args[1] === 'origin' && args[2] === 'feature/test'
    ));
    const revParseCall = mockExecFile.mock.calls.find(([, args]) => args[0] === 'rev-parse');
    const worktreeCall = mockExecFile.mock.calls.find(([, args]) => args[0] === 'worktree' && args[1] === 'add');
    expect(fetchCall).toBeDefined();
    expect(revParseCall[1]).toEqual(['rev-parse', '--verify', 'FETCH_HEAD^{commit}']);
    expect(worktreeCall[1]).toEqual(['worktree', 'add', '--detach', result.worktreePath, RESOLVED_SHA]);
    expect(mockExecFile.mock.calls.indexOf(fetchCall)).toBeLessThan(mockExecFile.mock.calls.indexOf(worktreeCall));
  });

  it('accepts a pull ref and appends a safe purpose name to the claim path', async () => {
    const result = await prepare({
      claimId: 987,
      ref: 'refs/pull/123/head',
      branch: undefined,
      name: 'verify-red',
    });

    expect(result.worktreePath).toBe('/work/.fluent-flow/repos/fluent-io/fluent-flow/.worktrees/claim-987-verify-red');
    const worktreeCall = mockExecFile.mock.calls.find(([, args]) => args[0] === 'worktree' && args[1] === 'add');
    expect(worktreeCall[1]).toContain(RESOLVED_SHA);
  });

  it('retries an explicitly missing ref after refreshing origin', async () => {
    let explicitFetches = 0;
    mockExecFile.mockImplementation((_command, args, options, callback) => {
      const done = callbackFrom(options, callback);
      if (args[0] === 'fetch' && args[2] === 'abc123def456') {
        explicitFetches += 1;
        if (explicitFetches === 1) {
          done(new Error('could not find remote ref abc123def456'), '', 'could not find remote ref');
          return;
        }
      }
      if (args[0] === 'rev-parse') done(null, `${RESOLVED_SHA}\n`, '');
      else done(null, '', '');
    });

    await prepare({ ref: 'abc123def456', branch: undefined });

    expect(mockExecFile.mock.calls.filter(([, args]) => args[0] === 'fetch').map(([, args]) => args)).toEqual([
      ['fetch', 'origin', 'abc123def456'],
      ['fetch', 'origin'],
      ['fetch', 'origin', 'abc123def456'],
    ]);
  });

  it('wraps a still-missing explicit ref as WorktreeRefUnavailableError', async () => {
    mockExecFile.mockImplementation((_command, args, options, callback) => {
      const done = callbackFrom(options, callback);
      if (args[0] === 'fetch' && args[2] === 'abc123def456') {
        done(new Error('could not find remote ref abc123def456'), '', 'could not find remote ref');
        return;
      }
      done(null, '', '');
    });

    await expect(prepare({ ref: 'abc123def456', branch: undefined }))
      .rejects.toBeInstanceOf(WorktreeRefUnavailableError);
  });

  it('rethrows authentication and transport failures from the retry fetch', async () => {
    let explicitFetches = 0;
    mockExecFile.mockImplementation((_command, args, options, callback) => {
      const done = callbackFrom(options, callback);
      if (args[0] === 'fetch' && args[2] === 'abc123def456') {
        explicitFetches += 1;
        if (explicitFetches === 1) {
          done(new Error('could not find remote ref abc123def456'), '', 'could not find remote ref');
          return;
        }
        done(new Error('remote: Repository not found'), '', 'remote: Repository not found');
        return;
      }
      done(null, '', '');
    });

    const failure = prepare({ ref: 'abc123def456', branch: undefined });
    await expect(failure).rejects.toThrow('Repository not found');
    await expect(failure).rejects.not.toBeInstanceOf(WorktreeRefUnavailableError);
  });

  it.each([
    undefined,
    null,
    0,
    -1,
    1.5,
    Number.MAX_SAFE_INTEGER + 1,
    NaN,
    Infinity,
    '',
    '123',
    'claim-123',
    'claim/child',
    'claim\\child',
  ])('rejects missing, non-positive, non-safe, or string-shaped claim ID %s before filesystem or Git work', async (claimId) => {
    await expect(prepare({ claimId })).rejects.toThrow();
    expect(mockExistsSync).not.toHaveBeenCalled();
    expect(mockMkdirSync).not.toHaveBeenCalled();
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it.each([
    undefined,
    '',
    '../repo',
    './repo',
    'owner/.',
    'owner/..',
    'owner/repo/extra',
    'owner//repo',
    '/owner/repo',
    'owner/repo/',
    'owner\\repo',
    'owner\\repo\\extra',
  ])('rejects unsafe repository %s before filesystem or Git work', async (repo) => {
    await expect(prepare({ repo })).rejects.toThrow();
    expect(mockExistsSync).not.toHaveBeenCalled();
    expect(mockMkdirSync).not.toHaveBeenCalled();
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it.each(['bad/name', 'bad\\name', '.', '..'])('rejects unsafe purpose name %s before filesystem or Git work', async (name) => {
    await expect(prepare({ name })).rejects.toThrow(/worktree name/i);
    expect(mockExistsSync).not.toHaveBeenCalled();
    expect(mockMkdirSync).not.toHaveBeenCalled();
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it('clones a missing repository from its clean HTTPS remote', async () => {
    mockExistsSync.mockReturnValue(false);

    await prepare();

    const cloneCall = mockExecFile.mock.calls.find(([, args]) => args[0] === 'clone');
    expect(cloneCall[1]).toEqual([
      'clone',
      'https://github.com/fluent-io/fluent-flow.git',
      '/work/.fluent-flow/repos/fluent-io/fluent-flow',
    ]);
  });

  it('ignores an existing HOME SSH key and attempts only the clean HTTPS clone', async () => {
    mockExistsSync.mockImplementation((path) => String(path).endsWith('/.ssh/id_ed25519'));

    await prepare({ githubToken: 'claim-github-token' });

    const cloneArgs = mockExecFile.mock.calls
      .filter(([, args]) => args[0] === 'clone')
      .map(([, args]) => args);
    expect(cloneArgs).toEqual([[
      'clone',
      'https://github.com/fluent-io/fluent-flow.git',
      '/work/.fluent-flow/repos/fluent-io/fluent-flow',
    ]]);
    expect(JSON.stringify(mockExecFile.mock.calls.map(([, args]) => args))).not.toContain('git@github.com');
  });

  it('normalizes an existing SSH origin to the clean HTTPS origin before fetching', async () => {
    mockExecFile.mockImplementation((_command, args, options, callback) => {
      const done = callbackFrom(options, callback);
      if (args[0] === 'remote' && args[1] === 'get-url') {
        done(null, 'git@github.com:fluent-io/fluent-flow.git\n', '');
      } else if (args[0] === 'rev-parse') {
        done(null, `${RESOLVED_SHA}\n`, '');
      } else {
        done(null, '', '');
      }
    });

    await prepare({ githubToken: 'claim-github-token' });

    const setUrlCall = mockExecFile.mock.calls.find(([, args]) => (
      args[0] === 'remote' && args[1] === 'set-url'
    ));
    const fetchCall = mockExecFile.mock.calls.find(([, args]) => args[0] === 'fetch');
    expect(setUrlCall[1]).toEqual([
      'remote',
      'set-url',
      'origin',
      'https://github.com/fluent-io/fluent-flow.git',
    ]);
    expect(mockExecFile.mock.calls.indexOf(setUrlCall)).toBeLessThan(mockExecFile.mock.calls.indexOf(fetchCall));
  });

  it('keeps claim credentials in a fresh per-call environment and out of args and persisted remotes', async () => {
    const githubToken = 'ghp_plaintext_claim_token';
    const hostGithubToken = 'ghp_unrelated_host_token';
    const environment = Object.freeze({ ...BASE_ENVIRONMENT, SLOT_ID: 'slot-1' });
    process.env.GITHUB_TOKEN = hostGithubToken;
    process.env.UNRELATED_HOST_SECRET = 'host-secret-must-not-leak';
    mockExistsSync.mockReturnValue(false);

    const { cleanup } = await prepare({ environment, githubToken });
    await cleanup();

    const cleanRemote = 'https://github.com/fluent-io/fluent-flow.git';
    const cloneCall = mockExecFile.mock.calls.find(([, args]) => args[0] === 'clone');
    expect(cloneCall[1]).toContain(cleanRemote);
    for (const call of mockExecFile.mock.calls) {
      expect(JSON.stringify(call[1])).not.toContain(githubToken);
      expect(JSON.stringify(call[1])).not.toContain(hostGithubToken);
      expectClaimGitEnvironment(execOptions(call).env, environment, githubToken);
      expect(execOptions(call).env).not.toHaveProperty('UNRELATED_HOST_SECRET');
      expect(JSON.stringify(execOptions(call).env)).not.toContain(hostGithubToken);
      for (const [name, value] of Object.entries(execOptions(call).env)) {
        if (name === 'GH_TOKEN' || name === 'GITHUB_TOKEN') continue;
        expect(String(value)).not.toContain(githubToken);
      }
    }
    for (const [, args] of mockExecFile.mock.calls.filter(([, args]) => args[0] === 'remote')) {
      expect(args).not.toContainEqual(expect.stringContaining('@github.com'));
      if (args[1] === 'set-url') expect(args).toContain(cleanRemote);
    }
    expect(environment).toEqual({ ...BASE_ENVIRONMENT, SLOT_ID: 'slot-1' });
  });

  it('serializes shared-repository preparation mutations', async () => {
    const firstFetchStarted = deferred();
    let releaseFirstFetch;
    let fetchCount = 0;
    const events = [];
    mockExecFile.mockImplementation((_command, args, options, callback) => {
      const done = callbackFrom(options, callback);
      if (args[0] === 'fetch') {
        fetchCount += 1;
        events.push(`fetch-${fetchCount}`);
        if (fetchCount === 1) {
          releaseFirstFetch = () => done(null, '', '');
          firstFetchStarted.resolve();
          return;
        }
      }
      if (args[0] === 'worktree' && args[1] === 'add') {
        events.push(args[2].includes('claim-101') ? 'add-first' : 'add-second');
      }
      done(null, '', '');
    });

    const first = prepare({ claimId: 101 });
    await firstFetchStarted.promise;
    const second = prepare({ claimId: 102 });
    try {
      await Promise.resolve();
      await Promise.resolve();
      expect(fetchCount).toBe(1);
    } finally {
      releaseFirstFetch?.();
      await Promise.allSettled([first, second]);
    }
    expect(events.indexOf('add-first')).toBeLessThan(events.indexOf('fetch-2'));
  });

  it('allows different repositories to prepare concurrently', async () => {
    const firstFetchStarted = deferred();
    let releaseFirstFetch;
    let secondRepositoryFetches = 0;
    mockExecFile.mockImplementation((_command, args, options, callback) => {
      const done = callbackFrom(options, callback);
      if (args[0] === 'fetch' && options.cwd.includes('/repo-one')) {
        releaseFirstFetch = () => done(null, '', '');
        firstFetchStarted.resolve();
        return;
      }
      if (args[0] === 'fetch' && options.cwd.includes('/repo-two')) secondRepositoryFetches += 1;
      done(null, '', '');
    });

    const first = prepare({ repo: 'owner/repo-one', claimId: 201 });
    await firstFetchStarted.promise;
    const second = prepare({ repo: 'owner/repo-two', claimId: 202 });
    try {
      await waitFor(() => secondRepositoryFetches === 1, 500);
      await second;
    } finally {
      releaseFirstFetch?.();
      await Promise.allSettled([first, second]);
    }
  });

  it('serializes cleanup against later preparation for the same repository', async () => {
    mockExistsSync.mockReturnValue(true);
    const { cleanup } = await prepare({ claimId: 301 });
    vi.clearAllMocks();
    const removeStarted = deferred();
    let releaseRemove;
    let laterFetches = 0;
    mockExecFile.mockImplementation((_command, args, options, callback) => {
      const done = callbackFrom(options, callback);
      if (args[0] === 'worktree' && args[1] === 'remove') {
        releaseRemove = () => done(null, '', '');
        removeStarted.resolve();
        return;
      }
      if (args[0] === 'fetch') laterFetches += 1;
      done(null, '', '');
    });

    const removal = cleanup();
    await removeStarted.promise;
    const laterPreparation = prepare({ claimId: 302 });
    try {
      await Promise.resolve();
      await Promise.resolve();
      expect(laterFetches).toBe(0);
    } finally {
      releaseRemove?.();
      await Promise.allSettled([removal, laterPreparation]);
    }
    expect(laterFetches).toBe(1);
  });

  it('returns a claim path and removes that worktree during cleanup', async () => {
    mockExistsSync.mockReturnValue(true);
    const result = await prepare({ claimId: 303 });

    await result.cleanup();

    expect(result.worktreePath).toContain('claim-303');
    const removeCall = mockExecFile.mock.calls.find(([, args]) => args[0] === 'worktree' && args[1] === 'remove');
    expect(removeCall[1]).toEqual(['worktree', 'remove', result.worktreePath, '--force']);
  });

  it('does not throw when cleanup finds the worktree already removed', async () => {
    mockExistsSync.mockReturnValue(true);
    const { cleanup } = await prepare({ claimId: 304 });
    mockExecFile.mockImplementation((_command, args, options, callback) => {
      const done = callbackFrom(options, callback);
      const error = new Error('not a working tree');
      error.code = 128;
      done(error, '', 'fatal: path is not a working tree');
    });

    await expect(cleanup()).resolves.toBeUndefined();
  });
});
