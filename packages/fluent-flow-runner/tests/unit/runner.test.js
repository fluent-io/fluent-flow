import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockSpawn = vi.fn();
vi.mock('node:child_process', () => ({
  spawn: (...args) => mockSpawn(...args),
}));

const mockPrepareWorktree = vi.fn();
vi.mock('../../src/worktree.js', () => ({
  prepareWorktree: (...args) => mockPrepareWorktree(...args),
}));

const mockRunVerifyClaim = vi.fn();
vi.mock('../../src/verify.js', () => ({
  runVerifyClaim: (...args) => mockRunVerifyClaim(...args),
}));

vi.mock('../../src/health.js', () => ({
  // Inline implementations (not mockResolvedValue) so vi.resetAllMocks in
  // per-describe beforeEach hooks restores these healthy defaults.
  checkRunnerHealth: vi.fn(async () => ({ healthy: true, harness: { ok: true, detail: 'mock' }, gh: { ok: true, detail: 'mock' } })),
  sendAlert: vi.fn(async () => ({ sent: false, configured: false })),
}));

import { sendAlert } from '../../src/health.js';
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
  // Real ChildProcess listeners are additive — store arrays, not one handler.
  const handlers = {};
  const proc = {
    on: vi.fn((event, cb) => { (handlers[event] ??= []).push(cb); }),
    stdout: { on: vi.fn() },
    stderr: { on: vi.fn() },
    kill: vi.fn(),
    pid: 1234,
  };
  // Auto-emit 'close' on next tick
  setTimeout(() => (handlers.close ?? []).forEach((cb) => cb(exitCode)), 10);
  return proc;
}

/** Helper: create a fake process that never exits (for shutdown tests) */
function hangingProcess() {
  const handlers = {};
  const proc = {
    on: vi.fn((event, cb) => { (handlers[event] ??= []).push(cb); }),
    stdout: { on: vi.fn() },
    stderr: { on: vi.fn() },
    kill: vi.fn(() => {
      // Simulate SIGTERM → close
      setTimeout(() => (handlers.close ?? []).forEach((cb) => cb(143)), 10);
    }),
    pid: 5678,
  };
  return proc;
}

