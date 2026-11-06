import { beforeEach, describe, expect, it, vi } from 'vitest';

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

  it('stops heartbeat after ownership expires without aborting the ACP turn', async () => {
    const turn = deferred();
    const client = api({
      poll: vi.fn().mockResolvedValueOnce(WORK).mockResolvedValue(null),
      heartbeat: vi.fn(async () => { throw new Error('Heartbeat failed: 410 — stale'); }),
    });
    const runner = makeRunner(client, runtime(vi.fn(() => turn.promise)), { heartbeatIntervalMs: 2 });
    const started = runner.start();
    await waitFor(() => client.heartbeat.mock.calls.length === 1);
    turn.resolve({ sessionId: 'acp', messageId: 'm', stopReason: 'end_turn' });
    await waitFor(() => client.reportClaim.mock.calls.length === 1);
    expect(client.heartbeat).toHaveBeenCalledTimes(1);
    expect(client.reportClaim).toHaveBeenCalledWith(expect.objectContaining({ status: 'completed' }));
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
      await vi.advanceTimersByTimeAsync(10_000);
      await started;
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
