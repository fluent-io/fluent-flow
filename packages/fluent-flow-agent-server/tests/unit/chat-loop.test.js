import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAcpRuntime } from '../../src/acp/runtime.js';
import { spawnAcpProcess } from '../../src/acp/process.js';

const fixture = join(dirname(fileURLToPath(import.meta.url)), 'fake-acp-agent.js');
const cleanups = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function waitFor(read, predicate = Boolean) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const value = await read();
    if (predicate(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('Fixture deadline exceeded');
}

async function harness(scenario = 'normal') {
  const root = await mkdtemp(join(tmpdir(), 'ff-chat-loop-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const trace = join(root, 'trace.jsonl');
  const commands = [];
  const acknowledgements = [];
  const updates = [];
  const processes = [];
  const requests = [];
  const runtime = createAcpRuntime({
    command: { bin: process.execPath, args: [fixture, '--scenario', scenario, '--trace', trace] },
    cwd: root,
    env: { PATH: process.env.PATH },
    spawnProcess: (options) => {
      const child = spawnAcpProcess(options);
      processes.push(child);
      return child;
    },
    onEvent: async (event) => { updates.push(event); },
    onRequest: async (request) => { requests.push(request); },
    limits: { requestTimeoutMs: 1000, silenceMs: 100, shutdownIdleMs: 100, shutdownExitMs: 100, shutdownKillMs: 100 },
  });
  cleanups.push(() => runtime.close());
  const client = {
    pollClaimCommands: vi.fn(async () => ({ commands: commands.splice(0) })),
    renewClaimCommand: vi.fn(async () => ({ renewed: true })),
    ackClaimCommand: vi.fn(async (_sessionId, _claimId, id, status, result) => {
      acknowledgements.push({ id, status, result });
      return {};
    }),
  };
  async function entries(kind) {
    try {
      return (await readFile(trace, 'utf8')).split('\n').filter(Boolean).map(JSON.parse).filter((entry) => entry.kind === kind);
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
  }
  return { root, runtime, commands, acknowledgements, updates, client, entries, processes, requests, repo: null };
}

it('Stop response after idle during a delayed acceptance ack is nonterminal and does not cancel the next turn', async () => {
  const { runChatSession } = await import('../../src/chat-loop.js');
  const h = await harness();
  let releaseAck;
  const held = new Promise((resolve) => { releaseAck = resolve; });
  h.client.ackClaimCommand.mockImplementation(async (_s, _c, id, status, result) => {
    h.acknowledgements.push({ id, status, result });
    if (id === 'first') await held;
  });
  h.commands.push({ id: 'first', kind: 'prompt', payload: { text: 'First' } });
  const run = runChatSession({ ...h, sessionId: 'slot', claimId: 1, commandPollMs: 5 });
  const observed = run.then((result) => ({ result }), (error) => ({ error }));
  await waitFor(() => h.updates.some((e) => e.update.state === 'idle'));
  h.commands.push({ id: 'stop', kind: 'cancel' }, { id: 'next', kind: 'prompt', payload: { text: 'Next' } });
  await new Promise((resolve) => setTimeout(resolve, 40));
  releaseAck();
  const ack = h.acknowledgements.find((a) => a.id === 'stop');
  if (ack) await waitFor(() => h.updates.filter((e) => e.update.state === 'idle').length === 2);
  h.commands.push({ id: 'end', kind: 'end_session' });
  const outcome = await observed;
  expect(ack).toMatchObject({ status: 'acked', result: { applied: false } });
  expect(outcome.result).toEqual({ status: 'cancelled', end_reason: 'user' });
  expect(await h.entries('session_cancel')).toHaveLength(0);
});

it('holds the next prompt behind a Stop response whose lease renewal is delayed', async () => {
  const { runChatSession } = await import('../../src/chat-loop.js');
  const h = await harness();
  let releaseAck, releaseRenew;
  const heldAck = new Promise((resolve) => { releaseAck = resolve; });
  const heldRenew = new Promise((resolve) => { releaseRenew = resolve; });
  let renewing = false;
  h.client.ackClaimCommand.mockImplementation(async (_s, _c, id, status, result) => {
    h.acknowledgements.push({ id, status, result });
    if (id === 'first') await heldAck;
  });
  h.client.renewClaimCommand.mockImplementation(async (_s, _c, id) => {
    if (id === 'stop') { renewing = true; await heldRenew; }
    return { renewed: true };
  });
  h.commands.push({ id: 'first', kind: 'prompt', payload: { text: 'First' } }, { id: 'next', kind: 'prompt', payload: { text: 'Next' } });
  const run = runChatSession({ ...h, sessionId: 'slot', claimId: 1, commandPollMs: 5 });
  const observed = run.then((result) => ({ result }), (error) => ({ error }));
  await waitFor(() => h.updates.some((e) => e.update.state === 'idle'));
  h.commands.push({ id: 'stop', kind: 'cancel' });
  await waitFor(() => renewing);
  releaseAck();
  await new Promise((resolve) => setTimeout(resolve, 40));
  const beforeRenew = await h.entries('session_prompt');
  releaseRenew();
  await waitFor(() => h.acknowledgements.some((a) => a.id === 'stop'));
  await waitFor(() => h.updates.filter((e) => e.update.state === 'idle').length === 2);
  h.commands.push({ id: 'end', kind: 'end_session' });
  await observed;
  expect(beforeRenew).toHaveLength(1);
  expect(h.acknowledgements.find((a) => a.id === 'stop').result.applied).toBe(false);
});

it('rejects invalid permission answers without killing the live session or consuming the request', async () => {
  const { runChatSession } = await import('../../src/chat-loop.js');
  const h = await harness('permission');
  h.commands.push({ id: 'prompt', kind: 'prompt', payload: { text: 'Ask' } });
  const run = runChatSession({ ...h, sessionId: 'slot-1', claimId: 1, commandPollMs: 5 });
  const observed = run.then((result) => ({ result }), (error) => ({ error }));
  await waitFor(() => h.requests[0]);
  h.commands.push({ id: 'invalid', kind: 'permission', request_key: h.requests[0].requestKey, payload: { answer: { invalid: true } } });
  const ack = await waitFor(async () => {
    const value = h.acknowledgements.find((a) => a.id === 'invalid');
    if (!value && (await Promise.race([observed, Promise.resolve(null)]))?.error) return { status: 'session_failed' };
    return value;
  });
  expect(ack.status).toBe('failed');
  h.commands.push({ id: 'valid', kind: 'permission', request_key: h.requests[0].requestKey,
    payload: { answer: { outcome: { outcome: 'selected', optionId: 'allow-once' } } } });
  await waitFor(() => h.entries('permission_answer'), (entries) => entries.length === 1);
  h.commands.push({ id: 'end', kind: 'end_session' });
  expect((await observed).result).toEqual({ status: 'cancelled', end_reason: 'user' });
});

it('never replays a duplicate command delivery into the same ACP session', async () => {
  const { runChatSession } = await import('../../src/chat-loop.js');
  const h = await harness('long-running');
  const command = { id: 'same-intent', kind: 'prompt', payload: { text: 'Submit only once' } };
  h.commands.push(command);
  const run = runChatSession({ ...h, sessionId: 'slot-1', claimId: 1, commandPollMs: 5 });
  const observed = run.then((result) => ({ result }), (error) => ({ error }));
  await waitFor(() => h.updates.some((event) => event.update.state === 'running'));
  h.commands.push(command);
  const outcome = await Promise.race([observed, new Promise((resolve) => setTimeout(() => resolve({ timeout: true }), 500))]);
  expect(outcome.error?.message).toMatch(/delivery.*uncertain/i);
  expect(await h.entries('session_prompt')).toHaveLength(1);
});

it('bounds pending prompts without blocking Stop response or End session', async () => {
  const { runChatSession } = await import('../../src/chat-loop.js');
  const h = await harness('long-running');
  h.commands.push({ id: 'first', kind: 'prompt', payload: { text: 'Run' } });
  const run = runChatSession({ ...h, sessionId: 'slot-1', claimId: 1, commandPollMs: 5, maxQueuedPrompts: 1 });
  await waitFor(() => h.updates.some((event) => event.update.state === 'running'));
  h.commands.push({ id: 'overflow', kind: 'prompt', payload: { text: 'Too many' } });
  await waitFor(() => h.acknowledgements.some((ack) => ack.id === 'overflow'));
  h.commands.push({ id: 'end', kind: 'end_session' });
  await expect(run).resolves.toEqual({ status: 'cancelled', end_reason: 'user' });
  expect(h.acknowledgements.find((ack) => ack.id === 'overflow')).toMatchObject({ status: 'failed', result: { error: 'Session command queue is full' } });
  expect(await h.entries('session_prompt')).toHaveLength(1);
});

it('delivers a leased permission answer to the live ACP request before acknowledging it', async () => {
  const { runChatSession } = await import('../../src/chat-loop.js');
  const h = await harness('permission');
  h.commands.push({ id: 'prompt', kind: 'prompt', payload: { text: 'Ask for approval' } });
  const run = runChatSession({ ...h, sessionId: 'slot-1', claimId: 1, commandPollMs: 5 });
  await waitFor(() => h.requests[0]);
  h.commands.push({ id: 'answer', kind: 'permission', request_key: h.requests[0].requestKey,
    payload: { answer: { outcome: { outcome: 'selected', optionId: 'allow-once' } } } });
  await waitFor(() => h.entries('permission_answer'), (entries) => entries.length === 1);
  h.commands.push({ id: 'end', kind: 'end_session' });
  await expect(run).resolves.toEqual({ status: 'cancelled', end_reason: 'user' });
  expect(h.acknowledgements.find((ack) => ack.id === 'answer')).toMatchObject({ status: 'acked', result: { applied: true } });
});

it('renews queued prompt leases while another turn runs and never applies a lost queued lease', async () => {
  const { runChatSession } = await import('../../src/chat-loop.js');
  const h = await harness('long-running');
  let queuedRenewals = 0;
  h.client.renewClaimCommand.mockImplementation(async (_session, _claim, id) => {
    if (id === 'queued') return { renewed: ++queuedRenewals < 2 };
    return { renewed: true };
  });
  h.commands.push({ id: 'first', kind: 'prompt', payload: { text: 'Hold this response' } },
    { id: 'queued', kind: 'prompt', payload: { text: 'Do not apply after losing lease' } });
  const run = runChatSession({ ...h, sessionId: 'slot-1', claimId: 1, commandPollMs: 5, commandLeaseRenewMs: 20 });
  await waitFor(() => queuedRenewals >= 2);
  h.commands.push({ id: 'cancel', kind: 'cancel' });
  await waitFor(() => h.updates.some((event) => event.update.state === 'idle'));
  h.commands.push({ id: 'end', kind: 'end_session' });
  await expect(run).resolves.toEqual({ status: 'cancelled', end_reason: 'user' });
  expect(await h.entries('session_prompt')).toHaveLength(1);
  expect(h.acknowledgements.some((ack) => ack.id === 'queued')).toBe(false);
});

it('marks lost prompt acceptance uncertain exactly once and never replays it', async () => {
  const { runChatSession } = await import('../../src/chat-loop.js');
  const h = await harness('ambiguous-prompt');
  h.commands.push({ id: 'uncertain', kind: 'prompt', payload: { text: 'Never replay' } });
  await expect(runChatSession({ ...h, sessionId: 'slot-1', claimId: 1, commandPollMs: 5 })).rejects.toThrow(/uncertain/i);
  expect(h.acknowledgements).toEqual([{ id: 'uncertain', status: 'uncertain', result: { error: 'Command outcome is uncertain' } }]);
  expect(await h.entries('session_prompt')).toHaveLength(1);
  expect(await h.entries('process_start')).toHaveLength(1);
});

it('shutdown aborts a held idle poll and reaps the child without treating abort as a transport failure', async () => {
  const { runChatSession } = await import('../../src/chat-loop.js');
  const h = await harness();
  const controller = new AbortController();
  let polling = false;
  h.client.pollClaimCommands.mockImplementation((_session, _claim, { signal }) => new Promise((_resolve, reject) => {
    polling = true;
    signal.addEventListener('abort', () => reject(new Error('intentional poll abort')), { once: true });
  }));
  const run = runChatSession({ ...h, sessionId: 'slot-1', claimId: 1, signal: controller.signal });
  await waitFor(() => polling);
  controller.abort();
  await expect(Promise.race([run, new Promise((resolve) => setTimeout(() => resolve('timeout'), 500))]))
    .resolves.toEqual({ status: 'failed', failure_kind: 'terminal', end_reason: 'host_lost' });
  await expect(h.runtime.exited).resolves.toMatchObject({ code: 0 });
});

it('the session deadline also closes a child still blocked in session setup', async () => {
  const { runChatSession } = await import('../../src/chat-loop.js');
  const h = await harness('blocked-setup');
  const run = runChatSession({ ...h, sessionId: 'slot-1', claimId: 1, maxSessionDurationMs: 50 });
  await expect(run).resolves.toEqual({ status: 'cancelled', end_reason: 'max_duration' });
  expect(h.processes).toHaveLength(1);
  expect(await h.entries('session_prompt')).toHaveLength(0);
  await h.runtime.exited;
});

it.each([
  { maxSessionDurationMs: 0 },
  { maxSessionDurationMs: Number.NaN },
  { maxSessionDurationMs: 8 * 60 * 60 * 1000 + 1 },
  { commandPollMs: 0 },
  { commandPollMs: Number.POSITIVE_INFINITY },
  { commandLeaseRenewMs: 0 },
  { commandLeaseRenewMs: 90_000 },
  { repo: 'org/repo' },
  { repo: 'org/repo', githubTokenExpiresAt: 'not-a-date' },
])('rejects unsafe runtime clocks before starting a child: %j', async (options) => {
  const { runChatSession } = await import('../../src/chat-loop.js');
  const h = await harness();
  await expect(runChatSession({ ...h, sessionId: 'slot-1', claimId: 1, ...options })).rejects.toThrow(/duration|expiry|poll|lease/i);
  expect(h.processes).toHaveLength(0);
});

it('does not open a child with an already expired repo credential', async () => {
  const { runChatSession } = await import('../../src/chat-loop.js');
  const h = await harness();
  await expect(runChatSession({ ...h, sessionId: 'slot-1', claimId: 1, repo: 'org/repo',
    githubTokenExpiresAt: new Date(Date.now() - 1000).toISOString() }))
    .resolves.toEqual({ status: 'cancelled', end_reason: 'max_duration' });
  expect(h.processes).toHaveLength(0);
});

it('caps a repo-linked session at credential expiry instead of the longer session duration', async () => {
  const { runChatSession } = await import('../../src/chat-loop.js');
  const h = await harness();
  const run = runChatSession({ ...h, sessionId: 'slot-1', claimId: 1, repo: 'org/repo',
    githubTokenExpiresAt: new Date(Date.now() + 400).toISOString(), maxSessionDurationMs: 3000, commandPollMs: 5 });
  await expect(Promise.race([run, new Promise((resolve) => setTimeout(() => resolve('timeout'), 900))]))
    .resolves.toEqual({ status: 'cancelled', end_reason: 'max_duration' });
  await expect(h.runtime.exited).resolves.toMatchObject({ code: 0 });
});

it('supervises idle child exit and releases without a reconnect', async () => {
  const { runChatSession } = await import('../../src/chat-loop.js');
  const h = await harness();
  const run = runChatSession({ ...h, sessionId: 'slot-1', claimId: 1, commandPollMs: 5 });
  await waitFor(() => h.entries('session_list'), (entries) => entries.length > 0);
  h.processes[0].kill('SIGTERM');
  await expect(Promise.race([run, new Promise((resolve) => setTimeout(() => resolve('timeout'), 300))]))
    .resolves.toEqual({ status: 'failed', failure_kind: 'terminal', end_reason: 'host_lost' });
  expect(await h.entries('process_start')).toHaveLength(1);
});

it('stops only the active response, permits another prompt, and treats idle cancel as a no-op', async () => {
  const { runChatSession } = await import('../../src/chat-loop.js');
  const h = await harness('long-running');
  const run = runChatSession({ ...h, sessionId: 'slot-1', claimId: 1, commandPollMs: 5 });
  h.commands.push({ id: 'idle-cancel', kind: 'cancel' });
  await waitFor(() => h.acknowledgements.some((ack) => ack.id === 'idle-cancel'));
  h.commands.push({ id: 'first', kind: 'prompt', payload: { text: 'Run until stopped' } });
  await waitFor(() => h.updates.some((event) => event.update.state === 'running'));
  h.commands.push({ id: 'stop-first', kind: 'cancel' });
  await waitFor(() => h.updates.some((event) => event.update.stopReason === 'cancelled'));
  h.commands.push({ id: 'second', kind: 'prompt', payload: { text: 'Run after cancel' } });
  await waitFor(() => h.updates.filter((event) => event.update.state === 'running').length === 2);
  h.commands.push({ id: 'end', kind: 'end_session' });
  await expect(run).resolves.toEqual({ status: 'cancelled', end_reason: 'user' });
  expect(h.acknowledgements.find((ack) => ack.id === 'idle-cancel')).toMatchObject({ status: 'acked', result: { applied: false } });
  expect(h.acknowledgements.find((ack) => ack.id === 'stop-first')).toMatchObject({ status: 'acked', result: { applied: true } });
  expect(await h.entries('session_prompt')).toHaveLength(2);
  expect(await h.entries('process_start')).toHaveLength(1);
});

it('services commands while idle without an initial prompt, preserves the workspace, and ends explicitly', async () => {
  const { runChatSession } = await import('../../src/chat-loop.js');
  const h = await harness();
  await writeFile(join(h.root, 'unsaved.txt'), 'retained work');
  const run = runChatSession({ ...h, sessionId: 'slot-1', claimId: 1, repo: null, commandPollMs: 5 });
  await waitFor(() => h.entries('session_new'), (entries) => entries.length === 1);
  expect(await h.entries('session_prompt')).toHaveLength(0);
  h.commands.push({ id: 'first', kind: 'prompt', payload: { text: 'First explicit turn' } });
  await waitFor(() => h.updates.filter((event) => event.update.state === 'idle').length);
  h.commands.push({ id: 'second', kind: 'prompt', payload: { text: 'Follow-up after idle' } });
  await waitFor(() => h.updates.filter((event) => event.update.state === 'idle').length === 2);
  h.commands.push({ id: 'end', kind: 'end_session', payload: {} });
  await expect(run).resolves.toEqual({ status: 'cancelled', end_reason: 'user' });
  expect(h.acknowledgements.map(({ id, status }) => ({ id, status }))).toEqual([
    { id: 'first', status: 'acked' }, { id: 'second', status: 'acked' }, { id: 'end', status: 'acked' },
  ]);
  expect(await h.entries('process_start')).toHaveLength(1);
  expect(await h.entries('session_prompt')).toHaveLength(2);
  expect(await h.entries('session_close')).toHaveLength(1);
  await expect(h.runtime.exited).resolves.toMatchObject({ code: 0 });
  expect(await readFile(join(h.root, 'unsaved.txt'), 'utf8')).toBe('retained work');
});

it('applies saved project instructions on the first explicit prompt only, never as opening work', async()=>{
 const {runChatSession}=await import('../../src/chat-loop.js');const h=await harness();
 const run=runChatSession({...h,sessionId:'slot',claimId:1,commandPollMs:5,instructions:'Use project conventions.'});
 await waitFor(()=>h.entries('session_new'),entries=>entries.length===1);
 expect(await h.entries('session_prompt')).toHaveLength(0);
 h.commands.push({id:'first',kind:'prompt',payload:{text:'First user message'}});
 await waitFor(()=>h.updates.filter(e=>e.update.state==='idle').length===1);
 h.commands.push({id:'second',kind:'prompt',payload:{text:'Second user message'}});
 await waitFor(()=>h.updates.filter(e=>e.update.state==='idle').length===2);
 h.commands.push({id:'end',kind:'end_session'});await run;
 const prompts=await h.entries('session_prompt');
 expect(prompts[0].params.prompt).toEqual([{type:'text',text:'Project instructions:\nUse project conventions.\n\nUser message:\nFirst user message'}]);
 expect(prompts[1].params.prompt).toEqual([{type:'text',text:'Second user message'}]);
});
