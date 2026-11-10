import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockPrepareWorktree = vi.fn();
vi.mock('../../src/worktree.js', () => ({ prepareWorktree: (...args) => mockPrepareWorktree(...args) }));

import { createRunner } from '../../src/runner.js';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function log() {
  return { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn(), isDebug: vi.fn(() => false) };
}

function api(overrides = {}) {
  return {
    register: vi.fn(async () => ({ session_id: 'registration-1', status: 'online' })),
    poll: vi.fn(async () => null),
    heartbeat: vi.fn(async () => ({ ok: true })),
    reportClaim: vi.fn(async () => ({ ok: true })),
    postClaimEvents: vi.fn(async () => ({ ok: true })),
    postClaimRequest: vi.fn(async () => ({ ok: true })),
    pollClaimCommands: vi.fn(async () => ({ commands: [] })),
    ackClaimCommand: vi.fn(async () => ({ ok: true })),
    ...overrides,
  };
}

function runtime(runInitialPrompt = vi.fn(async () => ({ sessionId: 'acp-1', messageId: 'm-1', stopReason: 'end_turn' }))) {
  return {
    runInitialPrompt,
    prompt: vi.fn(),
    cancel: vi.fn(),
    answerRequest: vi.fn(),
    close: vi.fn(async () => undefined),
    exited: Promise.resolve({ code: 0, signal: null, error: null }),
  };
}

const WORK = { claim_id: 42, claim_type: 'review_fix', message: 'Fix it', repo: 'org/repo', pr_number: 7, attempt: 1, agentType: 'claude-code' };

async function waitFor(predicate, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error('Timed out waiting for runner');
}

