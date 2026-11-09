import { afterEach, describe, expect, it, vi } from 'vitest';

const mockRunVerifyClaim = vi.hoisted(() => vi.fn());
vi.mock('../../src/verify.js', () => ({ runVerifyClaim: (...args) => mockRunVerifyClaim(...args) }));

import { createRunner } from '../../src/runner.js';

const VERIFY_WORK = {
  claim_id: 77,
  claim_type: 'verify',
  repo: 'org/repo',
  pr_number: 7,
  attempt: 1,
  agentType: 'claude-code',
};

function log() {
  return { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn(), isDebug: vi.fn(() => false) };
}

function client(work) {
  let served = false;
  return {
    register: vi.fn(async () => ({ session_id: 'registration-1', status: 'online' })),
    poll: vi.fn((_sessionId, { signal } = {}) => {
      if (!served) {
        served = true;
        return Promise.resolve(work);
      }
      return new Promise((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(new Error('poll aborted')), { once: true });
      });
    }),
    heartbeat: vi.fn(async () => ({ ok: true })),
    reportClaim: vi.fn(async () => ({ ok: true })),
    postClaimEvents: vi.fn(async () => ({ ok: true })),
    postClaimRequest: vi.fn(async () => ({ ok: true })),
    pollClaimCommands: vi.fn(async () => ({ commands: [] })),
    ackClaimCommand: vi.fn(async () => ({ ok: true })),
  };
}

function runtime() {
  return {
    runInitialPrompt: vi.fn(() => new Promise(() => {})),
    prompt: vi.fn(),
    cancel: vi.fn(),
    answerRequest: vi.fn(),
    close: vi.fn(async () => undefined),
    exited: Promise.resolve({ code: 0, signal: null, error: null }),
  };
}

function build(api, acpRuntime, logger) {
  return createRunner({
    client: api,
    log: logger,
    createAcpRuntime: vi.fn(() => acpRuntime),
    cwd: '/repo',
    acpCommand: 'agent',
    commandPollMs: 1000,
    heartbeatIntervalMs: 0,
    executionTimeoutMs: 60_000,
  });
}

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('verify claim execution timeout', () => {
  it('bounds an ACP authoring turn and reports one transient failure even if verification swallows the error', async () => {
    vi.useFakeTimers();
    mockRunVerifyClaim.mockImplementation(async ({ author, work }) => {
      try {
        await author({ worktreePath: '/wt', prompt: 'author it', work });
      } catch {
        return { status: 'completed', verification: { phase: 'red' } };
      }
      return { status: 'completed' };
    });
    const acpRuntime = runtime();
    const api = client(VERIFY_WORK);
    const logger = log();
    const runner = build(api, acpRuntime, logger);
    const started = runner.start();
    await vi.advanceTimersByTimeAsync(10);
    expect(acpRuntime.runInitialPrompt).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(59_000);
    expect(api.reportClaim).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(acpRuntime.close).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith('Claim execution timed out', expect.objectContaining({ claimId: 77 }));
    expect(api.reportClaim).toHaveBeenCalledTimes(1);
    expect(api.reportClaim).toHaveBeenCalledWith(expect.objectContaining({
      claim_id: 77,
      status: 'failed',
      failure_kind: 'transient',
    }));
    expect(api.reportClaim.mock.calls[0][0].verification).toBeUndefined();
    await vi.advanceTimersByTimeAsync(7_200_000);
    expect(api.reportClaim).toHaveBeenCalledTimes(1);
    await runner.shutdown();
    await started;
  });

  it('aborts a deterministic verification at the claim deadline and reports one transient failure', async () => {
    vi.useFakeTimers();
    let abortedResult;
    mockRunVerifyClaim.mockImplementation(({ execute }) => new Promise((resolve) => {
      setTimeout(async () => {
        abortedResult = await execute({ bin: 'true', args: [] }, '/tmp', 0);
        resolve({ status: 'completed', verification: { phase: 'green' } });
      }, 120_000);
    }));
    const acpRuntime = runtime();
    const api = client(VERIFY_WORK);
    const logger = log();
    const runner = build(api, acpRuntime, logger);
    const started = runner.start();
    await vi.advanceTimersByTimeAsync(59_000);
    expect(api.reportClaim).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1_500);
    expect(logger.warn).toHaveBeenCalledWith('Claim execution timed out', expect.objectContaining({ claimId: 77 }));
    expect(api.reportClaim).toHaveBeenCalledTimes(1);
    expect(api.reportClaim).toHaveBeenCalledWith(expect.objectContaining({
      claim_id: 77,
      status: 'failed',
      failure_kind: 'transient',
    }));
    expect(api.reportClaim.mock.calls[0][0].verification).toBeUndefined();

    await vi.advanceTimersByTimeAsync(70_000);
    expect(abortedResult).toMatchObject({ exitCode: 1, stderr: 'Command aborted' });
    expect(api.reportClaim).toHaveBeenCalledTimes(1);
    await runner.shutdown();
    await started;
  });

  it('clears the claim deadline when a deterministic verification finishes in time', async () => {
    vi.useFakeTimers();
    mockRunVerifyClaim.mockImplementation(() => new Promise((resolve) => {
      setTimeout(() => resolve({ status: 'completed', verification: { phase: 'green' } }), 30_000);
    }));
    const acpRuntime = runtime();
    const api = client(VERIFY_WORK);
    const logger = log();
    const runner = build(api, acpRuntime, logger);
    const started = runner.start();
    await vi.advanceTimersByTimeAsync(31_000);
    expect(api.reportClaim).toHaveBeenCalledTimes(1);
    expect(api.reportClaim).toHaveBeenCalledWith(expect.objectContaining({ status: 'completed' }));

    await vi.advanceTimersByTimeAsync(7_200_000);
    expect(logger.warn).not.toHaveBeenCalledWith('Claim execution timed out', expect.anything());
    expect(api.reportClaim).toHaveBeenCalledTimes(1);
    expect(acpRuntime.close).not.toHaveBeenCalled();
    await runner.shutdown();
    await started;
  });

  it('does not restart the deadline for each authoring turn', async () => {
    vi.useFakeTimers();
    mockRunVerifyClaim.mockImplementation(async ({ author, work }) => {
      try {
        await author({ worktreePath: '/wt', prompt: 'first', work });
        await author({ worktreePath: '/wt', prompt: 'second', work });
      } catch {
        return { status: 'completed' };
      }
      return { status: 'completed' };
    });
    const acpRuntime = runtime();
    acpRuntime.runInitialPrompt
      .mockImplementationOnce(() => new Promise((resolve) => {
        setTimeout(() => resolve({ sessionId: 's', messageId: 'm', stopReason: 'end_turn' }), 40_000);
      }));
    const api = client(VERIFY_WORK);
    const logger = log();
    const runner = build(api, acpRuntime, logger);
    const started = runner.start();
    await vi.advanceTimersByTimeAsync(45_000);
    expect(acpRuntime.runInitialPrompt).toHaveBeenCalledTimes(2);
    expect(api.reportClaim).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(16_000);
    expect(logger.warn).toHaveBeenCalledWith('Claim execution timed out', expect.objectContaining({ claimId: 77 }));
    expect(api.reportClaim).toHaveBeenCalledTimes(1);
    expect(api.reportClaim).toHaveBeenCalledWith(expect.objectContaining({ status: 'failed', failure_kind: 'transient' }));
    await runner.shutdown();
    await started;
  });
});
