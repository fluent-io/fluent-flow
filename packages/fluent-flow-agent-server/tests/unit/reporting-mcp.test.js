import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const databaseUrl = process.env.COLLAB_REPORTING_MCP_TEST_DATABASE_URL;
if (!databaseUrl) throw new Error('COLLAB_REPORTING_MCP_TEST_DATABASE_URL must name a dedicated loopback ff_reporting_mcp_* database.');
const parsedDatabaseUrl = new URL(databaseUrl);
if (!['127.0.0.1', 'localhost', '[::1]'].includes(parsedDatabaseUrl.hostname) || !/^\/ff_reporting_mcp_[a-z0-9_]+$/.test(parsedDatabaseUrl.pathname)) {
  throw new Error('Unsafe reporting MCP integration database.');
}
process.env.DATABASE_URL = databaseUrl;
process.env.LOG_LEVEL = 'silent';
process.env.FF_COLLAB_AUTH_SECRET = 'reporting-mcp-secret-0123456789abcdef0123456789abcdef';

const github = vi.hoisted(() => ({ prs: new Map() }));
vi.mock('../../../fluent-flow/src/providers/github/rest.js', async () => {
  const actual = await vi.importActual('../../../fluent-flow/src/providers/github/rest.js');
  return { ...actual,
    getPR: async (_owner, _name, number) => {
      const pullRequest = github.prs.get(number);
      if (!pullRequest) throw new Error('Fixture pull request does not exist');
      return structuredClone(pullRequest);
    },
    findPullRequestsByHead: async (_owner, _name, branch) => [...github.prs.values()]
      .filter((pullRequest) => pullRequest.head.ref === branch && pullRequest.state === 'open')
      .map((pullRequest) => structuredClone(pullRequest)),
  };
});

const { resetCollabSchema, seedUser, seedOrgMembership } = await import('../../../fluent-flow/tests/helpers/collab-db.js');
const db = await import('@fluent-flow/db');
const { createApp } = await import('../../../fluent-flow/src/app.js');
const { createReportingMcpDescriptor, reportFinalWorkspace } = await import('../../src/reporting-mcp.js');
const { createAcpRuntime } = await import('../../src/acp/runtime.js');
const { createRunner } = await import('../../src/runner.js');
const { createClient } = await import('../../src/client.js');
const { createLogger } = await import('../../src/logger.js');

const fakeAgent = join(dirname(fileURLToPath(import.meta.url)), 'fake-acp-agent.js');
const orgId = 'reporting-mcp-org';
const repo = 'acme/reporting-mcp';
const agentId = 'reporting-mcp-runner';
const MAX_CAPTURE_BYTES = 524288;

let server;
let base;
let owner;
let projectId;
let prNumber = 7100;

function asActor(principal) {
  return { principalId: principal.id, sessionVersion: principal.sessionVersion };
}

async function listen() {
  server = createApp().listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
}

async function stop(target) {
  await new Promise((resolve) => target.close(resolve));
}

