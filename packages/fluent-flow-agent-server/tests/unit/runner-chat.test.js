import { it, expect, afterEach, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRunner } from '../../src/runner.js';
import { createAcpRuntime } from '../../src/acp/runtime.js';
const fixture = join(dirname(fileURLToPath(import.meta.url)), 'fake-acp-agent.js');
const cleanups = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function waitFor(read) {
  const until = Date.now() + 4000;
  while (Date.now() < until) { const result = await read(); if (result) return result; await new Promise((r) => setTimeout(r, 5)); }
  throw new Error('Chat runner test deadline');
}
async function harness(options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'ff-runner-chat-')); cleanups.push(() => rm(root, { recursive: true, force: true }));
  const commands = [], events = [], reports = [];
  const work = { claim_id: 42, task_id: '11111111-1111-4111-8111-111111111111', repo: null, claim_type: 'chat', agentType: 'test', attempt: 1, githubToken: 'malformed-delivered-test-token', ...options.work };
  let polled = false, runtime, runtimeOptions;
  const api = {
    register: vi.fn(async () => ({ session_id: 1 })), poll: vi.fn(async () => { if (polled) return null; polled = true; return work; }),
    heartbeat: vi.fn(async () => ({ claim: { claim_id: 42 } })),
    reportClaim: vi.fn(async (report) => { reports.push(report); return {}; }),
    pollClaimCommands: vi.fn(async () => ({ commands: commands.splice(0) })),
    renewClaimCommand: vi.fn(async () => ({ renewed: true })), ackClaimCommand: vi.fn(async () => ({})),
    postClaimEvents: vi.fn(async (_s, _c, batch) => { events.push(...structuredClone(batch)); }),
    postClaimRequest: vi.fn(async () => ({})), cancelClaimRequest: vi.fn(async () => ({})),
    reportClaimWorkspace: vi.fn(async () => ({ ok: true })),
  };
  const runner = createRunner({ client: api, log: { info() {}, warn() {}, error() {}, debug() {} }, cwd: join(root, 'work'),
    childEnvironment: { PATH: process.env.PATH, GH_TOKEN: 'inherited-test-token', GITHUB_TOKEN: 'inherited-test-token', GIT_CONFIG_COUNT: '1', GIT_CONFIG_VALUE_0: 'inherited-test-token' },
    acpCommand: process.execPath, acpArgs: [fixture, '--scenario', 'chat-policy', '--trace', join(root, 'trace')],
    chat: { enabled: true, profiles: [{ id: 'safe', permission: { configId: 'approval', value: 'ask' }, models: [] }], ...options.chat },
    commandPollMs: 5, eventFlushMs: 5, heartbeatIntervalMs: 10, executionTimeoutMs: 10,
    createAcpRuntime: (input) => { runtimeOptions = input; runtime = createAcpRuntime(input); return runtime; }, ...options.runner });
  const run = runner.start(); cleanups.push(async () => { await runner.shutdown(); await run; });
  const started = async () => waitFor(async () => { try { return (await readFile(join(root, 'trace'), 'utf8')).includes('set_config_option'); } catch (e) { if (e.code === 'ENOENT') return false; throw e; } });
  return { root, runner, api, events, reports, commands, started, get runtime() { return runtime; }, get runtimeOptions() { return runtimeOptions; } };
}
it('repo-null ignores malformed delivered credentials and starts a real credential-free child outside the work root', async () => {
  const h = await harness(); await h.started();
  expect(h.runtimeOptions.env.GH_TOKEN).toBeUndefined(); expect(h.runtimeOptions.env.GITHUB_TOKEN).toBeUndefined();
  expect(h.runtimeOptions.env.GIT_CONFIG_COUNT).toBe('0');
  const child = (await readFile(join(h.root, 'trace'), 'utf8')).split('\n').filter(Boolean).map(JSON.parse).find((e) => e.kind === 'process_start');
  expect(child.githubCredentialPresent).toBe(false);
  expect(h.runtimeOptions.cwd.startsWith(join(h.root, 'work') + '/')).toBe(false);
  h.commands.push({ id: 1, kind: 'end_session' }); await waitFor(() => h.reports.length);
  expect(h.reports[0]).toMatchObject({ status: 'cancelled', end_reason: 'user' });
  await h.runtime.exited;
});
it('frees the child and slot even if retained workspace inspection never completes', async () => {
  let resolveRelease;
  const held = new Promise((r) => { resolveRelease = r; });
  const h = await harness({ runner: { chatWorkspaceManager: { prepare: async () => ({ path: tmpdir(), release: () => held }) } } });
  await h.started(); h.commands.push({ id: 1, kind: 'end_session' });
  await waitFor(() => h.reports.length && h.runner.activeWork === null);
  await h.runtime.exited;
  expect(h.reports[0].status).toBe('cancelled'); resolveRelease({ retained: true, reason: 'scratch' });
});
it('transcript truncation does not kill sticky turns, alter uploaded history or block session end', async () => {
  const h = await harness({ chat: { eventBudget: { totalBytes: 6500, reserveBytes: 3500 } } }); await h.started();
  h.commands.push({ id: 1, kind: 'prompt', payload: { text: 'first' } }, { id: 2, kind: 'prompt', payload: { text: 'second' } });
  await waitFor(() => h.events.some((e) => e.payload.raw.type === 'transcript_truncated'));
  const history = structuredClone(h.events);
  h.commands.push({ id: 3, kind: 'prompt', payload: { text: 'third' } });
  await waitFor(() => h.api.ackClaimCommand.mock.calls.some((a) => a[2] === 3));
  h.commands.push({ id: 4, kind: 'end_session' }); await waitFor(() => h.reports.length);
  expect(h.reports[0].status).toBe('cancelled');
  expect(h.events.slice(0, history.length)).toEqual(history);
  expect(h.events.filter((e) => e.payload.raw.type === 'transcript_truncated')).toHaveLength(1);
  expect(h.events.map((e) => e.seq)).toEqual(h.events.map((_e, i) => i + 1));
});
it('elides local workspace paths from claim events without leaking source roots', async () => {
  const h = await harness(); await h.started();
  await h.runtimeOptions.onEvent({ sessionId: 'fake-session-1', update: { sessionUpdate: 'agent_message_chunk', messageId: 'privacy', content: { type: 'text', text: `Source at ${h.runtimeOptions.cwd}/private-file ` } } });
  h.commands.push({ id: 1, kind: 'end_session' }); await waitFor(() => h.reports.length);
  expect(JSON.stringify(h.events)).not.toContain(h.root);
});

