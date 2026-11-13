import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
vi.mock('../../src/tracing.cjs', () => ({}));
vi.mock('../../src/logger.js', async () => ({ default: (await import('../helpers/mock-logger.js')).createMockLogger() }));
const { resolveCollabTestDatabaseUrl, resetCollabSchema, seedUser, seedOrgMembership } = await import('../helpers/collab-db.js');
process.env.DATABASE_URL = resolveCollabTestDatabaseUrl();
const db = await import('@fluent-flow/db');
const { createApp } = await import('../../src/app.js');
const { createRunner } = await import('../../../fluent-flow-agent-server/src/runner.js');
const { createClient } = await import('../../../fluent-flow-agent-server/src/client.js');
const fixture = resolve('../fluent-flow-agent-server/tests/unit/fake-acp-agent.js');
const secret = 'chat-runner-integration-test-only-0123456789012345';
const profiles = [{ id: 'safe', permission: { configId: 'approval', value: 'ask' }, models: ['small', 'large'], defaultModel: 'small', modelConfigId: 'model' }];
const log = { debug() {}, info() {}, warn() {}, error() {} };
async function waitFor(read, predicate = Boolean) {
  const until = Date.now() + 8000;
  while (Date.now() < until) { const result = await read(); if (predicate(result)) return result; await new Promise((r) => setTimeout(r, 10)); }
  throw new Error('Runner integration deadline');
}
describe('production chat runner over mounted HTTP and PostgreSQL', () => {
  let server, base, actor, projectId, root;
  beforeAll(async () => {
    process.env.FF_COLLAB_AUTH_SECRET = secret;
    await resetCollabSchema(process.env.DATABASE_URL); await db.runMigrations();
    const user = await seedUser(process.env.DATABASE_URL, { githubId: 99281, login: 'chat-runner-owner' });
    await seedOrgMembership(process.env.DATABASE_URL, user, 'chat-runner-org', 'admin');
    const p = await db.ensureGithubPrincipal({ userId: user, displayName: 'Chat runner owner', email: 'runner@example.test' });
    actor = { principalId: p.id, sessionVersion: p.sessionVersion };
    const workspace = await db.bootstrapCollaborationWorkspace({ actor, orgId: 'chat-runner-org', name: 'Runner test', idempotencyKey: 'runner-test' });
    projectId = (await db.createCollabProject({ actor, workspaceId: workspace.id, name: 'Runner test' })).id;
    server = createApp().listen(0, '127.0.0.1'); await new Promise((r) => server.once('listening', r));
    base = `http://127.0.0.1:${server.address().port}`;
    root = await mkdtemp(join(tmpdir(), 'ff-chat-http-'));
  }, 30000);
  afterAll(async () => {
    if (server) { server.closeAllConnections(); await new Promise((r) => server.close(r)); }
    await db.closePool(); if (root) await rm(root, { recursive: true, force: true }); delete process.env.FF_COLLAB_AUTH_SECRET;
  });
  async function collab(path, body) {
    const res = await fetch(`${base}/api/collab/v1${path}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-fluent-flow-actor': db.signCollaborationActor(actor, secret), 'idempotency-key': crypto.randomUUID() }, body: JSON.stringify(body) });
    const data = await res.json(); expect(res.ok, JSON.stringify(data)).toBe(true); return data;
  }
  it('registers the bounded public catalog above 4 KiB and rejects unsafe or unsupported projections', async () => {
    const { validateChatProfiles, advertisedChatProfiles } = await import('../../../fluent-flow-agent-server/src/chat-profiles.js');
    const local = Array.from({ length: 32 }, (_, i) => ({ id: `profile-${i}`, permission: { configId: 'approval', value: 'ask' },
      modelConfigId: 'model', models: Array.from({ length: 100 }, (_, m) => `model-${m}`), defaultModel: 'model-0' }));
    const catalog = advertisedChatProfiles(validateChatProfiles(local));
    expect(Buffer.byteLength(JSON.stringify(catalog))).toBeGreaterThan(4096);
    const agentId = 'chat-catalog';
    await db.createAgent({ id: agentId, orgId: 'chat-runner-org', agentType: 'test', transport: 'long_poll', repos: [] });
    const token = (await db.createToken({ orgId: 'chat-runner-org', agentId, label: 'test-only' })).plaintext;
    const register = (profiles) => fetch(`${base}/api/agent-server/register`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ meta: { capacity: 2, profiles } }) });
    const response = await register(catalog);
    expect(response.status).toBe(200);
    const { session_id } = await response.json();
    expect((await db.getPool().query('SELECT session_meta FROM agent_sessions WHERE id=$1', [session_id])).rows[0].session_meta.profiles).toEqual(catalog);
    for (const invalid of [
      [...catalog, catalog[0]], [{ ...catalog[0], env: { SECRET: 'no' } }],
      [{ ...catalog[0], models: ['duplicate', 'duplicate'] }], [{ ...catalog[0], default_model: 'unknown' }],
      [{ id: '../invalid?', models: [] }], [{ id: 'a'.repeat(129), models: [] }],
      [{ id: 'safe', models: Array.from({ length: 101 }, (_, i) => `m${i}`) }],
      Array.from({ length: 32 }, (_, i) => ({ id: `p${i}`, models: Array.from({ length: 100 }, (_, m) => `m${m}-${'x'.repeat(100)}`), default_model: `m0-${'x'.repeat(100)}` })),
    ]) expect((await register(invalid)).status).toBe(400);
  });
  it.each(['user', 'idle', 'host_lost'])('runs real claim -> idle -> prompt -> cancel/end with authoritative %s and no redispatch', async (ending) => {
    const agentId = `chat-real-${ending}`;
    await db.createAgent({ id: agentId, orgId: 'chat-runner-org', agentType: 'test', transport: 'long_poll', repos: [] });
    const token = (await db.createToken({ orgId: 'chat-runner-org', agentId, label: 'test-only' })).plaintext;
    const task = await db.createCollabTask({ actor, projectId, title: `Real chat ${ending}` });
    const opened = await collab(`/tasks/${task.id}/claim-executions`, { claimType: 'chat', expectedVersion: 1, targetAgentId: agentId });
    const claimId = opened.data.claim.id;
    const query = async () => (await db.getPool().query('SELECT * FROM agent_claims WHERE id=$1', [claimId])).rows[0];
    let lostResponse = false;
    const client = createClient({ serverUrl: base, token, fetch: async (url, options) => {
      const response = await fetch(url, options);
      if (ending === 'user' && url.endsWith('/claim') && response.ok && !lostResponse) { lostResponse = true; await response.text(); throw new Error('Test: response lost after persisted result'); }
      return response;
    } });
    const trace = join(root, `${ending}.jsonl`);
    const runner = createRunner({ client, log, cwd: join(root, ending), childEnvironment: { PATH: process.env.PATH },
      meta: { runtime: 'agent-server', capacity: 2 }, acpCommand: process.execPath, acpArgs: [fixture, '--scenario', 'chat-policy', '--trace', trace],
      chat: { enabled: true, profiles }, heartbeatIntervalMs: 40, commandPollMs: 10, eventFlushMs: 10, executionTimeoutMs: 10,
      runtimeLimits: { shutdownIdleMs: 50, shutdownExitMs: 50, shutdownKillMs: 50 } });
    const run = runner.start();
    try {
      await waitFor(query, (c) => c.status === 'claimed');
      await waitFor(async () => { try { return await readFile(trace, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return ''; throw e; } }, (s) => s.includes('set_config_option'));
      await new Promise((r) => setTimeout(r, 80));
      expect((await query()).status).toBe('claimed');
      expect((await readFile(trace, 'utf8'))).not.toContain('session_prompt');
      await collab(`/claim-executions/${claimId}/commands`, { kind: 'prompt', payload: { text: 'First attended turn' } });
      await waitFor(async () => (await db.getPool().query("SELECT * FROM agent_claim_commands WHERE claim_id=$1 AND kind='prompt' AND status='acked'", [claimId])).rows.length);
      await waitFor(async () => (await db.getPool().query("SELECT * FROM agent_claim_events WHERE claim_id=$1 AND kind='state' AND payload->'raw'->>'state'='idle'", [claimId])).rows.length);
      await db.getPool().query('UPDATE agents SET max_chat_slots=0 WHERE id=$1 AND org_id=$2', [agentId, 'chat-runner-org']);
      await collab(`/claim-executions/${claimId}/commands`, { kind: 'prompt', payload: { text: 'HOLD_CHAT_RESPONSE' } });
      await waitFor(async () => (await db.getPool().query("SELECT * FROM agent_claim_commands WHERE claim_id=$1 AND kind='prompt' AND status='acked'", [claimId])).rows.length === 2);
      await new Promise((r) => setTimeout(r, 80));
      await collab(`/claim-executions/${claimId}/commands`, { kind: 'cancel', payload: {} });
      await waitFor(async () => (await db.getPool().query("SELECT * FROM agent_claim_commands WHERE claim_id=$1 AND kind='cancel' AND status='acked'", [claimId])).rows.length);
      expect((await query()).status).toBe('claimed');
      expect((await db.getPool().query("SELECT result FROM agent_claim_commands WHERE claim_id=$1 AND kind='cancel'", [claimId])).rows[0].result.applied).toBe(true);
      if (ending === 'user') await collab(`/claim-executions/${claimId}/commands`, { kind: 'end_session', payload: {} });
      else {
        await waitFor(async () => (await db.getPool().query("SELECT * FROM agent_claim_events WHERE claim_id=$1 AND kind='state' AND payload->'raw'->>'state'='idle'", [claimId])).rows.length === 2);
        await db.getPool().query(ending === 'idle' ? "UPDATE agent_claims SET last_activity_at=now()-interval '1 day' WHERE id=$1" : "UPDATE agent_claims SET expires_at=now()-interval '1 hour' WHERE id=$1", [claimId]);
        const { expireClaims } = await import('../../src/agents/claim-manager.js'); await expireClaims();
      }
      await waitFor(query, (c) => c.status === 'cancelled');
      await waitFor(() => runner.activeWork === null);
      expect((await query()).end_reason).toBe(ending);
      expect((await db.getPool().query('SELECT * FROM agent_claims WHERE task_id=$1', [task.id])).rows).toHaveLength(1);
      const receipt = await waitFor(async () => (await db.listCollabRetainedWork({ actor, taskId: task.id })).items
        .find(item => item.claimId === claimId && item.retained === true));
      expect(receipt).toEqual({ claimId, agentId, repo: null, retained: true, reason: 'scratch', reportedAt: expect.any(String) });
      if (ending === 'user') expect(lostResponse).toBe(true);
    } finally { await runner.shutdown(); await run; }
  }, 20000);
});
