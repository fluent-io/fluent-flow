import { afterAll, beforeAll, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const databaseUrl = process.env.COLLAB_REPORTING_MCP_TEST_DATABASE_URL;
if (!databaseUrl) throw new Error('COLLAB_REPORTING_MCP_TEST_DATABASE_URL must name a dedicated loopback ff_reporting_mcp_* database.');
const parsedDatabaseUrl = new URL(databaseUrl);
if (!['127.0.0.1', 'localhost', '[::1]'].includes(parsedDatabaseUrl.hostname) || !/^\/ff_reporting_mcp_[a-z0-9_]+$/.test(parsedDatabaseUrl.pathname)) {
  throw new Error('Unsafe reporting MCP integration database.');
}
process.env.DATABASE_URL = databaseUrl;
process.env.LOG_LEVEL = 'silent';
process.env.FF_COLLAB_AUTH_SECRET = 'runner-summary-secret-0123456789abcdef0123456789abcdef';

const { resetCollabSchema, seedUser, seedOrgMembership } = await import('../../../fluent-flow/tests/helpers/collab-db.js');
const db = await import('@fluent-flow/db');
const { createApp } = await import('../../../fluent-flow/src/app.js');
const { createRunner } = await import('../../src/runner.js');
const { createAcpRuntime } = await import('../../src/acp/runtime.js');
const { createClient } = await import('../../src/client.js');
const { createLogger } = await import('../../src/logger.js');

const fakeAgent = join(dirname(fileURLToPath(import.meta.url)), 'fake-acp-agent.js');
const orgId = 'runner-summary-org';
const agentId = 'runner-summary-runner';
const advertisedProfiles = [{ id: 'design', models: ['small', 'large'], default_model: 'small' }];
const localProfiles = [{ id: 'design', permission: { configId: 'approval', value: 'ask' }, modelConfigId: 'model', models: ['small', 'large'], defaultModel: 'large' }];
const frozenCursor = { epoch: 'source-epoch', seq: '9007199254740994' };

let server;
let base;
let owner;
let projectId;
let mappingId;
let hostId;

function asActor(principal) {
  return { principalId: principal.id, sessionVersion: principal.sessionVersion };
}

async function listen() {
  server = createApp().listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
}

async function agentRequest(token, path, body) {
  const response = await fetch(`${base}/api/agent-server${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

async function until(predicate, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for runner summary state');
}

async function claimStatus(claimId) {
  return (await db.getPool().query('SELECT status FROM agent_claims WHERE id=$1', [claimId])).rows[0]?.status ?? null;
}

async function createRunFixture() {
  const task = await db.createCollabTask({ actor: asActor(owner), projectId, title: 'Runner summary source' });
  const started = await db.startCollabRun({ actor: asActor(owner), taskId: task.id, expectedVersion: task.version, idempotencyKey: randomUUID(), mappingId, profileId: 'summary-source-profile', instructions: 'Preserve the summary source.' });
  if (!('sessionId' in started)) throw new Error('Runner summary fixture requires internal execution access');
  const runId = started.run.id;
  const sessionId = started.sessionId;
  for (let index = 0; index < 2; index += 1) {
    const id = randomUUID();
    const at = new Date(Date.UTC(2026, 10, 14, 9, 0, index, 0)).toISOString().replace(/Z$/, '000Z');
    await db.getPool().query(`INSERT INTO collab_connector_observations
      (id,event_id,host_id,run_id,session_id,kind,payload,provider_epoch,provider_seq,observed_at,created_at)
      VALUES ($1,$2,$3,$4,$5,'timeline',$6,'source-epoch',$7,$8,$8)`,
    [id, `runner-summary-${id}`, hostId, runId, sessionId, JSON.stringify({ type: 'agent_message', text: index === 0 ? 'Frozen source entry one' : 'Second frozen entry' }), String(9007199254740993n + BigInt(index)), at]);
  }
  return { taskId: task.id, runId, sessionId };
}

async function queueSummary() {
  const source = await createRunFixture();
  const task = (await db.getPool().query('SELECT version FROM collab_tasks WHERE id=$1', [source.taskId])).rows[0];
  const queued = await db.queueClaimSummary({ actor: asActor(owner), taskId: source.taskId, expectedVersion: task.version, idempotencyKey: `runner-summary-${randomUUID()}`, source: { kind: 'execution', runId: source.runId, sessionId: source.sessionId } });
  return { ...source, ...queued };
}

async function leaseWork() {
  const token = await db.createToken({ orgId, agentId, label: `lease-${randomUUID()}` });
  const registered = await agentRequest(token.plaintext, '/register', { meta: { slot_id: 0, capacity: 1, supported_claim_types: ['summary'], profiles: advertisedProfiles } });
  expect(registered.status).toBe(200);
  const polled = await agentRequest(token.plaintext, '/poll', { session_id: registered.body.session_id });
  expect(polled.status).toBe(200);
  return { token, session: registered.body.session_id, work: polled.body.work };
}

function summaryHarness({ scenario, work, client = null, runnerToken = null, profiles = localProfiles, executionTimeoutMs = 30000, eventFlushMs = 5 } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'ff-runner-summary-'));
  const workDir = join(root, 'work');
  const tracePath = join(root, 'agent-trace.jsonl');
  const reports = [];
  let polled = false;
  let runtime = null;
  let runtimeOptions = null;
  const fakeApi = {
    serverUrl: base,
    register: async () => ({ session_id: 1 }),
    poll: async () => { if (polled) return null; polled = true; return work; },
    heartbeat: async () => ({ claim: { claim_id: work?.claim_id ?? 1 } }),
    reportClaim: async (report) => { reports.push(report); return {}; },
    pollClaimCommands: async () => ({ commands: [] }),
    renewClaimCommand: async () => ({ renewed: true }),
    ackClaimCommand: async () => ({}),
    postClaimEvents: async () => ({}),
    postClaimRequest: async () => ({}),
    cancelClaimRequest: async () => ({}),
    reportClaimWorkspace: async () => ({ ok: true }),
  };
  const runner = createRunner({
    client: client ?? fakeApi,
    runnerToken: runnerToken ?? undefined,
    log: createLogger(false, 'error', { write: () => {} }),
    cwd: workDir,
    childEnvironment: { PATH: process.env.PATH },
    acpCommand: process.execPath,
    acpArgs: [fakeAgent, '--scenario', scenario, '--trace', tracePath],
    commandPollMs: 5, eventFlushMs, heartbeatIntervalMs: 10,
    executionTimeoutMs,
    chat: { enabled: true, profiles, summary: true },
    createAcpRuntime: (input) => { runtimeOptions = input; runtime = createAcpRuntime(input); return runtime; },
  });
  const run = runner.start();
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    await runner.shutdown();
    await run;
  };
  return {
    root, workDir, tracePath, reports, runner, stop,
    get runtime() { return runtime; },
    get runtimeOptions() { return runtimeOptions; },
  };
}

async function withHarness(options, fn) {
  const h = await summaryHarness(options);
  try {
    return await fn(h);
  } finally {
    await h.stop();
    rmSync(h.root, { recursive: true, force: true });
  }
}

function traceEntries(tracePath) {
  if (!existsSync(tracePath)) return [];
  return readFileSync(tracePath, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

async function summaryRowCount(claimId) {
  return (await db.getPool().query('SELECT count(*)::int AS count FROM collab_summaries WHERE claim_id=$1', [claimId])).rows[0].count;
}

beforeAll(async () => {
  await resetCollabSchema(databaseUrl);
  await db.runMigrations();
  const ownerUserId = await seedUser(databaseUrl, { githubId: 9975, login: 'runner-summary-owner' });
  await seedOrgMembership(databaseUrl, ownerUserId, orgId, 'admin');
  const principal = await db.ensureGithubPrincipal({ userId: ownerUserId, displayName: 'Runner Summary Owner', email: 'runner-summary-owner@example.test' });
  owner = { id: principal.id, sessionVersion: principal.sessionVersion };
  const workspace = await db.bootstrapCollaborationWorkspace({ actor: asActor(owner), orgId, name: 'Runner Summary', idempotencyKey: 'runner-summary-workspace' });
  projectId = (await db.createCollabProject({ actor: asActor(owner), workspaceId: workspace.id, name: 'Runner Summary Project' })).id;
  await db.getPool().query(`INSERT INTO agents(id,org_id,agent_type,transport,max_chat_slots) VALUES($1,$2,'test','long_poll',0)`, [agentId, orgId]);
  await db.getPool().query(`INSERT INTO agent_sessions(org_id,agent_id,session_meta,status,last_seen_at,expires_at)
    VALUES($1,$2,$3,'online',NOW(),NOW()+interval '10 minutes')`,
  [orgId, agentId, JSON.stringify({ capacity: 1, supported_claim_types: ['summary'], profiles: advertisedProfiles })]);
  const settings = await db.getProjectSummarySettings({ actor: asActor(owner), projectId });
  await db.updateProjectSummarySettings({ actor: asActor(owner), projectId, expectedVersion: settings.version, defaults: { enabled: true, agentId, profileId: 'design', model: 'small' } });
  const host = await db.createExecutionHost({ actor: asActor(owner), name: 'Runner summary host' });
  hostId = host.id;
  mappingId = (await db.createProjectHostMapping({ actor: asActor(owner), projectId, hostId, repositoryKey: 'acme/runner-summary', profileIds: ['summary-source-profile'], defaultProfileId: 'summary-source-profile' })).id;
  await db.registerConnector({ token: host.token, instanceId: 'runner-summary-fixture', protocolVersion: 1, sdkVersion: '0.12.0', daemonVersion: '1.0.0', capabilities: {}, catalog: { repositories: [{ key: 'acme/runner-summary' }], profiles: [{ id: 'summary-source-profile', name: 'Summary source profile', provider: 'omp', model: 'fixture' }] } });
  await listen();
}, 30000);

afterAll(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  await db.closePool();
});

it('queues through the canonical summary request and freezes the wire from the server', async () => {
  const queued = await queueSummary();
  expect(queued.claimId).toBeGreaterThan(0);
  expect(queued.requestId).toMatch(/^[0-9a-f-]{36}$/);
  const leased = await leaseWork();
  expect(leased.work).toMatchObject({
    claim_id: queued.claimId, task_id: queued.taskId, claim_type: 'summary', repo: null, pr_number: null,
    summary: { requestId: queued.requestId, profile: 'design', model: 'small', timeoutMs: 300000, reported: false },
  });
  expect(leased.work.summary.prompt).toContain('Summarize only the frozen task and execution source below.');
  expect(leased.work.summary.prompt).toContain(JSON.stringify(frozenCursor));
  expect(leased.work.reporting).toMatchObject({ bindingId: expect.any(String), credential: expect.any(String), captureKey: expect.any(String) });
}, 20000);

it('publishes one canonical summary with stored attribution through the real result endpoint', async () => {
  const queued = await queueSummary();
  const token = await db.createToken({ orgId, agentId, label: `real-${randomUUID()}` });
  await withHarness({ scenario: 'summary-report', client: createClient({ serverUrl: base, token: token.plaintext }), runnerToken: token.plaintext }, async (h) => {
    await until(async () => await claimStatus(queued.claimId) === 'completed');
    const started = traceEntries(h.tracePath).find((entry) => entry.kind === 'process_start');
    expect(started.githubCredentialPresent).toBe(false);
    const taskTrace = traceEntries(h.tracePath).find((entry) => entry.kind === 'summary_task');
    expect(taskTrace.selectedModel).toBe('small');
    expect(taskTrace.reportingRole).toBe('summary');
    expect(taskTrace.hasWorkspace).toBe(false);
    expect(taskTrace.summaryKeys).toEqual(['model', 'profileId', 'reported', 'source', 'sourceCursor', 'sourceEntryCount', 'sourceText', 'sourceTruncated']);
    expect(traceEntries(h.tracePath).find((entry) => entry.kind === 'summary_publication')).toMatchObject({ isError: false });
    const row = (await db.getPool().query('SELECT body, model, source_epoch, source_seq, claim_id FROM collab_summaries WHERE claim_id=$1', [queued.claimId])).rows;
    expect(row).toHaveLength(1);
    expect(row[0]).toEqual({ body: 'Deterministic summary body.', model: 'small', source_epoch: frozenCursor.epoch, source_seq: frozenCursor.seq, claim_id: queued.claimId });
    expect((await db.getPool().query('SELECT count(*)::int AS count FROM collab_artifacts WHERE claim_id=$1', [queued.claimId])).rows[0].count).toBe(0);
    await h.runtime.exited;
    await until(() => h.runner.activeWork === null);
    await h.stop();
    expect(readdirSync(h.workDir, { recursive: true })).toEqual([]);
  });
}, 30000);

it('finishes an already reported summary without a paid turn', async () => {
  const queued = await queueSummary();
  const leased = await leaseWork();
  await withHarness({ scenario: 'summary-report', work: leased.work }, async (h) => {
    await until(() => h.reports.length > 0);
    expect(h.reports[0].status).toBe('completed');
  });
  const failed = await agentRequest(leased.token.plaintext, '/claim', { claim_id: queued.claimId, session_id: leased.session,
    repo: null, pr_number: null, attempt: leased.work.attempt, status: 'failed', failure_kind: 'transient' });
  expect(failed.status).toBe(200);
  const replay = await agentRequest(leased.token.plaintext, '/poll', { session_id: leased.session });
  expect(replay.status).toBe(200);
  const replayed = replay.body.work;
  expect(replayed.summary.reported).toBe(true);
  expect(replayed.claim_id).not.toBe(queued.claimId);
  await withHarness({ scenario: 'summary-report', work: replayed }, async (h) => {
    await until(() => h.reports.length > 0);
    expect(h.reports[0].status).toBe('completed');
    expect(traceEntries(h.tracePath).some((entry) => entry.kind === 'process_start')).toBe(false);
    expect(h.runtime).toBeNull();
    expect(await summaryRowCount(queued.claimId)).toBe(1);
    await until(() => h.runner.activeWork === null);
  });
}, 30000);

it('fails loudly and cleans up when the frozen turn never completes', async () => {
  const queued = await queueSummary();
  const leased = await leaseWork();
  await withHarness({ scenario: 'summary-hang', work: leased.work, executionTimeoutMs: 400 }, async (h) => {
    await until(() => h.reports.length > 0, 15000);
    expect(['failed', 'cancelled']).toContain(h.reports[0].status);
    expect(await summaryRowCount(queued.claimId)).toBe(0);
    await h.runtime.exited;
    await until(() => h.runner.activeWork === null);
    await h.stop();
    expect(readdirSync(h.workDir, { recursive: true })).toEqual([]);
  });
}, 30000);

it('does not credit success without publication through the real result endpoint', async () => {
  const queued = await queueSummary();
  const token = await db.createToken({ orgId, agentId, label: `real-${randomUUID()}` });
  await withHarness({ scenario: 'summary-no-publish', client: createClient({ serverUrl: base, token: token.plaintext }), runnerToken: token.plaintext }, async (h) => {
    await until(async () => await claimStatus(queued.claimId) === 'failed', 15000);
    expect(await summaryRowCount(queued.claimId)).toBe(0);
    expect((await db.getPool().query(`SELECT EXISTS(SELECT 1 FROM agent_claim_events WHERE claim_id=$1
      AND payload->'raw'->>'state'='idle' AND payload->'raw'->>'stopReason'='end_turn') AS ended`, [queued.claimId])).rows[0].ended).toBe(true);
    await h.runtime.exited;
    expect(traceEntries(h.tracePath).some((entry) => entry.kind === 'summary_publication')).toBe(false);
  });
}, 30000);

it('requires the exact server-frozen profile and model in the local catalog', async () => {
  const queued = await queueSummary();
  const leased = await leaseWork();
  const withoutProfile = [{ id: 'other', permission: { configId: 'approval', value: 'ask' }, modelConfigId: 'model', models: ['small'], defaultModel: 'small' }];
  const withoutModel = [{ id: 'design', permission: { configId: 'approval', value: 'ask' }, modelConfigId: 'model', models: ['large'], defaultModel: 'large' }];
  for (const profiles of [withoutProfile, withoutModel]) {
    await withHarness({ scenario: 'summary-report', work: leased.work, profiles }, async (h) => {
      await until(() => h.reports.length > 0);
      expect(h.reports[0].status).toBe('failed');
      expect(traceEntries(h.tracePath).some((entry) => entry.kind === 'process_start')).toBe(false);
      expect(await summaryRowCount(queued.claimId)).toBe(0);
      await until(() => h.runner.activeWork === null);
    });
  }
  expect(await summaryRowCount(queued.claimId)).toBe(0);
}, 30000);

it('contains the summary role from workspace capture, observations and progress reporting', async () => {
  const queued = await queueSummary();
  const leased = await leaseWork();
  await withHarness({ scenario: 'summary-capture', work: leased.work }, async (h) => {
    await until(() => h.reports.length > 0);
    expect(h.reports[0].status).toBe('completed');
    const entries = traceEntries(h.tracePath);
    const taskTrace = entries.find((entry) => entry.kind === 'summary_task');
    expect(taskTrace.reportingRole).toBe('summary');
    expect(taskTrace.hasWorkspace).toBe(false);
    expect(entries.find((entry) => entry.kind === 'summary_capture')).toMatchObject({ isError: true });
    expect(entries.find((entry) => entry.kind === 'summary_workspace_report')).toMatchObject({ isError: true });
    expect(entries.find((entry) => entry.kind === 'summary_progress')).toMatchObject({ isError: true });
    expect((await db.getPool().query('SELECT count(*)::int AS count FROM collab_artifacts WHERE claim_id=$1', [queued.claimId])).rows[0].count).toBe(0);
    const observations = (await db.getPool().query('SELECT count(*)::int AS count FROM collab_claim_workspace_state workspace JOIN collab_scoped_tokens token ON token.id=workspace.reporting_binding_id WHERE token.claim_id=$1', [queued.claimId])).rows[0].count;
    expect(observations).toBe(0);
    expect(await summaryRowCount(queued.claimId)).toBe(1);
    await h.runtime.exited;
  });
}, 30000);

it('records an applied user cancellation as cancelled rather than a failed summary', async () => {
  const queued = await queueSummary();
  const token = await db.createToken({ orgId, agentId, label: `cancel-${randomUUID()}` });
  await withHarness({ scenario: 'summary-hang', client: createClient({ serverUrl: base, token: token.plaintext }), runnerToken: token.plaintext, eventFlushMs: 10000 }, async h => {
    await until(() => traceEntries(h.tracePath).some(entry => entry.kind === 'session_prompt'));
    await db.submitCollabClaimCommand({ actor: asActor(owner), claimId: queued.claimId, idempotencyKey: randomUUID(), kind: 'cancel', payload: {} });
    await until(async () => ['failed', 'cancelled', 'completed'].includes(await claimStatus(queued.claimId)));
    expect(await claimStatus(queued.claimId)).toBe('cancelled');
    expect(await summaryRowCount(queued.claimId)).toBe(0);
    expect((await db.getPool().query(`SELECT EXISTS(SELECT 1 FROM agent_claim_events WHERE claim_id=$1
      AND payload->'raw'->>'state'='idle' AND payload->'raw'->>'stopReason'='cancelled') AS ended`, [queued.claimId])).rows[0].ended).toBe(true);
    await h.runtime.exited;
    await until(() => h.runner.activeWork === null);
    expect(readdirSync(h.workDir)).toEqual([]);
  });
}, 20000);