function makeRunner(client, acpRuntime, options = {}) {
  return createRunner({
    client,
    log: log(),
    createAcpRuntime: vi.fn(() => acpRuntime),
    cwd: '/repo',
    acpCommand: 'agent',
    commandPollMs: 1,
    ...options,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockPrepareWorktree.mockResolvedValue({ worktreePath: '/worktree', cleanup: vi.fn(async () => undefined) });
});

describe('heartbeat', () => {
  it('continues heartbeating while the ACP turn is pending and stops before report', async () => {
    const turn = deferred();
    const client = api({ poll: vi.fn().mockResolvedValueOnce(WORK).mockResolvedValue(null) });
    const runner = makeRunner(client, runtime(vi.fn(() => turn.promise)), { heartbeatIntervalMs: 5 });
    const started = runner.start();
    await waitFor(() => client.heartbeat.mock.calls.length >= 2);
    turn.resolve({ sessionId: 'acp', messageId: 'm', stopReason: 'end_turn' });
    await waitFor(() => client.reportClaim.mock.calls.length === 1);
    const count = client.heartbeat.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(client.heartbeat).toHaveBeenCalledWith('registration-1', 42);
    expect(client.heartbeat).toHaveBeenCalledTimes(count);
    await runner.shutdown();
    await started;
  });

});

describe('shutdown mid-claim', () => {
  it('closes the runtime, waits for it, cleans the worktree, and reports one transient failure', async () => {
    const turn = deferred();
    const exited = deferred();
    const cleanup = vi.fn(async () => undefined);
    mockPrepareWorktree.mockResolvedValueOnce({ worktreePath: '/worktree', cleanup });
    const acpRuntime = runtime(vi.fn(() => turn.promise));
    acpRuntime.exited = exited.promise;
    acpRuntime.close.mockImplementationOnce(async () => {
      turn.reject(new Error('closed for shutdown'));
      exited.resolve({ code: 0, signal: null, error: null });
      await exited.promise;
    });
    const client = api({ poll: vi.fn().mockResolvedValueOnce({ ...WORK, branch: 'fix/x' }).mockResolvedValue(null) });
    const runner = makeRunner(client, acpRuntime);
    const started = runner.start();
    await waitFor(() => acpRuntime.runInitialPrompt.mock.calls.length === 1);
    const first = runner.shutdown();
    const second = runner.shutdown();
    await Promise.all([first, second, started]);
    expect(acpRuntime.close).toHaveBeenCalledTimes(1);
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(client.reportClaim).toHaveBeenCalledTimes(1);
    expect(client.reportClaim).toHaveBeenCalledWith(expect.objectContaining({
      claim_id: 42,
      session_id: 'registration-1',
      status: 'failed',
      failure_kind: 'transient',
    }));
  });

  it('closes and reports without waiting for an indefinitely pending command poll', async () => {
    const turn = deferred();
    let pollAborted = false;
    const order = [];
    const acpRuntime = runtime(vi.fn(() => turn.promise));
    acpRuntime.close.mockImplementationOnce(async () => {
      order.push('close');
      turn.reject(new Error('closed for shutdown'));
    });
    const client = api({
      poll: vi.fn().mockResolvedValueOnce(WORK).mockResolvedValue(null),
      pollClaimCommands: vi.fn((_sessionId, _claimId, { signal }) => new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          pollAborted = true;
          reject(new Error('command poll aborted'));
        }, { once: true });
      })),
      reportClaim: vi.fn(async () => {
        order.push('report');
        return { ok: true };
      }),
    });
    const runner = makeRunner(client, acpRuntime);
    const started = runner.start();
    await waitFor(() => client.pollClaimCommands.mock.calls.length === 1);
    const completion = Promise.race([
      runner.shutdown().then(() => 'shutdown'),
      new Promise((resolve) => setTimeout(() => resolve('timed-out'), 200)),
    ]);
    await expect(completion).resolves.toBe('shutdown');
    expect(pollAborted).toBe(true);
    expect(order).toEqual(['close', 'report']);
    expect(client.reportClaim).toHaveBeenCalledWith(expect.objectContaining({
      status: 'failed',
      failure_kind: 'transient',
    }));
    await started;
  });

  it('does not start ACP when a claim poll resolves after shutdown', async () => {
    const polled = deferred();
    const acpRuntime = runtime();
    const client = api({
      poll: vi.fn((_sessionId, { signal }) => {
        expect(signal).toBeInstanceOf(AbortSignal);
        return polled.promise;
      }),
    });
    const runner = makeRunner(client, acpRuntime);
    const started = runner.start();
    await waitFor(() => client.poll.mock.calls.length === 1);

    await runner.shutdown();
    polled.resolve(WORK);
    await started;

    expect(mockPrepareWorktree).not.toHaveBeenCalled();
    expect(acpRuntime.runInitialPrompt).not.toHaveBeenCalled();
    expect(client.reportClaim).toHaveBeenCalledWith(expect.objectContaining({
      claim_id: 42,
      session_id: 'registration-1',
      status: 'failed',
      failure_kind: 'transient',
    }));
  });
});

