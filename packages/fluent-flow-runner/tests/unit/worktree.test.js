import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockExecFile = vi.fn();
const mockExistsSync = vi.fn();
const mockMkdirSync = vi.fn();

vi.mock('node:child_process', () => ({
  execFile: (...args) => mockExecFile(...args),
}));
vi.mock('node:fs', () => ({
  existsSync: (...args) => mockExistsSync(...args),
  mkdirSync: (...args) => mockMkdirSync(...args),
}));

const { prepareWorktree } = await import('../../src/worktree.js');

describe('worktree', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExecFile.mockImplementation((cmd, args, opts, cb) => {
      if (typeof opts === 'function') { opts(null, '', ''); return; }
      cb(null, '', '');
    });
  });

  describe('prepareWorktree', () => {
    it('clones repo when base clone does not exist', async () => {
      mockExistsSync.mockReturnValue(false);

      await prepareWorktree({
        workDir: '/work',
        repo: 'fluent-io/fluent-flow',
        prNumber: 40,
        attempt: 1,
        branch: 'fix/something',
      });

      expect(mockExecFile).toHaveBeenCalledWith(
        'git', ['clone', 'https://github.com/fluent-io/fluent-flow.git', expect.stringContaining('fluent-flow')],
        expect.anything(),
        expect.any(Function)
      );
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
