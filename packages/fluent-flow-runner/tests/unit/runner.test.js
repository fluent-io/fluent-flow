import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockSpawn = vi.fn();
vi.mock('node:child_process', () => ({
  spawn: (...args) => mockSpawn(...args),
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
  return { info: vi.fn(), error: vi.fn(), debug: vi.fn() };
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
    it('executes agent command when work is received', async () => {
      const work = {
        event: 'review_failed',
        message: 'Fix the bug at src/index.js:5',
        repo: 'org/repo',
        prNumber: 7,
        attempt: 1,
        agentId: 'claude-dev',
      };

      let pollCount = 0;
      const client = makeClient({
        poll: vi.fn().mockImplementation(async () => {
          pollCount++;
          if (pollCount === 1) return work;
          return null;
        }),
      });

      mockSpawn.mockReturnValueOnce(fakeProcess(0));

      const resolveCmd = vi.fn().mockReturnValue('claude -p "Fix the bug"');

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
        expect.any(String),
        expect.any(Array),
        expect.objectContaining({ cwd: '/repo', shell: true }),
      );
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
        resolveCommand: vi.fn().mockReturnValue('echo ok'),
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
        resolveCommand: vi.fn().mockReturnValue('echo fail'),
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
  });
});
