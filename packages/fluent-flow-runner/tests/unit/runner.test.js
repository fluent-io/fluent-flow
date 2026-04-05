import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockSpawn = vi.fn();
vi.mock('node:child_process', () => ({
  spawn: (...args) => mockSpawn(...args),
}));

const mockPrepareWorktree = vi.fn();
vi.mock('../../src/worktree.js', () => ({
  prepareWorktree: (...args) => mockPrepareWorktree(...args),
}));

import { createRunner } from '../../src/runner.js';

function makeClient(overrides = {}) {
  return {
    register: vi.fn().mockResolvedValue({ ok: true, session_id: 1, status: 'online' }),
    poll: vi.fn().mockResolvedValue(null),
    reportClaim: vi.fn().mockResolvedValue({ ok: true, claim_id: 1, status: 'completed' }),
    ...overrides,
  };
}

function makeLogger() {
  return { info: vi.fn(), error: vi.fn(), debug: vi.fn(), warn: vi.fn() };
}

/** Helper: create a fake child process that exits with given code */
function fakeProcess(exitCode = 0) {
  const handlers = {};
  const proc = {
    on: vi.fn((event, cb) => { handlers[event] = cb; }),
    stdout: { on: vi.fn() },
    stderr: { on: vi.fn() },
    kill: vi.fn(),
    pid: 1234,
  };
  // Auto-emit 'close' on next tick
  setTimeout(() => handlers.close?.(exitCode), 10);
  return proc;
}

/** Helper: create a fake process that never exits (for shutdown tests) */
function hangingProcess() {
  const handlers = {};
  const proc = {
    on: vi.fn((event, cb) => { handlers[event] = cb; }),
    stdout: { on: vi.fn() },
    stderr: { on: vi.fn() },
    kill: vi.fn(() => {
      // Simulate SIGTERM → close
      setTimeout(() => handlers.close?.(143), 10);
    }),
    pid: 5678,
  };
  return proc;
}