describe('claim report retry', () => {
  it('retries transient report failures and preserves the owned payload', async () => {
    vi.useFakeTimers();
    try {
      const client = api({
        poll: vi.fn().mockResolvedValueOnce(WORK).mockResolvedValue(null),
        reportClaim: vi.fn().mockRejectedValueOnce(new Error('Claim report failed: 500')).mockResolvedValueOnce({ ok: true }),
      });
      const runner = makeRunner(client, runtime());
      const started = runner.start();
      await vi.advanceTimersByTimeAsync(1001);
      await Promise.resolve();
      expect(client.reportClaim).toHaveBeenCalledTimes(2);
      expect(client.reportClaim.mock.calls[0][0]).toEqual(client.reportClaim.mock.calls[1][0]);
      expect(client.reportClaim.mock.calls[1][0]).toMatchObject({ claim_id: 42, session_id: 'registration-1', status: 'completed' });
      await runner.shutdown();
      await vi.advanceTimersByTimeAsync(200);
      await started;
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it('does not retry a permanent report rejection', async () => {
    const client = api({
      poll: vi.fn().mockResolvedValueOnce(WORK).mockResolvedValue(null),
      reportClaim: vi.fn(async () => { throw new Error('Claim report failed: 409'); }),
    });
    const runner = makeRunner(client, runtime());
    const started = runner.start();
    await waitFor(() => client.reportClaim.mock.calls.length === 1);
    await runner.shutdown();
    await started;
    expect(client.reportClaim).toHaveBeenCalledTimes(1);
  });
});

describe('poll reliability', () => {
  it('re-registers immediately after a 410 and polls with the new session', async () => {
    const client = api({
      register: vi.fn().mockResolvedValueOnce({ session_id: 'old', status: 'online' }).mockResolvedValueOnce({ session_id: 'new', status: 'online' }),
      poll: vi.fn().mockRejectedValueOnce(new Error('Poll failed: 410 — expired')).mockResolvedValue(null),
    });
    const runner = makeRunner(client, runtime());
    const started = runner.start();
    await waitFor(() => client.poll.mock.calls.some(([session]) => session === 'new'));
    await runner.shutdown();
    await started;
    expect(client.register).toHaveBeenCalledTimes(2);
    expect(client.poll.mock.calls.slice(0, 2).map(([session]) => session)).toEqual(['old', 'new']);
  });

  it('opens the poll circuit after the configured consecutive failure limit', async () => {
    vi.useFakeTimers();
    try {
      const client = api({ poll: vi.fn(async () => { throw new Error('offline'); }) });
      const runner = makeRunner(client, runtime(), { maxPollFailures: 3 });
      const started = runner.start();
      const rejected = expect(started).rejects.toThrow('Poll failure circuit opened');
      await vi.advanceTimersByTimeAsync(10_000);
      await rejected;
      expect(client.poll).toHaveBeenCalledTimes(3);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it('resets the circuit after a successful poll', async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      const client = api({
        poll: vi.fn(async () => {
          calls += 1;
          if ([1, 2, 4, 5].includes(calls)) throw new Error('offline');
          return null;
        }),
      });
      const runner = makeRunner(client, runtime(), { maxPollFailures: 3 });
      const started = runner.start();
      await vi.advanceTimersByTimeAsync(30_000);
      await runner.shutdown();
      await vi.advanceTimersByTimeAsync(200);
      await started;
      expect(client.poll.mock.calls.length).toBeGreaterThan(5);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });
});

function scriptedPolls() {
  const pending = [];
  const poll = vi.fn(() => {
    const call = deferred();
    pending.push(call);
    return call.promise;
  });
  return { poll, pending };
}

async function stopScripted(runner, started, polls) {
  const stopping = runner.shutdown();
  for (const call of polls.pending) call.resolve(null);
  await vi.advanceTimersByTimeAsync(60_000);
  await stopping;
  await started;
}

describe('health getters on the real runner', () => {
  it('starts with zero poll failures and no cleanup failure', () => {
    const runner = makeRunner(api(), runtime());

    expect(runner.consecutivePollFailures).toBe(0);
    expect(runner.cleanupFailed).toBe(false);
  });

  it('increments consecutivePollFailures once per failed poll', async () => {
    vi.useFakeTimers();
    try {
      const polls = scriptedPolls();
      const runner = makeRunner(api({ poll: polls.poll }), runtime());
      const started = runner.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(polls.pending).toHaveLength(1);
      expect(runner.consecutivePollFailures).toBe(0);

      polls.pending[0].reject(new Error('offline'));
      await vi.advanceTimersByTimeAsync(0);
      expect(runner.consecutivePollFailures).toBe(1);

      await vi.advanceTimersByTimeAsync(2000);
      expect(polls.pending).toHaveLength(2);
      polls.pending[1].reject(new Error('offline'));
      await vi.advanceTimersByTimeAsync(0);
      expect(runner.consecutivePollFailures).toBe(2);

      await vi.advanceTimersByTimeAsync(4000);
      expect(polls.pending).toHaveLength(3);
      polls.pending[2].reject(new Error('offline'));
      await vi.advanceTimersByTimeAsync(0);
      expect(runner.consecutivePollFailures).toBe(3);

      await stopScripted(runner, started, polls);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it('resets consecutivePollFailures to zero after a successful poll', async () => {
    vi.useFakeTimers();
    try {
      const polls = scriptedPolls();
      const runner = makeRunner(api({ poll: polls.poll }), runtime());
      const started = runner.start();
      await vi.advanceTimersByTimeAsync(0);
      polls.pending[0].reject(new Error('offline'));
      await vi.advanceTimersByTimeAsync(0);
      expect(runner.consecutivePollFailures).toBe(1);

      await vi.advanceTimersByTimeAsync(2000);
      expect(polls.pending).toHaveLength(2);
      polls.pending[1].resolve(null);
      await vi.advanceTimersByTimeAsync(0);

      expect(runner.consecutivePollFailures).toBe(0);
      await stopScripted(runner, started, polls);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it('resets consecutivePollFailures to zero after a 410 re-registration', async () => {
    vi.useFakeTimers();
    try {
      const polls = scriptedPolls();
      const client = api({
        poll: polls.poll,
        register: vi.fn()
          .mockResolvedValueOnce({ session_id: 'old', status: 'online' })
          .mockResolvedValueOnce({ session_id: 'new', status: 'online' }),
      });
      const runner = makeRunner(client, runtime());
      const started = runner.start();
      await vi.advanceTimersByTimeAsync(0);
      polls.pending[0].reject(new Error('offline'));
      await vi.advanceTimersByTimeAsync(0);
      expect(runner.consecutivePollFailures).toBe(1);

      await vi.advanceTimersByTimeAsync(2000);
      expect(polls.pending).toHaveLength(2);
      polls.pending[1].reject(new Error('Poll failed: 410 — expired'));
      await vi.advanceTimersByTimeAsync(0);

      expect(client.register).toHaveBeenCalledTimes(2);
      expect(runner.sessionId).toBe('new');
      expect(runner.consecutivePollFailures).toBe(0);
      await stopScripted(runner, started, polls);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it('resets consecutivePollFailures to zero when start is called again after a circuit opened', async () => {
    vi.useFakeTimers();
    try {
      const polls = scriptedPolls();
      const runner = makeRunner(api({ poll: polls.poll }), runtime(), { maxPollFailures: 2 });
      const first = runner.start();
      const rejected = expect(first).rejects.toThrow('Poll failure circuit opened');
      await vi.advanceTimersByTimeAsync(0);
      polls.pending[0].reject(new Error('offline'));
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(2000);
      polls.pending[1].reject(new Error('offline'));
      await vi.advanceTimersByTimeAsync(0);
      await rejected;
      expect(runner.consecutivePollFailures).toBe(2);

      const second = runner.start();
      await vi.advanceTimersByTimeAsync(0);

      expect(polls.pending).toHaveLength(3);
      expect(runner.consecutivePollFailures).toBe(0);
      await stopScripted(runner, second, polls);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it('reports cleanupFailed after a rejected cleanup without changing the claim result, then clears it after a clean claim', async () => {
    const FIRST_WORK = { ...WORK, branch: 'fix/x' };
    const SECOND_WORK = { ...WORK, branch: 'fix/y', claim_id: 43 };
    mockPrepareWorktree
      .mockResolvedValueOnce({ worktreePath: '/worktree', cleanup: vi.fn(async () => { throw new Error('rm failed'); }) })
      .mockResolvedValueOnce({ worktreePath: '/worktree', cleanup: vi.fn(async () => undefined) });
    const firstReported = deferred();
    const secondReported = deferred();
    const secondPollGate = deferred();
    let polls = 0;
    const client = api({
      poll: vi.fn(async () => {
        polls += 1;
        if (polls === 1) return FIRST_WORK;
        if (polls === 2) {
          await secondPollGate.promise;
          return SECOND_WORK;
        }
        return null;
      }),
      reportClaim: vi.fn(async (payload) => {
        if (payload.claim_id === 42) firstReported.resolve();
        if (payload.claim_id === 43) secondReported.resolve();
        return { ok: true };
      }),
    });
    const runner = makeRunner(client, runtime());
    expect(runner.cleanupFailed).toBe(false);
    const started = runner.start();

    await firstReported.promise;
    expect(client.reportClaim).toHaveBeenCalledWith(expect.objectContaining({ claim_id: 42, status: 'completed' }));
    expect(runner.cleanupFailed).toBe(true);

    secondPollGate.resolve();
    await secondReported.promise;
    expect(client.reportClaim).toHaveBeenCalledWith(expect.objectContaining({ claim_id: 43, status: 'completed' }));
    expect(runner.cleanupFailed).toBe(false);

    await runner.shutdown();
    await started;
  });
});

describe('worktree cleanup failure logging', () => {
  it('logs a redacted reason through log.error and leaves the claim result unchanged', async () => {
    mockPrepareWorktree.mockResolvedValue({
      worktreePath: '/worktree',
      cleanup: vi.fn(async () => { throw new Error('cleanup failed: ff_secret_cleanup_token'); }),
    });
    const reported = deferred();
    const logger = log();
    const client = api({
      poll: vi.fn().mockResolvedValueOnce({ ...WORK, branch: 'fix/x' }).mockResolvedValue(null),
      reportClaim: vi.fn(async () => {
        reported.resolve();
        return { ok: true };
      }),
    });
    const runner = makeRunner(client, runtime(), { log: logger });
    const started = runner.start();

    await reported.promise;
    await runner.shutdown();
    await started;

    expect(client.reportClaim).toHaveBeenCalledWith(expect.objectContaining({ claim_id: 42, status: 'completed' }));
    const cleanupLogs = logger.error.mock.calls.filter(([, fields]) => String(fields?.reason ?? '').includes('cleanup failed'));
    expect(cleanupLogs).toHaveLength(1);
    expect(typeof cleanupLogs[0][0]).toBe('string');
    expect(cleanupLogs[0][1].reason).toBe('cleanup failed: [REDACTED]');
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain('ff_secret_cleanup_token');
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('ff_secret_cleanup_token');
  });
});

function pendingPollAfter(work) {
  let served = false;
  return vi.fn((_sessionId, { signal } = {}) => {
    if (!served) {
      served = true;
      return Promise.resolve(work);
    }
    return new Promise((_resolve, reject) => {
      signal?.addEventListener('abort', () => reject(new Error('poll aborted')), { once: true });
    });
  });
}

function timeoutRunner(client, acpRuntime, options = {}) {
  const logger = log();
  const runner = makeRunner(client, acpRuntime, {
    log: logger,
    heartbeatIntervalMs: 0,
    commandPollMs: 1000,
    ...options,
  });
  return { runner, logger };
}

function timedOutLogs(logger) {
  return logger.warn.mock.calls.filter(([message]) => message === 'Claim execution timed out');
}

describe('claim execution timeout', () => {
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('cancels the runtime, cleans the worktree, and reports one transient failure at the deadline', async () => {
    vi.useFakeTimers();
    const cleanup = vi.fn(async () => undefined);
    mockPrepareWorktree.mockResolvedValueOnce({ worktreePath: '/worktree', cleanup });
    const acpRuntime = runtime(vi.fn(() => new Promise(() => {})));
    const client = api({ poll: pendingPollAfter({ ...WORK, branch: 'fix/x' }) });
    const { runner, logger } = timeoutRunner(client, acpRuntime, { executionTimeoutMs: 60_000 });
    const started = runner.start();
    await vi.advanceTimersByTimeAsync(10);
    expect(acpRuntime.runInitialPrompt).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(59_000);
    expect(acpRuntime.close).not.toHaveBeenCalled();
    expect(client.reportClaim).not.toHaveBeenCalled();
    expect(timedOutLogs(logger)).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(timedOutLogs(logger)).toHaveLength(1);
    expect(timedOutLogs(logger)[0][1]).toMatchObject({ claimId: 42, repo: 'org/repo', attempt: 1 });
    expect(acpRuntime.close).toHaveBeenCalledTimes(1);
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(client.reportClaim).toHaveBeenCalledTimes(1);
    expect(client.reportClaim).toHaveBeenCalledWith(expect.objectContaining({
      claim_id: 42,
      session_id: 'registration-1',
      status: 'failed',
      failure_kind: 'transient',
    }));

    await vi.advanceTimersByTimeAsync(7_200_000);
    expect(client.reportClaim).toHaveBeenCalledTimes(1);
    expect(acpRuntime.close).toHaveBeenCalledTimes(1);
    expect(timedOutLogs(logger)).toHaveLength(1);
    await runner.shutdown();
    await started;
    expect(client.reportClaim).toHaveBeenCalledTimes(1);
  });

  it('defaults to a one-hour limit', async () => {
    vi.useFakeTimers();
    const acpRuntime = runtime(vi.fn(() => new Promise(() => {})));
    const client = api({ poll: pendingPollAfter(WORK) });
    const { runner, logger } = timeoutRunner(client, acpRuntime);
    const started = runner.start();
    await vi.advanceTimersByTimeAsync(10);

    await vi.advanceTimersByTimeAsync(3_599_000);
    expect(acpRuntime.close).not.toHaveBeenCalled();
    expect(client.reportClaim).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1_000);
    expect(timedOutLogs(logger)).toHaveLength(1);
    expect(client.reportClaim).toHaveBeenCalledTimes(1);
    expect(client.reportClaim).toHaveBeenCalledWith(expect.objectContaining({
      status: 'failed',
      failure_kind: 'transient',
    }));
    await runner.shutdown();
    await started;
  });

  it('rejects a non-positive or non-finite execution timeout', () => {
    for (const executionTimeoutMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, '60000']) {
      expect(() => makeRunner(api(), runtime(), { executionTimeoutMs })).toThrow();
    }
  });

  it('leaves no pending timer after a claim completes before the deadline', async () => {
    vi.useFakeTimers();
    const acpRuntime = runtime();
    const client = api({ poll: pendingPollAfter(WORK) });
    const { runner, logger } = timeoutRunner(client, acpRuntime, { executionTimeoutMs: 60_000 });
    const started = runner.start();
    await vi.advanceTimersByTimeAsync(10);

    expect(client.reportClaim).toHaveBeenCalledTimes(1);
    expect(client.reportClaim).toHaveBeenCalledWith(expect.objectContaining({ status: 'completed' }));
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(timedOutLogs(logger)).toHaveLength(0);
    expect(acpRuntime.close).toHaveBeenCalledTimes(1);
    expect(client.reportClaim).toHaveBeenCalledTimes(1);
    await runner.shutdown();
    await started;
  });

  it('leaves no pending timer after the ACP turn fails before the deadline', async () => {
    vi.useFakeTimers();
    const acpRuntime = runtime(vi.fn(async () => { throw new Error('ACP transport closed'); }));
    const client = api({ poll: pendingPollAfter(WORK) });
    const { runner, logger } = timeoutRunner(client, acpRuntime, { executionTimeoutMs: 60_000 });
    const started = runner.start();
    await vi.advanceTimersByTimeAsync(10);

    expect(client.reportClaim).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(timedOutLogs(logger)).toHaveLength(0);
    expect(client.reportClaim).toHaveBeenCalledTimes(1);
    await runner.shutdown();
    await started;
  });

  it('does not fire after claim ownership is lost and never reports', async () => {
    vi.useFakeTimers();
    const turn = deferred();
    const acpRuntime = runtime(vi.fn(() => turn.promise));
    const client = api({
      poll: pendingPollAfter(WORK),
      heartbeat: vi.fn(async () => ({ claim: null })),
    });
    const { runner, logger } = timeoutRunner(client, acpRuntime, {
      executionTimeoutMs: 60_000,
      heartbeatIntervalMs: 100,
    });
    const started = runner.start();
    await vi.advanceTimersByTimeAsync(250);
    expect(acpRuntime.close).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(120_000);
    expect(timedOutLogs(logger)).toHaveLength(0);
    expect(acpRuntime.close).toHaveBeenCalledTimes(1);
    expect(client.reportClaim).not.toHaveBeenCalled();

    turn.reject(new Error('closed after ownership loss'));
    await vi.advanceTimersByTimeAsync(10);
    expect(vi.getTimerCount()).toBe(0);
    expect(client.reportClaim).not.toHaveBeenCalled();
    await runner.shutdown();
    await started;
  });

  it('does not fire after shutdown and reports only the shutdown transient failure', async () => {
    vi.useFakeTimers();
    const turn = deferred();
    const acpRuntime = runtime(vi.fn(() => turn.promise));
    acpRuntime.close.mockImplementationOnce(async () => {
      turn.reject(new Error('closed for shutdown'));
    });
    const client = api({ poll: pendingPollAfter(WORK) });
    const { runner, logger } = timeoutRunner(client, acpRuntime, { executionTimeoutMs: 60_000 });
    const started = runner.start();
    await vi.advanceTimersByTimeAsync(10);

    const stopping = runner.shutdown();
    await vi.advanceTimersByTimeAsync(10);
    await stopping;
    await started;
    expect(client.reportClaim).toHaveBeenCalledTimes(1);
    expect(client.reportClaim).toHaveBeenCalledWith(expect.objectContaining({
      status: 'failed',
      failure_kind: 'transient',
    }));
    expect(vi.getTimerCount()).toBe(0);

    await vi.advanceTimersByTimeAsync(120_000);
    expect(timedOutLogs(logger)).toHaveLength(0);
    expect(acpRuntime.close).toHaveBeenCalledTimes(1);
    expect(client.reportClaim).toHaveBeenCalledTimes(1);
  });

  it('reports a single failure when the deadline elapses while shutdown has already begun reporting', async () => {
    vi.useFakeTimers();
    const turn = deferred();
    const acpRuntime = runtime(vi.fn(() => turn.promise));
    acpRuntime.close.mockImplementationOnce(async () => {
      turn.reject(new Error('closed'));
    });
    const reportGate = deferred();
    const client = api({
      poll: pendingPollAfter(WORK),
      reportClaim: vi.fn(() => reportGate.promise),
    });
    const { runner, logger } = timeoutRunner(client, acpRuntime, { executionTimeoutMs: 60_000 });
    const started = runner.start();
    await vi.advanceTimersByTimeAsync(10);

    const stopping = runner.shutdown();
    await vi.advanceTimersByTimeAsync(70_000);
    expect(client.reportClaim).toHaveBeenCalledTimes(1);
    expect(timedOutLogs(logger)).toHaveLength(0);
    reportGate.resolve({ ok: true });
    await stopping;
    await started;
    expect(client.reportClaim).toHaveBeenCalledTimes(1);
  });
});

const SECRET_GITHUB_TOKEN = `ghp_${'A1b2'.repeat(9)}`;

describe('runner error reasons in logs', () => {
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('logs the claim id and a redacted reason when worktree preparation fails', async () => {
    mockPrepareWorktree.mockRejectedValueOnce(new Error(`clone failed with ${SECRET_GITHUB_TOKEN}`));
    const logger = log();
    const client = api({ poll: vi.fn().mockResolvedValueOnce({ ...WORK, branch: 'fix/x', githubToken: SECRET_GITHUB_TOKEN }).mockResolvedValue(null) });
    const runner = makeRunner(client, runtime(), { log: logger });
    const started = runner.start();
    await waitFor(() => client.reportClaim.mock.calls.length === 1);
    await runner.shutdown();
    await started;

    expect(logger.error).toHaveBeenCalledWith('Worktree preparation failed', expect.objectContaining({
      claimId: 42,
      reason: 'clone failed with [REDACTED]',
    }));
    expect(client.reportClaim).toHaveBeenCalledWith(expect.objectContaining({ status: 'failed', failure_kind: 'transient' }));
    expect(JSON.stringify([logger.info.mock.calls, logger.warn.mock.calls, logger.error.mock.calls])).not.toContain(SECRET_GITHUB_TOKEN);
  });

  it('logs the claim id and a redacted reason when the final report fails', async () => {
    const logger = log();
    const client = api({
      poll: vi.fn().mockResolvedValueOnce(WORK).mockResolvedValue(null),
      reportClaim: vi.fn(async () => { throw new Error(`Report failed: 400 ${SECRET_GITHUB_TOKEN}`); }),
    });
    const runner = makeRunner(client, runtime(), { log: logger });
    const started = runner.start();
    await waitFor(() => logger.error.mock.calls.some(([message]) => message === 'Failed to report claim'));
    await runner.shutdown();
    await started;

    expect(logger.error).toHaveBeenCalledWith('Failed to report claim', expect.objectContaining({
      event: 'claim_report_failed',
      claimId: 42,
      reason: 'Report failed: 400 [REDACTED]',
    }));
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain(SECRET_GITHUB_TOKEN);
  });

  it('logs the claim id and a redacted reason when the runtime close fails after the execution deadline', async () => {
    vi.useFakeTimers();
    const acpRuntime = runtime(vi.fn(() => new Promise(() => {})));
    acpRuntime.close.mockRejectedValue(new Error(`close failed ${SECRET_GITHUB_TOKEN}`));
    const client = api({ poll: pendingPollAfter(WORK) });
    const { runner, logger } = timeoutRunner(client, acpRuntime, { executionTimeoutMs: 60_000 });
    const started = runner.start();
    await vi.advanceTimersByTimeAsync(61_000);

    expect(logger.warn).toHaveBeenCalledWith('ACP runtime close failed after claim execution timeout', expect.objectContaining({
      claimId: 42,
      reason: 'close failed [REDACTED]',
    }));
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain(SECRET_GITHUB_TOKEN);
    await runner.shutdown();
    await started;
  });

  it('logs the claim id and a redacted reason when the runtime close fails after ownership loss', async () => {
    vi.useFakeTimers();
    const turn = deferred();
    const acpRuntime = runtime(vi.fn(() => turn.promise));
    acpRuntime.close.mockRejectedValue(new Error(`close failed ${SECRET_GITHUB_TOKEN}`));
    const client = api({
      poll: pendingPollAfter(WORK),
      heartbeat: vi.fn(async () => ({ claim: null })),
    });
    const { runner, logger } = timeoutRunner(client, acpRuntime, { heartbeatIntervalMs: 100 });
    const started = runner.start();
    await vi.advanceTimersByTimeAsync(250);

    expect(logger.warn).toHaveBeenCalledWith('ACP runtime close failed after claim ownership loss', expect.objectContaining({
      claimId: 42,
      reason: 'close failed [REDACTED]',
    }));
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain(SECRET_GITHUB_TOKEN);
    turn.reject(new Error('closed after ownership loss'));
    await vi.advanceTimersByTimeAsync(10);
    await runner.shutdown();
    await started;
  });
});