async function agentRequest(token, path, body) {
  const response = await fetch(`${base}/api/agent-server${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

async function acquire(title) {
  const task = await db.createCollabTask({ actor: asActor(owner), projectId, title });
  const started = await db.startCollabClaimExecution({
    actor: asActor(owner),
    taskId: task.id,
    expectedVersion: task.version,
    idempotencyKey: `reporting-mcp-${randomUUID()}`,
    repo,
    prNumber: prNumber++,
    branch: 'feature/reporting-mcp',
    claimType: 'spec',
    instructions: 'Report through the helper.',
  });
  const token = await db.createToken({ orgId, agentId, label: title });
  const registered = await agentRequest(token.plaintext, '/register', {
    meta: { source: 'reporting-mcp', slot_id: 0, capacity: 1, supported_claim_types: ['spec'] },
  });
  expect(registered.status).toBe(200);
  const polled = await agentRequest(token.plaintext, '/poll', { session_id: registered.body.session_id });
  expect(polled.status).toBe(200);
  expect(polled.body.work.claim_id).toBe(started.claim.id);
  return { taskId: task.id, claimId: started.claim.id, reporting: polled.body.work.reporting };
}

function workspaceFixture() {
  const root = mkdtempSync(join(tmpdir(), 'ff-reporting-mcp-'));
  const workspace = join(root, 'workspace');
  mkdirSync(join(workspace, 'reports'), { recursive: true });
  return { root, workspace };
}

function descriptorFor(work, workspace, overrides = {}) {
  return createReportingMcpDescriptor({
    serverUrl: overrides.serverUrl ?? base,
    claimId: work.claimId,
    reporting: work.reporting,
    workspaceRoot: workspace,
    denyValues: overrides.denyValues ?? [],
  });
}

function environmentOf(descriptor) {
  return Object.fromEntries(descriptor.env.map((variable) => [variable.name, variable.value]));
}

async function connect(descriptor) {
  const transport = new StdioClientTransport({
    command: descriptor.command,
    args: descriptor.args,
    env: environmentOf(descriptor),
    stderr: 'pipe',
  });
  const stderr = [];
  transport.stderr?.on('data', (chunk) => stderr.push(chunk.toString('utf8')));
  const client = new Client({ name: 'reporting-mcp-test', version: '1.0.0' });
  await client.connect(transport);
  return { client, transport, stderr };
}

async function withHelper(descriptor, fn) {
  const helper = await connect(descriptor);
  try {
    return await fn(helper);
  } finally {
    await helper.client.close();
  }
}

function parsed(result) {
  return { isError: result.isError === true, value: JSON.parse(result.content[0].text) };
}

async function reportFile(client, reference, extra = {}) {
  return parsed(await client.callTool({
    name: 'collaboration_add_artifact',
    arguments: { name: extra.name ?? `Report ${reference}`, kind: 'file', direction: 'output', reference, ...(extra.arguments ?? {}) },
    ...(extra.meta ? { _meta: extra.meta } : {}),
  }));
}

async function artifactCount(claimId) {
  return (await db.getPool().query('SELECT count(*)::int AS count FROM collab_artifacts WHERE claim_id = $1', [claimId])).rows[0].count;
}

async function rawContent(artifactId) {
  const response = await fetch(`${base}/api/collab/v1/artifacts/${artifactId}/content?raw=1`, {
    headers: { 'x-fluent-flow-actor': db.signCollaborationActor(asActor(owner), process.env.FF_COLLAB_AUTH_SECRET) },
  });
  return { status: response.status, bytes: Buffer.from(await response.arrayBuffer()) };
}

function exitOf(child, timeoutMs = 3000) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Helper did not exit')), timeoutMs);
    child.once('exit', (code, signal) => { clearTimeout(timer); resolve({ code, signal }); });
  });
}

function spawnRaw(descriptor) {
  const child = spawn(descriptor.command, descriptor.args, { env: environmentOf(descriptor), stdio: ['pipe', 'pipe', 'pipe'] });
  const stdout = [];
  const stderr = [];
  child.stdout.on('data', (chunk) => stdout.push(chunk.toString('utf8')));
  child.stderr.on('data', (chunk) => stderr.push(chunk.toString('utf8')));
  const send = (message) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
  const lines = () => stdout.join('').split('\n').filter(Boolean);
  return { child, send, lines, stderr };
}

async function initializeRaw(raw) {
  raw.send({ id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'raw', version: '1.0.0' } } });
  await until(() => raw.lines().some((line) => JSON.parse(line).id === 1));
  raw.send({ method: 'notifications/initialized' });
}

async function until(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for reporting helper state');
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    throw error;
  }
}

async function hangingServer() {
  const requests = [];
  const target = createServer((request) => {
    const record = { closed: false };
    requests.push(record);
    request.socket.once('close', () => { record.closed = true; });
  });
  target.listen(0, '127.0.0.1');
  await new Promise((resolve) => target.once('listening', resolve));
  return { target, requests, url: `http://127.0.0.1:${target.address().port}` };
}

async function deadServerUrl() {
  const target = createServer();
  target.listen(0, '127.0.0.1');
  await new Promise((resolve) => target.once('listening', resolve));
  const url = `http://127.0.0.1:${target.address().port}`;
  await stop(target);
  return url;
}

beforeAll(async () => {
  await resetCollabSchema(databaseUrl);
  await db.runMigrations();
  const ownerUserId = await seedUser(databaseUrl, { githubId: 9971, login: 'reporting-mcp-owner' });
  await seedOrgMembership(databaseUrl, ownerUserId, orgId, 'admin');
  const principal = await db.ensureGithubPrincipal({ userId: ownerUserId, displayName: 'Reporting MCP Owner', email: 'reporting-mcp-owner@example.test' });
  owner = { id: principal.id, sessionVersion: principal.sessionVersion };
  const workspace = await db.bootstrapCollaborationWorkspace({ actor: asActor(owner), orgId, name: 'Reporting MCP', idempotencyKey: 'reporting-mcp-workspace' });
  projectId = (await db.createCollabProject({ actor: asActor(owner), workspaceId: workspace.id, name: 'Reporting MCP Project' })).id;
  await db.getPool().query(`INSERT INTO repos (id, org_id, repo_full_name, provider) VALUES ($1, $2, $3, 'github')`, [randomUUID(), orgId, repo]);
  await db.createAgent({ id: agentId, orgId, agentType: 'test', transport: 'long_poll', repos: [repo] });
  await listen();
}, 30000);

afterAll(async () => {
  if (server) await stop(server);
  await db.closePool();
});

describe('packaged native reporting MCP helper', () => {
  it('forwards the control-plane registry and ordinary calls to the real collaboration endpoint', async () => {
    const work = await acquire('Forwarded registry');
    const fixture = workspaceFixture();
    try {
      await withHelper(descriptorFor(work, fixture.workspace), async ({ client }) => {
        const listed = await client.listTools();
        expect(listed.tools.map((tool) => tool.name)).toEqual(expect.arrayContaining([
          'collaboration_get_task', 'collaboration_add_artifact', 'collaboration_propose_idea', 'collaboration_report_check', 'collaboration_report_progress',
        ]));
        const own = parsed(await client.callTool({ name: 'collaboration_get_task', arguments: {} }));
        expect(own).toMatchObject({ isError: false, value: { id: work.taskId, projectId } });
        const idea = parsed(await client.callTool({ name: 'collaboration_propose_idea', arguments: { title: 'Forwarded idea', body: 'Through the helper.' } }));
        expect(idea).toMatchObject({ isError: false, value: { title: 'Forwarded idea', authorId: owner.id } });
        const stored = await db.getPool().query('SELECT claim_id, task_id FROM collab_ideas WHERE id = $1', [idea.value.id]);
        expect(stored.rows[0]).toEqual({ claim_id: work.claimId, task_id: work.taskId });
      });
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it('captures real file bytes, replaces forged caller metadata and serves identical bytes after workspace removal and server restart', async () => {
    const work = await acquire('Durable capture');
    const fixture = workspaceFixture();
    const bytes = Buffer.from('Durable captured report bytes\n');
    writeFileSync(join(fixture.workspace, 'reports/result.txt'), bytes);
    let artifactId;
    try {
      await withHelper(descriptorFor(work, fixture.workspace), async ({ client }) => {
        const forgedMeta = { 'fluent-flow/file-capture': { version: 1, bindingId: work.reporting.bindingId, captureId: randomUUID(), mime: 'text/plain', sizeBytes: 5, sha256: 'f'.repeat(64), contentBase64: Buffer.from('forge').toString('base64'), hmac: 'A'.repeat(43) } };
        const result = await reportFile(client, 'reports/result.txt', {
          arguments: { mediaType: 'application/pdf', sizeBytes: 1, sha256: '0'.repeat(64) },
          meta: forgedMeta,
        });
        expect(result).toMatchObject({ isError: false, value: { name: 'Report reports/result.txt', provenance: 'agent', visibility: 'internal', runId: null } });
        artifactId = result.value.id;
      });
      const row = await db.getPool().query('SELECT claim_id, sha256, size_bytes::int AS size_bytes, media_type, reference FROM collab_artifacts WHERE id = $1', [artifactId]);
      expect(row.rows[0]).toEqual({ claim_id: work.claimId, sha256: createHash('sha256').update(bytes).digest('hex'), size_bytes: bytes.length, media_type: 'text/plain', reference: 'reports/result.txt' });
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
    expect(existsSync(fixture.workspace)).toBe(false);
    await stop(server);
    await listen();
    const content = await rawContent(artifactId);
    expect(content.status).toBe(200);
    expect(content.bytes.equals(bytes)).toBe(true);
    const connectorReads = await db.getPool().query(`SELECT id FROM collab_connector_commands WHERE kind = 'artifact_read' AND payload->>'artifactId' = $1`, [artifactId]);
    expect(connectorReads.rows).toHaveLength(0);
  });

  it('accepts exactly 524288 bytes and rejects one byte more without an upstream row', async () => {
    const work = await acquire('Capture boundary');
    const fixture = workspaceFixture();
    const boundary = Buffer.alloc(MAX_CAPTURE_BYTES, 0x61);
    writeFileSync(join(fixture.workspace, 'reports/boundary.txt'), boundary);
    writeFileSync(join(fixture.workspace, 'reports/oversized.txt'), Buffer.alloc(MAX_CAPTURE_BYTES + 1, 0x61));
    try {
      await withHelper(descriptorFor(work, fixture.workspace), async ({ client }) => {
        const accepted = await reportFile(client, 'reports/boundary.txt');
        expect(accepted.isError).toBe(false);
        expect((await rawContent(accepted.value.id)).bytes.equals(boundary)).toBe(true);
        const rejected = await reportFile(client, 'reports/oversized.txt');
        expect(rejected).toEqual({ isError: true, value: { error: { code: 'capture_unavailable', reason: 'too_large', message: 'The file could not be captured.' } } });
      });
      expect(await artifactCount(work.claimId)).toBe(1);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it('rejects missing, sensitive, symlinked, escaping and unsupported files through the secure artifact reader', async () => {
    const work = await acquire('Capture rejection');
    const fixture = workspaceFixture();
    const outside = join(fixture.root, 'outside.txt');
    writeFileSync(outside, 'outside the workspace');
    writeFileSync(join(fixture.workspace, '.env'), 'TOKEN=value');
    mkdirSync(join(fixture.workspace, 'secrets'));
    writeFileSync(join(fixture.workspace, 'secrets/notes.txt'), 'private');
    symlinkSync(outside, join(fixture.workspace, 'reports/linked.txt'));
    writeFileSync(join(fixture.workspace, 'reports/binary.exe'), 'binary');
    try {
      await withHelper(descriptorFor(work, fixture.workspace), async ({ client }) => {
        const cases = [
          ['reports/missing.txt', 'not_found'],
          ['.env', 'credential_file'],
          ['secrets/notes.txt', 'credential_file'],
          ['reports/linked.txt', 'symlink_escape'],
          ['../outside.txt', 'outside_workspace'],
          ['reports/binary.exe', 'unsupported_media_type'],
        ];
        for (const [reference, reason] of cases) {
          expect(await reportFile(client, reference)).toEqual({ isError: true, value: { error: { code: 'capture_unavailable', reason, message: 'The file could not be captured.' } } });
        }
      });
      expect(await artifactCount(work.claimId)).toBe(0);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it('rejects files whose exact bytes contain known secrets or private paths instead of redacting them', async () => {
    const work = await acquire('Known secret rejection');
    const fixture = workspaceFixture();
    const denied = 'ghs_reportingDenyFixture0123456789abcdef';
    writeFileSync(join(fixture.workspace, 'reports/a.txt'), `leak ${work.reporting.credential}`);
    writeFileSync(join(fixture.workspace, 'reports/b.txt'), `leak ${work.reporting.captureKey}`);
    writeFileSync(join(fixture.workspace, 'reports/c.txt'), `leak ${denied}`);
    writeFileSync(join(fixture.workspace, 'reports/d.txt'), `see ${fixture.workspace}/src/private.ts`);
    try {
      await withHelper(descriptorFor(work, fixture.workspace, { denyValues: [denied] }), async ({ client }) => {
        for (const reference of ['reports/a.txt', 'reports/b.txt', 'reports/c.txt', 'reports/d.txt']) {
          const result = await reportFile(client, reference);
          expect(result).toEqual({ isError: true, value: { error: { code: 'capture_rejected', message: 'The file contains private data and was not captured.' } } });
          expect(JSON.stringify(result)).not.toContain(denied);
          expect(JSON.stringify(result)).not.toContain(fixture.workspace);
        }
      });
      expect(await artifactCount(work.claimId)).toBe(0);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it('captures the bytes present at each report when a file changes between reports', async () => {
    const work = await acquire('Changed file');
    const fixture = workspaceFixture();
    const first = Buffer.from('first version\n');
    const second = Buffer.from('second version, changed\n');
    try {
      await withHelper(descriptorFor(work, fixture.workspace), async ({ client }) => {
        writeFileSync(join(fixture.workspace, 'reports/changing.txt'), first);
        const before = await reportFile(client, 'reports/changing.txt', { name: 'Changing report' });
        writeFileSync(join(fixture.workspace, 'reports/changing.txt'), second);
        const after = await reportFile(client, 'reports/changing.txt', { name: 'Changing report' });
        expect(before.isError).toBe(false);
        expect(after.isError).toBe(false);
        expect(after.value.id).not.toBe(before.value.id);
        expect((await rawContent(before.value.id)).bytes.equals(first)).toBe(true);
        expect((await rawContent(after.value.id)).bytes.equals(second)).toBe(true);
        expect(after.value.sha256).toBe(createHash('sha256').update(second).digest('hex'));
      });
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it('returns a generic tool error without retrying when the control plane is unreachable or rejects the credential', async () => {
    const work = await acquire('Upstream failure');
    const fixture = workspaceFixture();
    writeFileSync(join(fixture.workspace, 'reports/result.txt'), 'bytes');
    try {
      await withHelper(descriptorFor(work, fixture.workspace, { serverUrl: await deadServerUrl() }), async ({ client, stderr }) => {
        const idea = parsed(await client.callTool({ name: 'collaboration_propose_idea', arguments: { title: 'Unreachable', body: 'No upstream.' } }));
        expect(idea).toEqual({ isError: true, value: { error: { code: 'reporting_unavailable', message: 'Reporting is unavailable.' } } });
        const file = await reportFile(client, 'reports/result.txt');
        expect(file).toEqual({ isError: true, value: { error: { code: 'reporting_unavailable', message: 'Reporting is unavailable.' } } });
        await expect(client.ping()).resolves.toBeDefined();
        expect(stderr.join('')).not.toContain(work.reporting.credential);
      });
      await db.getPool().query('UPDATE collab_scoped_tokens SET revoked_at = NOW() WHERE id = $1', [work.reporting.bindingId]);
      await withHelper(descriptorFor(work, fixture.workspace), async ({ client }) => {
        const denied = parsed(await client.callTool({ name: 'collaboration_propose_idea', arguments: { title: 'Revoked', body: 'Rejected upstream.' } }));
        expect(denied).toEqual({ isError: true, value: { error: { code: 'reporting_unavailable', message: 'Reporting is unavailable.' } } });
      });
      expect((await db.getPool().query("SELECT id FROM collab_ideas WHERE title IN ('Unreachable','Revoked')")).rows).toHaveLength(0);
      expect(await artifactCount(work.claimId)).toBe(0);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it('writes only JSON-RPC protocol messages to stdout and no credentials to stderr', async () => {
    const work = await acquire('Protocol purity');
    const fixture = workspaceFixture();
    writeFileSync(join(fixture.workspace, 'reports/result.txt'), 'purity bytes');
    const raw = spawnRaw(descriptorFor(work, fixture.workspace));
    try {
      await initializeRaw(raw);
      raw.send({ id: 2, method: 'tools/list', params: {} });
      raw.send({ id: 3, method: 'tools/call', params: { name: 'collaboration_add_artifact', arguments: { name: 'Purity', kind: 'file', direction: 'output', reference: 'reports/result.txt' } } });
      raw.send({ id: 4, method: 'tools/call', params: { name: 'collaboration_add_artifact', arguments: { name: 'Missing', kind: 'file', direction: 'output', reference: 'reports/missing.txt' } } });
      await until(() => [2, 3, 4].every((id) => raw.lines().some((line) => JSON.parse(line).id === id)));
      raw.child.stdin.end();
      expect(await exitOf(raw.child)).toEqual({ code: 0, signal: null });
      for (const line of raw.lines()) expect(JSON.parse(line).jsonrpc).toBe('2.0');
      const output = raw.lines().join('\n') + raw.stderr.join('');
      expect(output).not.toContain(work.reporting.credential);
      expect(output).not.toContain(work.reporting.captureKey);
      expect(output).not.toContain(fixture.workspace);
    } finally {
      raw.child.kill('SIGKILL');
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it('aborts pending upstream calls and exits on stdin EOF', async () => {
    const work = await acquire('EOF teardown');
    const fixture = workspaceFixture();
    const hanging = await hangingServer();
    const raw = spawnRaw(descriptorFor(work, fixture.workspace, { serverUrl: hanging.url }));
    try {
      await initializeRaw(raw);
      raw.send({ id: 2, method: 'tools/call', params: { name: 'collaboration_propose_idea', arguments: { title: 'Pending', body: 'Never answered.' } } });
      await until(() => hanging.requests.length > 0);
      raw.child.stdin.end();
      expect(await exitOf(raw.child)).toEqual({ code: 0, signal: null });
      await until(() => hanging.requests.every((request) => request.closed));
      for (const line of raw.lines()) expect(JSON.parse(line).jsonrpc).toBe('2.0');
    } finally {
      raw.child.kill('SIGKILL');
      hanging.target.closeAllConnections();
      await stop(hanging.target);
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it('aborts pending upstream calls and exits on termination', async () => {
    const work = await acquire('Termination teardown');
    const fixture = workspaceFixture();
    const hanging = await hangingServer();
    const raw = spawnRaw(descriptorFor(work, fixture.workspace, { serverUrl: hanging.url }));
    try {
      await initializeRaw(raw);
      raw.send({ id: 2, method: 'tools/call', params: { name: 'collaboration_propose_idea', arguments: { title: 'Pending', body: 'Never answered.' } } });
      await until(() => hanging.requests.length > 0);
      raw.child.kill('SIGTERM');
      const exited = await exitOf(raw.child);
      expect(exited.code === 0 || exited.signal === 'SIGTERM').toBe(true);
      await until(() => hanging.requests.every((request) => request.closed));
    } finally {
      raw.child.kill('SIGKILL');
      hanging.target.closeAllConnections();
      await stop(hanging.target);
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });
});

describe('ACP runtime reporting MCP injection', () => {
  function makeRuntime(scenario, fixture, descriptor) {
    const tracePath = join(fixture.root, 'trace.jsonl');
    const runtime = createAcpRuntime({
      command: { bin: process.execPath, args: [fakeAgent, '--scenario', scenario, '--trace', tracePath] },
      cwd: fixture.workspace,
      env: { ...process.env },
      mcpServers: [descriptor],
      onEvent: async () => {},
      onRequest: async () => {},
      onRequestCancelled: async () => {},
      log: {},
      limits: { requestTimeoutMs: 5000, silenceMs: 2000, shutdownIdleMs: 200, shutdownExitMs: 200, shutdownKillMs: 500, restartWindowMs: 60_000, maxRestarts: 2 },
    });
    const trace = (kind) => (existsSync(tracePath) ? readFileSync(tracePath, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)) : [])
      .filter((entry) => entry.kind === kind);
    return { runtime, trace };
  }

  it('injects the helper into session/new so the provider registers a real file through it', async () => {
    const work = await acquire('ACP new session injection');
    const fixture = workspaceFixture();
    const bytes = Buffer.from('ACP new-session report\n');
    writeFileSync(join(fixture.workspace, 'reports/acp.txt'), bytes);
    const descriptor = descriptorFor(work, fixture.workspace);
    const { runtime, trace } = makeRuntime('reporting-mcp', fixture, descriptor);
    try {
      await expect(runtime.runInitialPrompt('Report the file. REPORT_FILE:reports/acp.txt')).resolves.toMatchObject({ stopReason: 'end_turn' });
      const connected = trace('reporting_connected');
      expect(connected).toHaveLength(1);
      expect(connected[0].tools).toEqual(expect.arrayContaining(['collaboration_add_artifact']));
      const [reported] = trace('reporting_result');
      expect(reported).toMatchObject({ isError: false, value: { name: 'ACP reported file', provenance: 'agent' } });
      expect((await rawContent(reported.value.id)).bytes.equals(bytes)).toBe(true);
      await runtime.close();
      await until(() => !processAlive(connected[0].pid));
    } finally {
      await runtime.close();
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it('injects the same helper into session/resume after provider loss and the resumed provider registers a real file', async () => {
    const work = await acquire('ACP resume injection');
    const fixture = workspaceFixture();
    const bytes = Buffer.from('ACP resumed-session report\n');
    writeFileSync(join(fixture.workspace, 'reports/resumed.txt'), bytes);
    const descriptor = descriptorFor(work, fixture.workspace);
    const { runtime, trace } = makeRuntime('reporting-mcp-resume', fixture, descriptor);
    try {
      await expect(runtime.runInitialPrompt('Report after resume. REPORT_FILE:reports/resumed.txt')).resolves.toMatchObject({ stopReason: 'end_turn' });
      expect(trace('process_start')).toHaveLength(2);
      const connected = trace('reporting_connected');
      expect(connected).toHaveLength(2);
      await until(() => !processAlive(connected[0].pid));
      const results = trace('reporting_result');
      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({ isError: false, value: { name: 'ACP reported file' } });
      expect((await rawContent(results[0].value.id)).bytes.equals(bytes)).toBe(true);
      expect(await artifactCount(work.claimId)).toBe(1);
      await runtime.close();
      await until(() => !processAlive(connected[1].pid));
    } finally {
      await runtime.close();
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });
});

describe('claim-runner native reporting', () => {
  it('reports a durable artifact from a real claimed chat and keeps its bytes after End and workspace removal', async () => {
    const chatAgentId = 'reporting-chat-runner';
    await db.createAgent({ id: chatAgentId, orgId, agentType: 'claude', transport: 'long_poll', repos: [] });
    const token = await db.createToken({ orgId, agentId: chatAgentId, label: 'Real native runner' });
    const profile = { id: 'design', permission: { configId: 'approval', value: 'ask' }, modelConfigId: 'model', models: ['small', 'large'], defaultModel: 'small' };
    const advertised = await agentRequest(token.plaintext, '/register', { meta: { instance_id: 'reporting-native', slot_id: 1, capacity: 2, supported_claim_types: ['chat'], profiles: [{ id: 'design', models: profile.models, default_model: 'small' }] } });
    expect(advertised.status).toBe(200);
    const settings = await db.getProjectChatSettings({ actor: asActor(owner), projectId });
    await db.updateProjectChatSettings({ actor: asActor(owner), projectId, expectedVersion: settings.version, executionMode: 'chat', defaultAgentId: chatAgentId,
      defaults: { profileId: 'design', model: 'small', instructions: 'REPORT_FILE:reports/from-runner.txt' } });
    const task = await db.createCollabTask({ actor: asActor(owner), projectId, title: 'Real runner reporting' });
    const started = await db.startCollabClaimExecution({ actor: asActor(owner), taskId: task.id, expectedVersion: task.version, idempotencyKey: randomUUID(), claimType: 'chat', repo: null });
    const fixture = workspaceFixture();
    const workDir = join(fixture.root, 'work');
    mkdirSync(workDir);
    const tracePath = join(fixture.root, 'runner-trace.jsonl');
    const errors = [];
    const runner = createRunner({
      client: createClient({ serverUrl: base, token: token.plaintext }),
      log: createLogger(false, 'error', { write: (chunk) => errors.push(JSON.parse(chunk)) }),
      cwd: workDir, childEnvironment: { PATH: process.env.PATH }, runnerToken: token.plaintext,
      meta: { instance_id: 'reporting-native', slot_id: 0, capacity: 2 },
      acpCommand: process.execPath, acpArgs: [fakeAgent, '--scenario', 'reporting-runner', '--trace', tracePath],
      heartbeatIntervalMs: 1000, commandPollMs: 25, eventFlushMs: 10,
      chat: { enabled: true, profiles: [profile] }, executionTimeoutMs: 15000,
    });
    const running = runner.start();
    try {
      await until(async () => {
        expect(errors).toEqual([]);
        return (await db.getPool().query('SELECT status FROM agent_claims WHERE id=$1', [started.claim.id])).rows[0].status === 'claimed';
      });
      await db.submitCollabClaimCommand({ actor: asActor(owner), claimId: started.claim.id, kind: 'prompt', payload: { text: 'Write and report the file.' }, idempotencyKey: randomUUID() });
      await until(async () => {
        expect(errors).toEqual([]);
        return await artifactCount(started.claim.id) === 1;
      });
      const artifact = (await db.getPool().query('SELECT id, run_id, captured_content FROM collab_artifacts WHERE claim_id=$1', [started.claim.id])).rows[0];
      expect(artifact.run_id).toBeNull();
      expect(artifact.captured_content.equals(Buffer.from('runner durable artifact\n'))).toBe(true);
      await db.submitCollabClaimCommand({ actor: asActor(owner), claimId: started.claim.id, kind: 'end_session', payload: {}, idempotencyKey: randomUUID() });
      await until(async () => (await db.getPool().query('SELECT status FROM agent_claims WHERE id=$1', [started.claim.id])).rows[0].status === 'cancelled');
      await runner.shutdown();
      await running;
      const state = (await db.getPool().query('SELECT workspace.state,workspace.final FROM collab_claim_workspace_state workspace JOIN collab_scoped_tokens token ON token.id=workspace.reporting_binding_id WHERE token.claim_id=$1', [started.claim.id])).rows[0];
      expect(state).toMatchObject({ state: 'not_repository', final: true });
      const connections = readFileSync(tracePath, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)).filter((entry) => entry.kind === 'reporting_connected');
      for (const connection of connections) await until(() => !processAlive(connection.pid));
      rmSync(fixture.root, { recursive: true, force: true });
      const content = await rawContent(artifact.id);
      expect(content.status).toBe(200);
      expect(content.bytes.equals(Buffer.from('runner durable artifact\n'))).toBe(true);
      expect(errors).toEqual([]);
    } finally {
      await runner.shutdown();
      await running;
      rmSync(fixture.root, { recursive: true, force: true });
    }
  }, 15000);
});

describe('native reporting privacy', () => {
  it('redacts known private values before structured reports reach canonical storage', async () => {
    const work = await acquire('Structured report privacy');
    const fixture = workspaceFixture();
    const denied = 'operator-private-value-0123456789';
    const privateValues = [work.reporting.credential, work.reporting.captureKey, fixture.workspace, denied];
    try {
      await withHelper(descriptorFor(work, fixture.workspace, { denyValues: [denied] }), async ({ client }) => {
        const result = parsed(await client.callTool({ name: 'collaboration_propose_idea', arguments: { title: 'Safe report', body: `Normal finding. ${privateValues.join(' ')}` } }));
        expect(result.isError).toBe(false);
        const persisted = (await db.getPool().query('SELECT body FROM collab_ideas WHERE claim_id=$1', [work.claimId])).rows[0];
        for (const value of privateValues) {
          expect(JSON.stringify(result).includes(value)).toBe(false);
          expect(persisted.body.includes(value)).toBe(false);
        }
        expect(persisted.body.startsWith('Normal finding. ')).toBe(true);
      });
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it('protects artifact display metadata without changing captured bytes or publishing private paths', async () => {
    const work = await acquire('Artifact metadata privacy');
    const fixture = workspaceFixture();
    const content = Buffer.from('public artifact bytes\n');
    writeFileSync(join(fixture.workspace, 'reports/safe.txt'), content);
    const privateReference = `reports${fixture.workspace}/safe.txt`;
    mkdirSync(join(fixture.workspace, dirname(privateReference)), { recursive: true });
    writeFileSync(join(fixture.workspace, privateReference), content);
    try {
      await withHelper(descriptorFor(work, fixture.workspace), async ({ client }) => {
        const reported = await reportFile(client, 'reports/safe.txt', { name: `Report ${work.reporting.credential}` });
        expect(reported.isError).toBe(false);
        expect(JSON.stringify(reported).includes(work.reporting.credential)).toBe(false);
        const row = (await db.getPool().query('SELECT name,captured_content FROM collab_artifacts WHERE id=$1', [reported.value.id])).rows[0];
        expect(row.name.includes(work.reporting.credential)).toBe(false);
        expect(row.captured_content.equals(content)).toBe(true);
        const denied = await reportFile(client, privateReference);
        expect(denied).toMatchObject({ isError: true, value: { error: { code: 'capture_rejected' } } });
        expect(JSON.stringify(denied).includes(fixture.workspace)).toBe(false);
        expect(await artifactCount(work.claimId)).toBe(1);
      });
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });
});

function gitAt(cwd, args) {
  return execFileSync('git', ['-C', cwd, '-c', 'user.name=Reporting Fixture', '-c', 'user.email=reporting@example.test', '-c', 'core.hooksPath=/dev/null', ...args], {
    encoding: 'utf8', env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
  }).trim();
}

function gitWorkspaceFixture() {
  const fixture = workspaceFixture();
  gitAt(fixture.workspace, ['init', '-b', 'main']);
  writeFileSync(join(fixture.workspace, 'app.txt'), 'first version\n');
  gitAt(fixture.workspace, ['add', 'app.txt']);
  gitAt(fixture.workspace, ['commit', '-m', 'Initial fixture']);
  return { ...fixture, head: gitAt(fixture.workspace, ['rev-parse', 'HEAD']) };
}

function workspaceProof(work, seq, { state = 'known', headCommit = 'a'.repeat(40), dirty = false, final = false } = {}) {
  const material = JSON.stringify(['fluent-flow:workspace-observation:v1', work.reporting.bindingId, work.claimId, seq, state, headCommit, dirty, final, null, null, null]);
  return { version: 1, bindingId: work.reporting.bindingId, seq, state, headCommit, dirty, final, repository: null, taskBranch: null, taskBranchHead: null,
    hmac: createHmac('sha256', Buffer.from(work.reporting.captureKey, 'base64url')).update(material).digest('base64url') };
}

describe('native workspace observations', () => {
  it('attests the actual origin and remote task ref rather than assuming local HEAD was pushed', async () => {
    const work = await acquire('Observed remote task ref');
    const fixture = gitWorkspaceFixture();
    const credential = 'private-origin-credential-canary';
    try {
      gitAt(fixture.workspace, ['remote', 'add', 'origin', `https://user:${credential}@github.com/${repo}.git`]);
      gitAt(fixture.workspace, ['update-ref', 'refs/remotes/origin/feature/reporting-mcp', fixture.head]);
      writeFileSync(join(fixture.workspace, 'app.txt'), 'new local commit\n');
      gitAt(fixture.workspace, ['add', 'app.txt']);
      gitAt(fixture.workspace, ['commit', '-m', 'Unpushed fixture']);
      const current = gitAt(fixture.workspace, ['rev-parse', 'HEAD']);
      await withHelper(descriptorFor(work, fixture.workspace, { denyValues: [credential] }), async ({ client }) => {
        const unpushed = parsed(await client.callTool({ name: 'collaboration_get_task', arguments: {} }));
        expect(unpushed.isError).toBe(false);
        expect(unpushed.value.workspace).toMatchObject({ repository: repo, taskBranch: 'feature/reporting-mcp', taskBranchHead: fixture.head, headCommit: current, dirty: false });
        expect(JSON.stringify(unpushed)).not.toContain(credential);
        gitAt(fixture.workspace, ['update-ref', 'refs/remotes/origin/feature/reporting-mcp', current]);
        const pushed = parsed(await client.callTool({ name: 'collaboration_get_task', arguments: {} }));
        expect(pushed.value.workspace).toMatchObject({ repository: repo, taskBranch: 'feature/reporting-mcp', taskBranchHead: current, headCommit: current });
        gitAt(fixture.workspace, ['remote', 'set-url', 'origin', 'git@github.com:another/fixture.git']);
        const changedOrigin = parsed(await client.callTool({ name: 'collaboration_get_task', arguments: {} }));
        expect(changedOrigin.value.workspace.repository).toBe('another/fixture');
      });
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it('uses the real owned Git head and dirtiness rather than model cleanliness assertions', async () => {
    const work = await acquire('Observed native check');
    const fixture = gitWorkspaceFixture();
    try {
      await withHelper(descriptorFor(work, fixture.workspace), async ({ client }) => {
        const clean = parsed(await client.callTool({ name: 'collaboration_report_check', arguments: { name: 'Observed check', command: 'npm test', status: 'passed', commit: fixture.head, dirty: false, exitCode: 0 } }));
        expect(clean.isError).toBe(false);
        expect(clean.value.stale).toBe(false);
        const declaredDirty = parsed(await client.callTool({ name: 'collaboration_report_check', arguments: { checkId: clean.value.checkId, status: 'passed', commit: fixture.head, dirty: true, exitCode: 0 } }));
        expect(declaredDirty.value.dirty).toBe(true);
        expect(declaredDirty.value.stale).toBe(true);
        writeFileSync(join(fixture.workspace, 'app.txt'), 'changed without a commit\n');
        const dirty = parsed(await client.callTool({ name: 'collaboration_report_check', arguments: { checkId: clean.value.checkId, status: 'passed', commit: fixture.head, dirty: false, exitCode: 0 } }));
        expect(dirty.isError).toBe(false);
        expect(dirty.value.dirty).toBe(true);
        expect(dirty.value.stale).toBe(true);
        const checks = await db.listCollabChecks({ actor: asActor(owner), taskId: work.taskId });
        expect(checks[0].evidence.every((evidence) => evidence.stale)).toBe(true);
        gitAt(fixture.workspace, ['add', 'app.txt']);
        gitAt(fixture.workspace, ['commit', '-m', 'Changed fixture']);
        const currentHead = gitAt(fixture.workspace, ['rev-parse', 'HEAD']);
        const current = parsed(await client.callTool({ name: 'collaboration_report_check', arguments: { checkId: clean.value.checkId, status: 'passed', commit: currentHead, dirty: false, exitCode: 0 } }));
        expect(current.value.stale).toBe(false);
        const after = await db.listCollabChecks({ actor: asActor(owner), taskId: work.taskId });
        expect(after[0].evidence.find((evidence) => evidence.id === clean.value.id).stale).toBe(true);
        await db.getPool().query("UPDATE agent_claims SET claimed_at=claimed_at+interval '1 microsecond' WHERE id=$1", [work.claimId]);
        const reacquired = await db.listCollabChecks({ actor: asActor(owner), taskId: work.taskId });
        expect(reacquired[0].evidence.find((evidence) => evidence.id === current.value.id).stale).toBe(true);
      });
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it('keeps repo-less and enclosing-repository state unknown despite an advertised claim head', async () => {
    const work = await acquire('No owned repository');
    const fixture = workspaceFixture();
    gitAt(fixture.root, ['init', '-b', 'main']);
    writeFileSync(join(fixture.root, 'parent.txt'), 'parent repository\n');
    gitAt(fixture.root, ['add', 'parent.txt']);
    gitAt(fixture.root, ['commit', '-m', 'Enclosing repository']);
    const parentHead = gitAt(fixture.root, ['rev-parse', 'HEAD']);
    await db.getPool().query('UPDATE agent_claims SET head_sha=$2 WHERE id=$1', [work.claimId, parentHead]);
    try {
      await withHelper(descriptorFor(work, fixture.workspace), async ({ client }) => {
        const check = parsed(await client.callTool({ name: 'collaboration_report_check', arguments: { name: 'Unobserved check', command: 'npm test', status: 'passed', commit: parentHead, dirty: false, exitCode: 0 } }));
        expect(check.value.dirty).toBeNull();
        expect(check.value.stale).toBe(true);
        const task = parsed(await client.callTool({ name: 'collaboration_get_task', arguments: {} }));
        expect(task.value.workspace).toMatchObject({ state: 'not_repository', headCommit: null, dirty: null });
      });
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  it('fences signed observation replay, concurrent writers and sequences above the JavaScript safe integer range', async () => {
    const work = await acquire('Observation counter');
    const client = new Client({ name: 'workspace-proof-test', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp/collab`), { requestInit: { headers: { authorization: `Bearer ${work.reporting.credential}` } } }));
    const report = async (proof) => parsed(await client.callTool({ name: 'collaboration_report_workspace', arguments: {}, _meta: { 'fluent-flow/workspace-observation': proof } }));
    try {
      const first = workspaceProof(work, '1');
      expect(await report(first)).toMatchObject({ isError: false, value: { seq: '1', headCommit: 'a'.repeat(40) } });
      expect(await report(first)).toMatchObject({ isError: false, value: { seq: '1' } });
      expect(await report(workspaceProof(work, '1', { headCommit: 'b'.repeat(40) }))).toMatchObject({ isError: true, value: { error: { code: 'workspace_conflict' } } });
      expect(await report({ ...workspaceProof(work, '2'), hmac: 'A'.repeat(43) })).toMatchObject({ isError: true, value: { error: { code: 'workspace_proof_invalid' } } });
      const raced = await Promise.all([report(workspaceProof(work, '2')), report(workspaceProof(work, '2', { headCommit: 'b'.repeat(40) }))]);
      expect(raced.map((result) => result.isError).sort()).toEqual([false, true]);
      await db.getPool().query('UPDATE collab_claim_workspace_state SET last_seq=$2 WHERE reporting_binding_id=$1', [work.reporting.bindingId, '9007199254740992']);
      expect(await report(workspaceProof(work, '9007199254740993'))).toMatchObject({ isError: false, value: { seq: '9007199254740993' } });
      expect(await report(workspaceProof(work, '2'))).toMatchObject({ isError: true, value: { error: { code: 'workspace_conflict' } } });
      const task = parsed(await client.callTool({ name: 'collaboration_get_task', arguments: {} }));
      expect(task.value.workspace.seq).toBe('9007199254740993');
      const check = parsed(await client.callTool({ name: 'collaboration_report_check', arguments: { name: 'Finalized source', command: 'npm test', status: 'passed', commit: 'a'.repeat(40), dirty: false, exitCode: 0 } }));
      expect(check.value.stale).toBe(false);
      await db.getPool().query("UPDATE agent_claims SET status='completed' WHERE id=$1", [work.claimId]);
      expect((await db.listCollabChecks({ actor: asActor(owner), taskId: work.taskId }))[0].evidence[0].stale).toBe(true);
      await db.getPool().query("UPDATE agent_claims SET status='claimed' WHERE id=$1", [work.claimId]);
      expect(await report(workspaceProof(work, '9007199254740994', { final: true }))).toMatchObject({ isError: false, value: { final: true } });
      await db.getPool().query("UPDATE agent_claims SET status='completed' WHERE id=$1", [work.claimId]);
      expect((await db.listCollabChecks({ actor: asActor(owner), taskId: work.taskId }))[0].evidence[0].stale).toBe(false);
    } finally {
      await client.close();
    }
  });
});

describe('native workspace observer teardown', () => {
  it('aborts an owned Git process and its filter on EOF without forwarding reporting credentials', async () => {
    const work = await acquire('Git observer teardown');
    const fixture = gitWorkspaceFixture();
    const identityPath = join(fixture.root, 'filter-identity.json');
    const filter = fileURLToPath(new URL('./fake-git-filter.js', import.meta.url));
    gitAt(fixture.workspace, ['config', 'filter.hanging.process', [process.execPath, filter, identityPath].map((value) => JSON.stringify(value)).join(' ')]);
    gitAt(fixture.workspace, ['config', 'filter.hanging.required', 'true']);
    writeFileSync(join(fixture.workspace, '.gitattributes'), 'app.txt filter=hanging\n');
    writeFileSync(join(fixture.workspace, 'app.txt'), 'other version\n');
    utimesSync(join(fixture.workspace, 'app.txt'), new Date(0), new Date(0));
    const raw = spawnRaw(descriptorFor(work, fixture.workspace));
    try {
      await initializeRaw(raw);
      raw.send({ id: 2, method: 'tools/call', params: { name: 'collaboration_get_task', arguments: {} } });
      await until(() => existsSync(identityPath));
      const identity = JSON.parse(readFileSync(identityPath, 'utf8'));
      expect(identity.hasReportingSecrets).toBe(false);
      raw.child.stdin.end();
      expect(await exitOf(raw.child)).toEqual({ code: 0, signal: null });
      await until(() => !processAlive(identity.pid));
    } finally {
      raw.child.kill('SIGKILL');
      if (existsSync(identityPath)) {
        const identity = JSON.parse(readFileSync(identityPath, 'utf8'));
        for (const pid of [identity.pid, identity.parentPid]) {
          try {
            if (readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes(fixture.root)) process.kill(pid, 'SIGKILL');
          } catch (error) {
            if (!['ENOENT', 'ESRCH'].includes(error.code)) throw error;
          }
        }
      }
      rmSync(fixture.root, { recursive: true, force: true });
    }
  }, 15000);
});

describe('native pull request completion binding', () => {
  async function buildFixture(label) {
    const task = await db.createCollabTask({ actor: asActor(owner), projectId, title: label });
    const branch = `ff/task-${task.id}`;
    const started = await db.startCollabClaimExecution({
      actor: asActor(owner),
      taskId: task.id,
      expectedVersion: task.version,
      idempotencyKey: `reporting-mcp-build-${randomUUID()}`,
      repo,
      claimType: 'spec',
      instructions: 'Chain to build.',
    });
    const token = await db.createToken({ orgId, agentId, label: `${label} agent` });
    const registered = await agentRequest(token.plaintext, '/register', {
      meta: { instance_id: 'reporting-native-build', slot_id: 0, capacity: 4, supported_claim_types: ['spec', 'build'] },
    });
    expect(registered.status).toBe(200);
    const sessionId = registered.body.session_id;
    const spec = (await agentRequest(token.plaintext, '/poll', { session_id: sessionId })).body.work;
    expect(spec.claim_id).toBe(started.claim.id);
    const completed = await agentRequest(token.plaintext, '/claim', {
      session_id: sessionId, claim_id: spec.claim_id, repo, pr_number: null, attempt: spec.attempt, status: 'completed',
    });
    expect(completed.status).toBe(200);
    const build = (await agentRequest(token.plaintext, '/poll', { session_id: sessionId })).body.work;
    expect(build.claim_type).toBe('build');
    return { taskId: task.id, rootClaimId: spec.claim_id, claimId: build.claim_id, reporting: build.reporting, branch };
  }

  function pullRequestFixture({ number, branch, sha }) {
    const repository = { id: 9001, node_id: 'R_reporting_mcp_fixture', full_name: repo, owner: { login: orgId } };
    return {
      id: number + 100000,
      node_id: `PR_reporting_mcp_${number}`,
      number,
      state: 'open',
      body: '',
      title: 'Reporting MCP build output',
      created_at: new Date().toISOString(),
      html_url: `https://github.com/${repo}/pull/${number}`,
      user: { login: 'reporting-mcp-owner' },
      base: { repo: repository, ref: 'main' },
      head: { repo: repository, ref: branch, sha },
    };
  }

  function registerPullRequest(pullRequest) {
    github.prs.set(pullRequest.number, pullRequest);
  }

  function pushedGitWorkspace(work) {
    const fixture = gitWorkspaceFixture();
    gitAt(fixture.workspace, ['remote', 'add', 'origin', `https://github.com/${repo}.git`]);
    gitAt(fixture.workspace, ['update-ref', `refs/remotes/origin/${work.branch}`, fixture.head]);
    return fixture;
  }

  async function linksForTask(taskId) {
    return (await db.getPool().query(
      'SELECT id,repo,pr_number,head_branch,head_sha,task_id,claim_id,native_binding_id,producer_binding_id FROM collab_delivery_links WHERE task_id = $1',
      [taskId],
    )).rows;
  }

  async function workspaceStateFor(bindingId) {
    return (await db.getPool().query(
      'SELECT state,head_commit,dirty,final,repository,task_branch,task_branch_head FROM collab_claim_workspace_state WHERE reporting_binding_id = $1',
      [bindingId],
    )).rows[0];
  }

  it('binds the observed final head as a native delivery link without any model turn', async () => {
    const work = await buildFixture('Build binds output PR');
    const number = prNumber++;
    const fixture = pushedGitWorkspace(work);
    registerPullRequest(pullRequestFixture({ number, branch: work.branch, sha: fixture.head }));
    await expect(reportFinalWorkspace(descriptorFor(work, fixture.workspace), { requirePullRequest: true })).resolves.toBeUndefined();
    const links = await linksForTask(work.taskId);
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({
      repo,
      pr_number: number,
      head_branch: work.branch,
      head_sha: fixture.head,
      task_id: work.taskId,
      claim_id: String(work.claimId),
      native_binding_id: work.reporting.bindingId,
      producer_binding_id: work.reporting.bindingId,
    });
    expect(await workspaceStateFor(work.reporting.bindingId)).toMatchObject({
      state: 'known',
      final: true,
      dirty: false,
      repository: repo,
      task_branch: work.branch,
      head_commit: fixture.head,
      task_branch_head: fixture.head,
    });
    await expect(reportFinalWorkspace(descriptorFor(work, fixture.workspace), { requirePullRequest: true })).resolves.toBeUndefined();
    const replayed = await linksForTask(work.taskId);
    expect(replayed).toHaveLength(1);
    expect(replayed[0].id).toBe(links[0].id);
  });

  it('rejects and leaves no link when the observed origin is not the claim repository', async () => {
    const work = await buildFixture('Wrong origin build');
    const number = prNumber++;
    const fixture = gitWorkspaceFixture();
    gitAt(fixture.workspace, ['remote', 'add', 'origin', 'git@github.com:another/fixture.git']);
    gitAt(fixture.workspace, ['update-ref', `refs/remotes/origin/${work.branch}`, fixture.head]);
    registerPullRequest(pullRequestFixture({ number, branch: work.branch, sha: fixture.head }));
    await expect(reportFinalWorkspace(descriptorFor(work, fixture.workspace), { requirePullRequest: true })).rejects.toThrow();
    expect(await linksForTask(work.taskId)).toEqual([]);
    expect(await workspaceStateFor(work.reporting.bindingId)).toMatchObject({
      state: 'known',
      final: true,
      repository: 'another/fixture',
      task_branch: work.branch,
      head_commit: fixture.head,
      task_branch_head: fixture.head,
    });
  });

  it('rejects and leaves no link when the final workspace is dirty', async () => {
    const work = await buildFixture('Dirty build');
    const number = prNumber++;
    const fixture = pushedGitWorkspace(work);
    writeFileSync(join(fixture.workspace, 'app.txt'), 'uncommitted build output\n');
    registerPullRequest(pullRequestFixture({ number, branch: work.branch, sha: fixture.head }));
    await expect(reportFinalWorkspace(descriptorFor(work, fixture.workspace), { requirePullRequest: true })).rejects.toThrow();
    expect(await linksForTask(work.taskId)).toEqual([]);
    expect(await workspaceStateFor(work.reporting.bindingId)).toMatchObject({ state: 'known', final: true, dirty: true });
  });

  it('rejects and leaves no link when the observed head is unpushed', async () => {
    const work = await buildFixture('Unpushed build');
    const number = prNumber++;
    const fixture = pushedGitWorkspace(work);
    writeFileSync(join(fixture.workspace, 'app.txt'), 'local build output\n');
    gitAt(fixture.workspace, ['add', 'app.txt']);
    gitAt(fixture.workspace, ['commit', '-m', 'Unpushed build']);
    const localHead = gitAt(fixture.workspace, ['rev-parse', 'HEAD']);
    registerPullRequest(pullRequestFixture({ number, branch: work.branch, sha: fixture.head }));
    await expect(reportFinalWorkspace(descriptorFor(work, fixture.workspace), { requirePullRequest: true })).rejects.toThrow();
    expect(await linksForTask(work.taskId)).toEqual([]);
    expect(await workspaceStateFor(work.reporting.bindingId)).toMatchObject({
      state: 'known',
      final: true,
      dirty: false,
      head_commit: localHead,
      task_branch_head: fixture.head,
    });
  });

  it('rejects and leaves no link when no pull request covers the task branch', async () => {
    const work = await buildFixture('Missing PR build');
    const fixture = pushedGitWorkspace(work);
    await expect(reportFinalWorkspace(descriptorFor(work, fixture.workspace), { requirePullRequest: true })).rejects.toThrow();
    expect(await linksForTask(work.taskId)).toEqual([]);
    expect(await workspaceStateFor(work.reporting.bindingId)).toMatchObject({
      state: 'known',
      final: true,
      dirty: false,
      repository: repo,
      task_branch: work.branch,
      head_commit: fixture.head,
      task_branch_head: fixture.head,
    });
  });

  it('rejects and leaves no link when the task branch has ambiguous pull requests', async () => {
    const work = await buildFixture('Ambiguous PR build');
    const fixture = pushedGitWorkspace(work);
    registerPullRequest(pullRequestFixture({ number: prNumber++, branch: work.branch, sha: fixture.head }));
    registerPullRequest(pullRequestFixture({ number: prNumber++, branch: work.branch, sha: fixture.head }));
    await expect(reportFinalWorkspace(descriptorFor(work, fixture.workspace), { requirePullRequest: true })).rejects.toThrow();
    expect(await linksForTask(work.taskId)).toEqual([]);
  });

  it('finalizes a linkable build without acquiring any pull request when the requirement is not set', async () => {
    const work = await buildFixture('Build without requirement');
    const number = prNumber++;
    const fixture = pushedGitWorkspace(work);
    registerPullRequest(pullRequestFixture({ number, branch: work.branch, sha: fixture.head }));
    await expect(reportFinalWorkspace(descriptorFor(work, fixture.workspace))).resolves.toBeUndefined();
    expect(await linksForTask(work.taskId)).toEqual([]);
    expect(await workspaceStateFor(work.reporting.bindingId)).toMatchObject({
      state: 'known',
      final: true,
      dirty: false,
      repository: repo,
      task_branch: work.branch,
      head_commit: fixture.head,
      task_branch_head: fixture.head,
    });
  });
});
