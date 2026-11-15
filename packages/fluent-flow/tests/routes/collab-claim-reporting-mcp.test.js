import { createHash, createHmac } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/tracing.cjs', () => ({}));
vi.mock('../../src/logger.js', async () => {
  const { createMockLogger } = await import('../helpers/mock-logger.js');
  return { default: createMockLogger() };
});

const {
  resolveCollabTestDatabaseUrl,
  resetCollabSchema,
  seedUser,
  seedOrgMembership,
} = await import('../helpers/collab-db.js');
process.env.DATABASE_URL = resolveCollabTestDatabaseUrl();

const AUTH_SECRET = 'claim-reporting-mcp-secret-0123456789abcdef0123456789abcdef';
const db = await import('@fluent-flow/db');
const { createApp } = await import('../../src/app.js');
const { releaseUndeliveredClaim, claimPendingWork } = await import('../../src/routes/agent-server.js');
const { completeClaimById, createFollowOnClaim } = await import('../../src/agents/claim-manager.js');
const { normalizeAcpUpdate } = await import('../../../fluent-flow-agent-server/src/acp/normalize.js');
const { recordUsageSample } = await import('../../../db/dist/collaboration/evidence.js');

const orgId = 'claim-reporting-mcp-org';
const repo = 'acme/claim-reporting-mcp';
const agentId = 'claim-reporting-mcp-runner';
const HEAD = 'b'.repeat(40);
const WORK_CAPABILITIES = ['task.read', 'task.write', 'internal.read', 'run.start'];
const MAX_CAPTURE_BYTES = 524288;

function asActor(principal) {
  return { principalId: principal.id, sessionVersion: principal.sessionVersion };
}