it('preserves an applied user end when its command acknowledgement transport fails', async () => {
  const h = await harness(); await h.started();
  h.api.ackClaimCommand.mockRejectedValueOnce(new Error('Test: End acknowledgement response lost'));
  h.commands.push({ id: 1, kind: 'end_session' });
  await waitFor(() => h.reports.length);
  expect(h.reports[0]).toMatchObject({ status: 'cancelled', end_reason: 'user' });
  await h.runtime.exited;
});

it('ownership expiry with rejected open-request cancellation still releases the task for reopening', async () => {
  const h = await harness({ runner: { acpArgs: [fixture, '--scenario', 'chat-policy', '--permission', 'yes'] } });
  await waitFor(() => h.runtime);
  h.commands.push({ id: 1, kind: 'prompt', payload: { text: 'Ask' } });
  await waitFor(() => h.api.postClaimRequest.mock.calls.length);
  h.api.cancelClaimRequest.mockRejectedValue(new Error('cancel failed: 409'));
  h.api.heartbeat.mockResolvedValue({ claim: null });
  await waitFor(() => h.runner.activeWork === null);
  await h.runtime.exited;
  const receipt = join(h.root, 'work-chat', 'tasks', '11111111-1111-4111-8111-111111111111', '42.json');
  await waitFor(async () => !(JSON.parse(await readFile(receipt, 'utf8'))).active);
  const { createChatWorkspaceManager } = await import('../../src/chat-workspace.js');
  const manager = createChatWorkspaceManager({ workDir: join(h.root, 'work') });
  const reopened = await Promise.race([manager.prepare({ task_id: '11111111-1111-4111-8111-111111111111', claim_id: 43, repo: null }), new Promise((_, reject) => setTimeout(() => reject(new Error('same-task reopen hung')), 500))]);
  await reopened.release();
});

