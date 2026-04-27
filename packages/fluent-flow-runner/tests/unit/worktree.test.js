import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockExecFile = vi.fn();
const mockExistsSync = vi.fn();
const mockMkdirSync = vi.fn();
const mockHomedir = vi.fn();

vi.mock('node:child_process', () => ({
  execFile: (...args) => mockExecFile(...args),
}));
vi.mock('node:fs', () => ({
  existsSync: (...args) => mockExistsSync(...args),
  mkdirSync: (...args) => mockMkdirSync(...args),
}));
vi.mock('node:os', () => ({
  homedir: (...args) => mockHomedir(...args),
}));

const { prepareWorktree } = await import('../../src/worktree.js');

describe('worktree', () => {
  let savedEnv;

  beforeEach(() => {
    vi.clearAllMocks();
    savedEnv = { ...process.env };
    mockHomedir.mockReturnValue('/root');
    mockExecFile.mockImplementation((cmd, args, opts, cb) => {
      if (typeof opts === 'function') { opts(null, '', ''); return; }
      cb(null, '', '');
    });
  });

  afterEach(() => {
    // Restore env to avoid cross-test mutation
    for (const key of Object.keys(process.env)) {
      if (!(key in savedEnv)) delete process.env[key];
    }
    Object.assign(process.env, savedEnv);
  });

  describe('prepareWorktree', () => {
    it('clones repo when base clone does not exist (plain HTTPS fallback)', async () => {
      mockExistsSync.mockReturnValue(false);
      delete process.env.SSH_AUTH_SOCK;
      delete process.env.GITHUB_TOKEN;

      await prepareWorktree({
        workDir: '/work',
        repo: 'fluent-io/fluent-flow',
        prNumber: 40,
        attempt: 1,
        branch: 'fix/something',
      });

      const cloneCall = mockExecFile.mock.calls.find(c => c[1].includes('clone'));
      expect(cloneCall).toBeDefined();
      // Should use plain HTTPS when no SSH key and no GITHUB_TOKEN
      expect(cloneCall[1]).toContain('https://github.com/fluent-io/fluent-flow.git');
      expect(cloneCall[1][2]).toContain('fluent-flow'); // baseDir path
    });

    it('clones via SSH when SSH key is detected', async () => {
      mockExistsSync.mockImplementation((p) => {
        if (p.includes('id_ed25519')) return true;
        return false;
      });
      delete process.env.SSH_AUTH_SOCK;
      delete process.env.GITHUB_TOKEN;

      await prepareWorktree({
        workDir: '/work',
        repo: 'fluent-io/fluent-flow',
        prNumber: 40,
        attempt: 1,
        branch: 'fix/something',
      });

      const cloneCall = mockExecFile.mock.calls.find(c => c[1].includes('clone'));
      expect(cloneCall).toBeDefined();
      expect(cloneCall[1]).toContain('git@github.com:fluent-io/fluent-flow.git');
    });

    it('clones via HTTPS with token when GITHUB_TOKEN is set', async () => {
      mockExistsSync.mockReturnValue(false);
      delete process.env.SSH_AUTH_SOCK;
      process.env.GITHUB_TOKEN = 'ghp_testtoken123';

      await prepareWorktree({
        workDir: '/work',
        repo: 'fluent-io/fluent-flow',
        prNumber: 40,
        attempt: 1,
        branch: 'fix/something',
      });

      const cloneCall = mockExecFile.mock.calls.find(c => c[1].includes('clone'));
      expect(cloneCall).toBeDefined();
      // Should use x-access-token URL auth
      expect(cloneCall[1]).toContain('https://x-access-token:ghp_testtoken123@github.com/fluent-io/fluent-flow.git');
    });

    it('tries SSH first when both SSH key and GITHUB_TOKEN are available', async () => {
      mockExistsSync.mockImplementation((p) => {
        if (p.includes('id_ed25519')) return true;
        return false;
      });
      delete process.env.SSH_AUTH_SOCK;
      process.env.GITHUB_TOKEN = 'ghp_testtoken123';

      await prepareWorktree({
        workDir: '/work',
        repo: 'fluent-io/fluent-flow',
        prNumber: 40,
        attempt: 1,
        branch: 'fix/something',
      });

      const cloneCall = mockExecFile.mock.calls.find(c => c[1].includes('clone'));
      expect(cloneCall).toBeDefined();
      expect(cloneCall[1]).toContain('git@github.com:fluent-io/fluent-flow.git');
    });

    it('falls back to HTTPS when SSH fails and GITHUB_TOKEN is set', async () => {
      mockExistsSync.mockImplementation((p) => {
        if (p.includes('id_ed25519')) return true;
        return false;
      });
      delete process.env.SSH_AUTH_SOCK;
      process.env.GITHUB_TOKEN = 'ghp_testtoken123';

      // SSH clone fails, HTTPS with token succeeds
      let callCount = 0;
      mockExecFile.mockImplementation((cmd, args, opts, cb) => {
        callCount++;
        if (typeof opts === 'function') { opts(null, '', ''); return; }
        if (callCount === 1) {
          // First call (SSH clone) fails
          cb(new Error('Permission denied (publickey)'));
          return;
        }
        cb(null, '', '');
      });

      await prepareWorktree({
        workDir: '/work',
        repo: 'fluent-io/fluent-flow',
        prNumber: 40,
        attempt: 1,
        branch: 'fix/something',
      });

      const cloneCalls = mockExecFile.mock.calls.filter(c => c[1].includes('clone'));
      expect(cloneCalls).toHaveLength(2);
      // First attempt: SSH
      expect(cloneCalls[0][1]).toContain('git@github.com:fluent-io/fluent-flow.git');
      // Second attempt: HTTPS with x-access-token URL auth
      expect(cloneCalls[1][1]).toContain('https://x-access-token:ghp_testtoken123@github.com/fluent-io/fluent-flow.git');
    });

    it('falls back to plain HTTPS when token clone fails', async () => {
      mockExistsSync.mockReturnValue(false);
      delete process.env.SSH_AUTH_SOCK;
      process.env.GITHUB_TOKEN = 'ghp_testtoken123';

      // First clone attempt (token HTTPS) fails, second (plain HTTPS) succeeds
      let callCount = 0;
      mockExecFile.mockImplementation((cmd, args, opts, cb) => {
        callCount++;
        if (typeof opts === 'function') { opts(null, '', ''); return; }
        if (callCount === 1 && args.includes('clone')) {
          // Token-based clone fails
          cb(new Error('HTTP 401 Bad credentials'));
          return;
        }
        cb(null, '', '');
      });

      await prepareWorktree({
        workDir: '/work',
        repo: 'fluent-io/fluent-flow',
        prNumber: 40,
        attempt: 1,
        branch: 'fix/something',
      });

      const cloneCalls = mockExecFile.mock.calls.filter(c => c[1].includes('clone'));
      expect(cloneCalls).toHaveLength(2);
      // First attempt: HTTPS with x-access-token URL auth
      expect(cloneCalls[0][1]).toContain('https://x-access-token:ghp_testtoken123@github.com/fluent-io/fluent-flow.git');
      // Second attempt: plain HTTPS (no token in URL)
      expect(cloneCalls[1][1]).toContain('https://github.com/fluent-io/fluent-flow.git');
      expect(cloneCalls[1][1].some(a => a.includes('x-access-token'))).toBe(false);
    });

    it('throws when all clone attempts fail', async () => {
      mockExistsSync.mockReturnValue(false);
      delete process.env.SSH_AUTH_SOCK;
      process.env.GITHUB_TOKEN = 'ghp_testtoken123';

      mockExecFile.mockImplementation((cmd, args, opts, cb) => {
        if (typeof opts === 'function') { opts(new Error('fail')); return; }
        cb(new Error('fail'));
      });

      await expect(
        prepareWorktree({
          workDir: '/work',
          repo: 'fluent-io/fluent-flow',
          prNumber: 40,
          attempt: 1,
          branch: 'fix/something',
        }),
      ).rejects.toThrow('fail');
    });

    it('skips clone when base clone exists', async () => {
      mockExistsSync.mockImplementation((p) => {
        if (p.endsWith('.git')) return true;
        return false;
      });

      await prepareWorktree({
        workDir: '/work',
        repo: 'fluent-io/fluent-flow',
        prNumber: 40,
        attempt: 1,
        branch: 'fix/something',
      });

      const cloneCalls = mockExecFile.mock.calls.filter(c => c[1][0] === 'clone');
      expect(cloneCalls).toHaveLength(0);
    });

    it('fetches latest before creating worktree', async () => {
      mockExistsSync.mockImplementation((p) => {
        if (p.endsWith('.git')) return true;
        return false;
      });

      await prepareWorktree({
        workDir: '/work',
        repo: 'fluent-io/fluent-flow',
        prNumber: 40,
        attempt: 1,
        branch: 'fix/something',
      });

      const fetchCalls = mockExecFile.mock.calls.filter(c => c[1][0] === 'fetch');
      expect(fetchCalls.length).toBeGreaterThanOrEqual(1);
    });

    it('creates worktree and returns path + cleanup function', async () => {
      mockExistsSync.mockImplementation((p) => {
        if (p.endsWith('.git')) return true;
        return false;
      });

      const result = await prepareWorktree({
        workDir: '/work',
        repo: 'fluent-io/fluent-flow',
        prNumber: 40,
        attempt: 1,
        branch: 'fix/something',
      });

      expect(result.worktreePath).toContain('pr-40-attempt-1');
      expect(typeof result.cleanup).toBe('function');

      const worktreeCalls = mockExecFile.mock.calls.filter(c => c[1][0] === 'worktree' && c[1][1] === 'add');
      expect(worktreeCalls).toHaveLength(1);
    });

    it('cleanup removes the worktree', async () => {
      mockExistsSync.mockImplementation((p) => {
        if (p.endsWith('.git')) return true;
        return false;
      });

      const { cleanup } = await prepareWorktree({
        workDir: '/work',
        repo: 'fluent-io/fluent-flow',
        prNumber: 40,
        attempt: 1,
        branch: 'fix/something',
      });

      await cleanup();

      const removeCalls = mockExecFile.mock.calls.filter(c => c[1][0] === 'worktree' && c[1][1] === 'remove');
      expect(removeCalls).toHaveLength(1);
      expect(removeCalls[0][1].some(a => a.includes('pr-40-attempt-1'))).toBe(true);
    });

    it('cleanup does not throw if worktree already removed', async () => {
      mockExistsSync.mockImplementation((p) => {
        if (p.endsWith('.git')) return true;
        return false;
      });

      const { cleanup } = await prepareWorktree({
        workDir: '/work',
        repo: 'fluent-io/fluent-flow',
        prNumber: 40,
        attempt: 1,
        branch: 'fix/something',
      });

      mockExecFile.mockImplementation((cmd, args, opts, cb) => {
        if (typeof opts === 'function') { opts(new Error('not a worktree')); return; }
        cb(new Error('not a worktree'));
      });

      await expect(cleanup()).resolves.toBeUndefined();
    });
  });
});
