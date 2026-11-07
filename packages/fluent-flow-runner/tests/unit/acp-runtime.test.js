import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAcpRuntime } from '../../src/acp/runtime.js';
import { spawnAcpProcess } from '../../src/acp/process.js';

const fixture = join(dirname(fileURLToPath(import.meta.url)), 'fake-acp-agent.js');
const roots = [];
const runtimes = [];

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function waitFor(readValue, predicate = Boolean, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = readValue();
    if (predicate(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('Timed out waiting for fixture state');
}
async function settleWithin(promise, timeoutMs = 500) {
  return Promise.race([
    Promise.resolve(promise).then(
      (value) => ({ status: 'resolved', value }),
      (error) => ({ status: 'rejected', error }),
    ),
    new Promise((resolve) => setTimeout(() => resolve({ status: 'timeout' }), timeoutMs)),
  ]);
}

function traceEntries(tracePath) {
  try {
    return readFileSync(tracePath, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
}

function entriesOf(tracePath, kind) {
  return traceEntries(tracePath).filter((entry) => entry.kind === kind);
}

function makeHarness(scenario = 'normal', overrides = {}) {
  const root = mkdtempSync(join(tmpdir(), 'ff-acp-runtime-'));
  roots.push(root);
  const tracePath = overrides.tracePath ?? join(root, 'trace.jsonl');
  const events = [];
  const requests = [];
  const processes = [];
  const spawnProcess = overrides.spawnProcess ?? ((options) => {
    const child = spawnAcpProcess(options);
    const kill = child.kill.bind(child);
    child.kill = vi.fn((signal) => kill(signal));
    processes.push(child);
    return child;
  });
  const runtime = createAcpRuntime({
    command: {
      bin: process.execPath,
      args: [fixture, '--scenario', scenario, '--trace', tracePath, ...(overrides.extraArgs ?? [])],
    },
    cwd: root,
    env: { ...process.env },
    onEvent: overrides.onEvent ?? (async (event) => { events.push(event); }),
    onRequest: overrides.onRequest ?? (async (request) => { requests.push(request); }),
    onRequestCancelled: overrides.onRequestCancelled ?? (async () => {}),
    log: overrides.log ?? { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    spawnProcess,
    now: overrides.now ?? (() => Date.now()),
    timers: overrides.timers ?? { setTimeout, clearTimeout },
    limits: {
      requestTimeoutMs: 1000,
      silenceMs: 50,
      shutdownIdleMs: 75,
      shutdownExitMs: 75,
      shutdownKillMs: 250,
      restartWindowMs: 60_000,
      maxRestarts: 2,
      ...(overrides.limits ?? {}),
    },
  });
  runtimes.push(runtime);
  return { runtime, root, tracePath, events, requests, processes };
}

async function finish(runtime) {
  await runtime.close();
  const index = runtimes.indexOf(runtime);
  if (index !== -1) runtimes.splice(index, 1);
}

afterEach(async () => {
  await Promise.allSettled(runtimes.splice(0).map((runtime) => runtime.close()));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('createAcpRuntime', () => {
  it('initializes with pinned protocol v2 and explicit client interaction capabilities', async () => {
    const { runtime, tracePath } = makeHarness();
    await runtime.runInitialPrompt('Review the change.');
    await finish(runtime);

    const initialize = entriesOf(tracePath, 'initialize');
    expect(initialize).toHaveLength(1);
    expect(initialize[0].params).toMatchObject({
      protocolVersion: 2,
      info: { name: 'fluent-flow-runner' },
      capabilities: { elicitation: { form: {} } },
    });
  });

  it('rejects an initialize response without a non-null session capability', async () => {
    const { runtime, tracePath } = makeHarness('missing-capability');
    await expect(runtime.runInitialPrompt('Review the change.')).rejects.toThrow(/session capability|incompatible/i);
    expect(entriesOf(tracePath, 'session_new')).toHaveLength(0);
  });

  it('rejects an agent missing baseline session/list support', async () => {
    const { runtime, tracePath } = makeHarness('missing-list');
    await expect(runtime.runInitialPrompt('Review the change.')).rejects.toThrow(/session\/list|incompatible/i);
    expect(entriesOf(tracePath, 'session_prompt')).toHaveLength(0);
  });

  it('creates a session with the absolute worktree and probes session/list before prompting', async () => {
    const { runtime, root, tracePath } = makeHarness();
    await runtime.runInitialPrompt('Review the change.');
    await finish(runtime);

    const trace = traceEntries(tracePath);
    const sessionNew = trace.find((entry) => entry.kind === 'session_new');
    const listIndex = trace.findIndex((entry) => entry.kind === 'session_list');
    const promptIndex = trace.findIndex((entry) => entry.kind === 'session_prompt');
    expect(sessionNew.params).toEqual({ cwd: root, mcpServers: [] });
    expect(listIndex).toBeGreaterThan(trace.findIndex((entry) => entry.kind === 'session_new'));
    expect(promptIndex).toBeGreaterThan(listIndex);
  });

  it('keeps live updates ordered and returns the accepted prompt messageId only after running becomes idle', async () => {
    const gate = deferred();
    const observed = [];
    let blocked = false;
    const { runtime } = makeHarness('normal', {
      onEvent: async (event) => {
        observed.push(event);
        if (event.update.sessionUpdate === 'agent_message_chunk') {
          blocked = true;
          await gate.promise;
        }
      },
    });
    let settled = false;
    const completion = runtime.runInitialPrompt('Review the change.').finally(() => { settled = true; });

    await waitFor(() => blocked);
    await Promise.resolve();
    expect(settled).toBe(false);
    gate.resolve();
    await expect(completion).resolves.toMatchObject({
      sessionId: 'fake-session-1',
      messageId: 'fake-user-message-1',
      stopReason: 'end_turn',
    });
    expect(observed.map((event) => event.update.sessionUpdate)).toEqual([
      'state_update',
      'agent_message_chunk',
      'state_update',
    ]);
  });

  it('completes each prompt on its next running-to-idle transition', async () => {
    const { runtime } = makeHarness();
    await expect(runtime.runInitialPrompt('First prompt.')).resolves.toMatchObject({ messageId: 'fake-user-message-1' });
    await expect(runtime.prompt('Second prompt.')).resolves.toMatchObject({
      messageId: 'fake-user-message-2',
      stopReason: 'end_turn',
    });
  });

  it('holds permission requests until the matching answer and rejects duplicate or late answers', async () => {
    const { runtime, requests, tracePath } = makeHarness('permission');
    const completion = runtime.runInitialPrompt('Request permission.');
    const request = await waitFor(() => requests[0]);

    expect(request).toMatchObject({
      kind: 'permission',
      payload: {
        sessionId: 'fake-session-1',
        title: 'Allow deterministic write?',
        options: [{ optionId: 'allow-once' }, { optionId: 'deny-once' }],
      },
    });
    expect(entriesOf(tracePath, 'permission_answer')).toHaveLength(0);
    await expect(runtime.answerRequest('permission:missing', {
      outcome: { outcome: 'selected', optionId: 'allow-once' },
    })).rejects.toThrow(/unknown|not open|request/i);
    await expect(runtime.answerRequest(request.requestKey, {
      outcome: { outcome: 'selected', optionId: 'allow-once' },
    })).resolves.toEqual({ accepted: true });
    await expect(runtime.answerRequest(request.requestKey, {
      outcome: { outcome: 'selected', optionId: 'allow-once' },
    })).rejects.toThrow(/already answered|not open|late/i);
    await completion;
    expect(entriesOf(tracePath, 'permission_answer')[0].answer).toEqual({
      outcome: { outcome: 'selected', optionId: 'allow-once' },
    });
    await expect(runtime.answerRequest(request.requestKey, {
      outcome: { outcome: 'cancelled' },
    })).rejects.toThrow(/already answered|not open|late/i);
  });

  it('reports a persisted request cancellation before closing the matching ACP request', async () => {
    const cancelled = [];
    const { runtime, requests } = makeHarness('permission', {
      onRequestCancelled: async (request) => {
        cancelled.push(request);
      },
    });
    const completion = runtime.runInitialPrompt('Request permission.');
    const request = await waitFor(() => requests[0]);

    await runtime.cancel();
    await waitFor(() => cancelled[0]);
    await completion;
    expect(cancelled).toEqual([{
      requestKey: request.requestKey,
      kind: 'permission',
    }]);
  });

  it('reports prompt acceptance before the ACP turn reaches idle', async () => {
    const accepted = deferred();
    const { runtime } = makeHarness('long-running');
    const completion = runtime.runInitialPrompt('Keep running.', {
      onAccepted: accepted.resolve,
    });

    await expect(accepted.promise).resolves.toEqual({ messageId: 'fake-user-message-1' });
    expect(await settleWithin(completion, 25)).toEqual({ status: 'timeout' });
    await runtime.cancel();
    await expect(completion).resolves.toMatchObject({ stopReason: 'cancelled' });
  });

  it('holds form elicitations until a schema-valid matching answer', async () => {
    const { runtime, requests, tracePath } = makeHarness('elicitation');
    const completion = runtime.runInitialPrompt('Request structured input.');
    const request = await waitFor(() => requests[0]);

    expect(request).toMatchObject({
      kind: 'elicitation',
      payload: {
        sessionId: 'fake-session-1',
        mode: 'form',
        requestedSchema: { type: 'object', required: ['choice'] },
      },
    });
    expect(entriesOf(tracePath, 'elicitation_answer')).toHaveLength(0);
    await runtime.answerRequest(request.requestKey, { action: 'accept', content: { choice: 'deterministic' } });
    await completion;
    expect(entriesOf(tracePath, 'elicitation_answer')[0].answer).toEqual({
      action: 'accept',
      content: { choice: 'deterministic' },
    });
  });

  it('cancels foreground work and completes only on the cancellation idle update', async () => {
    const { runtime, tracePath } = makeHarness('long-running');
    const completion = runtime.runInitialPrompt('Keep running.');
    await waitFor(() => entriesOf(tracePath, 'update').some((entry) => entry.update.state === 'running'));

    await runtime.cancel();
    await expect(completion).resolves.toMatchObject({ stopReason: 'cancelled' });
    expect(entriesOf(tracePath, 'session_cancel')).toHaveLength(1);
  });

  it('closes an idle session before closing stdin and observes a clean direct-child exit', async () => {
    const { runtime, tracePath, processes } = makeHarness();
    await runtime.runInitialPrompt('Finish normally.');
    await finish(runtime);

    expect(entriesOf(tracePath, 'session_close')).toHaveLength(1);
    await expect(runtime.exited).resolves.toMatchObject({ code: 0, signal: null, error: null });
    expect(processes).toHaveLength(1);
    expect(processes[0].kill).not.toHaveBeenCalled();
  });

  it('cancels active work, closes the ACP session, then kills only a hung direct child after the deadline', async () => {
    const { runtime, tracePath, processes } = makeHarness('close-hung', {
      limits: { shutdownIdleMs: 30, shutdownExitMs: 30, shutdownKillMs: 250 },
    });
    runtime.runInitialPrompt('Remain active.').catch(() => {});
    await waitFor(() => entriesOf(tracePath, 'update').some((entry) => entry.update.state === 'running'));

    await finish(runtime);

    const trace = traceEntries(tracePath);
    expect(trace.findIndex((entry) => entry.kind === 'session_cancel'))
      .toBeLessThan(trace.findIndex((entry) => entry.kind === 'session_close'));
    expect(processes).toHaveLength(1);
    expect(processes[0].kill).toHaveBeenCalledTimes(1);
    expect(processes[0].kill).toHaveBeenCalledWith('SIGTERM');
    await expect(runtime.exited).resolves.toMatchObject({ signal: 'SIGTERM' });
  });

  it('restarts once when setup fails before session/prompt and submits the prompt once', async () => {
    const { runtime, tracePath } = makeHarness('setup-restart');
    await expect(runtime.runInitialPrompt('Submit once.')).resolves.toMatchObject({ messageId: 'fake-user-message-1' });

    expect(entriesOf(tracePath, 'process_start')).toHaveLength(2);
    expect(entriesOf(tracePath, 'session_prompt')).toHaveLength(1);
  });

  it('closes during blocked setup without restarting, prompting, reviving, or leaking a child', async () => {
    const { runtime, tracePath, processes } = makeHarness('blocked-setup');
    const initialPrompt = runtime.runInitialPrompt('Must never be submitted.').then(
      (value) => ({ status: 'resolved', value }),
      (error) => ({ status: 'rejected', error }),
    );
    await waitFor(() => entriesOf(tracePath, 'session_new').length === 1);

    await finish(runtime);
    const outcome = await initialPrompt;
    await expect(processes[0].exited).resolves.toMatchObject({ code: 0, signal: null, error: null });

    expect(outcome.status).toBe('rejected');
    expect(entriesOf(tracePath, 'process_start')).toHaveLength(1);
    expect(entriesOf(tracePath, 'session_prompt')).toHaveLength(0);
    expect(processes).toHaveLength(1);
    await expect(runtime.exited).resolves.toMatchObject({ code: 0, signal: null, error: null });
  });

  it('does not replay a prompt whose acceptance was lost', async () => {
    const { runtime, tracePath } = makeHarness('ambiguous-prompt');
    await expect(runtime.runInitialPrompt('Never replay me.')).rejects.toThrow(/uncertain|acceptance|transient/i);

    expect(entriesOf(tracePath, 'process_start')).toHaveLength(1);
    expect(entriesOf(tracePath, 'session_prompt')).toHaveLength(1);
    expect(entriesOf(tracePath, 'session_resume')).toHaveLength(0);
  });

  it('resumes an accepted prompt once without replay and waits for a live resumed idle transition', async () => {
    const { runtime, tracePath, events } = makeHarness('accepted-loss-resume-running');
    await expect(runtime.runInitialPrompt('Resume without replay.')).resolves.toMatchObject({
      sessionId: 'fake-session-1',
      messageId: 'fake-user-message-1',
      stopReason: 'end_turn',
    });

    expect(entriesOf(tracePath, 'process_start')).toHaveLength(2);
    expect(entriesOf(tracePath, 'session_prompt')).toHaveLength(1);
    expect(entriesOf(tracePath, 'session_resume')).toHaveLength(1);
    expect(entriesOf(tracePath, 'session_resume')[0].params).toEqual({
      sessionId: 'fake-session-1',
      cwd: dirname(tracePath),
      mcpServers: [],
    });
    expect(events.some((event) => event.update.messageId === 'fake-agent-message-resumed')).toBe(true);
  });

  it('completes once when resumed running and idle updates arrive before session/resume responds', async () => {
    const gate = deferred();
    let blocked = false;
    const { runtime, tracePath } = makeHarness('accepted-loss-resume-before-response', {
      onEvent: async (event) => {
        if (event.update.sessionUpdate === 'state_update' && event.update.state === 'running') {
          blocked = true;
          await gate.promise;
        }
      },
    });
    const completion = runtime.runInitialPrompt('Complete during resume.');

    try {
      await waitFor(() => blocked);
      await waitFor(() => entriesOf(tracePath, 'update').some((entry) => entry.update.state === 'idle'));
    } finally {
      gate.resolve();
    }

    const outcome = await settleWithin(completion);
    expect(outcome).toEqual({
      status: 'resolved',
      value: {
        sessionId: 'fake-session-1',
        messageId: 'fake-user-message-1',
        stopReason: 'end_turn',
      },
    });
    expect(entriesOf(tracePath, 'session_prompt')).toHaveLength(1);
    expect(entriesOf(tracePath, 'session_resume')).toHaveLength(1);
  });

  it('keeps request keys unique when replacement-child JSON-RPC request IDs restart', async () => {
    const { runtime, requests, tracePath } = makeHarness('request-key-recovery');
    const completion = runtime.runInitialPrompt('Request on both connections.');
    const before = await waitFor(() => requests.find((request) => request.payload.title === 'Before recovery'));
    await runtime.answerRequest(before.requestKey, {
      outcome: { outcome: 'selected', optionId: 'allow-before' },
    });
    const after = await waitFor(() => requests.find((request) => request.payload.title === 'After recovery'));

    expect(after.requestKey).not.toBe(before.requestKey);
    await runtime.answerRequest(after.requestKey, {
      outcome: { outcome: 'selected', optionId: 'allow-after' },
    });
    await expect(completion).resolves.toMatchObject({
      sessionId: 'fake-session-1',
      messageId: 'fake-user-message-1',
      stopReason: 'end_turn',
    });
    expect(entriesOf(tracePath, 'permission_answer').map((entry) => entry.title)).toEqual([
      'Before recovery',
      'After recovery',
    ]);
    expect(entriesOf(tracePath, 'process_start')).toHaveLength(2);
    expect(entriesOf(tracePath, 'session_prompt')).toHaveLength(1);
    expect(entriesOf(tracePath, 'session_resume')).toHaveLength(1);
  });

  it('treats the current idle snapshot during resume as uncertainty rather than a new completion', async () => {
    const { runtime, tracePath } = makeHarness('accepted-loss-resume-idle');
    await expect(runtime.runInitialPrompt('Do not infer completion.')).rejects.toThrow(/uncertain|transient|idle/i);

    expect(entriesOf(tracePath, 'session_prompt')).toHaveLength(1);
    expect(entriesOf(tracePath, 'session_resume')).toHaveLength(1);
  });

  it('reports a failed resume without replaying an accepted prompt', async () => {
    const { runtime, tracePath } = makeHarness('failed-resume');
    await expect(runtime.runInitialPrompt('Do not replay after failed resume.')).rejects.toThrow(/resume|transient/i);

    expect(entriesOf(tracePath, 'session_prompt')).toHaveLength(1);
    expect(entriesOf(tracePath, 'session_resume')).toHaveLength(1);
  });

  it('probes session/list after update silence before deciding recovery is needed', async () => {
    const { runtime, tracePath } = makeHarness('silence', { limits: { silenceMs: 25 } });
    await expect(runtime.runInitialPrompt('Become temporarily silent.')).resolves.toMatchObject({ stopReason: 'end_turn' });

    expect(entriesOf(tracePath, 'session_list')).toHaveLength(2);
    expect(entriesOf(tracePath, 'process_start')).toHaveLength(1);
  });

  it('enforces a rolling restart budget across runtimes using the same adapter command', async () => {
    const extraArgs = ['--budget-key', `budget-${Date.now()}`];
    const first = makeHarness('rolling-restart-budget', {
      extraArgs,
      limits: { maxRestarts: 1, restartWindowMs: 60_000 },
    });
    const second = makeHarness('rolling-restart-budget', {
      extraArgs,
      tracePath: first.tracePath,
      limits: { maxRestarts: 1, restartWindowMs: 60_000 },
    });

    await expect(first.runtime.runInitialPrompt('First failing setup.')).rejects.toThrow();
    await expect(second.runtime.runInitialPrompt('Budget must stop this.')).rejects.toThrow(/restart budget|restarts exhausted/i);

    expect(entriesOf(first.tracePath, 'process_start').length).toBeLessThanOrEqual(3);
  });
});