describe('claim-bound reporting over the collaboration MCP endpoint', () => {
  let server;
  let baseUrl;
  let owner;
  let workspaceId;
  let projectId;
  let prNumber = 5100;

  async function collab(method, path, actor = owner, body, idempotencyKey) {
    const response = await fetch(`${baseUrl}/api/collab/v1${path}`, {
      method,
      headers: { 'x-fluent-flow-actor': db.signCollaborationActor(asActor(actor), AUTH_SECRET),
        'content-type': 'application/json', ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  }

  async function agentRequest(token, path, body) {
    const response = await fetch(`${baseUrl}/api/agent-server${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  }

  async function mcp(credential, name, args, meta) {
    const response = await fetch(`${baseUrl}/mcp/collab`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${credential}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name, arguments: args, ...(meta ? { _meta: meta } : {}) },
      }),
    });
    const body = await response.json();
    if (response.status !== 200) return { status: response.status, body };
    return { status: 200, isError: body.result.isError === true, value: JSON.parse(body.result.content[0].text) };
  }

  async function enrollActor(name, capabilities = WORK_CAPABILITIES) {
    const role = await db.createWorkspaceRole({ actor: asActor(owner), workspaceId, name, capabilities });
    const invitation = await db.createCollabInvitation({
      actor: asActor(owner),
      projectId,
      email: `${name}@example.test`,
      roleId: role.id,
      expiresInHours: 24,
    });
    const accepted = await fetch(`${baseUrl}/api/collab/v1/invitations/accept`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: invitation.url.split('token=')[1], displayName: name, password: 'synthetic-password' }),
    });
    const payload = await accepted.json();
    expect(accepted.status).toBe(201);
    return { actor: payload.data.principal, roleId: role.id };
  }

  async function runner(label) {
    const token = await db.createToken({ orgId, agentId, label });
    const registered = await agentRequest(token.plaintext, '/register', {
      meta: { source: 'claim-reporting-mcp', slot_id: 0, capacity: 1, supported_claim_types: ['spec'] },
    });
    expect(registered.status).toBe(200);
    return { token: token.plaintext, tokenId: token.id, sessionId: registered.body.session_id };
  }

  async function poll(owningRunner) {
    return agentRequest(owningRunner.token, '/poll', { session_id: owningRunner.sessionId });
  }

  async function startSpec(initiator, title) {
    const task = await db.createCollabTask({ actor: asActor(owner), projectId, title });
    const started = await db.startCollabClaimExecution({
      actor: asActor(initiator),
      taskId: task.id,
      expectedVersion: task.version,
      idempotencyKey: `claim-reporting-${crypto.randomUUID()}`,
      repo,
      prNumber: prNumber++,
      branch: 'feature/claim-reporting',
      claimType: 'spec',
      instructions: 'Report through the claim.',
    });
    return { taskId: task.id, claimId: started.claim.id };
  }

  async function acquire(initiator, title) {
    const work = await startSpec(initiator, title);
    const owningRunner = await runner(title);
    const polled = await poll(owningRunner);
    expect(polled.status).toBe(200);
    expect(polled.body.work.claim_id).toBe(work.claimId);
    return { ...work, runner: owningRunner, reporting: polled.body.work.reporting };
  }

  async function chatDestination(taskId, lease = true) {
    const chatAgentId = `idea-chat-${crypto.randomUUID()}`;
    await db.createAgent({ id: chatAgentId, orgId, agentType: 'test', transport: 'long_poll', repos: [repo] });
    const token = await db.createToken({ orgId, agentId: chatAgentId, label: 'Idea follow-up target' });
    const registered = await agentRequest(token.plaintext, '/register', {
      meta: { capacity: 2, supported_claim_types: ['chat'], profiles: [{ id: 'ideas', models: ['small'], default_model: 'small' }] },
    });
    expect(registered.status).toBe(200);
    const task = (await collab('GET', `/tasks/${taskId}`)).body.data;
    const started = await db.startCollabClaimExecution({ actor: asActor(owner), taskId, expectedVersion: task.version,
      idempotencyKey: crypto.randomUUID(), repo: null, claimType: 'chat', targetAgentId: chatAgentId });
    const target = { token: token.plaintext, sessionId: registered.body.session_id };
    const work = lease ? (await poll(target)).body.work : null;
    if (lease) expect(work.claim_id).toBe(started.claim.id);
    return { claimId: started.claim.id, runner: target, work };
  }

  async function proposeIdea(credential, title) {
    return mcp(credential, 'collaboration_propose_idea', { title, body: 'Claim-bound idea.' });
  }

  async function ideaRows(title) {
    return (await db.getPool().query('SELECT id, claim_id, author_principal_id FROM collab_ideas WHERE title = $1', [title])).rows;
  }

  function expectUnauthenticated(result) {
    expect(result.status).toBe(401);
    expect(result.body).toEqual({ error: { code: 'unauthenticated', message: 'Authentication required.' } });
  }

  function fileArgs(overrides = {}) {
    return { name: 'Generated report', kind: 'file', direction: 'output', reference: 'reports/result.txt', mediaType: 'text/plain', ...overrides };
  }

  function signCapture({ reporting, claimId, args, bytes, captureId = crypto.randomUUID(), mime = 'text/plain', signedArgs = args, signedBytes = bytes, captureKey = reporting.captureKey, bindingId = reporting.bindingId }) {
    const sha256 = createHash('sha256').update(signedBytes).digest('hex');
    const material = JSON.stringify([
      'fluent-flow:file-capture:v1',
      bindingId,
      claimId,
      captureId,
      signedArgs.name,
      'file',
      signedArgs.direction,
      signedArgs.reference,
      mime,
      signedBytes.length,
      sha256,
    ]);
    return {
      'fluent-flow/file-capture': {
        version: 1,
        bindingId,
        captureId,
        mime,
        sizeBytes: signedBytes.length,
        sha256,
        contentBase64: bytes.toString('base64'),
        hmac: createHmac('sha256', Buffer.from(captureKey, 'base64url')).update(material).digest('base64url'),
      },
    };
  }

  async function artifactCount(claimId) {
    const rows = await db.getPool().query('SELECT count(*)::int AS count FROM collab_artifacts WHERE claim_id = $1', [claimId]);
    return rows.rows[0].count;
  }

  beforeAll(async () => {
    process.env.FF_COLLAB_AUTH_SECRET = AUTH_SECRET;
    await resetCollabSchema(process.env.DATABASE_URL);
    await db.runMigrations();
    const ownerUserId = await seedUser(process.env.DATABASE_URL, { githubId: 9951, login: 'claim-reporting-mcp-owner' });
    await seedOrgMembership(process.env.DATABASE_URL, ownerUserId, orgId, 'admin');
    const ownerPrincipal = await db.ensureGithubPrincipal({
      userId: ownerUserId,
      displayName: 'Claim Reporting Owner',
      email: 'claim-reporting-mcp-owner@example.test',
    });
    owner = { id: ownerPrincipal.id, sessionVersion: ownerPrincipal.sessionVersion };
    const workspace = await db.bootstrapCollaborationWorkspace({
      actor: asActor(owner),
      orgId,
      name: 'Claim Reporting MCP Workspace',
      idempotencyKey: 'claim-reporting-mcp-workspace',
    });
    workspaceId = workspace.id;
    projectId = (await db.createCollabProject({ actor: asActor(owner), workspaceId, name: 'Claim Reporting MCP Project' })).id;
    await db.getPool().query(
      `INSERT INTO repos (id, org_id, repo_full_name, provider) VALUES ($1, $2, $3, 'github')`,
      [crypto.randomUUID(), orgId, repo],
    );
    const app = createApp();
    await new Promise((resolve) => {
      server = app.listen(0, '127.0.0.1', resolve);
    });
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    await db.createAgent({ id: agentId, orgId, agentType: 'test', transport: 'long_poll', repos: [repo] });
  }, 30000);

  afterAll(async () => {
    delete process.env.FF_COLLAB_AUTH_SECRET;
    if (server) await new Promise((resolve) => server.close(resolve));
    await db.closePool();
  });

  it('delivers a minted binding to the owning runner and authenticates canonical reports over MCP', async () => {
    const work = await acquire(owner, 'Valid minted reporting');
    expect(Object.keys(work.reporting).sort()).toEqual(['bindingId', 'captureKey', 'credential']);
    const stored = await db.getPool().query(
      `SELECT token.id, token.token_hash, token.principal_id, token.project_id, token.task_id, token.agent_token_id,
         token.runner_session_id, token.run_id, token.session_id, token.creator_session_version,
         token.claimed_at = claim.claimed_at AS exact_acquisition
       FROM collab_scoped_tokens token JOIN agent_claims claim ON claim.id = token.claim_id
       WHERE token.claim_id = $1`,
      [work.claimId],
    );
    expect(stored.rows).toEqual([{
      id: work.reporting.bindingId,
      token_hash: createHash('sha256').update(work.reporting.credential).digest('hex'),
      principal_id: owner.id,
      project_id: projectId,
      task_id: work.taskId,
      agent_token_id: work.runner.tokenId,
      runner_session_id: work.runner.sessionId,
      run_id: null,
      session_id: null,
      creator_session_version: owner.sessionVersion,
      exact_acquisition: true,
    }]);

    const own = await mcp(work.reporting.credential, 'collaboration_get_task', {});
    expect(own).toMatchObject({ status: 200, isError: false, value: { id: work.taskId, projectId } });

    const check = await mcp(work.reporting.credential, 'collaboration_report_check', {
      name: 'unit', command: 'npm test', status: 'passed', commit: HEAD, dirty: false, exitCode: 0,
    });
    expect(check).toMatchObject({ status: 200, isError: false, value: { status: 'passed', provenance: 'agent', actorId: owner.id, claimId: work.claimId, runId: null, sessionId: null } });
    const idea = await proposeIdea(work.reporting.credential, 'Native MCP idea');
    expect(idea).toMatchObject({ status: 200, isError: false, value: { title: 'Native MCP idea', authorId: owner.id, runId: null } });
    const plan = await mcp(work.reporting.credential, 'collaboration_report_plan', { items: [{ text: 'Ship parity', status: 'in_progress' }] });
    expect(plan).toMatchObject({ status: 200, isError: false, value: { claimId: work.claimId, runId: null, sessionId: null, items: [{ text: 'Ship parity', status: 'in_progress' }] } });
    const artifact = await mcp(work.reporting.credential, 'collaboration_add_artifact', { name: 'Native origin report', kind: 'text', content: 'Source-bound artifact content.' });
    expect(artifact).toMatchObject({ status: 200, isError: false, value: { claimId: work.claimId, runId: null, sessionId: null } });
    const { recordOpenQuestionReport } = await import('../../../db/dist/collaboration/evidence.js');
    const question = await recordOpenQuestionReport({ taskId: work.taskId, source: { kind: 'claim', claimId: work.claimId, reportingBindingId: work.reporting.bindingId }, text: 'Which boundary should remain explicit?' });
    const runsBefore = (await db.getPool().query('SELECT count(*)::int AS count FROM collab_runs')).rows[0].count;
    const progress = await mcp(work.reporting.credential, 'collaboration_report_progress', { text: 'Working', percent: 20 });
    expect(progress).toMatchObject({ status: 200, isError: false, value: { text: 'Working', percent: 20, provenance: 'agent' } });
    expect((await db.getPool().query('SELECT count(*)::int AS count FROM collab_runs')).rows[0].count).toBe(runsBefore);
    expect((await collab('GET', `/tasks/${work.taskId}`)).body.data.execution.publishedProgress).toEqual({ claimId: work.claimId, text: 'Working', percent: 20 });
    const publicReader = await enrollActor('progress-task-reader', ['task.read']);
    const publicTask = await collab('GET', `/tasks/${work.taskId}`, publicReader.actor);
    expect(publicTask.status).toBe(200);
    expect(publicTask.body.data.execution.progress).toBeNull();
    expect(publicTask.body.data.execution.publishedProgress).toBeNull();
    expect(JSON.stringify(publicTask.body)).not.toContain('Working');

    const checks = await collab('GET', `/tasks/${work.taskId}/checks`);
    const ideas = await collab('GET', `/tasks/${work.taskId}/ideas`);
    const workpad = await collab('GET', `/tasks/${work.taskId}/plan`);
    const artifacts = await collab('GET', `/tasks/${work.taskId}/artifacts`);
    const questions = await collab('GET', `/tasks/${work.taskId}/questions`);
    expect(checks.status).toBe(200);
    expect(checks.body.data).toEqual(expect.arrayContaining([expect.objectContaining({
      id: check.value.checkId,
      name: 'unit',
      command: 'npm test',
      evidence: expect.arrayContaining([expect.objectContaining({ id: check.value.id, status: 'passed', provenance: 'agent', actorId: owner.id, claimId: work.claimId, runId: null, sessionId: null })]),
    })]));
    expect(ideas.body.data).toEqual(expect.arrayContaining([expect.objectContaining({ id: idea.value.id, title: 'Native MCP idea', authorId: owner.id })]));
    expect(workpad.body.data.plan).toMatchObject({ claimId: work.claimId, runId: null, sessionId: null, items: [{ text: 'Ship parity', status: 'in_progress' }] });
    expect(artifacts.body.data).toEqual(expect.arrayContaining([expect.objectContaining({ id: artifact.value.id, claimId: work.claimId, runId: null, sessionId: null })]));
    expect(questions.body.data).toEqual(expect.arrayContaining([expect.objectContaining({ id: question.id, claimId: work.claimId, runId: null, sessionId: null })]));
    const evidence = await db.getPool().query('SELECT claim_id, actor_principal_id, run_id FROM collab_check_evidence WHERE id = $1', [check.value.id]);
    expect(evidence.rows[0]).toEqual({ claim_id: work.claimId, actor_principal_id: owner.id, run_id: null });
    expect(await ideaRows('Native MCP idea')).toEqual([{ id: idea.value.id, claim_id: work.claimId, author_principal_id: owner.id }]);
    const serialized = JSON.stringify([checks.body, ideas.body, workpad.body, artifacts.body, questions.body, check.value, idea.value, plan.value, artifact.value, question, progress.value]);
    expect(serialized).not.toContain(work.reporting.credential);
    expect(serialized).not.toContain(work.reporting.captureKey);
    expect(serialized).not.toContain(work.reporting.bindingId);
  });

  it('keeps a work binding inside its own task and out of summary authority', async () => {
    const work = await acquire(owner, 'Scoped reporting');
    const other = await db.createCollabTask({ actor: asActor(owner), projectId, title: 'Other task' });
    const crossTask = await mcp(work.reporting.credential, 'collaboration_get_task', { taskId: other.id });
    expect(crossTask).toMatchObject({ status: 200, isError: true, value: { error: { code: 'not_found' } } });
    const summary = await mcp(work.reporting.credential, 'collaboration_report_summary', { body: 'Not a summary claim.' });
    expect(summary).toMatchObject({ status: 200, isError: true, value: { error: { code: 'forbidden' } } });
    const summaries = await db.getPool().query('SELECT id FROM collab_summaries WHERE claim_id = $1', [work.claimId]);
    expect(summaries.rows).toHaveLength(0);
  });

  it('rejects forged, unknown and malformed claim credentials at authentication', async () => {
    const work = await acquire(owner, 'Forged credentials');
    const forgedSuffix = `ffcl_${work.reporting.bindingId}_${'A'.repeat(43)}`;
    const unknownBinding = work.reporting.credential.replace(work.reporting.bindingId, crypto.randomUUID());
    expectUnauthenticated(await proposeIdea(forgedSuffix, 'Forged suffix'));
    expectUnauthenticated(await proposeIdea(unknownBinding, 'Unknown binding'));
    expectUnauthenticated(await proposeIdea(`ffcl_${work.claimId}_${'A'.repeat(32)}`, 'Legacy claim-number shape'));
    expect(await ideaRows('Forged suffix')).toEqual([]);
    expect(await ideaRows('Unknown binding')).toEqual([]);
    expect(await ideaRows('Legacy claim-number shape')).toEqual([]);
  });

  it('fences a same-claim acquisition change of one microsecond', async () => {
    const work = await acquire(owner, 'Microsecond fence');
    expect((await proposeIdea(work.reporting.credential, 'Before microsecond change')).isError).toBe(false);
    await db.getPool().query("UPDATE agent_claims SET claimed_at = claimed_at + interval '1 microsecond' WHERE id = $1", [work.claimId]);
    expectUnauthenticated(await proposeIdea(work.reporting.credential, 'After microsecond change'));
    expect(await ideaRows('After microsecond change')).toEqual([]);
  });

  it('rejects a credential after its claim moves to another runner slot and authorizes only the new acquisition', async () => {
    const work = await acquire(owner, 'Moved runner slot');
    expect(await releaseUndeliveredClaim(orgId, agentId, work.runner.sessionId, work.claimId)).toBe(true);
    const nextRunner = await runner('Moved runner slot target');
    const repolled = await poll(nextRunner);
    expect(repolled.status).toBe(200);
    expect(repolled.body.work.claim_id).toBe(work.claimId);
    const moved = repolled.body.work.reporting;
    expect(moved.bindingId).not.toBe(work.reporting.bindingId);
    expect(moved.credential).not.toBe(work.reporting.credential);
    expect(moved.captureKey).not.toBe(work.reporting.captureKey);
    expectUnauthenticated(await proposeIdea(work.reporting.credential, 'Previous slot after move'));
    expect(await proposeIdea(moved.credential, 'Current slot after move')).toMatchObject({ status: 200, isError: false });
    expect(await ideaRows('Previous slot after move')).toEqual([]);
    expect(await ideaRows('Current slot after move')).toHaveLength(1);
  });

  it('rejects a credential when the owning runner session changes without a new acquisition timestamp', async () => {
    const work = await acquire(owner, 'Session fence');
    const otherRunner = await runner('Session fence other');
    await db.getPool().query('UPDATE agent_claims SET session_id = $2 WHERE id = $1', [work.claimId, otherRunner.sessionId]);
    expectUnauthenticated(await proposeIdea(work.reporting.credential, 'Foreign session fence'));
    expect(await ideaRows('Foreign session fence')).toEqual([]);
  });

  it('does not revive a released claim credential when its runner slot is reused for later work', async () => {
    const first = await acquire(owner, 'Reused slot first');
    const finalized = await completeClaimById(orgId, first.claimId, first.runner.sessionId);
    expect(finalized).toMatchObject({ id: first.claimId, status: 'completed' });
    const second = await startSpec(owner, 'Reused slot second');
    const repolled = await poll(first.runner);
    expect(repolled.status).toBe(200);
    expect(repolled.body.work.claim_id).toBe(second.claimId);
    const reused = repolled.body.work.reporting;
    expectUnauthenticated(await proposeIdea(first.reporting.credential, 'Released claim on reused slot'));
    expect(await proposeIdea(reused.credential, 'Later claim on reused slot')).toMatchObject({ status: 200, isError: false });
    const firstIdeas = await collab('GET', `/tasks/${first.taskId}/ideas`);
    const secondIdeas = await collab('GET', `/tasks/${second.taskId}/ideas`);
    expect(firstIdeas.body.data.map((idea) => idea.title)).not.toContain('Later claim on reused slot');
    expect(secondIdeas.body.data.map((idea) => idea.title)).toContain('Later claim on reused slot');
    expect(await ideaRows('Released claim on reused slot')).toEqual([]);
  });

  it('revokes reporting when the formerly authorized initiator is disabled', async () => {
    const { actor } = await enrollActor('claim-reporting-disabled');
    const work = await acquire(actor, 'Disabled initiator');
    expect((await proposeIdea(work.reporting.credential, 'Before disable')).isError).toBe(false);
    await db.getPool().query('UPDATE collab_principals SET disabled_at = NOW() WHERE id = $1', [actor.id]);
    expectUnauthenticated(await proposeIdea(work.reporting.credential, 'After disable'));
    expect(await ideaRows('After disable')).toEqual([]);
  });

  it('revokes reporting when the initiator session version advances past the stored snapshot', async () => {
    const { actor } = await enrollActor('claim-reporting-version');
    const work = await acquire(actor, 'Version revoked initiator');
    expect((await proposeIdea(work.reporting.credential, 'Before version bump')).isError).toBe(false);
    await db.getPool().query('UPDATE collab_principals SET session_version = session_version + 1 WHERE id = $1', [actor.id]);
    expectUnauthenticated(await proposeIdea(work.reporting.credential, 'After version bump'));
    expect(await ideaRows('After version bump')).toEqual([]);
  });

  it('revokes reporting when the formerly authorized initiator loses internal read access', async () => {
    const { actor, roleId } = await enrollActor('claim-reporting-role');
    const work = await acquire(actor, 'Role denial');
    expect((await proposeIdea(work.reporting.credential, 'Before role downgrade')).isError).toBe(false);
    await db.getPool().query('UPDATE collab_roles SET capabilities = $2::text[] WHERE id = $1', [roleId, ['task.read', 'task.write', 'run.start']]);
    expectUnauthenticated(await proposeIdea(work.reporting.credential, 'After role downgrade'));
    expect(await ideaRows('After role downgrade')).toEqual([]);
  });

  it('revokes reporting when the originating agent token expires or is revoked', async () => {
    const expiring = await acquire(owner, 'Expired agent token');
    await db.getPool().query("UPDATE agent_tokens SET expires_at = NOW() - interval '1 second' WHERE id = $1", [expiring.runner.tokenId]);
    expectUnauthenticated(await proposeIdea(expiring.reporting.credential, 'After agent token expiry'));
    const revoked = await acquire(owner, 'Revoked agent token');
    await db.getPool().query('UPDATE agent_tokens SET revoked_at = NOW() WHERE id = $1', [revoked.runner.tokenId]);
    expectUnauthenticated(await proposeIdea(revoked.reporting.credential, 'After agent token revocation'));
    expect(await ideaRows('After agent token expiry')).toEqual([]);
    expect(await ideaRows('After agent token revocation')).toEqual([]);
  });

  it('revokes reporting when the owning runner session or claim lease expires', async () => {
    const runnerExpiry = await acquire(owner, 'Expired runner session');
    await db.getPool().query("UPDATE agent_sessions SET expires_at = NOW() - interval '1 second' WHERE id = $1", [runnerExpiry.runner.sessionId]);
    expectUnauthenticated(await proposeIdea(runnerExpiry.reporting.credential, 'After runner session expiry'));
    const leaseExpiry = await acquire(owner, 'Expired claim lease');
    await db.getPool().query("UPDATE agent_claims SET expires_at = NOW() - interval '1 second' WHERE id = $1", [leaseExpiry.claimId]);
    expectUnauthenticated(await proposeIdea(leaseExpiry.reporting.credential, 'After claim lease expiry'));
    expect(await ideaRows('After runner session expiry')).toEqual([]);
    expect(await ideaRows('After claim lease expiry')).toEqual([]);
  });

  it('delivers work without reporting authority for a claim link that has no original session snapshot', async () => {
    const work = await startSpec(owner, 'Missing original snapshot');
    await db.getPool().query('UPDATE collab_claim_executions SET created_by_session_version = NULL WHERE claim_id = $1', [work.claimId]);
    const owningRunner = await runner('Missing original snapshot');
    const polled = await poll(owningRunner);
    expect(polled.status).toBe(200);
    expect(polled.body.work.claim_id).toBe(work.claimId);
    expect(polled.body.work).not.toHaveProperty('reporting');
    const tokens = await db.getPool().query('SELECT id FROM collab_scoped_tokens WHERE claim_id = $1', [work.claimId]);
    expect(tokens.rows).toHaveLength(0);
    const event = normalizeAcpUpdate({ claimId: work.claimId, seq: 1, sessionId: 'unbound-provider', update: { sessionUpdate: 'usage_update', used: 10, size: 100, cost: { amount: 2, currency: 'USD' } } });
    expect((await agentRequest(owningRunner.token, `/claims/${work.claimId}/events`, { session_id: owningRunner.sessionId, events: [event] })).status).toBe(200);
    expect((await db.getPool().query('SELECT kind FROM agent_claim_events WHERE claim_id=$1', [work.claimId])).rows).toEqual([{ kind: 'usage' }]);
    expect((await db.getPool().query('SELECT id FROM collab_usage_samples WHERE claim_id=$1', [work.claimId])).rows).toEqual([]);
  });

  it('fails delivery loudly and releases the claim when bootstrap fails unexpectedly', async () => {
    const work = await startSpec(owner, 'Bootstrap failure');
    const failingRunner = await runner('Bootstrap failure');
    delete process.env.FF_COLLAB_AUTH_SECRET;
    let failed;
    try {
      failed = await poll(failingRunner);
    } finally {
      process.env.FF_COLLAB_AUTH_SECRET = AUTH_SECRET;
    }
    expect(failed.status).toBe(500);
    expect(failed.body).not.toHaveProperty('work');
    expect(JSON.stringify(failed.body)).not.toMatch(/FF_COLLAB|secret|collab_scoped_tokens/i);
    const released = await db.getPool().query('SELECT status, session_id, claimed_at FROM agent_claims WHERE id = $1', [work.claimId]);
    expect(released.rows[0]).toEqual({ status: 'pending', session_id: null, claimed_at: null });
    expect((await db.getPool().query('SELECT id FROM collab_scoped_tokens WHERE claim_id = $1', [work.claimId])).rows).toHaveLength(0);
    const recoveredRunner = await runner('Bootstrap recovery');
    const recovered = await poll(recoveredRunner);
    expect(recovered.status).toBe(200);
    expect(recovered.body.work.claim_id).toBe(work.claimId);
    expect(Object.keys(recovered.body.work.reporting).sort()).toEqual(['bindingId', 'captureKey', 'credential']);
  });

  it('rejects file artifacts without a verified capture and never stores metadata-only rows', async () => {
    const work = await acquire(owner, 'Capture rejection');
    const bytes = Buffer.from('Captured report bytes');
    const args = fileArgs();
    const absent = await mcp(work.reporting.credential, 'collaboration_add_artifact', args);
    expect(absent).toMatchObject({ status: 200, isError: true, value: { error: { code: 'capture_invalid' } } });
    const metadataOnly = await mcp(work.reporting.credential, 'collaboration_add_artifact', fileArgs({
      sizeBytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    }));
    expect(metadataOnly).toMatchObject({ status: 200, isError: true, value: { error: { code: 'capture_invalid' } } });
    const forged = signCapture({ reporting: work.reporting, claimId: work.claimId, args, bytes });
    forged['fluent-flow/file-capture'].hmac = createHmac('sha256', 'not-the-capture-key').update('forged').digest('base64url');
    expect(await mcp(work.reporting.credential, 'collaboration_add_artifact', args, forged)).toMatchObject({ status: 200, isError: true, value: { error: { code: 'capture_invalid' } } });
    const changedReference = signCapture({ reporting: work.reporting, claimId: work.claimId, args, bytes, signedArgs: fileArgs({ reference: 'reports/other.txt' }) });
    expect(await mcp(work.reporting.credential, 'collaboration_add_artifact', args, changedReference)).toMatchObject({ status: 200, isError: true, value: { error: { code: 'capture_invalid' } } });
    const changedName = signCapture({ reporting: work.reporting, claimId: work.claimId, args, bytes, signedArgs: fileArgs({ name: 'Renamed report' }) });
    expect(await mcp(work.reporting.credential, 'collaboration_add_artifact', args, changedName)).toMatchObject({ status: 200, isError: true, value: { error: { code: 'capture_invalid' } } });
    const changedBytes = signCapture({ reporting: work.reporting, claimId: work.claimId, args, bytes: Buffer.from('Different bytes'), signedBytes: bytes });
    expect(await mcp(work.reporting.credential, 'collaboration_add_artifact', args, changedBytes)).toMatchObject({ status: 200, isError: true, value: { error: { code: 'capture_invalid' } } });
    const mismatchedMediaType = signCapture({ reporting: work.reporting, claimId: work.claimId, args, bytes, mime: 'application/json' });
    expect(await mcp(work.reporting.credential, 'collaboration_add_artifact', args, mismatchedMediaType)).toMatchObject({ status: 200, isError: true, value: { error: { code: 'capture_invalid' } } });
    const other = await acquire(owner, 'Capture rejection other binding');
    const otherBinding = signCapture({ reporting: other.reporting, claimId: work.claimId, args, bytes, bindingId: work.reporting.bindingId });
    expect(await mcp(work.reporting.credential, 'collaboration_add_artifact', args, otherBinding)).toMatchObject({ status: 200, isError: true, value: { error: { code: 'capture_invalid' } } });
    const oversized = Buffer.alloc(MAX_CAPTURE_BYTES + 1, 0x61);
    expect(await mcp(work.reporting.credential, 'collaboration_add_artifact', args, signCapture({ reporting: work.reporting, claimId: work.claimId, args, bytes: oversized }))).toMatchObject({ status: 200, isError: true, value: { error: { code: 'capture_invalid' } } });
    const traversal = fileArgs({ reference: '../outside.txt' });
    expect(await mcp(work.reporting.credential, 'collaboration_add_artifact', traversal, signCapture({ reporting: work.reporting, claimId: work.claimId, args: traversal, bytes }))).toMatchObject({ status: 200, isError: true, value: { error: { code: 'capture_invalid' } } });
    expect(await artifactCount(work.claimId)).toBe(0);
  });

  it('stores verified captured bytes atomically and serves them without a connector read', async () => {
    const work = await acquire(owner, 'Verified capture');
    const text = 'Actual captured report bytes';
    const bytes = Buffer.from(text);
    const args = fileArgs();
    const proof = signCapture({ reporting: work.reporting, claimId: work.claimId, args, bytes });
    const created = await mcp(work.reporting.credential, 'collaboration_add_artifact', args, proof);
    expect(created).toMatchObject({ status: 200, isError: false, value: { name: 'Generated report', visibility: 'internal', provenance: 'agent', runId: null } });
    expect(created.value).not.toHaveProperty('reference');
    expect(JSON.stringify(created.value)).not.toContain(proof['fluent-flow/file-capture'].hmac);
    const row = await db.getPool().query('SELECT claim_id, sha256, size_bytes::int AS size_bytes, media_type FROM collab_artifacts WHERE id = $1', [created.value.id]);
    expect(row.rows[0]).toEqual({ claim_id: work.claimId, sha256: createHash('sha256').update(bytes).digest('hex'), size_bytes: bytes.length, media_type: 'text/plain' });
    const content = await collab('GET', `/artifacts/${created.value.id}/content`);
    expect(content.status).toBe(200);
    expect(content.body.data.content).toBe(text);
    const connectorReads = await db.getPool().query(`SELECT id FROM collab_connector_commands WHERE kind = 'artifact_read' AND payload->>'artifactId' = $1`, [created.value.id]);
    expect(connectorReads.rows).toHaveLength(0);

    const replay = await mcp(work.reporting.credential, 'collaboration_add_artifact', args, proof);
    expect(replay).toMatchObject({ status: 200, isError: false, value: { id: created.value.id } });
    const captureId = proof['fluent-flow/file-capture'].captureId;
    const conflictingArgs = fileArgs({ name: 'Conflicting replay' });
    const conflicting = signCapture({ reporting: work.reporting, claimId: work.claimId, args: conflictingArgs, bytes, captureId });
    expect(await mcp(work.reporting.credential, 'collaboration_add_artifact', conflictingArgs, conflicting)).toMatchObject({ status: 200, isError: true, value: { error: { code: 'idempotency_conflict' } } });
    expect(await artifactCount(work.claimId)).toBe(1);

    const boundary = Buffer.alloc(MAX_CAPTURE_BYTES, 0x62);
    const boundaryArgs = fileArgs({ name: 'Boundary report', reference: 'reports/boundary.txt' });
    const atBoundary = await mcp(work.reporting.credential, 'collaboration_add_artifact', boundaryArgs, signCapture({ reporting: work.reporting, claimId: work.claimId, args: boundaryArgs, bytes: boundary }));
    expect(atBoundary).toMatchObject({ status: 200, isError: false, value: { name: 'Boundary report' } });
    expect(await artifactCount(work.claimId)).toBe(2);
  });

  it('converts an idea into one explicitly selected native chat prompt without changing its origin or starting a task', async () => {
    const source = await acquire(owner, 'Native idea follow-up origin');
    const proposed = await proposeIdea(source.reporting.credential, 'Inspect the follow-up boundary');
    expect(proposed.isError).toBe(false);
    const idea = proposed.value;
    const destination = await chatDestination(source.taskId);
    const before = (await db.getPool().query('SELECT status,version FROM collab_tasks WHERE id=$1', [source.taskId])).rows[0];
    const key = 'n'.repeat(256);
    const body = { taskId: source.taskId, kind: 'follow_up', claimId: destination.claimId, expectedVersion: idea.version };
    const converted = await collab('POST', `/ideas/${idea.id}/conversions`, owner, body, key);
    expect(converted.status).toBe(201);
    const commandId = converted.body.data.claimCommandId;
    expect(converted.body.data.commandId).toBeNull();
    expect(converted.body.data.createdTaskId).toBeNull();
    const replay = await collab('POST', `/ideas/${idea.id}/conversions`, owner, body, key);
    expect(replay.status).toBe(200);
    expect(replay.body.data.claimCommandId).toBe(commandId);
    expect((await db.getPool().query(
      'SELECT id,claim_id,kind,payload,status,originator_principal_id,originator_session_version FROM agent_claim_commands WHERE claim_id=$1', [destination.claimId])).rows)
      .toEqual([{ id: commandId, claim_id: destination.claimId, kind: 'prompt', payload: { text: 'Follow-up idea: Inspect the follow-up boundary\n\nClaim-bound idea.' },
        status: 'pending', originator_principal_id: owner.id, originator_session_version: owner.sessionVersion }]);
    expect((await db.getPool().query(
      'SELECT claim_id,conversion_claim_id,conversion_claim_command_id,conversion_command_id,conversion_session_id FROM collab_ideas WHERE id=$1', [idea.id])).rows)
      .toEqual([{ claim_id: source.claimId, conversion_claim_id: destination.claimId, conversion_claim_command_id: commandId, conversion_command_id: null, conversion_session_id: null }]);
    const visible = (await collab('GET', `/tasks/${source.taskId}/ideas`)).body.data.find(row => row.id === idea.id);
    expect(visible).toMatchObject({ claimId: source.claimId, conversionClaimId: destination.claimId, conversionClaimCommandId: commandId });
    expect((await db.getPool().query('SELECT status,version FROM collab_tasks WHERE id=$1', [source.taskId])).rows[0]).toEqual(before);
    expect((await collab('POST', `/ideas/${idea.id}/conversions`, owner, body, crypto.randomUUID())).status).toBe(409);
    expect((await db.getPool().query('SELECT id FROM collab_connector_commands WHERE payload->>\'text\' LIKE $1', ['%Inspect the follow-up boundary%'])).rows).toEqual([]);
  });

  it('does not send idea follow-ups to another task, ordinary work or a closed chat', async () => {
    const source = await acquire(owner, 'Native idea target validation');
    const idea = (await proposeIdea(source.reporting.credential, 'Keep the target explicit')).value;
    const otherTask = await db.createCollabTask({ actor: asActor(owner), projectId, title: 'Another idea destination' });
    const foreign = await chatDestination(otherTask.id);
    const destination = await chatDestination(source.taskId);
    const convert = claimId => collab('POST', `/ideas/${idea.id}/conversions`, owner,
      { taskId: source.taskId, kind: 'follow_up', claimId, expectedVersion: idea.version }, crypto.randomUUID());
    expect((await convert(foreign.claimId)).status).toBe(404);
    expect((await convert(source.claimId)).status).toBe(404);
    expect((await agentRequest(destination.runner.token, '/claim', {
      claim_id: destination.claimId, session_id: destination.runner.sessionId, repo: destination.work.repo,
      pr_number: destination.work.pr_number, attempt: destination.work.attempt, status: 'cancelled', end_reason: 'user',
    })).status).toBe(200);
    expect((await convert(destination.claimId)).status).toBe(409);
    expect((await db.getPool().query('SELECT status,version FROM collab_ideas WHERE id=$1', [idea.id])).rows)
      .toEqual([{ status: 'inbox', version: idea.version }]);
    expect((await db.getPool().query('SELECT id FROM agent_claim_commands WHERE claim_id=ANY($1)', [[source.claimId, destination.claimId, foreign.claimId]])).rows).toEqual([]);
  });

  it('rejects ambiguous or not-yet-active idea destinations without changing the idea or queueing a prompt', async () => {
    const source = await acquire(owner, 'Pending idea destination');
    const idea = (await proposeIdea(source.reporting.credential, 'Wait for an active session')).value;
    const pending = await chatDestination(source.taskId, false);
    const body = { taskId: source.taskId, kind: 'follow_up', claimId: pending.claimId, expectedVersion: idea.version };
    expect((await collab('POST', `/ideas/${idea.id}/conversions`, owner, { ...body, sessionId: crypto.randomUUID() }, crypto.randomUUID())).status).toBe(422);
    expect((await collab('POST', `/ideas/${idea.id}/conversions`, owner, body, crypto.randomUUID())).status).toBe(409);
    expect((await db.getPool().query('SELECT status,version,conversion_claim_id FROM collab_ideas WHERE id=$1', [idea.id])).rows)
      .toEqual([{ status: 'inbox', version: idea.version, conversion_claim_id: null }]);
    expect((await db.getPool().query('SELECT id FROM agent_claim_commands WHERE claim_id=$1', [pending.claimId])).rows).toEqual([]);
  });

  it('keeps an oversized follow-up intact and permits backlog conversion instead of truncating a paid prompt', async () => {
    const source = await acquire(owner, 'Bounded idea prompt');
    const body = 'word '.repeat(4000);
    const proposed = await mcp(source.reporting.credential, 'collaboration_propose_idea', { title: 'Preserve this complete idea', body });
    expect(proposed.isError).toBe(false);
    const idea = proposed.value;
    const destination = await chatDestination(source.taskId);
    const rejected = await collab('POST', `/ideas/${idea.id}/conversions`, owner,
      { taskId: source.taskId, kind: 'follow_up', claimId: destination.claimId, expectedVersion: idea.version }, crypto.randomUUID());
    expect(rejected.status).toBe(422);
    expect((await db.getPool().query('SELECT status,body FROM collab_ideas WHERE id=$1', [idea.id])).rows).toEqual([{ status: 'inbox', body }]);
    expect((await db.getPool().query('SELECT id FROM agent_claim_commands WHERE claim_id=$1', [destination.claimId])).rows).toEqual([]);
    const converted = await collab('POST', `/ideas/${idea.id}/conversions`, owner,
      { taskId: source.taskId, kind: 'task', expectedVersion: idea.version }, crypto.randomUUID());
    expect(converted.status).toBe(201);
    expect((await db.getPool().query('SELECT title,description,status FROM collab_tasks WHERE id=$1', [converted.body.data.createdTaskId])).rows)
      .toEqual([{ title: idea.title, description: expect.stringContaining(body), status: 'backlog' }]);
  });

  it('rolls idea conversion and paid prompts back together and rejects lost steering authority', async () => {
    const initiator = await enrollActor('native-idea-steering', [...WORK_CAPABILITIES, 'run.steer']);
    const source = await acquire(initiator.actor, 'Atomic idea conversion');
    const idea = (await proposeIdea(source.reporting.credential, 'Atomic follow-up')).value;
    const destination = await chatDestination(source.taskId);
    const body = { taskId: source.taskId, kind: 'follow_up', claimId: destination.claimId, expectedVersion: idea.version };
    await db.getPool().query('UPDATE collab_roles SET capabilities=$2::text[] WHERE id=$1', [initiator.roleId, WORK_CAPABILITIES]);
    try {
      expect((await collab('POST', `/ideas/${idea.id}/conversions`, initiator.actor, body, crypto.randomUUID())).status).toBe(403);
    } finally {
      await db.getPool().query('UPDATE collab_roles SET capabilities=$2::text[] WHERE id=$1', [initiator.roleId, [...WORK_CAPABILITIES, 'run.steer']]);
    }
    await db.getPool().query(`CREATE FUNCTION ff_reject_native_idea_conversion() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.id='${idea.id}'::uuid AND NEW.status='converted' THEN RAISE EXCEPTION 'fixture conversion failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER ff_reject_native_idea_conversion BEFORE UPDATE ON collab_ideas FOR EACH ROW EXECUTE FUNCTION ff_reject_native_idea_conversion()`);
    const key = crypto.randomUUID();
    try {
      expect((await collab('POST', `/ideas/${idea.id}/conversions`, initiator.actor, body, key)).status).toBe(500);
      expect((await db.getPool().query('SELECT id FROM agent_claim_commands WHERE claim_id=$1', [destination.claimId])).rows).toEqual([]);
      expect((await db.getPool().query('SELECT status,version FROM collab_ideas WHERE id=$1', [idea.id])).rows).toEqual([{ status: 'inbox', version: idea.version }]);
      expect((await db.getPool().query('SELECT resource_id,claim_id FROM collab_idempotency_records WHERE scope_key=$1 AND idempotency_key=$2', [`idea:${idea.id}`, key])).rows).toEqual([]);
    } finally {
      await db.getPool().query('DROP TRIGGER ff_reject_native_idea_conversion ON collab_ideas; DROP FUNCTION ff_reject_native_idea_conversion()');
    }
  });

  it('publishes accepted plans and progress without replaying older source revisions', async () => {
    const work = await acquire(owner, 'Native ACP workpad projection');
    const event = (seq, update) => normalizeAcpUpdate({ claimId: work.claimId, seq, sessionId: 'workpad-provider', update });
    const post = events => agentRequest(work.runner.token, `/claims/${work.claimId}/events`, { session_id: work.runner.sessionId, events });
    const plan = async actor => (await collab('GET', `/tasks/${work.taskId}/plan`, actor)).body.data.plan;
    const progress = async actor => (await collab('GET', `/tasks/${work.taskId}`, actor)).body.data.execution.publishedProgress;
    const first = [
      event(10, { sessionUpdate: 'plan', entries: [{ content: 'Inspect the boundary', status: 'completed', priority: 'high' }, { content: 'Apply the verified change', status: 'in_progress', priority: 'high' }] }),
      event(11, { sessionUpdate: 'tool_call', toolCallId: 'inspection', title: 'Inspect the boundary', kind: 'read', status: 'in_progress' }),
    ];
    expect((await post(first)).status).toBe(200);
    const published = await plan();
    expect(published).toMatchObject({ runId: null, sessionId: null, provenance: 'agent', items: [
      { text: 'Inspect the boundary', status: 'completed' }, { text: 'Apply the verified change', status: 'in_progress' },
    ] });
    expect(await progress()).toEqual({ claimId: work.claimId, text: 'Inspect the boundary: in_progress', percent: null });
    expect((await db.getPool().query(
      'SELECT claim_id,created_by_principal_id FROM collab_workpad_plans WHERE id=$1', [published.id])).rows)
      .toEqual([{ claim_id: work.claimId, created_by_principal_id: owner.id }]);
    expect((await post(first)).body.inserted).toBe(0);
    expect((await plan()).id).toBe(published.id);
    expect((await post([
      event(1, { sessionUpdate: 'plan_update', plan: { entries: [{ content: 'Old plan must not replace current work', status: 'pending' }] } }),
      event(2, { sessionUpdate: 'state_update', progress: { text: 'Old progress must not replace current work', percent: 1 } }),
    ])).status).toBe(200);
    expect((await plan()).id).toBe(published.id);
    expect(await progress()).toEqual({ claimId: work.claimId, text: 'Inspect the boundary: in_progress', percent: null });
    const publicReader = await enrollActor('projected-workpad-public', ['task.read']);
    expect(await plan(publicReader.actor)).toBeNull();
    expect(await progress(publicReader.actor)).toBeNull();
    expect((await post([
      event(20, { sessionUpdate: 'plan', entries: [] }),
      event(21, { sessionUpdate: 'state_update', progress: { text: 'Verification is complete', percent: 100 } }),
    ])).status).toBe(200);
    expect((await plan()).items).toEqual([]);
    expect(await progress()).toEqual({ claimId: work.claimId, text: 'Verification is complete', percent: 100 });
    expect((await post([
      event(30, { sessionUpdate: 'plan', entries: [{ content: 'Unsupported status', status: 'invented' }] }),
      event(31, { sessionUpdate: 'state_update', progress: { text: 'Unsupported percentage', percent: '100' } }),
    ])).status).toBe(200);
    expect((await plan()).items).toEqual([]);
    expect(await progress()).toEqual({ claimId: work.claimId, text: 'Verification is complete', percent: 100 });
    expect((await db.getPool().query('SELECT id FROM collab_runs WHERE task_id=$1', [work.taskId])).rows).toEqual([]);
  });

  it('orders explicit canonical reports by application rather than an older transaction start', async () => {
    const work = await acquire(owner, 'Canonical reporting after an accepted event');
    const client = await db.getPool().connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT now()');
      const events = [
        normalizeAcpUpdate({ claimId: work.claimId, seq: 1, sessionId: 'transaction-order', update: { sessionUpdate: 'plan', entries: [{ content: 'Earlier accepted plan', status: 'pending' }] } }),
        normalizeAcpUpdate({ claimId: work.claimId, seq: 2, sessionId: 'transaction-order', update: { sessionUpdate: 'state_update', progress: { text: 'Earlier accepted progress', percent: 10 } } }),
      ];
      expect((await agentRequest(work.runner.token, `/claims/${work.claimId}/events`, { session_id: work.runner.sessionId, events })).status).toBe(200);
      const context = await db.authenticateCollabToken(work.reporting.credential);
      await db.recordWorkpadPlanReport({ taskId: work.taskId, source: context.source, items: [{ text: 'Later explicit plan', status: 'completed' }] }, client);
      await db.recordAgentProgress(context, { text: 'Later explicit progress', percent: 100 }, client);
      await client.query('COMMIT');
      expect.soft((await collab('GET', `/tasks/${work.taskId}/plan`)).body.data.plan.items).toEqual([{ text: 'Later explicit plan', status: 'completed' }]);
      expect.soft((await collab('GET', `/tasks/${work.taskId}`)).body.data.execution.publishedProgress)
        .toEqual({ claimId: work.claimId, text: 'Later explicit progress', percent: 100 });
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  it('rejects revoked workpad authority and rolls back source events with canonical writes', async () => {
    const initiator = await enrollActor('native-workpad-revocation');
    const work = await acquire(initiator.actor, 'Atomic native plan and progress');
    const event = (seq, update) => normalizeAcpUpdate({ claimId: work.claimId, seq, sessionId: 'atomic-workpad', update });
    const post = events => agentRequest(work.runner.token, `/claims/${work.claimId}/events`, { session_id: work.runner.sessionId, events });
    expect((await post([event(1, { sessionUpdate: 'plan', entries: [{ content: 'Authorized work', status: 'pending' }] })])).status).toBe(200);
    await db.getPool().query('UPDATE collab_roles SET capabilities=$2::text[] WHERE id=$1', [initiator.roleId, ['task.read', 'internal.read']]);
    try {
      expect((await post([event(2, { sessionUpdate: 'plan', entries: [{ content: 'Revoked work must not persist', status: 'completed' }] })])).status).toBe(403);
      expect((await db.getPool().query('SELECT seq::text AS seq FROM agent_claim_events WHERE claim_id=$1 ORDER BY seq', [work.claimId])).rows).toEqual([{ seq: '1' }]);
    } finally {
      await db.getPool().query('UPDATE collab_roles SET capabilities=$2::text[] WHERE id=$1', [initiator.roleId, WORK_CAPABILITIES]);
    }
    await db.getPool().query(`CREATE FUNCTION ff_reject_projected_progress() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.task_id='${work.taskId}'::uuid AND NEW.payload ? 'progress' THEN RAISE EXCEPTION 'fixture projection failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER ff_reject_projected_progress BEFORE INSERT ON collab_task_events FOR EACH ROW EXECUTE FUNCTION ff_reject_projected_progress()`);
    try {
      expect((await post([
        event(3, { sessionUpdate: 'plan', entries: [{ content: 'Rolled back plan', status: 'completed' }] }),
        event(4, { sessionUpdate: 'state_update', progress: { text: 'Rolled back progress', percent: 100 } }),
      ])).status).toBe(500);
      expect((await db.getPool().query('SELECT seq::text AS seq FROM agent_claim_events WHERE claim_id=$1 ORDER BY seq', [work.claimId])).rows).toEqual([{ seq: '1' }]);
      expect((await collab('GET', `/tasks/${work.taskId}/plan`, initiator.actor)).body.data.plan.items).toEqual([{ text: 'Authorized work', status: 'pending' }]);
      expect((await db.getPool().query("SELECT payload->'progress' AS progress FROM collab_task_events WHERE task_id=$1 AND payload ? 'progress'", [work.taskId])).rows).toEqual([]);
    } finally {
      await db.getPool().query('DROP TRIGGER ff_reject_projected_progress ON collab_task_events; DROP FUNCTION ff_reject_projected_progress()');
    }
  });

  it('projects accepted ACP session costs without billing context tokens or replaying stale totals', async () => {
    const work = await acquire(owner, 'Native ACP cost projection');
    const event = (seq, sessionId, cost) => normalizeAcpUpdate({
      claimId: work.claimId, seq, sessionId,
      update: { sessionUpdate: 'usage_update', used: 1200, size: 32000, ...(cost === undefined ? {} : { cost }) },
    });
    const post = events => agentRequest(work.runner.token, `/claims/${work.claimId}/events`, { session_id: work.runner.sessionId, events });
    const rows = async () => (await db.getPool().query(
      'SELECT claim_id,run_id,session_id,reporting_binding_id,tokens_in,tokens_out,cost_usd,unavailable_reason FROM collab_usage_samples WHERE claim_id=$1 ORDER BY provider_turn_id', [work.claimId],
    )).rows;
    const insights = async () => {
      const result = await collab('GET', `/projects/${projectId}/insights?from=2000-01-01T00:00:00.000Z&to=2100-01-01T00:00:00.000Z`);
      expect(result.status).toBe(200);
      expect(JSON.stringify(result.body)).not.toContain(work.reporting.bindingId);
      return result.body.data.usage;
    };
    const first = event(10, 'provider-design', { amount: 0.2, currency: 'USD' });
    expect((await post([first])).status).toBe(200);
    expect(await rows()).toEqual([expect.objectContaining({
      claim_id: work.claimId, run_id: null, session_id: null, reporting_binding_id: work.reporting.bindingId,
      tokens_in: null, tokens_out: null, cost_usd: '0.200000',
    })]);
    expect(await insights()).toMatchObject({ tokensIn: null, tokensOut: null, costUsd: 0.2, coverage: { samples: 1, tokensIn: 0, tokensOut: 0, costUsd: 1 } });
    expect((await post([event(12, 'provider-design')])).status).toBe(200);
    expect((await rows())[0].cost_usd).toBe('0.200000');
    expect((await post([event(11, 'provider-design', { amount: 0.3, currency: 'USD' })])).status).toBe(200);
    expect((await rows())[0].cost_usd).toBe('0.300000');
    expect((await post([event(9, 'provider-design', { amount: 0.1, currency: 'USD' })])).status).toBe(200);
    expect((await rows())[0].cost_usd).toBe('0.300000');
    expect((await post([first, event(13, 'provider-design')])).body).toEqual({ ok: true, inserted: 1, lastSeq: 13 });
    expect((await rows())[0].cost_usd).toBe('0.300000');
    expect((await post([event(14, 'provider-design', { amount: 9, currency: 'EUR' })])).status).toBe(200);
    expect((await rows())[0]).toMatchObject({ tokens_in: null, tokens_out: null, cost_usd: null });
    expect((await post([event(8, 'provider-design', { amount: 0.9, currency: 'USD' })])).status).toBe(200);
    expect((await rows())[0].cost_usd).toBeNull();
    expect((await insights()).available).toBe(false);
    expect((await post([event(15, 'provider-design', null)])).status).toBe(200);
    expect((await rows())[0].cost_usd).toBeNull();
    expect((await post([event(16, 'provider-design', { amount: 0.4, currency: 'USD' }), event(17, 'provider-build', { amount: 0.6, currency: 'USD' })])).status).toBe(200);
    expect((await rows()).map(row => row.cost_usd).sort()).toEqual(['0.400000', '0.600000']);
    expect(await insights()).toMatchObject({ tokensIn: null, tokensOut: null, costUsd: 1, coverage: { samples: 2, tokensIn: 0, tokensOut: 0, costUsd: 2 } });
    const report = values => recordUsageSample({
      source: { kind: 'claim', claimId: work.claimId, reportingBindingId: work.reporting.bindingId },
      taskId: work.taskId, unavailableReason: null, ...values,
    });
    await report({ providerTurnId: 'ordinary-turn', tokensIn: 300, tokensOut: 100, costUsd: 0.9 });
    expect(await insights()).toMatchObject({ tokensIn: null, tokensOut: null, costUsd: 1, coverage: { samples: 2, tokensIn: 0, tokensOut: 0, costUsd: 2 } });
    await report({ providerTurnId: 'native-session-snapshot', tokensIn: null, tokensOut: null, costUsd: null, unavailableReason: 'provider_did_not_report_usage' });
    expect((await insights()).costUsd).toBe(1);
    expect((await post([event(18, 'provider-design', null), event(19, 'provider-build', null)])).status).toBe(200);
    expect(await insights()).toMatchObject({ tokensIn: 300, tokensOut: 100, costUsd: 0.9, coverage: { samples: 1, tokensIn: 1, tokensOut: 1, costUsd: 1 } });
    await report({ providerTurnId: 'native-session-snapshot', tokensIn: 555, tokensOut: 111, costUsd: 2 });
    expect(await insights()).toMatchObject({ tokensIn: 555, tokensOut: 111, costUsd: 2, coverage: { samples: 1, tokensIn: 1, tokensOut: 1, costUsd: 1 } });
    const marker = '2026-11-13T09:00:00.000Z';
    await db.getPool().query('UPDATE collab_usage_samples SET observed_at=$2 WHERE claim_id=$1', [work.claimId, marker]);
    expect((await post([first])).body).toEqual({ ok: true, inserted: 0, lastSeq: 10 });
    const observed = await db.getPool().query('SELECT observed_at FROM collab_usage_samples WHERE claim_id=$1 AND source_event_seq IS NOT NULL', [work.claimId]);
    expect(observed.rows.map(row => row.observed_at.toISOString())).toEqual([marker, marker]);
  });

  it('rolls raw events and canonical costs back together on conflicts and reporting revocation', async () => {
    const initiator = await enrollActor('native-usage-revocation');
    const work = await acquire(initiator.actor, 'Atomic native cost projection');
    const usage = (seq, amount) => normalizeAcpUpdate({
      claimId: work.claimId, seq, sessionId: 'provider-atomic',
      update: { sessionUpdate: 'usage_update', used: 10, size: 100, cost: { amount, currency: 'USD' } },
    });
    const post = events => agentRequest(work.runner.token, `/claims/${work.claimId}/events`, { session_id: work.runner.sessionId, events });
    expect((await post([usage(1, 1)])).status).toBe(200);
    const conflict = await post([{ seq: 2, kind: 'notice', payload: { text: 'Must roll back' } }, usage(3, 2), usage(1, 3)]);
    expect(conflict.status).toBe(409);
    await db.getPool().query('UPDATE collab_roles SET capabilities=$2::text[] WHERE id=$1', [initiator.roleId, ['task.read', 'internal.read']]);
    const revoked = await post([{ seq: 4, kind: 'notice', payload: { text: 'Also must roll back' } }, usage(5, 4)]);
    expect(revoked.status).toBe(403);
    expect(JSON.stringify(revoked.body)).not.toContain(work.reporting.bindingId);
    const raw = await db.getPool().query('SELECT seq::text AS seq FROM agent_claim_events WHERE claim_id=$1 ORDER BY seq', [work.claimId]);
    expect(raw.rows).toEqual([{ seq: '1' }]);
    const canonical = await db.getPool().query('SELECT cost_usd,reporting_binding_id FROM collab_usage_samples WHERE claim_id=$1', [work.claimId]);
    expect(canonical.rows).toEqual([{ cost_usd: '1.000000', reporting_binding_id: work.reporting.bindingId }]);
    await db.getPool().query('UPDATE collab_roles SET capabilities=$2::text[] WHERE id=$1', [initiator.roleId, WORK_CAPABILITIES]);
  });

  it('keeps costs inside their original acquisition when provider session identifiers are reused', async () => {
    const work = await acquire(owner, 'Reacquired cost projection');
    const usage = (seq, cost) => normalizeAcpUpdate({
      claimId: work.claimId, seq, sessionId: 'provider-reused',
      update: { sessionUpdate: 'usage_update', used: 40, size: 1000, ...(cost === undefined ? {} : { cost: { amount: cost, currency: 'USD' } }) },
    });
    const first = usage(1, 1);
    expect((await agentRequest(work.runner.token, `/claims/${work.claimId}/events`, { session_id: work.runner.sessionId, events: [first] })).status).toBe(200);
    expect(await releaseUndeliveredClaim(orgId, agentId, work.runner.sessionId, work.claimId)).toBe(true);
    const nextRunner = await runner('Reacquired cost target');
    const next = await poll(nextRunner);
    expect(next.status).toBe(200);
    expect(next.body.work.claim_id).toBe(work.claimId);
    const nextBinding = next.body.work.reporting.bindingId;
    expect(nextBinding).not.toBe(work.reporting.bindingId);
    const post = events => agentRequest(nextRunner.token, `/claims/${work.claimId}/events`, { session_id: nextRunner.sessionId, events });
    expect((await post([usage(20)])).status).toBe(200);
    const unavailable = await db.getPool().query('SELECT cost_usd FROM collab_usage_samples WHERE reporting_binding_id=$1', [nextBinding]);
    expect(unavailable.rows).toEqual([{ cost_usd: null }]);
    expect((await post([usage(19, 0.2)])).status).toBe(200);
    expect((await post([first])).body).toEqual({ ok: true, inserted: 0, lastSeq: 1 });
    const wrongOwner = await agentRequest(work.runner.token, `/claims/${work.claimId}/events`, { session_id: work.runner.sessionId, events: [usage(21, 9)] });
    expect(wrongOwner.status).toBe(409);
    const costs = await db.getPool().query('SELECT reporting_binding_id,cost_usd FROM collab_usage_samples WHERE claim_id=$1 ORDER BY cost_usd', [work.claimId]);
    expect(costs.rows).toEqual([
      { reporting_binding_id: nextBinding, cost_usd: '0.200000' },
      { reporting_binding_id: work.reporting.bindingId, cost_usd: '1.000000' },
    ]);
    const events = await collab('GET', `/claim-executions/${work.claimId}/events`);
    expect(events.status).toBe(200);
    expect(JSON.stringify(events.body)).not.toContain(nextBinding);
    expect(JSON.stringify(events.body)).not.toContain(work.reporting.bindingId);
    expect((await db.getPool().query('SELECT seq::text AS seq FROM agent_claim_events WHERE claim_id=$1 ORDER BY seq', [work.claimId])).rows)
      .toEqual([{ seq: '1' }, { seq: '19' }, { seq: '20' }]);
  });

  it('rolls back event ingestion when an expected reporting binding is missing', async () => {
    const work = await acquire(owner, 'Missing usage binding');
    await db.getPool().query('DELETE FROM collab_scoped_tokens WHERE id=$1', [work.reporting.bindingId]);
    const usage = normalizeAcpUpdate({ claimId: work.claimId, seq: 1, sessionId: 'missing-binding-provider', update: { sessionUpdate: 'usage_update', used: 10, size: 100, cost: { amount: 2, currency: 'USD' } } });
    const result = await agentRequest(work.runner.token, `/claims/${work.claimId}/events`, { session_id: work.runner.sessionId, events: [usage] });
    expect(result.status).toBe(500);
    expect(result.body).toEqual({ error: 'Internal server error' });
    expect((await db.getPool().query('SELECT seq FROM agent_claim_events WHERE claim_id=$1', [work.claimId])).rows).toEqual([]);
    expect((await db.getPool().query('SELECT id FROM collab_usage_samples WHERE claim_id=$1', [work.claimId])).rows).toEqual([]);
  });

  it('serializes event accounting with a concurrent canonical task report without deadlock', async () => {
    const work = await acquire(owner, 'Concurrent canonical accounting');
    const client = await db.getPool().connect();
    let pending;
    try {
      await client.query('BEGIN');
      await client.query('SELECT id FROM collab_tasks WHERE id=$1 FOR UPDATE', [work.taskId]);
      const pid = (await client.query('SELECT pg_backend_pid() AS id')).rows[0].id;
      const event = normalizeAcpUpdate({ claimId: work.claimId, seq: 1, sessionId: 'provider-concurrent', update: { sessionUpdate: 'usage_update', used: 10, size: 100, cost: { amount: 1, currency: 'USD' } } });
      pending = agentRequest(work.runner.token, `/claims/${work.claimId}/events`, { session_id: work.runner.sessionId, events: [event] });
      const deadline = Date.now() + 5000;
      let blocked = false;
      while (Date.now() < deadline) {
        const activity = await db.getPool().query('SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND $1::integer=ANY(pg_blocking_pids(pid))) AS blocked', [pid]);
        if (activity.rows[0].blocked) { blocked = true; break; }
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(blocked).toBe(true);
      await recordUsageSample({
        source: { kind: 'claim', claimId: work.claimId, reportingBindingId: work.reporting.bindingId },
        taskId: work.taskId, providerTurnId: 'concurrent-turn', tokensIn: 10, tokensOut: 5, costUsd: 0.5, unavailableReason: null,
      }, client);
      await client.query('COMMIT');
      expect((await pending).status).toBe(200);
      const rows = await db.getPool().query('SELECT cost_usd FROM collab_usage_samples WHERE claim_id=$1 ORDER BY cost_usd', [work.claimId]);
      expect(rows.rows).toEqual([{ cost_usd: '0.500000' }, { cost_usd: '1.000000' }]);
    } finally {
      await client.query('ROLLBACK');
      client.release();
      if (pending) await pending;
    }
  });

  async function summaryFixture() {
    const source = await acquire(owner, `Summary source ${crypto.randomUUID()}`);
    const event = normalizeAcpUpdate({ claimId: source.claimId, seq: 1, sessionId: 'summary-source-provider',
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Private frozen summary source.' } } });
    expect((await agentRequest(source.runner.token, `/claims/${source.claimId}/events`, { session_id: source.runner.sessionId, events: [event] })).status).toBe(200);
    const summaryAgentId = `summary-${crypto.randomUUID()}`;
    await db.createAgent({ id: summaryAgentId, orgId, agentType: 'test', transport: 'long_poll', repos: ['unrelated/private-repo'] });
    await db.updateAgentChatSlots(orgId, summaryAgentId, 0);
    const token = await db.createToken({ orgId, agentId: summaryAgentId, label: 'Summary work capacity' });
    const meta = { capacity: 1, supported_claim_types: ['summary'], profiles: [{ id: 'summary', models: ['small', 'large'], default_model: 'small' }] };
    const registered = await agentRequest(token.plaintext, '/register', { meta });
    expect(registered.status).toBe(200);
    const settings = await db.getProjectSummarySettings({ actor: asActor(owner), projectId });
    await db.updateProjectSummarySettings({ actor: asActor(owner), projectId, expectedVersion: settings.version,
      defaults: { enabled: true, agentId: summaryAgentId, profileId: 'summary', model: 'small' } });
    const before = (await db.getPool().query('SELECT status,version FROM collab_tasks WHERE id=$1', [source.taskId])).rows[0];
    const body = { expectedVersion: before.version, source: { kind: 'claim', claimId: source.claimId } };
    const key = crypto.randomUUID();
    const queued = await collab('POST', `/tasks/${source.taskId}/summaries`, owner, body, key);
    expect(queued.status).toBe(202);
    const replay = await collab('POST', `/tasks/${source.taskId}/summaries`, owner, body, key);
    expect(replay.status).toBe(200);
    expect(replay.body.data.claimId).toBe(queued.body.data.claimId);
    expect((await db.getPool().query('SELECT status,version FROM collab_tasks WHERE id=$1', [source.taskId])).rows[0]).toEqual(before);
    return { source, summaryAgentId, meta, claimId: queued.body.data.claimId, requestId: queued.body.data.requestId,
      runner: { token: token.plaintext, sessionId: registered.body.session_id } };
  }

  it('completes canonical native summary work only after an authorized frozen publication', async () => {
    const fixture = await summaryFixture();
    const settings = await db.getProjectSummarySettings({ actor: asActor(owner), projectId });
    await db.updateProjectSummarySettings({ actor: asActor(owner), projectId, expectedVersion: settings.version,
      defaults: { ...settings.defaults, model: 'large' } });
    const polled = await poll(fixture.runner);
    expect(polled.status).toBe(200);
    const work = polled.body.work;
    expect(work).toMatchObject({ claim_id: fixture.claimId, task_id: fixture.source.taskId, repo: null, pr_number: null,
      summary: { requestId: fixture.requestId, profile: 'summary', model: 'small', reported: false } });
    expect(work.githubToken).toBeUndefined();
    const report = { claim_id: work.claim_id, session_id: fixture.runner.sessionId, repo: null, pr_number: null, attempt: work.attempt, status: 'completed' };
    expect((await agentRequest(fixture.runner.token, '/claim', report)).status).toBe(409);
    expect((await db.getPool().query('SELECT status FROM agent_claims WHERE id=$1', [work.claim_id])).rows[0].status).toBe('claimed');
    const task = await mcp(work.reporting.credential, 'collaboration_get_task', {});
    expect(task.value.reportingRole).toBe('summary');
    expect(task.value.workspace).toBeUndefined();
    expect(task.value.description).toBeUndefined();
    expect(task.value.summary).toMatchObject({ model: 'small', sourceCursor: { seq: '1' }, source: { kind: 'claim', claimId: fixture.source.claimId } });
    expect(task.value.summary.sourceText).toContain('Private frozen summary source.');
    expect((await mcp(work.reporting.credential, 'collaboration_report_progress', { text: 'Cannot publish work progress.' })).isError).toBe(true);
    const raw = [
      normalizeAcpUpdate({ claimId: work.claim_id, seq: 1, sessionId: 'summary-role', update: { sessionUpdate: 'plan', entries: [{ content: 'Not work authority', status: 'pending' }] } }),
      normalizeAcpUpdate({ claimId: work.claim_id, seq: 2, sessionId: 'summary-role', update: { sessionUpdate: 'tool_call', toolCallId: 'summary-tool', title: 'Not work progress', status: 'completed' } }),
      normalizeAcpUpdate({ claimId: work.claim_id, seq: 3, sessionId: 'summary-role', update: { sessionUpdate: 'usage_update', used: 20, size: 100, cost: { amount: 0.03, currency: 'USD' } } }),
    ];
    expect((await agentRequest(fixture.runner.token, `/claims/${work.claim_id}/events`, { session_id: fixture.runner.sessionId, events: raw })).status).toBe(200);
    expect((await db.getPool().query('SELECT id FROM collab_workpad_plans WHERE claim_id=$1', [work.claim_id])).rows).toEqual([]);
    expect((await db.getPool().query("SELECT id FROM collab_task_events WHERE payload->>'claimId'=$1 AND payload ? 'progress'", [String(work.claim_id)])).rows).toEqual([]);
    expect((await db.getPool().query('SELECT cost_usd FROM collab_usage_samples WHERE claim_id=$1', [work.claim_id])).rows).toEqual([{ cost_usd: '0.030000' }]);
    const extraPrompt = await collab('POST', `/claim-executions/${work.claim_id}/commands`, owner,
      { kind: 'prompt', payload: { text: 'Replace the frozen source with a new turn.' } }, crypto.randomUUID());
    expect(extraPrompt.status).toBe(409);
    expect(extraPrompt.body.error.code).toBe('summary_not_interactive');
    expect((await db.getPool().query('SELECT id FROM agent_claim_commands WHERE claim_id=$1 AND kind=$2', [work.claim_id, 'prompt'])).rows).toEqual([]);
    const published = await mcp(work.reporting.credential, 'collaboration_report_summary', { body: 'Canonical generated summary.', model: 'forged', sourceEpoch: 'forged', sourceSeq: '999' });
    expect(published.isError).toBe(false);
    expect(published.value).toMatchObject({ claimId: work.claim_id, model: 'small', sourceCursor: '1', visibility: 'internal' });
    expect((await agentRequest(fixture.runner.token, '/claim', { ...report, attempt: report.attempt + 1 })).status).toBe(400);
    expect((await agentRequest(fixture.runner.token, '/claim', report)).status).toBe(200);
    expect((await agentRequest(fixture.runner.token, '/claim', report)).body).toMatchObject({ status: 'completed', note: 'already_resolved' });
    const history = await collab('GET', `/tasks/${fixture.source.taskId}/summaries`);
    expect(history.body.data.summaries).toEqual([expect.objectContaining({ id: published.value.id, body: 'Canonical generated summary.', claimId: work.claim_id })]);
    for (const secret of Object.values(work.reporting)) expect(JSON.stringify(history.body)).not.toContain(secret);
    const publicReader = await enrollActor(`summary-reader-${crypto.randomUUID()}`, ['task.read']);
    const publicHistory = await collab('GET', `/tasks/${fixture.source.taskId}/summaries`, publicReader.actor);
    expect(publicHistory.body.data.summaries).toEqual([]);
    expect(JSON.stringify(publicHistory.body)).not.toContain('Canonical generated summary.');
    expect((await db.getPool().query('SELECT id FROM collab_runs WHERE task_id=$1', [fixture.source.taskId])).rows).toEqual([]);
  });

  it('acknowledges a transient native summary retry without replacing its original producing claim', async () => {
    const fixture = await summaryFixture();
    const first = (await poll(fixture.runner)).body.work;
    const published = await mcp(first.reporting.credential, 'collaboration_report_summary', { body: 'Published before result acknowledgement.' });
    expect(published.isError).toBe(false);
    const failed = { claim_id: first.claim_id, session_id: fixture.runner.sessionId, repo: null, pr_number: null, attempt: first.attempt, status: 'failed', failure_kind: 'transient' };
    expect((await agentRequest(fixture.runner.token, '/claim', failed)).status).toBe(200);
    expect((await agentRequest(fixture.runner.token, '/claim', failed)).body).toMatchObject({ note: 'already_resolved' });
    const retry = (await poll(fixture.runner)).body.work;
    expect(retry).toMatchObject({ task_id: fixture.source.taskId, attempt: first.attempt + 1, repo: null,
      summary: { requestId: fixture.requestId, model: 'small', reported: true } });
    expect(retry.claim_id).not.toBe(first.claim_id);
    expect((await agentRequest(fixture.runner.token, '/claim', { ...failed, claim_id: retry.claim_id, attempt: retry.attempt, status: 'completed', failure_kind: undefined })).status).toBe(200);
    const stored = (await db.getPool().query('SELECT id,claim_id,body FROM collab_summaries WHERE summary_request_id=$1', [fixture.requestId])).rows;
    expect(stored).toEqual([{ id: published.value.id, claim_id: first.claim_id, body: 'Published before result acknowledgement.' }]);
    expect((await db.getPool().query('SELECT claim_id,parent_claim_id FROM collab_summary_claims WHERE summary_request_id=$1 ORDER BY claim_id', [fixture.requestId])).rows)
      .toEqual([{ claim_id: first.claim_id, parent_claim_id: null }, { claim_id: retry.claim_id, parent_claim_id: first.claim_id }]);
  });

  it('keeps native summary work pending when the polling slot no longer advertises its frozen model', async () => {
    const fixture = await summaryFixture();
    await db.getPool().query('UPDATE agent_sessions SET session_meta=$2 WHERE id=$1', [fixture.runner.sessionId,
      JSON.stringify({ ...fixture.meta, profiles: [{ id: 'summary', models: ['large'], default_model: 'large' }] })]);
    expect(await claimPendingWork(orgId, fixture.summaryAgentId, fixture.runner.sessionId)).toBeNull();
    expect((await db.getPool().query('SELECT status FROM agent_claims WHERE id=$1', [fixture.claimId])).rows[0].status).toBe('pending');
    await db.getPool().query('UPDATE agent_sessions SET session_meta=$2 WHERE id=$1', [fixture.runner.sessionId, JSON.stringify(fixture.meta)]);
    expect((await poll(fixture.runner)).body.work).toMatchObject({ claim_id: fixture.claimId, summary: { model: 'small' } });
  });

  it('reviews native workspace evidence and ACP requests through the human delivery routes', async () => {
    const source = await acquire(owner, 'Native human delivery');
    const proof = { version: 1, bindingId: source.reporting.bindingId, seq: '1', state: 'known', headCommit: HEAD, dirty: false, final: false, repository: null, taskBranch: null, taskBranchHead: null };
    const material = JSON.stringify(['fluent-flow:workspace-observation:v1', proof.bindingId, source.claimId, proof.seq, proof.state, proof.headCommit, proof.dirty, proof.final, null, null, null]);
    proof.hmac = createHmac('sha256', Buffer.from(source.reporting.captureKey, 'base64url')).update(material).digest('base64url');
    expect((await mcp(source.reporting.credential, 'collaboration_report_workspace', {}, { 'fluent-flow/workspace-observation': proof })).isError).toBe(false);
    const check = await mcp(source.reporting.credential, 'collaboration_report_check', { name: 'Native delivery smoke', command: 'npm test', status: 'passed', commit: HEAD, dirty: false, exitCode: 0 });
    expect(check.isError).toBe(false);
    await db.getPool().query("UPDATE collab_tasks SET status='in_progress' WHERE id=$1", [source.taskId]);
    const task = await collab('GET', `/tasks/${source.taskId}`);
    const delivery = await collab('POST', `/tasks/${source.taskId}/deliveries`, owner, { expectedVersion: task.body.data.version, note: 'Explicit human review remains required.' });
    expect(delivery.status).toBe(201);
    const { actor: reviewer } = await enrollActor(`native-delivery-${crypto.randomUUID()}`, ['task.read', 'delivery.accept']);
    const before = await collab('GET', `/tasks/${source.taskId}/delivery-review`, reviewer);
    expect(before.body.data).toMatchObject({ source: { kind: 'claim', claimId: source.claimId }, headCommit: HEAD, dirty: false, openItems: [] });
    const request = await agentRequest(source.runner.token, `/claims/${source.claimId}/requests`, { session_id: source.runner.sessionId,
      request: { requestKey: 'native-human-permission', kind: 'permission', payload: { toolCall: { title: 'Private deployment approval' }, secret: 'DO-NOT-EXPOSE-REQUEST' } } });
    expect(request.status).toBe(200);
    const review = await collab('GET', `/tasks/${source.taskId}/delivery-review`, reviewer);
    expect(review.body.data.openItems).toEqual([{ id: expect.stringMatching(/^[0-9a-f-]{36}$/), label: 'Native approval awaiting a response' }]);
    const ids = review.body.data.openItems.map(item => item.id);
    const decision = { expectedVersion: delivery.body.data.taskVersion, decision: 'accept', acknowledgedOpenItemIds: ids };
    const stale = await collab('POST', `/tasks/${source.taskId}/decisions`, reviewer, { ...decision, reviewSnapshot: before.body.data });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('review_changed');
    expect((await collab('POST', `/tasks/${source.taskId}/decisions`, reviewer, { ...decision, reviewSnapshot: review.body.data })).status).toBe(200);
    const history = await collab('GET', `/tasks/${source.taskId}/decisions`, reviewer);
    expect(history.body.data[0]).toMatchObject({ decision: 'accept', acknowledgedOpenItemIds: ids, reviewSnapshot: { source: { kind: 'claim', claimId: source.claimId }, headCommit: HEAD } });
    const publicReader = await enrollActor(`native-delivery-public-${crypto.randomUUID()}`, ['task.read']);
    expect((await collab('GET', `/tasks/${source.taskId}/delivery-review`, publicReader.actor)).status).toBe(403);
    for (const secret of [...Object.values(source.reporting), 'Private deployment approval', 'DO-NOT-EXPOSE-REQUEST', 'native-human-permission']) {
      expect(JSON.stringify([review.body, history.body])).not.toContain(secret);
    }
  });

  it('copies the original session-version snapshot to follow-on claims instead of the current version', async () => {
    const { actor } = await enrollActor('claim-reporting-follow-on');
    const parent = await startSpec(actor, 'Follow-on snapshot');
    const original = (await db.getPool().query('SELECT created_by_session_version FROM collab_claim_executions WHERE claim_id = $1', [parent.claimId])).rows[0].created_by_session_version;
    expect(original).toBe(actor.sessionVersion);
    await db.getPool().query('UPDATE collab_principals SET session_version = session_version + 1 WHERE id = $1', [actor.id]);
    const followOn = await createFollowOnClaim({
      parentClaimId: parent.claimId,
      orgId,
      repo,
      prNumber: prNumber++,
      attempt: 2,
      claimType: 'spec',
      payload: { source: 'collab' },
    });
    const link = await db.getPool().query(
      'SELECT task_id, root_claim_id, created_by_principal_id, created_by_session_version FROM collab_claim_executions WHERE claim_id = $1',
      [followOn.id],
    );
    expect(link.rows[0]).toEqual({ task_id: parent.taskId, root_claim_id: parent.claimId, created_by_principal_id: actor.id, created_by_session_version: original });
  });
});