it('reports the intended user end after a transient final heartbeat failure', async () => {
  const h = await harness({ runner: { heartbeatIntervalMs: 60_000 } }); await h.started();
  h.api.heartbeat.mockRejectedValueOnce(new Error('heartbeat failed: 503'));
  h.commands.push({ id: 1, kind: 'end_session' });
  await waitFor(() => h.reports.length);
  expect(h.reports[0]).toMatchObject({ status: 'cancelled', end_reason: 'user' });
});

it('preserves user end through final transcript upload failure', async () => {
  const h = await harness({ runner: { eventFlushMs: 60_000 } }); await h.started();
  h.api.postClaimEvents.mockRejectedValue(new Error('events failed: 503'));
  await h.runtimeOptions.onEvent({ sessionId: 'fake-session-1', update: { sessionUpdate: 'agent_message_chunk', messageId: 'final', content: { type: 'text', text: 'Buffered final output.' } } });
  h.commands.push({ id: 1, kind: 'end_session' });
  await waitFor(() => h.reports.length);
  expect(h.reports[0]).toMatchObject({ status: 'cancelled', end_reason: 'user' });
});

it('background upload failure after idle stops command delivery and retries terminal reporting without another ACP event', async () => {
  const h = await harness({ runner: { eventFlushMs: 200 } }); await h.started();
  h.api.postClaimEvents.mockRejectedValue(new Error('background upload failed: 503'));
  h.api.reportClaim.mockRejectedValueOnce(new Error('claim failed: 503'));
  h.commands.push({ id: 1, kind: 'prompt', payload: { text: 'First' } });
  await waitFor(() => h.api.ackClaimCommand.mock.calls.some((a) => a[2] === 1));
  await waitFor(() => h.api.postClaimEvents.mock.calls.length);
  await waitFor(() => h.api.reportClaim.mock.calls.length);
  h.commands.push({ id: 2, kind: 'prompt', payload: { text: 'Must not apply' } });
  await waitFor(() => h.reports.length);
  await h.runtime.exited;
  expect(h.reports[0]).toMatchObject({ status: 'failed', failure_kind: 'terminal', end_reason: 'host_lost' });
  expect(h.api.ackClaimCommand.mock.calls.some((a) => a[2] === 2)).toBe(false);
  expect(h.api.reportClaim.mock.calls).toHaveLength(2);
});

it('expired linked credentials spawn no child and report the duration boundary', async () => {
  const h = await harness({ work: { repo: 'org/repo', githubTokenExpiresAt: new Date(Date.now() - 1000).toISOString() } });
  await waitFor(() => h.reports.length);
  expect(h.runtime).toBeUndefined(); expect(h.reports[0]).toMatchObject({ status: 'cancelled', end_reason: 'max_duration' });
});

it('captures only the handoff turn through the real runner bridge while preserving the attended claim', async () => {
  const h = await harness({
    work: { repo: 'org/repo', githubToken: 'fixture-token', githubTokenExpiresAt: new Date(Date.now() + 60000).toISOString() },
    runner: { acpArgs: [fixture, '--scenario', 'handoff-summary'],
      chatWorkspaceManager: { prepare: async () => ({ path: tmpdir(),
        handoff: async () => ({ branch: 'ff/task-11111111-1111-4111-8111-111111111111', headSha: 'd'.repeat(40) }),
        release: async () => ({ retained: false, reason: 'clean_pushed' }) }) } },
  });
  await waitFor(() => h.runtime);
  h.commands.push({ id: 1, kind: 'prompt', payload: { text: 'Discuss the feature first' } });
  await waitFor(() => h.events.some(event => event.kind === 'state' && event.payload.raw.state === 'idle'));
  h.commands.push({ id: 2, kind: 'handoff', payload: {} });
  const ack = await waitFor(() => h.api.ackClaimCommand.mock.calls.find(call => call[2] === 2));
  expect(ack[3]).toBe('acked');
  expect(ack[4]).toMatchObject({ digest: { goal: 'Build the agreed feature', acceptanceCriteria: ['Feature works'] } });
  expect(h.reports).toEqual([]);
  h.commands.push({ id: 3, kind: 'end_session' });
  await waitFor(() => h.reports.length);
  expect(h.reports[0]).toMatchObject({ status: 'cancelled', end_reason: 'user' });
});
