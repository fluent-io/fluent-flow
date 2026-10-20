import { beforeAll, afterAll, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createConnectorRuntime } from '../../../src/connector/runtime.js';
import { createConnectorClient } from '../../../src/connector/connector-client.js';
import { fakePaseoSdk } from './helpers/fake-paseo.js';
import { createObserver } from '../../../src/connector/observer.js';
import { createPaseoAdapter } from '../../../src/connector/paseo-adapter.js';

// This suite deliberately uses a third database: Turbo runs DB/server/runner
// concurrently. Never inherit their destructive-reset database variables.
const databaseUrl = process.env.COLLAB_CONNECTOR_TEST_DATABASE_URL;
if (!databaseUrl) throw new Error('COLLAB_CONNECTOR_TEST_DATABASE_URL must name a dedicated loopback ff_connector_* database.');
const parsed = new URL(databaseUrl);
if (!['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname) || !/^\/(ff_connector_[a-z0-9_]+|ff_c)$/.test(parsed.pathname)) throw new Error('Unsafe connector integration database.');
process.env.DATABASE_URL = databaseUrl;
process.env.LOG_LEVEL = 'silent';
process.env.FF_COLLAB_AUTH_SECRET = 'connector-test-secret-0123456789abcdef0123456789abcdef';
const db = await import('@fluent-flow/db');
const { createApp } = await import('../../../../fluent-flow/src/app.js');
const exec = promisify(execFile);
const profile = { id: 'connector-test', name: 'Synthetic external SDK only', provider: 'omp', model: 'synthetic', modeId: null, thinkingOptionId: null, features: {} };
const temp = mkdtempSync(join(tmpdir(), 'ff-real-connector-'));
let server, base, actor, project, host, mapping, runtime, running, paseo;
let loseAccepted = true;
let loseObservation = true;
let capturedFences = [];
let worktree;
let lastBinding, lastTaskId, lastRunId;
let revokeNextAccepted = false;
const ackResponses = [];
const stoppedAgents = [];
const daemonHome = join(temp, 'private-paseo-home');
const sourceRoot = join(temp, 'private-source-root');
const daemonCredential = 'native-local-password-fixture-0123456789';
const observationBodies = [];

async function until(predicate) {
  for (let count = 0; count < 500; count++) { if (await predicate()) return; await new Promise((resolve) => setTimeout(resolve, 10)); }
  throw new Error('Timed out waiting for real connector state.');
}
async function request(method, path, body, key) {
  const response = await fetch(`${base}/api/collab/v1${path}`, { method, headers: { 'content-type': 'application/json', 'x-fluent-flow-actor': db.signCollaborationActor(actor, process.env.FF_COLLAB_AUTH_SECRET), ...(key ? { 'idempotency-key': key } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const result = response.status === 204 ? null : await response.json();
  return { status: response.status, data: result?.data, error: result?.error };
}
async function makeRuntime() {
  const client = createConnectorClient({ serverUrl: base, token: host.token, fetch: async (url, options) => {
    const body = JSON.parse(options.body);
    if (url.endsWith('/observations')) observationBodies.push(body);
    capturedFences.push({ path: new URL(url).pathname, connectorSessionId: body.connectorSessionId, leaseEpoch: body.leaseEpoch });
    if (url.includes('/ack') && body.state === 'accepted' && revokeNextAccepted) {
      revokeNextAccepted = false;
      await db.getPool().query('UPDATE collab_principals SET disabled_at=now() WHERE id=$1', [actor.principalId]);
    }
    const response = await fetch(url, options);
    if (url.includes('/ack')) ackResponses.push({ requested: body.state, status: response.status, recorded: (await response.clone().json()).data?.state });
    if (url.includes('/ack') && body.state === 'accepted' && loseAccepted) { loseAccepted = false; await response.text(); throw new Error('simulated lost accepted response'); }
    if (url.endsWith('/observations') && loseObservation) { loseObservation = false; await response.text(); throw new Error('simulated lost observation ACK'); }
    return response;
  } });
  const result = await createConnectorRuntime({ config: { instanceId: 'stable-test-instance', serverUrl: base, token: host.token, repositories: { repo: worktree, other: sourceRoot }, profiles: [profile.id], paseo: { home: daemonHome } }, journalDir: join(temp, 'journal'), paseo, client, stopAgent: async (id) => { stoppedAgents.push(id); }, intervals: { pollWaitMs: 0, baseBackoffMs: 10, maxBackoffMs: 30 } });
  return result;
}

beforeAll(async () => {
  await db.runMigrations();
  const suffix = randomUUID();
  const legacy = await db.getPool().query('INSERT INTO users(github_id,login,email,is_superadmin) VALUES($1,$2,$3,true) RETURNING id', [Math.floor(Math.random() * 1e9), `connector-${suffix}`, `${suffix}@example.test`]);
  const principal = await db.ensureGithubPrincipal({ legacyUserId: legacy.rows[0].id, displayName: 'Connector owner', email: `${suffix}@example.test` });
  actor = { principalId: principal.id, sessionVersion: principal.sessionVersion };
  const orgId = `connector-${suffix}`;
  await db.getPool().query('INSERT INTO orgs(id,name) VALUES($1,$1)', [orgId]);
  const workspace = await db.bootstrapCollaborationWorkspace({ actor, legacyOrgId: orgId, name: 'Connector fixture', idempotencyKey: suffix });
  project = await db.createCollabProject({ actor, workspaceId: workspace.id, name: 'Real connector composition' });
  host = await db.createExecutionHost({ actor, name: 'Connector fixture PC' });
  server = createApp().listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  worktree = join(temp, 'worktree'); mkdirSync(worktree);
  mkdirSync(daemonHome); mkdirSync(sourceRoot);
  writeFileSync(join(daemonHome, 'paseo.pid'), JSON.stringify({ listen: '127.0.0.1:1' }));
  writeFileSync(join(daemonHome, 'local-credential'), daemonCredential);
  await exec('git', ['init', '-b', 'main', worktree]);
  await exec('git', ['-C', worktree, '-c', 'user.name=T', '-c', 'user.email=t@example.test', 'commit', '--allow-empty', '-m', 'fixture']);
  writeFileSync(join(worktree, 'generated.md'), 'generated output');
  paseo = fakePaseoSdk();
  paseo.config = { get: async () => ({ config: { agentProfiles: [profile] } }) };
  paseo.close = async () => {};
  const originalCreate = paseo.workspaces.create;
  paseo.workspaces.create = async (options) => {
    const handle = await originalCreate(options);
    handle.refresh = async () => ({ id: handle.id, workspaceKind: 'worktree', workspaceDirectory: worktree, archivingAt: null });
    return handle;
  };
  runtime = await makeRuntime();
  await runtime.loop.register();
  mapping = await db.createProjectHostMapping({ actor, projectId: project.id, hostId: host.id, repositoryKey: 'repo', profileIds: [profile.id], defaultProfileId: profile.id });
}, 30_000);

afterAll(async () => {
  if (runtime) { runtime.loop.stop(); await running; await runtime.close(); }
  if (server) { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
  if (host) await db.getPool().query('UPDATE collab_hosts SET revoked_at=now() WHERE id=$1', [host.id]);
  await db.closePool(); await db.pool.end(); rmSync(temp, { recursive: true, force: true });
});

it('recovers a lost accepted grant after restart with one agent and prompt, then projects native observations through real HTTP/PG', async () => {
  const task = await request('POST', `/projects/${project.id}/tasks`, { title: 'Actual connector launch while host is offline' });
  expect(task.status).toBe(201);
  const started = await request('POST', `/tasks/${task.data.id}/runs`, { expectedVersion: task.data.version, mappingId: mapping.id, profileId: profile.id }, randomUUID());
  expect(started.status).toBe(202);
  expect(paseo.state.sends).toHaveLength(0);
  const runId = started.data.run.id;
  running = runtime.start();
  await until(() => runtime.journal.boundCommandIds().length === 1 && !loseAccepted);
  expect(paseo.state.sends).toHaveLength(0);
  const commandId = runtime.journal.boundCommandIds()[0];
  const binding = runtime.journal.byCommand(commandId).binding;
  lastBinding = binding; lastTaskId = task.data.id; lastRunId = runId;
  runtime.loop.stop(); await running; await runtime.close();
  await db.getPool().query("UPDATE collab_connector_commands SET claimed_at=now()-interval '2 minutes',acked_at=now()-interval '2 minutes' WHERE id=$1", [commandId]);
  runtime = await makeRuntime(); running = runtime.start();
  await until(() => paseo.state.sends.length === 1);
  expect(paseo.state.agents.size).toBe(1);
  expect(paseo.state.sends[0].agentId).toBe(binding.paseoAgentId);
  expect(paseo.state.sends[0].messageId).toBe(commandId);
  expect(paseo.state.agentCreateCalls[0].config.mcpServers['fluent-flow'].url).toBe(`${base}/mcp/collab`);
  const todo = { type: 'todo', items: [{ text: 'Keep native plan', completed: false, status: 'in_progress' }] };
  const emit = (seq, event) => paseo.state.deliverLive(binding.paseoAgentId, { agentId: binding.paseoAgentId, event, epoch: 'actual-epoch', seq, timestamp: new Date().toISOString() });
  emit(1, { type: 'turn_started', turnId: 'turn' });
  emit(2, { type: 'timeline', item: todo });
  emit(3, { type: 'usage_updated', turnId: 'turn', usage: { inputTokens: 10, outputTokens: 2 } });
  emit(4, { type: 'usage_updated', turnId: 'turn', usage: { inputTokens: 20, outputTokens: 3 } });
  for (let seq = 5; seq < 115; seq++) emit(seq, { type: 'timeline', item: { type: 'assistant_message', text: `output ${seq}` } });
  emit(115, { type: 'turn_completed', turnId: 'turn' });
  await until(async () => (await db.getPool().query('SELECT count(*)::int AS n FROM collab_connector_observations WHERE run_id=$1', [runId])).rows[0].n >= 117);
  const plan = await request('GET', `/tasks/${task.data.id}/plan`);
  expect(plan.status).toBe(200); expect(plan.data.plan.items).toEqual([{ text: 'Keep native plan', status: 'in_progress' }]);
  const usage = await db.getPool().query("SELECT tokens_in,tokens_out FROM collab_usage_samples WHERE run_id=$1 AND provider_turn_id='turn'", [runId]);
  expect(usage.rows).toHaveLength(1); expect(Number(usage.rows[0].tokens_in)).toBe(20);
  const usageFrom = encodeURIComponent(new Date(Date.now() - 60_000).toISOString());
  const usageTo = encodeURIComponent(new Date(Date.now() + 60_000).toISOString());
  const turnInsights = await request('GET', `/projects/${project.id}/insights?from=${usageFrom}&to=${usageTo}`);
  expect(turnInsights.status).toBe(200);
  expect(turnInsights.data.usage).toMatchObject({ available: true, tokensIn: 20, tokensOut: 3, costUsd: null, coverage: { samples: 1 } });
  const head = await db.getPool().query('SELECT head_commit FROM collab_runs WHERE id=$1', [runId]);
  expect(head.rows[0].head_commit).toMatch(/^[a-f0-9]{40}$/);
  const history = await request('GET', `/sessions/${binding.sessionId}/timeline?limit=100`);
  expect(history.status).toBe(200);
  expect(JSON.stringify(history.data)).toContain('Keep native plan');
  const fences = capturedFences.filter((item) => !item.path.endsWith('/register'));
  expect(fences.every((fence) => typeof fence.connectorSessionId === 'string' && Number.isInteger(fence.leaseEpoch))).toBe(true);
  const replayed = await db.getPool().query('SELECT event_id,count(*)::int AS n FROM collab_connector_observations WHERE run_id=$1 GROUP BY event_id', [runId]);
  expect(replayed.rows.every((row) => row.n === 1)).toBe(true);
}, 30_000);

it('delivers the frozen nonempty task prompt to a new session after native idle with empty instructions', async () => {
  const task = await request('POST', `/projects/${project.id}/tasks`, { title: 'Preserve the original task context in an additional session' });
  expect(task.status).toBe(201);
  const initialSends = paseo.state.sends.length;
  const started = await request('POST', `/tasks/${task.data.id}/runs`, { expectedVersion: task.data.version, mappingId: mapping.id, profileId: profile.id }, randomUUID());
  expect(started.status).toBe(202);
  const runId = started.data.run.id;
  await until(() => paseo.state.sends.length === initialSends + 1);
  const originalBinding = runtime.journal.bindingForRun(runId);
  paseo.state.deliverLive(originalBinding.paseoAgentId, { event: { type: 'turn_completed', turnId: 'original-turn' }, epoch: 'original-epoch', seq: 1, timestamp: new Date().toISOString() });
  await until(async () => (await db.getPool().query('SELECT state FROM collab_runs WHERE id=$1', [runId])).rows[0].state === 'idle');
  const before = paseo.state.sends.length;
  const queued = await request('POST', `/runs/${runId}/sessions`, { title: 'Continue original task', instructions: '' }, randomUUID());
  expect(queued.status).toBe(202);
  const row = (await db.getPool().query('SELECT payload FROM collab_connector_commands WHERE id=$1', [queued.data.commandId])).rows[0];
  expect(row.payload.instructions).toBe('');
  expect(row.payload.prompt.trim().length).toBeGreaterThan(0);
  expect(row.payload.prompt).toContain(task.data.title);
  await until(async () => (await db.getPool().query('SELECT state FROM collab_connector_commands WHERE id=$1', [queued.data.commandId])).rows[0].state === 'applied');
  const binding = runtime.journal.byCommand(queued.data.commandId).binding;
  expect(paseo.state.sends).toHaveLength(before + 1);
  expect(paseo.state.sends.at(-1)).toMatchObject({ messageId: queued.data.commandId, agentId: binding.paseoAgentId, text: row.payload.prompt });
  expect(binding.workspaceId).toBe(originalBinding.workspaceId);
  expect(binding.paseoAgentId).not.toBe(originalBinding.paseoAgentId);
  paseo.state.deliverLive(binding.paseoAgentId, { event: { type: 'turn_completed', turnId: 'additional-turn' }, epoch: 'additional-epoch', seq: 1, timestamp: new Date().toISOString() });
  await until(async () => (await db.getPool().query('SELECT state FROM collab_runs WHERE id=$1', [runId])).rows[0].state === 'idle');
}, 10_000);

it('answers native questions, steers selected sessions and keeps cancellation pending until a native cancellation event', async () => {
  const binding = lastBinding;
  const beforeResume = paseo.state.sends.length;
  const resumeText = 'Resume this task and ask the operator what to do next.';
  const resume = await request('POST', `/sessions/${binding.sessionId}/commands`, { kind: 'prompt', text: resumeText, behavior: 'steer' }, randomUUID());
  expect(resume.status).toBe(202);
  await until(() => paseo.state.sends.length >= beforeResume + 1);
  expect(paseo.state.sends).toHaveLength(beforeResume + 1);
  expect(paseo.state.sends.at(-1)).toMatchObject({ agentId: binding.paseoAgentId, messageId: resume.data.commandId, text: resumeText, activeTurnBehavior: 'steer' });
  const question = { id: 'native-question', name: 'Ask', kind: 'question', input: { source: 'native', questions: [{ question: 'What next?', header: 'Next', options: [{ label: 'Continue' }, { label: 'Review' }], multiSelect: false, allowOther: false, allowEmpty: false }] } };
  paseo.state.pendingPermissions.set(question.id, question);
  paseo.state.deliverLive(binding.paseoAgentId, { event: { type: 'turn_started', turnId: 'turn-2' }, epoch: 'actual-epoch', seq: 116, timestamp: new Date().toISOString() });
  paseo.state.deliverLive(binding.paseoAgentId, { event: { type: 'permission_requested', request: question }, epoch: 'actual-epoch', seq: 117, timestamp: new Date().toISOString() });
  await until(async () => (await request('GET', '/attention')).data.some((item) => item.requestId === question.id));
  expect((await db.getPool().query('SELECT state FROM collab_runs WHERE id=$1', [lastRunId])).rows[0].state).toBe('needs_input');
  const answered = await request('POST', `/sessions/${binding.sessionId}/commands`, { kind: 'permission', requestId: question.id, response: { behavior: 'allow', answers: { Next: 'Continue' } } }, randomUUID());
  expect(answered.status).toBe(202);
  await until(() => paseo.state.permissionResponses.length === 1);
  expect(paseo.state.permissionResponses[0].response.updatedInput).toEqual({ ...question.input, answers: { Next: 'Continue' } });
  paseo.state.deliverLive(binding.paseoAgentId, { event: { type: 'permission_resolved', requestId: question.id }, epoch: 'actual-epoch', seq: 118, timestamp: new Date().toISOString() });
  await until(async () => (await db.getPool().query('SELECT state FROM collab_runs WHERE id=$1', [lastRunId])).rows[0].state === 'running');
  expect((await request('GET', '/attention')).data.some((item) => item.requestId === question.id)).toBe(false);
  const sendsBefore = paseo.state.sends.length;
  const followup = await request('POST', `/sessions/${binding.sessionId}/commands`, { kind: 'prompt', text: 'Follow-up on this session.', behavior: 'steer' }, randomUUID());
  expect(followup.status).toBe(202);
  await until(() => paseo.state.sends.length === sendsBefore + 1);
  expect(paseo.state.sends.at(-1)).toMatchObject({ agentId: binding.paseoAgentId, activeTurnBehavior: 'steer' });
  const cancel = await request('POST', `/sessions/${binding.sessionId}/commands`, { kind: 'cancel' }, randomUUID());
  expect(cancel.status).toBe(202);
  await until(() => stoppedAgents.length === 1);
  await until(async () => (await db.getPool().query('SELECT state FROM collab_runs WHERE id=$1', [lastRunId])).rows[0].state === 'cancel_requested');
  expect((await db.getPool().query('SELECT status FROM collab_tasks WHERE id=$1', [lastTaskId])).rows[0].status).not.toBe('cancelled');
  paseo.state.deliverLive(binding.paseoAgentId, { event: { type: 'turn_canceled', turnId: 'turn' }, epoch: 'actual-epoch', seq: 119, timestamp: new Date().toISOString() });
  await until(async () => (await db.getPool().query('SELECT state FROM collab_runs WHERE id=$1', [lastRunId])).rows[0].state === 'cancelled');
  expect(stoppedAgents).toEqual([binding.paseoAgentId]);
}, 15_000);

it('redacts known local context before observation persistence/transport while native execution inputs stay exact', async () => {
  const task = await request('POST', `/projects/${project.id}/tasks`, { title: 'Known local context privacy fixture' });
  const before = paseo.state.sends.length;
  const started = await request('POST', `/tasks/${task.data.id}/runs`, { expectedVersion: task.data.version, mappingId: mapping.id, profileId: profile.id }, randomUUID());
  expect(started.status).toBe(202);
  await until(() => paseo.state.sends.length === before + 1);
  const binding = runtime.journal.bindingForRun(started.data.run.id);
  const created = paseo.state.agentCreateCalls.find((call) => call.agentId === binding.paseoAgentId);
  const reportingCredential = created.config.mcpServers['fluent-flow'].headers.Authorization.slice('Bearer '.length);
  const sensitive = `${worktree}/src/keep.ts ${sourceRoot}/lib.ts ${daemonHome}/daemon.json ${host.token} ${daemonCredential} ${reportingCredential}`;
  const question = { id: 'privacy-question', kind: 'question', name: 'Ask', description: sensitive, input: { cwd: worktree, metadata: { command: sensitive }, questions: [{ question: 'Continue with src/keep.ts?', header: 'Choice', options: [{ label: `${worktree}/src/keep.ts` }], allowOther: false, multiSelect: false }] } };
  const nativeInput = structuredClone(question.input);
  paseo.state.pendingPermissions.set(question.id, question);
  const emit = (seq, event) => paseo.state.deliverLive(binding.paseoAgentId, { event, epoch: 'privacy-epoch', seq, timestamp: new Date().toISOString() });
  emit(1, { type: 'turn_started', turnId: 'privacy-turn' });
  emit(2, { type: 'timeline', item: { type: 'tool_call', callId: 'shell-private', name: 'Bash', status: 'completed', error: null, detail: { type: 'shell', cwd: worktree, command: `cat ${sensitive}`, output: sensitive } } });
  emit(3, { type: 'timeline', item: { type: 'tool_call', callId: 'read-private', name: 'Read', status: 'completed', error: null, detail: { type: 'read', filePath: `${worktree}/src/keep.ts`, content: sensitive } } });
  emit(4, { type: 'timeline', item: { type: 'assistant_message', text: `Keep relative src/keep.ts; ${sensitive}` } });
  emit(5, { type: 'permission_requested', request: question });
  await until(async () => (await request('GET', `/sessions/${binding.sessionId}/pending-request`)).data?.requestId === question.id);
  const timeline = await request('GET', `/sessions/${binding.sessionId}/timeline?limit=100`);
  const pending = await request('GET', `/sessions/${binding.sessionId}/pending-request`);
  const wireEvents = observationBodies.flatMap((body) => body.events).filter((event) => event.runId === binding.runId);
  const persisted = wireEvents.map((event) => runtime.journal.observationById(event.eventId));
  const output = JSON.stringify({ timeline, pending, wireEvents, persisted });
  for (const privateValue of [worktree, sourceRoot, daemonHome, host.token, daemonCredential, reportingCredential]) expect(output.includes(privateValue)).toBe(false);
  expect(output).toContain('[workspace]/src/keep.ts');
  expect(output).toContain('relative src/keep.ts');
  expect(output).toContain('[redacted]');
  expect(readFileSync(join(temp, 'journal', 'journal.jsonl'), 'utf8')).not.toContain(reportingCredential);
  const beforeAnswers = paseo.state.permissionResponses.length;
  const answered = await request('POST', `/sessions/${binding.sessionId}/commands`, { kind: 'permission', requestId: question.id, response: { behavior: 'allow', answers: { Choice: '[workspace]/src/keep.ts' } } }, randomUUID());
  expect(answered.status).toBe(202);
  await until(() => paseo.state.permissionResponses.length === beforeAnswers + 1);
  expect(paseo.state.permissionResponses.at(-1).response.updatedInput).toEqual({ ...nativeInput, answers: { Choice: `${worktree}/src/keep.ts` } });
  expect(question.input).toEqual(nativeInput);
  expect(created.config.mcpServers['fluent-flow'].headers.Authorization).toBe(`Bearer ${reportingCredential}`);
}, 15_000);

it('withholds a launch when the real accepted HTTP200 records an ambiguous revoked grant', async () => {
  const task = await request('POST', `/projects/${project.id}/tasks`, { title: 'Revoked accepted grant must hold prompt' });
  const before = paseo.state.sends.length;
  revokeNextAccepted = true;
  try {
    const started = await request('POST', `/tasks/${task.data.id}/runs`, { expectedVersion: task.data.version, mappingId: mapping.id, profileId: profile.id }, randomUUID());
    expect(started.status).toBe(202);
    await until(() => ackResponses.some((response) => response.requested === 'accepted' && response.status === 200 && response.recorded === 'ambiguous'));
    expect(paseo.state.sends).toHaveLength(before);
    expect((await db.getPool().query('SELECT state FROM collab_connector_commands WHERE run_id=$1', [started.data.run.id])).rows[0].state).toBe('ambiguous');
  } finally { await db.getPool().query('UPDATE collab_principals SET disabled_at=NULL WHERE id=$1', [actor.principalId]); }
}, 10_000);

it('projects native idle snapshot lastUsage into real project insights and updates one cumulative sample across replay', async () => {
  const usageProject = await db.createCollabProject({ actor, workspaceId: project.workspaceId, name: 'Native snapshot usage fixture' });
  const usageMapping = await db.createProjectHostMapping({ actor, projectId: usageProject.id, hostId: host.id, repositoryKey: 'repo', profileIds: [profile.id], defaultProfileId: profile.id });
  const task = await request('POST', `/projects/${usageProject.id}/tasks`, { title: 'Keep actual native snapshot usage and available cost' });
  const before = paseo.state.sends.length;
  const started = await request('POST', `/tasks/${task.data.id}/runs`, { expectedVersion: task.data.version, mappingId: usageMapping.id, profileId: profile.id }, randomUUID());
  expect(started.status).toBe(202);
  await until(() => paseo.state.sends.length === before + 1);
  const binding = runtime.journal.bindingForRun(started.data.run.id);
  const nativeAgent = paseo.state.agentsById.get(binding.paseoAgentId);
  nativeAgent.lastUsage = { inputTokens: 132, cachedInputTokens: 580784, outputTokens: 4681, totalCostUsd: 0.1666354, contextWindowMaxTokens: 200000, contextWindowUsedTokens: 42518 };
  nativeAgent.status = 'idle';
  paseo.state.deliverLive(binding.paseoAgentId, { event: { type: 'usage_updated', turnId: 'snapshot-turn', usage: { inputTokens: 10, outputTokens: 5, totalCostUsd: 0.01 } }, epoch: 'snapshot-epoch', seq: 1, timestamp: new Date().toISOString() });
  paseo.state.deliverLive(binding.paseoAgentId, { event: { type: 'turn_completed', turnId: 'snapshot-turn' }, epoch: 'snapshot-epoch', seq: 2, timestamp: new Date().toISOString() });
  await until(async () => (await db.getPool().query('SELECT state FROM collab_runs WHERE id=$1', [binding.runId])).rows[0].state === 'idle');
  await runtime.observer.sync();
  await until(() => runtime.loop.pendingObservationIds.length === 0);
  let samples = await db.getPool().query("SELECT tokens_in,tokens_out,cost_usd FROM collab_usage_samples WHERE run_id=$1 AND provider_turn_id='native-session-snapshot'", [binding.runId]);
  expect(samples.rows).toHaveLength(1);
  expect(Number(samples.rows[0].tokens_in)).toBe(132);
  expect(Number(samples.rows[0].tokens_out)).toBe(4681);
  expect(Number(samples.rows[0].cost_usd)).toBeCloseTo(0.1666354, 6); // Existing numeric(…,6) projection; raw observation stays exact.
  const adapter = createPaseoAdapter({ paseo, journal: runtime.journal });
  const restored = createObserver({ paseo, journal: runtime.journal, adapter, onObservations: (events) => runtime.loop.enqueueObservations(events) });
  await restored.sync();
  await restored.sync();
  await restored.close();
  nativeAgent.lastUsage = { ...nativeAgent.lastUsage, inputTokens: 147, outputTokens: 4800, totalCostUsd: 0.2 };
  await runtime.observer.sync();
  await until(() => runtime.loop.pendingObservationIds.length === 0);
  samples = await db.getPool().query("SELECT tokens_in,tokens_out,cost_usd FROM collab_usage_samples WHERE run_id=$1 AND provider_turn_id='native-session-snapshot'", [binding.runId]);
  expect(samples.rows).toHaveLength(1);
  expect(Number(samples.rows[0].tokens_in)).toBe(147);
  expect(Number(samples.rows[0].tokens_out)).toBe(4800);
  const from = encodeURIComponent(new Date(Date.now() - 60_000).toISOString());
  const to = encodeURIComponent(new Date(Date.now() + 60_000).toISOString());
  const insights = await request('GET', `/projects/${usageProject.id}/insights?from=${from}&to=${to}`);
  expect(insights.status).toBe(200);
  expect(insights.data.usage).toMatchObject({ available: true, tokensIn: 147, tokensOut: 4800, costUsd: 0.2, coverage: { samples: 1 } });
  const source = await db.getPool().query("SELECT payload FROM collab_connector_observations WHERE session_id=$1 AND kind='usage' ORDER BY created_at DESC", [binding.sessionId]);
  expect(source.rows.some((row) => row.payload.costUsd === 0.1666354 && row.payload.cachedInputTokens === 580784 && row.payload.contextWindowUsedTokens === 42518)).toBe(true);
}, 15_000);

it('retains confirmed archive HEAD as historical across sampling and runtime restart while an unconfirmed missing workspace stays unknown', async () => {
  // Only this suite's disposable fixture is removed; no native daemon/CLI I/O.
  rmSync(join(worktree, 'generated.md'));
  const remote = join(temp, 'archive-remote.git');
  await exec('git', ['clone', '--bare', worktree, remote]);
  await exec('git', ['-C', worktree, 'remote', 'add', 'archive-fixture', remote]);
  await exec('git', ['-C', worktree, 'push', '-u', 'archive-fixture', 'main']);
  const head = (await exec('git', ['-C', worktree, 'rev-parse', 'HEAD'])).stdout.trim();
  const task = await request('POST', `/projects/${project.id}/tasks`, { title: 'Keep archived commit evidence' });
  const before = paseo.state.sends.length;
  const started = await request('POST', `/tasks/${task.data.id}/runs`, { expectedVersion: task.data.version, mappingId: mapping.id, profileId: profile.id }, randomUUID());
  expect(started.status).toBe(202);
  await until(() => paseo.state.sends.length === before + 1);
  const binding = runtime.journal.bindingForRun(started.data.run.id);
  paseo.state.deliverLive(binding.paseoAgentId, { event: { type: 'turn_completed', turnId: 'archive-turn' }, epoch: 'archive-epoch', seq: 1, timestamp: new Date().toISOString() });
  await until(async () => (await db.getPool().query('SELECT state FROM collab_runs WHERE id=$1', [binding.runId])).rows[0].state === 'idle');
  const currentTask = await request('GET', `/tasks/${task.data.id}`);
  expect(currentTask.status).toBe(200);
  expect((await request('POST', `/tasks/${task.data.id}/deliveries`, { expectedVersion: currentTask.data.version, note: 'Fixture delivery before owned cleanup.', artifactIds: [], checkEvidenceIds: [] })).status).toBe(201);
  paseo.agents.list = async () => ({ entries: [...paseo.state.agentsById.values()].map((agent) => ({ agent })), pageInfo: {} });
  let releaseArchive;
  let directoryRemoved = false;
  const confirmation = new Promise((resolve) => { releaseArchive = resolve; });
  paseo.workspaces.archive = async (workspaceId) => {
    expect(workspaceId).toBe(binding.workspaceId);
    rmSync(worktree, { recursive: true });
    directoryRemoved = true;
    await confirmation;
    return { workspaceId, archivedAt: new Date().toISOString(), error: null };
  };
  const preflight = await request('POST', `/runs/${binding.runId}/wrap-up-preflights`, {}, randomUUID());
  expect(preflight.status).toBe(202);
  await until(async () => (await db.getPool().query('SELECT state FROM collab_connector_commands WHERE id=$1', [preflight.data.commandId])).rows[0].state === 'applied');
  const archive = await request('POST', `/runs/${binding.runId}/wrap-ups`, { preflightId: preflight.data.commandId, mode: 'archive_owned_workspace' }, randomUUID());
  expect(archive.status).toBe(202);
  await until(() => directoryRemoved);
  let sampled = false;
  const duringArchive = runtime.sampleGit(binding).finally(() => { sampled = true; });
  await new Promise((resolve) => setTimeout(resolve, 10));
  const heldForConfirmation = !sampled;
  releaseArchive();
  expect(heldForConfirmation).toBe(true);
  await until(async () => (await db.getPool().query('SELECT state FROM collab_connector_commands WHERE id=$1', [archive.data.commandId])).rows[0].state === 'applied');
  const archived = await runtime.sampleGit(binding);
  expect((await duringArchive).eventId).toBe(archived.eventId);
  expect(archived.payload).toMatchObject({ headCommit: head, dirty: false, workspaceState: 'archived', historical: true, source: 'owned_workspace_archive' });
  const unknown = await runtime.sampleGit(lastBinding);
  expect(unknown.payload).toMatchObject({ headCommit: null, dirty: null });
  expect(unknown.payload.workspaceState).not.toBe('archived');
  runtime.loop.stop(); await running; await runtime.close();
  runtime = await makeRuntime();
  const recovered = await runtime.sampleGit(binding);
  expect(recovered).toMatchObject({ eventId: archived.eventId, observedAt: archived.observedAt, payload: archived.payload });
  running = runtime.start();
  await until(() => runtime.loop.pendingObservationIds.length === 0);
  const review = await request('GET', `/tasks/${task.data.id}/delivery-review`);
  expect(review.status).toBe(200);
  expect(review.data).toMatchObject({ headCommit: head, dirty: false });
  const historical = await db.getPool().query("SELECT payload FROM collab_connector_observations WHERE run_id=$1 AND kind='state' AND payload->>'workspaceState'='archived'", [binding.runId]);
  expect(historical.rows).toHaveLength(1);
  expect(historical.rows[0].payload).toMatchObject({ headCommit: head, dirty: false, historical: true });
}, 15_000);