describe('runner', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('createRunner()', () => {
    it('returns an object with start() and shutdown()', () => {
      const runner = createRunner({
        client: makeClient(),
        log: makeLogger(),
        resolveCommand: vi.fn(),
      });
      expect(typeof runner.start).toBe('function');
      expect(typeof runner.shutdown).toBe('function');
    });
  });

  describe('start()', () => {
    it('registers a session on start', async () => {
      const client = makeClient();
      const runner = createRunner({
        client,
        log: makeLogger(),
        resolveCommand: vi.fn(),
        meta: { hostname: 'test' },
      });
      const startPromise = runner.start();
      await new Promise((r) => setTimeout(r, 50));
      runner.shutdown();
      await startPromise;
      expect(client.register).toHaveBeenCalledWith({ hostname: 'test' });
    });

    it('polls after registration', async () => {
      const client = makeClient();
      const runner = createRunner({
        client,
        log: makeLogger(),
        resolveCommand: vi.fn(),
      });
      const startPromise = runner.start();
      await new Promise((r) => setTimeout(r, 50));
      runner.shutdown();
      await startPromise;
      expect(client.poll).toHaveBeenCalledWith(1);
    });
  });

  describe('work execution', () => {
    it('spawns with shell: false for built-in agent types ({ bin, args })', async () => {
      const work = {
        event: 'review_failed',
        message: 'Fix the bug at src/index.js:5',
        repo: 'org/repo',
        prNumber: 7,
        attempt: 1,
      };

      let pollCount = 0;
      const client = makeClient({
        poll: vi.fn().mockImplementation(async () => {
          pollCount++;
          return pollCount === 1 ? work : null;
        }),
      });

      mockSpawn.mockReturnValueOnce(fakeProcess(0));

      const resolveCmd = vi.fn().mockReturnValue({
        bin: 'claude',
        args: ['-p', 'Fix the bug at src/index.js:5'],
      });

      const runner = createRunner({
        client,
        log: makeLogger(),
        resolveCommand: resolveCmd,
        cwd: '/repo',
      });

      const startPromise = runner.start();
      await new Promise((r) => setTimeout(r, 100));
      runner.shutdown();
      await startPromise;

      expect(resolveCmd).toHaveBeenCalledWith(expect.objectContaining({
        prompt: 'Fix the bug at src/index.js:5',
      }));
      expect(mockSpawn).toHaveBeenCalledWith(
        'claude',
        ['-p', 'Fix the bug at src/index.js:5'],
        expect.objectContaining({ cwd: '/repo', shell: false }),
      );
    });

    it('spawns with shell: true and passes env vars for custom templates ({ shell, env })', async () => {
      const work = {
        event: 'review_failed',
        message: 'Fix it',
        repo: 'org/repo',
        prNumber: 7,
        attempt: 1,
      };

      let pollCount = 0;
      const client = makeClient({
        poll: vi.fn().mockImplementation(async () => {
          pollCount++;
          return pollCount === 1 ? work : null;
        }),
      });

      mockSpawn.mockReturnValueOnce(fakeProcess(0));

      const promptEnv = { FLUENT_FLOW_PROMPT: 'Fix it' };
      const runner = createRunner({
        client,
        log: makeLogger(),
        resolveCommand: vi.fn().mockReturnValue({
          shell: 'my-agent "$FLUENT_FLOW_PROMPT"',
          env: promptEnv,
        }),
      });

      const startPromise = runner.start();
      await new Promise((r) => setTimeout(r, 100));
      runner.shutdown();
      await startPromise;

      expect(mockSpawn).toHaveBeenCalledWith(
        'my-agent "$FLUENT_FLOW_PROMPT"',
        [],
        expect.objectContaining({
          shell: true,
          env: expect.objectContaining(promptEnv),
        }),
      );
    });

    it('uses an isolated environment for shell commands (no full process.env leak)', async () => {
      // Set a fake secret in process.env
      process.env.__TEST_SECRET_KEY = 'super-secret';

      const work = {
        event: 'review_failed',
        message: 'Fix it',
        repo: 'org/repo',
        prNumber: 7,
        attempt: 1,
      };

      let pollCount = 0;
      const client = makeClient({
        poll: vi.fn().mockImplementation(async () => {
          pollCount++;
          return pollCount === 1 ? work : null;
        }),
      });

      mockSpawn.mockReturnValueOnce(fakeProcess(0));

      const runner = createRunner({
        client,
        log: makeLogger(),
        resolveCommand: vi.fn().mockReturnValue({
          shell: 'my-agent "$FLUENT_FLOW_PROMPT"',
          env: { FLUENT_FLOW_PROMPT: 'Fix it' },
        }),
      });

      const startPromise = runner.start();
      await new Promise((r) => setTimeout(r, 100));
      runner.shutdown();
      await startPromise;

      const spawnEnv = mockSpawn.mock.calls[0][2].env;
      // Isolated env must contain the explicitly passed var
      expect(spawnEnv.FLUENT_FLOW_PROMPT).toBe('Fix it');
      // Isolated env must contain PATH (essential)
      expect(spawnEnv.PATH).toBeDefined();
      // Isolated env must NOT contain the fake secret
      expect(spawnEnv.__TEST_SECRET_KEY).toBeUndefined();

      delete process.env.__TEST_SECRET_KEY;
    });

    it('reports completed when agent exits 0', async () => {
      const work = {
        event: 'review_failed',
        message: 'Fix it',
        repo: 'org/repo',
        prNumber: 7,
        attempt: 1,
      };

      let pollCount = 0;
      const client = makeClient({
        poll: vi.fn().mockImplementation(async () => {
          pollCount++;
          return pollCount === 1 ? work : null;
        }),
      });

      mockSpawn.mockReturnValueOnce(fakeProcess(0));

      const runner = createRunner({
        client,
        log: makeLogger(),
        resolveCommand: vi.fn().mockReturnValue({ bin: 'echo', args: ['ok'] }),
      });

      const startPromise = runner.start();
      await new Promise((r) => setTimeout(r, 100));
      runner.shutdown();
      await startPromise;

      expect(client.reportClaim).toHaveBeenCalledWith({
        status: 'completed',
        repo: 'org/repo',
        pr_number: 7,
        attempt: 1,
      });
    });

    it('reports failed when agent exits non-zero', async () => {
      const work = {
        event: 'review_failed',
        message: 'Fix it',
        repo: 'org/repo',
        prNumber: 7,
        attempt: 1,
      };

      let pollCount = 0;
      const client = makeClient({
        poll: vi.fn().mockImplementation(async () => {
          pollCount++;
          return pollCount === 1 ? work : null;
        }),
      });

      mockSpawn.mockReturnValueOnce(fakeProcess(1));

      const runner = createRunner({
        client,
        log: makeLogger(),
        resolveCommand: vi.fn().mockReturnValue({ bin: 'echo', args: ['fail'] }),
      });

      const startPromise = runner.start();
      await new Promise((r) => setTimeout(r, 100));
      runner.shutdown();
      await startPromise;

      expect(client.reportClaim).toHaveBeenCalledWith({
        status: 'failed',
        repo: 'org/repo',
        pr_number: 7,
        attempt: 1,
      });
    });
  });

  describe('shutdown()', () => {
    it('stops the poll loop', async () => {
      const client = makeClient();
      const runner = createRunner({
        client,
        log: makeLogger(),
        resolveCommand: vi.fn(),
      });
      const startPromise = runner.start();
      await new Promise((r) => setTimeout(r, 50));
      runner.shutdown();
      await startPromise;
      const pollCountAtShutdown = client.poll.mock.calls.length;
      await new Promise((r) => setTimeout(r, 100));
      expect(client.poll.mock.calls.length).toBe(pollCountAtShutdown);
    });

    it('reports active claim as failed on shutdown', async () => {
      const work = {
        event: 'review_failed',
        message: 'Fix it',
        repo: 'org/repo',
        prNumber: 7,
        attempt: 2,
      };

      let pollCount = 0;
      const client = makeClient({
        poll: vi.fn().mockImplementation(async () => {
          pollCount++;
          return pollCount === 1 ? work : null;
        }),
      });

      // Use a hanging process so the agent is still running when shutdown is called
      mockSpawn.mockReturnValueOnce(hangingProcess());

      const runner = createRunner({
        client,
        log: makeLogger(),
        resolveCommand: vi.fn().mockReturnValue({ bin: 'long-agent', args: [] }),
      });

      const startPromise = runner.start();
      // Wait for work to be picked up and agent to start
      await new Promise((r) => setTimeout(r, 50));

      // Shutdown while agent is running
      await runner.shutdown();
      await startPromise;

      // Should have reported the active claim as failed
      expect(client.reportClaim).toHaveBeenCalledWith({
        status: 'failed',
        repo: 'org/repo',
        pr_number: 7,
        attempt: 2,
      });
    });
  });

  describe('shutdown() kill error handling', () => {
    it('logs a warning when kill fails with unexpected error', async () => {
      const work = {
        event: 'review_failed',
        message: 'Fix it',
        repo: 'org/repo',
        prNumber: 7,
        attempt: 1,
      };

      let pollCount = 0;
      const client = makeClient({
        poll: vi.fn().mockImplementation(async () => {
          pollCount++;
          return pollCount === 1 ? work : null;
        }),
      });

      // Build a process where kill throws but close still fires
      const handlers = {};
      const proc = {
        on: vi.fn((event, cb) => { handlers[event] = cb; }),
        stdout: { on: vi.fn() },
        stderr: { on: vi.fn() },
        kill: vi.fn(() => {
          const err = new Error('Operation not permitted');
          err.code = 'EPERM';
          throw err;
        }),
        pid: 9999,
      };
      // Process exits on its own after a tick (simulating already-dying)
      setTimeout(() => handlers.close?.(1), 200);
      mockSpawn.mockReturnValueOnce(proc);

      const log = makeLogger();
      const runner = createRunner({
        client,
        log,
        resolveCommand: vi.fn().mockReturnValue({ bin: 'agent', args: [] }),
      });

      const startPromise = runner.start();
      await new Promise((r) => setTimeout(r, 50));
      await runner.shutdown();
      await new Promise((r) => setTimeout(r, 300));
      await startPromise;

      expect(log.warn).toHaveBeenCalledWith(
        'Failed to kill agent process',
        expect.objectContaining({ error: 'Operation not permitted', code: 'EPERM' }),
      );
    });

    it('silently ignores ESRCH (process already exited)', async () => {
      const work = {
        event: 'review_failed',
        message: 'Fix it',
        repo: 'org/repo',
        prNumber: 7,
        attempt: 1,
      };

      let pollCount = 0;
      const client = makeClient({
        poll: vi.fn().mockImplementation(async () => {
          pollCount++;
          return pollCount === 1 ? work : null;
        }),
      });

      const handlers = {};
      const proc = {
        on: vi.fn((event, cb) => { handlers[event] = cb; }),
        stdout: { on: vi.fn() },
        stderr: { on: vi.fn() },
        kill: vi.fn(() => {
          const err = new Error('No such process');
          err.code = 'ESRCH';
          throw err;
        }),
        pid: 9998,
      };
      setTimeout(() => handlers.close?.(1), 200);
      mockSpawn.mockReturnValueOnce(proc);

      const log = makeLogger();
      const runner = createRunner({
        client,
        log,
        resolveCommand: vi.fn().mockReturnValue({ bin: 'agent', args: [] }),
      });

      const startPromise = runner.start();
      await new Promise((r) => setTimeout(r, 50));
      await runner.shutdown();
      await new Promise((r) => setTimeout(r, 300));
      await startPromise;

      expect(log.warn).not.toHaveBeenCalled();
    });
  });

  describe('poll failure circuit breaker', () => {
    it('stops runner after max consecutive poll failures', async () => {
      vi.useFakeTimers();
      const log = makeLogger();
      const client = makeClient({
        poll: vi.fn().mockRejectedValue(new Error('network down')),
      });

      const runner = createRunner({
        client,
        log,
        resolveCommand: vi.fn(),
        maxPollFailures: 3,
      });

      const startPromise = runner.start();
      // Advance through backoff delays: 2s + 4s + exit
      await vi.advanceTimersByTimeAsync(10000);
      await startPromise;

      vi.useRealTimers();

      expect(client.poll.mock.calls.length).toBe(3);
      expect(log.error).toHaveBeenCalledWith(
        'Max consecutive poll failures reached, stopping runner',
        expect.objectContaining({ consecutiveFailures: 3, maxFailures: 3 }),
      );
    });

    it('resets failure count on successful poll', async () => {
      vi.useFakeTimers();
      let callCount = 0;
      const client = makeClient({
        poll: vi.fn().mockImplementation(async () => {
          callCount++;
          // Fail twice, succeed once, then fail twice more, succeed → total 6+ calls without hitting max(3)
          if (callCount <= 2) throw new Error('fail');
          if (callCount === 3) return null; // success resets counter
          if (callCount <= 5) throw new Error('fail again');
          if (callCount === 6) return null; // another success
          return null;
        }),
      });

      const runner = createRunner({
        client,
        log: makeLogger(),
        resolveCommand: vi.fn(),
        maxPollFailures: 3,
      });

      const startPromise = runner.start();
      // Advance enough time for all backoff cycles
      await vi.advanceTimersByTimeAsync(30000);
      runner.shutdown();
      await vi.advanceTimersByTimeAsync(1000);
      await startPromise;

      vi.useRealTimers();

      // Runner should still be alive past 5 total failures because resets happened
      expect(client.poll.mock.calls.length).toBeGreaterThan(5);
    });
  });

  describe('worktree integration', () => {
    it('creates worktree and runs agent in worktree cwd', async () => {
      const mockCleanup = vi.fn().mockResolvedValue();
      mockPrepareWorktree.mockResolvedValueOnce({
        worktreePath: '/work/.fluent-flow/repos/fluent-io/fluent-flow/.worktrees/pr-40-attempt-1',
        cleanup: mockCleanup,
      });
      mockSpawn.mockReturnValueOnce(fakeProcess(0));

      const client = makeClient({
        poll: vi.fn()
          .mockResolvedValueOnce({
            message: 'fix the bug',
            repo: 'fluent-io/fluent-flow',
            pr_number: 40,
            attempt: 1,
            branch: 'fix/something',
            agentType: 'claude-code',
          })
          .mockResolvedValue(null),
      });
      const log = makeLogger();
      const runner = createRunner({ client, log, resolveCommand: (opts) => ({ bin: 'claude', args: [opts.prompt] }) });

      const startPromise = runner.start();
      await new Promise((r) => setTimeout(r, 50));
      await runner.shutdown();
      await startPromise;

      expect(mockPrepareWorktree).toHaveBeenCalledWith(expect.objectContaining({
        repo: 'fluent-io/fluent-flow',
        prNumber: 40,
        attempt: 1,
        branch: 'fix/something',
      }));

      const spawnCall = mockSpawn.mock.calls[0];
      expect(spawnCall[2].cwd).toBe('/work/.fluent-flow/repos/fluent-io/fluent-flow/.worktrees/pr-40-attempt-1');

      expect(mockCleanup).toHaveBeenCalled();
    });

    it('cleans up worktree even if agent fails', async () => {
      const mockCleanup = vi.fn().mockResolvedValue();
      mockPrepareWorktree.mockResolvedValueOnce({
        worktreePath: '/work/.fluent-flow/repos/o/r/.worktrees/pr-1-attempt-1',
        cleanup: mockCleanup,
      });
      mockSpawn.mockReturnValueOnce(fakeProcess(1));

      const client = makeClient({
        poll: vi.fn()
          .mockResolvedValueOnce({
            message: 'fix', repo: 'o/r', pr_number: 1, attempt: 1, branch: 'fix/x', agentType: 'claude-code',
          })
          .mockResolvedValue(null),
      });
      const log = makeLogger();
      const runner = createRunner({ client, log, resolveCommand: (opts) => ({ bin: 'claude', args: [opts.prompt] }) });

      const startPromise = runner.start();
      await new Promise((r) => setTimeout(r, 50));
      await runner.shutdown();
      await startPromise;

      expect(mockCleanup).toHaveBeenCalled();
    });

    it('skips worktree when branch is not provided', async () => {
      mockSpawn.mockReturnValueOnce(fakeProcess(0));

      const client = makeClient({
        poll: vi.fn()
          .mockResolvedValueOnce({
            message: 'fix', repo: 'o/r', pr_number: 1, attempt: 1, agentType: 'claude-code',
          })
          .mockResolvedValue(null),
      });
      const log = makeLogger();
      const runner = createRunner({ client, log, resolveCommand: (opts) => ({ bin: 'claude', args: [opts.prompt] }) });

      const startPromise = runner.start();
      await new Promise((r) => setTimeout(r, 50));
      await runner.shutdown();
      await startPromise;

      expect(mockPrepareWorktree).not.toHaveBeenCalled();
    });
  });
});