describe('runner', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRunVerifyClaim.mockReset();
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
      expect(client.register).toHaveBeenCalledWith({
        hostname: 'test',
        supported_claim_types: ['spec', 'build', 'review', 'review_fix', 'test_verify', 'verify'],
      });
    });

    it('preserves explicit supported claim types when registering a constrained runner', async () => {
      const client = makeClient();
      const runner = createRunner({
        client,
        log: makeLogger(),
        resolveCommand: vi.fn(),
        meta: { hostname: 'test', supported_claim_types: ['review', 'review_fix'] },
      });

      const startPromise = runner.start();
      await new Promise((r) => setTimeout(r, 50));
      runner.shutdown();
      await startPromise;

      expect(client.register).toHaveBeenCalledWith({
        hostname: 'test',
        supported_claim_types: ['review', 'review_fix'],
      });
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
        agentType: 'claude-code',
      };

      let pollCount = 0;
      const client = makeClient({
        poll: vi.fn().mockImplementation(async () => {
          pollCount++;
          return pollCount === 1 ? work : null;
        }),
      });

      mockSpawn.mockReturnValueOnce(fakeProcess(0));

      const resolveCmd = vi.fn().mockImplementation(({ prompt }) => ({
        bin: 'claude',
        args: ['-p', prompt],
      }));

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
        prompt: expect.stringContaining('Fix the bug at src/index.js:5'),
      }));
      const resolvedPrompt = resolveCmd.mock.calls[0][0].prompt;
      expect(mockSpawn).toHaveBeenCalledWith(
        'claude',
        ['-p', resolvedPrompt],
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
        agentType: 'claude-code',
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

    it('passes all env vars through to agent subprocess', async () => {
      // Set a fake API key in process.env
      process.env.__TEST_API_KEY = 'test-key-value';

      const work = {
        event: 'review_failed',
        message: 'Fix it',
        repo: 'org/repo',
        prNumber: 7,
        attempt: 1,
        agentType: 'claude-code',
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
      // Env must contain the explicitly passed var
      expect(spawnEnv.FLUENT_FLOW_PROMPT).toBe('Fix it');
      // Env must contain process.env vars (e.g. API keys for AI agents)
      expect(spawnEnv.__TEST_API_KEY).toBe('test-key-value');
      // Env must contain PATH
      expect(spawnEnv.PATH).toBeDefined();

      delete process.env.__TEST_API_KEY;
    });

    it('reports completed when agent exits 0', async () => {
      const work = {
        event: 'review_failed',
        message: 'Fix it',
        repo: 'org/repo',
        prNumber: 7,
        attempt: 1,
        agentType: 'claude-code',
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
        agentType: 'claude-code',
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
        agentType: 'claude-code',
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
        agentType: 'claude-code',
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
        on: vi.fn((event, cb) => { (handlers[event] ??= []).push(cb); }),
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
      setTimeout(() => (handlers.close ?? []).forEach((cb) => cb(1)), 200);
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
        agentType: 'claude-code',
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
        on: vi.fn((event, cb) => { (handlers[event] ??= []).push(cb); }),
        stdout: { on: vi.fn() },
        stderr: { on: vi.fn() },
        kill: vi.fn(() => {
          const err = new Error('No such process');
          err.code = 'ESRCH';
          throw err;
        }),
        pid: 9998,
      };
      setTimeout(() => (handlers.close ?? []).forEach((cb) => cb(1)), 200);
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

  describe('claim_type prompt resolution', () => {
    it('resolves prompt from claim_type via resolvePrompt', async () => {
      const work = {
        event: 'claim_created',
        claim_type: 'spec',
        message: 'Build the feature',
        repo: 'org/repo',
        prNumber: 10,
        attempt: 1,
        branch: 'feature/x',
        agentType: 'claude-code',
      };

      let pollCount = 0;
      const client = makeClient({
        poll: vi.fn().mockImplementation(async () => {
          pollCount++;
          return pollCount === 1 ? work : null;
        }),
      });

      const mockResolveCommand = vi.fn().mockReturnValue({ bin: 'claude', args: ['-p', 'prompt'] });
      mockSpawn.mockReturnValueOnce(fakeProcess(0));
      mockPrepareWorktree.mockResolvedValueOnce({ worktreePath: '/wt', cleanup: vi.fn() });

      const runner = createRunner({ client, log: makeLogger(), resolveCommand: mockResolveCommand, cwd: '/repo' });
      const startPromise = runner.start();
      await new Promise((r) => setTimeout(r, 80));
      runner.shutdown();
      await startPromise;

      expect(mockResolveCommand).toHaveBeenCalled();
      const promptArg = mockResolveCommand.mock.calls[0][0].prompt;
      expect(promptArg).toContain('docs/specs/');
      expect(promptArg).toContain('org/repo');
    });

    it('defaults to review_fix when claim_type is not provided', async () => {
      const work = {
        event: 'review_failed',
        message: 'Fix the bug',
        repo: 'org/repo',
        prNumber: 7,
        attempt: 1,
        agentType: 'claude-code',
      };

      let pollCount = 0;
      const client = makeClient({
        poll: vi.fn().mockImplementation(async () => {
          pollCount++;
          return pollCount === 1 ? work : null;
        }),
      });

      const mockResolveCommand = vi.fn().mockReturnValue({ bin: 'claude', args: ['-p', 'prompt'] });
      mockSpawn.mockReturnValueOnce(fakeProcess(0));

      const runner = createRunner({ client, log: makeLogger(), resolveCommand: mockResolveCommand });
      const startPromise = runner.start();
      await new Promise((r) => setTimeout(r, 80));
      runner.shutdown();
      await startPromise;

      const promptArg = mockResolveCommand.mock.calls[0][0].prompt;
      expect(promptArg).toContain('Fix the bug');
      expect(promptArg).toContain('fix agent');
    });

    it('routes verify claims through runVerifyClaim and reports verification results', async () => {
      const work = {
        event: 'claim_created',
        claim_id: 55,
        claim_type: 'verify',
        repo: 'org/repo',
        prNumber: 11,
        attempt: 2,
        head_sha: 'b'.repeat(40),
        phase: 'red',
        red_base_sha: 'a'.repeat(40),
        verification: { timeouts_min: { red: 15, green: 30 } },
        agentType: 'claude-code',
      };

      let pollCount = 0;
      const client = makeClient({
        poll: vi.fn().mockImplementation(async () => {
          pollCount++;
          return pollCount === 1 ? work : null;
        }),
      });

      mockRunVerifyClaim.mockResolvedValueOnce({
        status: 'completed',
        verification: {
          phase: 'red',
          framework: 'vitest',
          outcome: 'PASS',
          matrix: { requirements: [], suite: { total: 0, passed: 0, failed: 0, flaky: 0, skipped: 0 }, schema_version: 1 },
        },
      });

      const runner = createRunner({
        client,
        log: makeLogger(),
        resolveCommand: vi.fn(),
        cwd: '/repo',
      });

      const startPromise = runner.start();
      await new Promise((r) => setTimeout(r, 80));
      runner.shutdown();
      await startPromise;

      expect(mockRunVerifyClaim).toHaveBeenCalledWith(expect.objectContaining({
        work,
        client,
        sessionId: 1,
        cwd: '/repo',
        resolveCommand: expect.any(Function),
        execute: expect.any(Function),
      }));
      expect(client.reportClaim).toHaveBeenCalledWith(expect.objectContaining({
        claim_id: 55,
        status: 'completed',
        verification: {
          phase: 'red',
          framework: 'vitest',
          outcome: 'PASS',
          matrix: { requirements: [], suite: { total: 0, passed: 0, failed: 0, flaky: 0, skipped: 0 }, schema_version: 1 },
        },
      }));
      expect(mockPrepareWorktree).not.toHaveBeenCalled();
    });

    it('reports unknown claim types as terminal failed claims', async () => {
      const work = {
        event: 'claim_created',
        claim_id: 73,
        claim_type: 'mystery',
        repo: 'org/repo',
        prNumber: 9,
        attempt: 4,
        agentType: 'claude-code',
      };

      let pollCount = 0;
      const client = makeClient({
        poll: vi.fn().mockImplementation(async () => {
          pollCount++;
          return pollCount === 1 ? work : null;
        }),
      });

      const runner = createRunner({
        client,
        log: makeLogger(),
        resolveCommand: vi.fn(),
      });

      const startPromise = runner.start();
      await new Promise((r) => setTimeout(r, 80));
      runner.shutdown();
      await startPromise;

      expect(mockRunVerifyClaim).not.toHaveBeenCalled();
      expect(client.reportClaim).toHaveBeenCalledWith({
        status: 'failed',
        repo: 'org/repo',
        pr_number: 9,
        attempt: 4,
        claim_id: 73,
        failure_kind: 'terminal',
      });
    });
  });

  describe('410 session expiry re-registration', () => {
    it('re-registers and resumes polling on 410', async () => {
      vi.useFakeTimers();

      let pollCallCount = 0;
      let registeredSessionIds = [];

      const client = makeClient({
        poll: vi.fn().mockImplementation(async (sid) => {
          pollCallCount++;
          if (pollCallCount === 1) {
            throw new Error('Poll failed: 410 — session expired');
          }
          return null; // subsequent polls return no work
        }),
        register: vi.fn().mockImplementation(async (meta) => {
          const sessionId = registeredSessionIds.length + 100; // new session IDs
          registeredSessionIds.push(sessionId);
          return { ok: true, session_id: sessionId, status: 'online' };
        }),
      });

      const log = makeLogger();
      const runner = createRunner({
        client,
        log,
        resolveCommand: vi.fn(),
        maxPollFailures: 3,
      });

      const startPromise = runner.start();
      // Advance through initial registration + first poll (410) + re-register + second poll
      await vi.advanceTimersByTimeAsync(5000);
      runner.shutdown();
      await vi.advanceTimersByTimeAsync(1000);
      await startPromise;

      vi.useRealTimers();

      // register should have been called twice: initial + re-register after 410
      expect(client.register).toHaveBeenCalledTimes(2);

      // poll should have been called with the new session ID after re-registration
      expect(client.poll).toHaveBeenCalledWith(100); // first registration session
      expect(client.poll).toHaveBeenCalledWith(101); // re-registered session

      // consecutiveFailures should have been reset, so circuit breaker should NOT have tripped
      expect(log.error).not.toHaveBeenCalledWith(
        'Max consecutive poll failures reached, stopping runner',
        expect.anything(),
      );
    });

    it('continues backoff when re-registration fails', async () => {
      vi.useFakeTimers();

      let pollCallCount = 0;
      let regCallCount = 0;

      const client = makeClient({
        poll: vi.fn().mockImplementation(async () => {
          pollCallCount++;
          throw new Error('Poll failed: 410 — session expired');
        }),
        register: vi.fn().mockImplementation(async () => {
          regCallCount++;
          if (regCallCount === 1) return { ok: true, session_id: 1, status: 'online' }; // initial registration
          throw new Error('Re-registration failed'); // re-register fails
        }),
      });

      const log = makeLogger();
      const runner = createRunner({
        client,
        log,
        resolveCommand: vi.fn(),
        maxPollFailures: 5,
      });

      const startPromise = runner.start();
      await vi.advanceTimersByTimeAsync(60000);
      await startPromise;

      vi.useRealTimers();

      // Should have logged the re-registration failure
      expect(log.error).toHaveBeenCalledWith(
        'Re-registration failed',
        expect.objectContaining({ error: 'Re-registration failed' }),
      );

      // Should have eventually hit the circuit breaker since re-reg kept failing
      expect(log.error).toHaveBeenCalledWith(
        'Max consecutive poll failures reached, stopping runner',
        expect.anything(),
      );
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
