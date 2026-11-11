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

const AUTH_SECRET = 'claim-routes-secret-0123456789abcdef0123456789abcdef';
const db = await import('@fluent-flow/db');
const { createApp } = await import('../../src/app.js');

function actorHeader(actor) {
  return db.signCollaborationActor(
    { principalId: actor.id, sessionVersion: actor.sessionVersion },
    AUTH_SECRET,
  );
}

function expectGenericError(response, status, code) {
  expect(response.status).toBe(status);
  expect(response.body.error).toEqual(expect.objectContaining({ code, message: expect.any(String) }));
  const serialized = JSON.stringify(response.body);
  expect(serialized).not.toMatch(/claim-route-org|agent_claim_|collab_claim_|SELECT |INSERT |UPDATE |\/home\//i);
}

function encodedCursor(value) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

describe('collaboration claim execution routes', () => {
  let server;
  let baseUrl;
  let owner;
  let workspaceId;
  let projectId;
  let taskId;
  let foreignOwner;
  let foreignTaskId;
  let reader;
  let internalReader;
  let steerer;
  let canceller;
  let steerWithoutInternal;
  let cancelWithoutInternal;
  let controller;
  let revocable;
  let revocableRoleId;
  let revocableStarter;
  let revocableStarterRoleId;
  let revocableReader;
  let revocableReaderRoleId;
  let runnerToken;
  let runnerSessionId;
  const orgId = 'claim-route-org';
  const repo = 'acme/claim-route-tests';

  async function request(method, path, { actor = owner, body, headers } = {}) {
    const requestHeaders = { ...(headers ?? {}) };
    if (actor) requestHeaders['x-fluent-flow-actor'] = actorHeader(actor);
    if (body !== undefined) requestHeaders['content-type'] = 'application/json';
    const response = await fetch(`${baseUrl}/api/collab/v1${path}`, {
      method,
      headers: requestHeaders,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  }

  async function runnerRequest(path, body) {
    const response = await fetch(`${baseUrl}/api/agent-server${path}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${runnerToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  }

  async function enrollActor(name, email, capabilities) {
    const role = await db.createWorkspaceRole({
      actor: { principalId: owner.id, sessionVersion: owner.sessionVersion },
      workspaceId,
      name,
      capabilities,
    });
    const invitation = await db.createCollabInvitation({
      actor: { principalId: owner.id, sessionVersion: owner.sessionVersion },
      projectId,
      email,
      roleId: role.id,
      expiresInHours: 24,
    });
    const accepted = await fetch(`${baseUrl}/api/collab/v1/invitations/accept`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        token: invitation.url.split('token=')[1],
        displayName: name,
        password: 'synthetic-password',
      }),
    });
    const payload = await accepted.json();
    expect(accepted.status).toBe(201);
    return {
      actor: payload.data.principal,
      roleId: role.id,
    };
  }

  async function createTask(title = `Claim route task ${crypto.randomUUID()}`) {
    return db.createCollabTask({
      actor: { principalId: owner.id, sessionVersion: owner.sessionVersion },
      projectId,
      title,
    });
  }

  async function createExecution(overrides = {}) {
    const task = overrides.taskId ? null : await createTask();
    const result = await db.startCollabClaimExecution({
      actor: { principalId: owner.id, sessionVersion: owner.sessionVersion },
      taskId: overrides.taskId ?? task.id,
      expectedVersion: 1,
      idempotencyKey: overrides.idempotencyKey ?? `service-${crypto.randomUUID()}`,
      repo,
      prNumber: overrides.prNumber ?? 701,
      branch: overrides.branch ?? 'feature/claim-route-tests',
      claimType: overrides.claimType ?? 'spec',
      instructions: overrides.instructions ?? 'Complete the task.',
    });
    return { taskId: overrides.taskId ?? task.id, claimId: result.claim.id };
  }

  async function setClaimStatus(claimId, status) {
    await db.getPool().query(
      `UPDATE agent_claims
       SET status = $2,
           claimed_at = CASE WHEN $2 = 'claimed' THEN now() ELSE claimed_at END,
           completed_at = CASE WHEN $2 IN ('completed', 'failed', 'expired', 'cancelled') THEN now() ELSE NULL END
       WHERE id = $1`,
      [claimId, status],
    );
  }

  async function assignClaim(claimId) {
    await db.getPool().query(
      `UPDATE agent_claims
       SET status = 'claimed', session_id = $2, claimed_at = now(), expires_at = now() + interval '1 hour'
       WHERE id = $1`,
      [claimId, runnerSessionId],
    );
  }

  async function command(claimId, actor, key, body) {
    return request('POST', `/claim-executions/${claimId}/commands`, {
      actor,
      headers: { 'idempotency-key': key },
      body,
    });
  }

  async function commandRows(claimId) {
    return (await db.getPool().query(
      `SELECT id, idempotency_key, request_key, kind, payload, status, result
       FROM agent_claim_commands WHERE claim_id = $1 ORDER BY id`,
      [claimId],
    )).rows;
  }

  beforeAll(async () => {
    process.env.FF_COLLAB_AUTH_SECRET = AUTH_SECRET;
    await resetCollabSchema(process.env.DATABASE_URL);
    await db.runMigrations();

    const ownerUserId = await seedUser(process.env.DATABASE_URL, {
      githubId: 9911,
      login: 'claim-route-owner',
    });
    await seedOrgMembership(process.env.DATABASE_URL, ownerUserId, orgId, 'admin');
    const ownerPrincipal = await db.ensureGithubPrincipal({
      userId: ownerUserId,
      displayName: 'Claim Route Owner',
      email: 'claim-route-owner@example.test',
    });
    owner = { id: ownerPrincipal.id, sessionVersion: ownerPrincipal.sessionVersion };
    const workspace = await db.bootstrapCollaborationWorkspace({
      actor: { principalId: owner.id, sessionVersion: owner.sessionVersion },
      orgId,
      name: 'Claim Route Workspace',
      idempotencyKey: 'claim-route-workspace',
    });
    workspaceId = workspace.id;
    const project = await db.createCollabProject({
      actor: { principalId: owner.id, sessionVersion: owner.sessionVersion },
      workspaceId,
      name: 'Claim Route Project',
    });
    projectId = project.id;
    taskId = (await createTask('Primary claim route task')).id;
    await db.getPool().query(
      `INSERT INTO repos (id, org_id, repo_full_name, provider) VALUES ($1, $2, $3, 'github')`,
      [crypto.randomUUID(), orgId, repo],
    );

    const foreignOrgId = 'claim-route-foreign-org';
    const foreignUserId = await seedUser(process.env.DATABASE_URL, {
      githubId: 9912,
      login: 'claim-route-foreign-owner',
    });
    await seedOrgMembership(process.env.DATABASE_URL, foreignUserId, foreignOrgId, 'admin');
    const foreignPrincipal = await db.ensureGithubPrincipal({
      userId: foreignUserId,
      displayName: 'Foreign Claim Owner',
      email: 'foreign-claim-owner@example.test',
    });
    foreignOwner = { id: foreignPrincipal.id, sessionVersion: foreignPrincipal.sessionVersion };
    const foreignWorkspace = await db.bootstrapCollaborationWorkspace({
      actor: { principalId: foreignOwner.id, sessionVersion: foreignOwner.sessionVersion },
      orgId: foreignOrgId,
      name: 'Foreign Claim Workspace',
      idempotencyKey: 'foreign-claim-workspace',
    });
    const foreignProject = await db.createCollabProject({
      actor: { principalId: foreignOwner.id, sessionVersion: foreignOwner.sessionVersion },
      workspaceId: foreignWorkspace.id,
      name: 'Foreign Claim Project',
    });
    foreignTaskId = (await db.createCollabTask({
      actor: { principalId: foreignOwner.id, sessionVersion: foreignOwner.sessionVersion },
      projectId: foreignProject.id,
      title: 'Foreign claim task',
    })).id;

    const app = createApp();
    await new Promise((resolve) => {
      server = app.listen(0, '127.0.0.1', resolve);
    });
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    await db.createAgent({
      id: 'claim-route-runner',
      orgId,
      agentType: 'test',
      transport: 'long_poll',
      repos: [repo],
    });
    runnerToken = (await db.createToken({
      orgId,
      agentId: 'claim-route-runner',
      label: 'claim-route-tests',
    })).plaintext;
    const registered = await runnerRequest('/register', { meta: { source: 'claim-route-tests' } });
    expect(registered.status).toBe(200);
    runnerSessionId = registered.body.session_id;

    reader = (await enrollActor('claim-reader', 'claim-reader@example.test', ['task.read'])).actor;
    internalReader = (await enrollActor(
      'claim-internal-reader',
      'claim-internal-reader@example.test',
      ['task.read', 'internal.read'],
    )).actor;
    steerer = (await enrollActor(
      'claim-steerer',
      'claim-steerer@example.test',
      ['task.read', 'internal.read', 'run.steer'],
    )).actor;
    canceller = (await enrollActor(
      'claim-canceller',
      'claim-canceller@example.test',
      ['task.read', 'internal.read', 'run.cancel'],
    )).actor;
    steerWithoutInternal = (await enrollActor(
      'claim-steer-without-internal',
      'claim-steer-without-internal@example.test',
      ['task.read', 'run.steer'],
    )).actor;
    cancelWithoutInternal = (await enrollActor(
      'claim-cancel-without-internal',
      'claim-cancel-without-internal@example.test',
      ['task.read', 'run.cancel'],
    )).actor;
    controller = (await enrollActor(
      'claim-controller',
      'claim-controller@example.test',
      ['task.read', 'internal.read', 'run.start', 'run.steer', 'run.cancel'],
    )).actor;
    const revocableEnrollment = await enrollActor(
      'claim-revocable',
      'claim-revocable@example.test',
      ['task.read', 'internal.read', 'run.steer'],
    );
    revocable = revocableEnrollment.actor;
    revocableRoleId = revocableEnrollment.roleId;
    const revocableStarterEnrollment = await enrollActor(
      'claim-revocable-starter',
      'claim-revocable-starter@example.test',
      ['task.read', 'run.start'],
    );
    revocableStarter = revocableStarterEnrollment.actor;
    revocableStarterRoleId = revocableStarterEnrollment.roleId;
    const revocableReaderEnrollment = await enrollActor(
      'claim-revocable-reader',
      'claim-revocable-reader@example.test',
      ['task.read', 'internal.read'],
    );
    revocableReader = revocableReaderEnrollment.actor;
    revocableReaderRoleId = revocableReaderEnrollment.roleId;
  }, 30000);

  afterAll(async () => {
    delete process.env.FF_COLLAB_AUTH_SECRET;
    if (server) await new Promise((resolve) => server.close(resolve));
    await db.closePool();
  });

  it('starts, exactly replays, and rejects a changed payload for one start key', async () => {
    const body = {
      expectedVersion: 1,
      repo,
      prNumber: 702,
      branch: 'feature/http-start',
      claimType: 'build',
      instructions: 'Build through ACP.',
    };
    const first = await request('POST', `/tasks/${taskId}/claim-executions`, {
      actor: controller,
      headers: { 'idempotency-key': 'claim-http-start-key' },
      body,
    });
    expect(first.status).toBe(202);
    expect(first.body.data.created).toBe(true);
    expect(first.body.data.claim).toEqual(expect.objectContaining({
      taskId,
      claimType: 'build',
      status: 'pending',
    }));

    const replay = await request('POST', `/tasks/${taskId}/claim-executions`, {
      actor: controller,
      headers: { 'idempotency-key': 'claim-http-start-key' },
      body,
    });
    expect(replay.status).toBe(200);
    expect(replay.body.data).toEqual({ ...first.body.data, created: false });

    const conflict = await request('POST', `/tasks/${taskId}/claim-executions`, {
      actor: controller,
      headers: { 'idempotency-key': 'claim-http-start-key' },
      body: { ...body, instructions: 'Different instructions.' },
    });
    expectGenericError(conflict, 409, 'idempotency_conflict');
  });

  it('requires a bounded idempotency key and a valid discriminated start body', async () => {
    const body = {
      expectedVersion: 1,
      repo,
      claimType: 'spec',
      instructions: 'Valid start.',
    };
    for (const headers of [
      {},
      { 'idempotency-key': 'short' },
      { 'idempotency-key': 'x'.repeat(257) },
    ]) {
      const response = await request('POST', `/tasks/${taskId}/claim-executions`, {
        actor: controller,
        headers,
        body,
      });
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('idempotency_key_required');
    }
    expectGenericError(
      await request('POST', `/tasks/${taskId}/claim-executions`, {
        actor: controller,
        headers: { 'idempotency-key': 'invalid-start-body-key' },
        body: { ...body, claimType: 'other' },
      }),
      400,
      'malformed',
    );
  });

  it('lists and details executions with stable bounded cursors', async () => {
    const task = await createTask('Cursor task');
    const first = await createExecution({ taskId: task.id, idempotencyKey: 'cursor-execution-one' });
    const second = await createExecution({ taskId: task.id, idempotencyKey: 'cursor-execution-two', claimType: 'build' });

    const pageOne = await request('GET', `/tasks/${task.id}/claim-executions?limit=1`, { actor: reader });
    expect(pageOne.status).toBe(200);
    expect(pageOne.body.data).toHaveLength(1);
    expect(pageOne.body.nextCursor).toEqual(expect.any(String));
    expect(pageOne.body.data[0]).toEqual(expect.objectContaining({
      id: first.claimId,
      taskId: task.id,
      claimType: 'spec',
      status: 'pending',
    }));
    expect(pageOne.body.data[0]).not.toHaveProperty('payload');
    expect(pageOne.body.data[0]).not.toHaveProperty('repo');
    expect(pageOne.body.data[0]).not.toHaveProperty('sessionId');

    const pageTwo = await request(
      'GET',
      `/tasks/${task.id}/claim-executions?limit=1&cursor=${encodeURIComponent(pageOne.body.nextCursor)}`,
      { actor: reader },
    );
    expect(pageTwo.status).toBe(200);
    expect(pageTwo.body.data.map((claim) => claim.id)).toEqual([second.claimId]);
    expect(pageTwo.body.nextCursor).toBeNull();

    const safeDetail = await request('GET', `/claim-executions/${first.claimId}`, { actor: reader });
    expect(safeDetail.status).toBe(200);
    expect(safeDetail.body.data).not.toHaveProperty('payload');
    expect(safeDetail.body.data).not.toHaveProperty('repo');
    expect(safeDetail.body.data).not.toHaveProperty('sessionId');

    const fullDetail = await request('GET', `/claim-executions/${first.claimId}`, { actor: internalReader });
    expect(fullDetail.status).toBe(200);
    expect(fullDetail.body.data).toEqual(expect.objectContaining({
      id: first.claimId,
      projectId,
      repo,
      prNumber: 701,
      payload: expect.objectContaining({ instructions: 'Complete the task.' }),
      sessionId: null,
    }));

    expectGenericError(
      await request('GET', `/tasks/${task.id}/claim-executions?limit=101`, { actor: reader }),
      400,
      'malformed',
    );
    expectGenericError(
      await request('GET', `/tasks/${task.id}/claim-executions?cursor=not-a-cursor`, { actor: reader }),
      400,
      'invalid_cursor',
    );
  });

  it('paginates events and requests without exposing saved responses', async () => {
    const execution = await createExecution();
    await db.appendClaimEvents({
      orgId,
      claimId: execution.claimId,
      events: [
        { seq: 1, kind: 'agent_message', payload: { text: 'first event' } },
        { seq: 2, kind: 'tool_activity', payload: { title: 'second event' } },
      ],
    });
    await db.upsertClaimRequest({
      orgId,
      claimId: execution.claimId,
      requestKey: 'permission-page-one',
      kind: 'permission',
      payload: { title: 'Allow write?' },
    });
    await db.upsertClaimRequest({
      orgId,
      claimId: execution.claimId,
      requestKey: 'elicitation-page-two',
      kind: 'elicitation',
      payload: { message: 'Choose a value' },
    });
    await db.getPool().query(
      `UPDATE agent_claim_requests SET response = $3 WHERE org_id = $1 AND claim_id = $2 AND request_key = 'permission-page-one'`,
      [orgId, execution.claimId, JSON.stringify({ private: 'must not be returned' })],
    );

    const eventOne = await request('GET', `/claim-executions/${execution.claimId}/events?limit=1`, {
      actor: internalReader,
    });
    expect(eventOne.status).toBe(200);
    expect(eventOne.body.data).toEqual([
      expect.objectContaining({ seq: 1, kind: 'agent_message', payload: { text: 'first event' } }),
    ]);
    expect(eventOne.body.nextCursor).toEqual(expect.any(String));
    const eventTwo = await request(
      'GET',
      `/claim-executions/${execution.claimId}/events?limit=1&cursor=${encodeURIComponent(eventOne.body.nextCursor)}`,
      { actor: internalReader },
    );
    expect(eventTwo.status).toBe(200);
    expect(eventTwo.body.data.map((event) => event.seq)).toEqual([2]);
    expect(eventTwo.body.nextCursor).toBeNull();

    const requestOne = await request('GET', `/claim-executions/${execution.claimId}/requests?limit=1`, {
      actor: internalReader,
    });
    expect(requestOne.status).toBe(200);
    expect(requestOne.body.data).toHaveLength(1);
    expect(requestOne.body.data[0]).not.toHaveProperty('response');
    expect(JSON.stringify(requestOne.body)).not.toContain('must not be returned');
    expect(requestOne.body.nextCursor).toEqual(expect.any(String));
    const requestTwo = await request(
      'GET',
      `/claim-executions/${execution.claimId}/requests?limit=1&cursor=${encodeURIComponent(requestOne.body.nextCursor)}`,
      { actor: internalReader },
    );
    expect(requestTwo.status).toBe(200);
    expect(requestTwo.body.data).toHaveLength(1);
    expect(requestTwo.body.data[0].requestKey).not.toBe(requestOne.body.data[0].requestKey);
    expect(requestTwo.body.nextCursor).toBeNull();

    expectGenericError(
      await request('GET', `/claim-executions/${execution.claimId}/events?limit=101`, {
        actor: internalReader,
      }),
      400,
      'malformed',
    );
    expectGenericError(
      await request('GET', `/claim-executions/${execution.claimId}/requests?limit=101`, {
        actor: internalReader,
      }),
      400,
      'malformed',
    );
    expectGenericError(
      await request('GET', `/claim-executions/${execution.claimId}/events?cursor=invalid`, {
        actor: internalReader,
      }),
      400,
      'invalid_cursor',
    );
    expectGenericError(
      await request('GET', `/claim-executions/${execution.claimId}/requests?cursor=invalid`, {
        actor: internalReader,
      }),
      400,
      'invalid_cursor',
    );

    expectGenericError(
      await request('GET', `/claim-executions/${execution.claimId}/events`, { actor: reader }),
      403,
      'forbidden',
    );
    expectGenericError(
      await request('GET', `/claim-executions/${execution.claimId}/requests`, { actor: reader }),
      403,
      'forbidden',
    );
  });

  it('enforces a cumulative 16 MiB claim event budget without charging exact retries or partially persisting a rejected batch', async () => {
    const execution = await createExecution();
    await assignClaim(execution.claimId);
    const payloadBudget = 16 * 1024 * 1024;
    const payloadBytes = async (payload) => Number((await db.getPool().query(
      'SELECT octet_length($1::jsonb::text)::int AS bytes',
      [JSON.stringify(payload)],
    )).rows[0].bytes);
    const standardPayload = { text: 'x'.repeat(240 * 1024) };
    const standardPayloadBytes = await payloadBytes(standardPayload);
    let seq = 1;
    let persistedBytes = 0;

    for (let batchIndex = 0; batchIndex < 17; batchIndex += 1) {
      const events = Array.from({ length: 4 }, () => ({
        seq: seq++,
        kind: 'terminal_output',
        payload: standardPayload,
      }));
      const appended = await runnerRequest(`/claims/${execution.claimId}/events`, {
        session_id: runnerSessionId,
        events,
      });
      expect(appended.status).toBe(200);
      expect(appended.body.inserted).toBe(4);
      persistedBytes += standardPayloadBytes * events.length;
      if (batchIndex === 0) {
        const replayed = await runnerRequest(`/claims/${execution.claimId}/events`, {
          session_id: runnerSessionId,
          events,
        });
        expect(replayed.status).toBe(200);
        expect(replayed.body.inserted).toBe(0);
      }
    }

    const emptyPayloadBytes = await payloadBytes({ text: '' });
    const boundaryPayload = {
      text: 'y'.repeat(payloadBudget - persistedBytes - emptyPayloadBytes),
    };
    expect(await payloadBytes(boundaryPayload) + persistedBytes).toBe(payloadBudget);
    const boundaryEvent = { seq: seq++, kind: 'terminal_output', payload: boundaryPayload };
    const boundary = await runnerRequest(`/claims/${execution.claimId}/events`, {
      session_id: runnerSessionId,
      events: [boundaryEvent],
    });
    expect(boundary.status).toBe(200);
    expect(boundary.body.inserted).toBe(1);
    const boundaryReplay = await runnerRequest(`/claims/${execution.claimId}/events`, {
      session_id: runnerSessionId,
      events: [boundaryEvent],
    });
    expect(boundaryReplay.status).toBe(200);
    expect(boundaryReplay.body.inserted).toBe(0);

    const rejected = await runnerRequest(`/claims/${execution.claimId}/events`, {
      session_id: runnerSessionId,
      events: [
        { seq: seq++, kind: 'notice', payload: { text: 'first rejected event' } },
        { seq: seq++, kind: 'notice', payload: { text: 'second rejected event' } },
      ],
    });
    const stored = await db.getPool().query(
      'SELECT count(*)::int AS count, max(seq)::int AS max_seq FROM agent_claim_events WHERE claim_id = $1',
      [execution.claimId],
    );
    const heartbeat = await runnerRequest('/heartbeat', {
      session_id: runnerSessionId,
      claim_id: execution.claimId,
    });
    expect.soft(rejected.status).toBe(413);
    expect.soft(rejected.body).toEqual({ error: 'Payload too large' });
    expect.soft(stored.rows[0]).toEqual({ count: 69, max_seq: 69 });
    expect(heartbeat.status).toBe(200);
    expect(heartbeat.body).toEqual(expect.objectContaining({ ok: true }));
  }, 30000);

  it('caps event and request pages below 1 MiB and continues each cursor without gaps or duplicates', async () => {
    const execution = await createExecution();
    const largeText = 'p'.repeat(240 * 1024);
    await db.appendClaimEvents({
      orgId,
      claimId: execution.claimId,
      events: Array.from({ length: 5 }, (_, index) => ({
        seq: index + 1,
        kind: 'agent_message',
        payload: { text: `${index}:${largeText}` },
      })),
    });
    for (let index = 0; index < 5; index += 1) {
      await db.upsertClaimRequest({
        orgId,
        claimId: execution.claimId,
        requestKey: `large-request-${index}`,
        kind: 'elicitation',
        payload: { message: `${index}:${largeText}` },
      });
      await db.getPool().query(
        `UPDATE agent_claim_requests
         SET response = $3
         WHERE org_id = $1 AND claim_id = $2 AND request_key = $4`,
        [
          orgId,
          execution.claimId,
          JSON.stringify({ private: `${index}:${largeText}` }),
          `large-request-${index}`,
        ],
      );
    }

    const readAll = async (suffix, identity) => {
      const identities = [];
      let cursor = null;
      let pageCount = 0;
      do {
        const query = cursor === null ? '?limit=100' : `?limit=100&cursor=${encodeURIComponent(cursor)}`;
        const page = await request('GET', `/claim-executions/${execution.claimId}/${suffix}${query}`, {
          actor: internalReader,
        });
        expect(page.status).toBe(200);
        expect.soft(Buffer.byteLength(JSON.stringify(page.body.data))).toBeLessThanOrEqual(1024 * 1024);
        identities.push(...page.body.data.map(identity));
        expect(JSON.stringify(page.body)).not.toContain('"response"');
        expect(JSON.stringify(page.body)).not.toContain('"private"');
        cursor = page.body.nextCursor;
        pageCount += 1;
      } while (cursor !== null);
      return { identities, pageCount };
    };

    const events = await readAll('events', (event) => event.seq);
    const requests = await readAll('requests', (pendingRequest) => pendingRequest.requestKey);
    expect.soft(events.pageCount).toBeGreaterThan(1);
    expect(events.identities).toEqual([1, 2, 3, 4, 5]);
    expect(new Set(events.identities).size).toBe(5);
    expect.soft(requests.pageCount).toBeGreaterThan(1);
    expect(requests.identities).toEqual([
      'large-request-0',
      'large-request-1',
      'large-request-2',
      'large-request-3',
      'large-request-4',
    ]);
    expect(new Set(requests.identities).size).toBe(5);
  }, 30000);

  it.each([
    ['execution timestamp', (execution) => `/tasks/${execution.taskId}/claim-executions?cursor=${encodedCursor({ t: 'not-a-timestamp', c: 1 })}`],
    ['noncanonical execution timestamp', (execution) => `/tasks/${execution.taskId}/claim-executions?cursor=${encodedCursor({ t: '2026-01-01T00:00:00Z', c: 1 })}`],
    ['execution claim integer overflow', (execution) => `/tasks/${execution.taskId}/claim-executions?cursor=${encodedCursor({ t: '2026-01-01T00:00:00.000000Z', c: 2_147_483_648 })}`],
    ['event sequence integer overflow', (execution) => `/claim-executions/${execution.claimId}/events?cursor=${encodedCursor({ s: 2_147_483_648 })}`],
    ['request timestamp', (execution) => `/claim-executions/${execution.claimId}/requests?cursor=${encodedCursor({ t: '2026-01-01T00:00:00+00:00', k: 'request-key' })}`],
  ])('rejects a valid Base64 JSON cursor with malformed %s', async (_label, pathFor) => {
    const execution = await createExecution();
    const response = await request('GET', pathFor(execution), { actor: internalReader });
    expectGenericError(response, 400, 'invalid_cursor');
  });

  it('enforces the per-kind capability combinations', async () => {
    const startBody = {
      expectedVersion: 1,
      repo,
      claimType: 'spec',
      instructions: 'Denied start.',
    };
    expectGenericError(
      await request('POST', `/tasks/${taskId}/claim-executions`, {
        actor: reader,
        headers: { 'idempotency-key': 'reader-cannot-start' },
        body: startBody,
      }),
      403,
      'forbidden',
    );

    const execution = await createExecution();
    await setClaimStatus(execution.claimId, 'claimed');
    await db.upsertClaimRequest({
      orgId,
      claimId: execution.claimId,
      requestKey: 'capability-permission-request',
      kind: 'permission',
      payload: { title: 'Capability check' },
    });
    expectGenericError(
      await command(execution.claimId, internalReader, 'internal-cannot-prompt', {
        kind: 'prompt',
        payload: { text: 'Missing run.steer.' },
      }),
      403,
      'forbidden',
    );
    expectGenericError(
      await command(execution.claimId, steerWithoutInternal, 'steer-without-internal', {
        kind: 'prompt',
        payload: { text: 'Missing internal.read.' },
      }),
      403,
      'forbidden',
    );
    expectGenericError(
      await command(execution.claimId, steerer, 'steerer-cannot-cancel', {
        kind: 'cancel',
        payload: {},
      }),
      403,
      'forbidden',
    );
    expectGenericError(
      await command(execution.claimId, cancelWithoutInternal, 'cancel-without-internal', {
        kind: 'cancel',
        payload: {},
      }),
      403,
      'forbidden',
    );
    expectGenericError(
      await command(execution.claimId, canceller, 'canceller-cannot-answer', {
        kind: 'permission',
        requestKey: 'capability-permission-request',
        payload: { answer: { outcome: 'cancelled' } },
      }),
      403,
      'forbidden',
    );
    expect(await commandRows(execution.claimId)).toEqual([]);
    expect((await db.getPool().query(
      'SELECT status FROM agent_claim_requests WHERE claim_id = $1 AND request_key = $2',
      [execution.claimId, 'capability-permission-request'],
    )).rows[0].status).toBe('open');
  });

  it('enqueues claimed prompt and cancel commands idempotently with safe responses', async () => {
    const prompted = await createExecution();
    await setClaimStatus(prompted.claimId, 'claimed');
    const promptBody = { kind: 'prompt', payload: { text: 'Continue with the accepted plan.' } };
    const firstPrompt = await command(prompted.claimId, steerer, 'prompt-command-key', promptBody);
    expect(firstPrompt.status).toBe(202);
    expect(firstPrompt.body.data).toEqual(expect.objectContaining({
      kind: 'prompt',
      status: 'pending',
      created: true,
    }));
    expect(firstPrompt.body.data).not.toHaveProperty('result');
    const promptReplay = await command(prompted.claimId, steerer, 'prompt-command-key', promptBody);
    expect(promptReplay.status).toBe(200);
    expect(promptReplay.body.data).toEqual({ ...firstPrompt.body.data, created: false });
    expect(await commandRows(prompted.claimId)).toEqual([
      expect.objectContaining({
        idempotency_key: 'prompt-command-key',
        kind: 'prompt',
        payload: { text: 'Continue with the accepted plan.' },
        status: 'pending',
      }),
    ]);

    const cancelled = await createExecution();
    await setClaimStatus(cancelled.claimId, 'claimed');
    const firstCancel = await command(
      cancelled.claimId,
      canceller,
      'claimed-cancel-key',
      { kind: 'cancel', payload: {} },
    );
    expect(firstCancel.status).toBe(202);
    expect(firstCancel.body.data).toEqual(expect.objectContaining({
      kind: 'cancel',
      status: 'pending',
      created: true,
    }));
    const cancelReplay = await command(
      cancelled.claimId,
      canceller,
      'claimed-cancel-key',
      { kind: 'cancel', payload: {} },
    );
    expect(cancelReplay.status).toBe(200);
    expect(await commandRows(cancelled.claimId)).toHaveLength(1);
  });

  it('atomically cancels a pending claim and its open interactions without a runner command', async () => {
    const execution = await createExecution();
    await db.upsertClaimRequest({
      orgId,
      claimId: execution.claimId,
      requestKey: 'pending-cancel-request',
      kind: 'permission',
      payload: { title: 'Open request' },
    });
    const first = await command(
      execution.claimId,
      canceller,
      'pending-cancel-key',
      { kind: 'cancel', payload: {} },
    );
    expect(first.status).toBe(202);
    expect(first.body.data).toEqual(expect.objectContaining({ created: true, kind: 'cancel' }));
    const replay = await command(
      execution.claimId,
      canceller,
      'pending-cancel-key',
      { kind: 'cancel', payload: {} },
    );
    expect(replay.status).toBe(200);
    expect(replay.body.data).toEqual({ ...first.body.data, created: false });

    const claim = (await db.getPool().query(
      'SELECT status, completed_at FROM agent_claims WHERE id = $1',
      [execution.claimId],
    )).rows[0];
    const interaction = (await db.getPool().query(
      'SELECT status, resolved_at FROM agent_claim_requests WHERE claim_id = $1',
      [execution.claimId],
    )).rows[0];
    expect(claim.status).toBe('cancelled');
    expect(claim.completed_at).toBeInstanceOf(Date);
    expect(interaction.status).toBe('cancelled');
    expect(interaction.resolved_at).toBeInstanceOf(Date);
    expect(await commandRows(execution.claimId)).toEqual([]);
  });

  it('rolls back a pending cancellation when interaction cancellation fails', async () => {
    const execution = await createExecution();
    await db.upsertClaimRequest({
      orgId,
      claimId: execution.claimId,
      requestKey: 'pending-cancel-rollback-request',
      kind: 'permission',
      payload: { title: 'Remain open after rollback' },
    });
    await db.getPool().query(`
      CREATE FUNCTION fail_pending_interaction_cancel() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.status = 'cancelled' THEN
          RAISE EXCEPTION 'private pending cancellation failure';
        END IF;
        RETURN NEW;
      END;
      $$
    `);
    await db.getPool().query(`
      CREATE TRIGGER fail_pending_interaction_cancel
      BEFORE UPDATE ON agent_claim_requests
      FOR EACH ROW EXECUTE FUNCTION fail_pending_interaction_cancel()
    `);
    try {
      const response = await command(
        execution.claimId,
        canceller,
        'pending-cancel-rollback-key',
        { kind: 'cancel', payload: {} },
      );
      expectGenericError(response, 500, 'internal_error');
      expect((await db.getPool().query(
        'SELECT status, completed_at FROM agent_claims WHERE id = $1',
        [execution.claimId],
      )).rows[0]).toEqual(expect.objectContaining({ status: 'pending', completed_at: null }));
      expect((await db.getPool().query(
        'SELECT status, resolved_at FROM agent_claim_requests WHERE claim_id = $1',
        [execution.claimId],
      )).rows[0]).toEqual(expect.objectContaining({ status: 'open', resolved_at: null }));
      expect(await commandRows(execution.claimId)).toEqual([]);
    } finally {
      await db.getPool().query(
        'DROP TRIGGER fail_pending_interaction_cancel ON agent_claim_requests',
      );
      await db.getPool().query('DROP FUNCTION fail_pending_interaction_cancel()');
    }
  });

  it('rejects prompt and answers while pending and rejects every command in terminal states', async () => {
    const pending = await createExecution();
    await db.upsertClaimRequest({
      orgId,
      claimId: pending.claimId,
      requestKey: 'pending-permission',
      kind: 'permission',
      payload: { title: 'Still pending' },
    });
    expectGenericError(
      await command(pending.claimId, steerer, 'pending-prompt-key', {
        kind: 'prompt',
        payload: { text: 'Too early.' },
      }),
      409,
      'claim_not_active',
    );
    expectGenericError(
      await command(pending.claimId, steerer, 'pending-answer-key', {
        kind: 'permission',
        requestKey: 'pending-permission',
        payload: { answer: { outcome: 'cancelled' } },
      }),
      409,
      'claim_not_active',
    );

    for (const status of ['completed', 'failed', 'expired', 'cancelled']) {
      const terminal = await createExecution();
      await setClaimStatus(terminal.claimId, status);
      const actor = status === 'cancelled' ? canceller : steerer;
      const body = status === 'cancelled'
        ? { kind: 'cancel', payload: {} }
        : { kind: 'prompt', payload: { text: 'Cannot run.' } };
      expectGenericError(
        await command(terminal.claimId, actor, `terminal-${status}-key`, body),
        409,
        'claim_not_active',
      );
      expect(await commandRows(terminal.claimId)).toEqual([]);
    }
  });

  it('reserves permission and elicitation answers atomically and replays after acknowledgement', async () => {
    const execution = await createExecution();
    await setClaimStatus(execution.claimId, 'claimed');
    await db.upsertClaimRequest({
      orgId,
      claimId: execution.claimId,
      requestKey: 'permission-answer-request',
      kind: 'permission',
      payload: { title: 'Allow write?', options: [{ optionId: 'allow' }] },
    });
    await db.upsertClaimRequest({
      orgId,
      claimId: execution.claimId,
      requestKey: 'elicitation-answer-request',
      kind: 'elicitation',
      payload: { message: 'Provide a value' },
    });

    const permissionBody = {
      kind: 'permission',
      requestKey: 'permission-answer-request',
      payload: { answer: { outcome: 'selected', optionId: 'allow' } },
    };
    const permission = await command(
      execution.claimId,
      steerer,
      'permission-answer-key',
      permissionBody,
    );
    expect(permission.status).toBe(202);
    const permissionState = (await db.getPool().query(
      `SELECT request.status, request.response, command.kind, command.payload, command.status AS command_status
       FROM agent_claim_requests request
       JOIN agent_claim_commands command
         ON command.claim_id = request.claim_id AND command.request_key = request.request_key
       WHERE request.claim_id = $1 AND request.request_key = $2`,
      [execution.claimId, 'permission-answer-request'],
    )).rows[0];
    expect(permissionState).toEqual(expect.objectContaining({
      status: 'answer_queued',
      response: null,
      kind: 'permission',
      payload: { answer: { outcome: 'selected', optionId: 'allow' } },
      command_status: 'pending',
    }));

    const elicitation = await command(
      execution.claimId,
      steerer,
      'elicitation-answer-key',
      {
        kind: 'elicitation',
        requestKey: 'elicitation-answer-request',
        payload: { answer: { action: 'accept', content: { value: 'synthetic' } } },
      },
    );
    expect(elicitation.status).toBe(202);
    expect((await db.getPool().query(
      'SELECT status, response FROM agent_claim_requests WHERE claim_id = $1 AND request_key = $2',
      [execution.claimId, 'elicitation-answer-request'],
    )).rows[0]).toEqual(expect.objectContaining({ status: 'answer_queued', response: null }));

    const leased = await db.leaseClaimCommands({ orgId, claimId: execution.claimId, limit: 10 });
    const leasedPermission = leased.find((item) => item.requestKey === 'permission-answer-request');
    await db.ackClaimCommand({
      orgId,
      claimId: execution.claimId,
      commandId: leasedPermission.id,
      status: 'acked',
      result: { applied: true },
    });
    const postAckReplay = await command(
      execution.claimId,
      steerer,
      'permission-answer-key',
      permissionBody,
    );
    expect(postAckReplay.status).toBe(200);
    expect(postAckReplay.body.data).toEqual(expect.objectContaining({ created: false, status: 'acked' }));
    expect(postAckReplay.body.data).not.toHaveProperty('result');
    expect((await commandRows(execution.claimId)).filter(
      (row) => row.idempotency_key === 'permission-answer-key',
    )).toHaveLength(1);
  });

  it('linearizes concurrent answers and rejects a different answer or stale request', async () => {
    const execution = await createExecution();
    await setClaimStatus(execution.claimId, 'claimed');
    await db.upsertClaimRequest({
      orgId,
      claimId: execution.claimId,
      requestKey: 'concurrent-permission',
      kind: 'permission',
      payload: { title: 'Choose once' },
    });
    const attempts = await Promise.all([
      command(execution.claimId, steerer, 'concurrent-answer-one', {
        kind: 'permission',
        requestKey: 'concurrent-permission',
        payload: { answer: { outcome: 'selected', optionId: 'allow' } },
      }),
      command(execution.claimId, steerer, 'concurrent-answer-two', {
        kind: 'permission',
        requestKey: 'concurrent-permission',
        payload: { answer: { outcome: 'cancelled' } },
      }),
    ]);
    expect(attempts.map((item) => item.status).sort()).toEqual([202, 409]);
    expect((await commandRows(execution.claimId)).filter(
      (row) => row.request_key === 'concurrent-permission',
    )).toHaveLength(1);

    expectGenericError(
      await command(execution.claimId, steerer, 'different-answer-key', {
        kind: 'permission',
        requestKey: 'concurrent-permission',
        payload: { answer: { outcome: 'selected', optionId: 'different' } },
      }),
      409,
      'request_conflict',
    );
    expectGenericError(
      await command(execution.claimId, steerer, 'stale-answer-key', {
        kind: 'elicitation',
        requestKey: 'missing-request',
        payload: { answer: { action: 'decline' } },
      }),
      409,
      'request_conflict',
    );
  });

  it('denies detail, event, and request reads replayed after their capabilities are revoked', async () => {
    const execution = await createExecution();
    await db.appendClaimEvents({
      orgId,
      claimId: execution.claimId,
      events: [{ seq: 1, kind: 'agent_message', payload: { text: 'revocation event' } }],
    });
    await db.upsertClaimRequest({
      orgId,
      claimId: execution.claimId,
      requestKey: 'revocation-request',
      kind: 'permission',
      payload: { title: 'Revocation request' },
    });
    const paths = [
      `/claim-executions/${execution.claimId}`,
      `/claim-executions/${execution.claimId}/events`,
      `/claim-executions/${execution.claimId}/requests`,
    ];
    for (const path of paths) {
      expect((await request('GET', path, { actor: revocableReader })).status).toBe(200);
    }
    await db.getPool().query(
      'UPDATE collab_roles SET capabilities = ARRAY[]::text[] WHERE id = $1',
      [revocableReaderRoleId],
    );
    for (const path of paths) {
      expectGenericError(
        await request('GET', path, { actor: revocableReader }),
        404,
        'not_found',
      );
    }
  });

  it('authorizes every replay before returning command data', async () => {
    const execution = await createExecution();
    await setClaimStatus(execution.claimId, 'claimed');
    const body = { kind: 'prompt', payload: { text: 'Authorized once.' } };
    expect((await command(execution.claimId, revocable, 'revoked-replay-key', body)).status).toBe(202);
    await db.getPool().query(
      `UPDATE collab_roles SET capabilities = ARRAY['task.read']::text[] WHERE id = $1`,
      [revocableRoleId],
    );
    const denied = await command(execution.claimId, revocable, 'revoked-replay-key', body);
    expectGenericError(denied, 403, 'forbidden');
    expect(JSON.stringify(denied.body)).not.toContain('revoked-replay-key');
  });

  it('authorizes a start replay after the original start succeeded', async () => {
    const task = await createTask('Revoked start replay task');
    const body = {
      expectedVersion: 1,
      repo,
      prNumber: 703,
      branch: 'feature/revoked-start',
      claimType: 'spec',
      instructions: 'Start once.',
    };
    const first = await request('POST', `/tasks/${task.id}/claim-executions`, {
      actor: revocableStarter,
      headers: { 'idempotency-key': 'revoked-start-replay-key' },
      body,
    });
    expect(first.status).toBe(202);
    await db.getPool().query(
      `UPDATE collab_roles SET capabilities = ARRAY['task.read']::text[] WHERE id = $1`,
      [revocableStarterRoleId],
    );
    const denied = await request('POST', `/tasks/${task.id}/claim-executions`, {
      actor: revocableStarter,
      headers: { 'idempotency-key': 'revoked-start-replay-key' },
      body,
    });
    expectGenericError(denied, 403, 'forbidden');
  });

  it('maps idempotency kind and body conflicts to generic 409 responses', async () => {
    const execution = await createExecution();
    await setClaimStatus(execution.claimId, 'claimed');
    expect((await command(execution.claimId, controller, 'command-conflict-key', {
      kind: 'prompt',
      payload: { text: 'Original prompt.' },
    })).status).toBe(202);

    const bodyConflict = await command(execution.claimId, controller, 'command-conflict-key', {
      kind: 'prompt',
      payload: { text: 'Changed prompt.' },
    });
    expectGenericError(bodyConflict, 409, 'idempotency_conflict');
    const kindConflict = await command(execution.claimId, controller, 'command-conflict-key', {
      kind: 'cancel',
      payload: {},
    });
    expectGenericError(kindConflict, 409, 'idempotency_conflict');
    expect(await commandRows(execution.claimId)).toHaveLength(1);
  });

  it('enforces strict command bodies, key lengths, prompt length, request-key length, and payload bytes', async () => {
    const execution = await createExecution();
    await setClaimStatus(execution.claimId, 'claimed');
    const cases = [
      [{}, { kind: 'prompt', payload: { text: 'Valid.' } }],
      [{ 'idempotency-key': 'short' }, { kind: 'prompt', payload: { text: 'Valid.' } }],
      [{ 'idempotency-key': 'x'.repeat(257) }, { kind: 'prompt', payload: { text: 'Valid.' } }],
      [{ 'idempotency-key': 'empty-prompt-key' }, { kind: 'prompt', payload: { text: '' } }],
      [{ 'idempotency-key': 'long-prompt-key' }, { kind: 'prompt', payload: { text: 'x'.repeat(20001) } }],
      [{ 'idempotency-key': 'long-request-key' }, {
        kind: 'permission',
        requestKey: 'r'.repeat(513),
        payload: { answer: { outcome: 'cancelled' } },
      }],
      [{ 'idempotency-key': 'wrong-prompt-payload' }, { kind: 'prompt', payload: { answer: 'wrong' } }],
      [{ 'idempotency-key': 'wrong-cancel-payload' }, { kind: 'cancel', payload: { reason: 'extra' } }],
      [{ 'idempotency-key': 'extra-command-field' }, {
        kind: 'prompt',
        payload: { text: 'Valid.' },
        extra: true,
      }],
    ];
    for (const [headers, body] of cases) {
      const response = await request('POST', `/claim-executions/${execution.claimId}/commands`, {
        actor: controller,
        headers,
        body,
      });
      expect(response.status).toBe(400);
      expect(response.body.error.code).toMatch(/malformed|idempotency_key_required/);
    }

    await db.upsertClaimRequest({
      orgId,
      claimId: execution.claimId,
      requestKey: 'oversized-elicitation-request',
      kind: 'elicitation',
      payload: { message: 'Large answer' },
    });
    const oversized = await command(execution.claimId, steerer, 'oversized-payload-key', {
      kind: 'elicitation',
      requestKey: 'oversized-elicitation-request',
      payload: {
        answer: {
          action: 'accept',
          content: { value: 'x'.repeat(256 * 1024) },
        },
      },
    });
    expectGenericError(oversized, 413, 'payload_too_large');
    expect(await commandRows(execution.claimId)).toEqual([]);
  });

  it('returns only generic internal errors and rolls back request reservation with command creation', async () => {
    const execution = await createExecution();
    await setClaimStatus(execution.claimId, 'claimed');
    await db.upsertClaimRequest({
      orgId,
      claimId: execution.claimId,
      requestKey: 'rollback-permission-request',
      kind: 'permission',
      payload: { title: 'Must remain open' },
    });
    await db.getPool().query(`
      CREATE FUNCTION fail_claim_route_command() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'private SQL failure agent_claim_commands claim-route-org /home/private';
      END;
      $$
    `);
    await db.getPool().query(`
      CREATE TRIGGER fail_claim_route_command
      BEFORE INSERT ON agent_claim_commands
      FOR EACH ROW EXECUTE FUNCTION fail_claim_route_command()
    `);
    try {
      const response = await command(execution.claimId, steerer, 'generic-error-key', {
        kind: 'permission',
        requestKey: 'rollback-permission-request',
        payload: { answer: { outcome: 'cancelled' } },
      });
      expectGenericError(response, 500, 'internal_error');
      expect(await commandRows(execution.claimId)).toEqual([]);
      expect((await db.getPool().query(
        'SELECT status, response FROM agent_claim_requests WHERE claim_id = $1 AND request_key = $2',
        [execution.claimId, 'rollback-permission-request'],
      )).rows[0]).toEqual(expect.objectContaining({ status: 'open', response: null }));
    } finally {
      await db.getPool().query('DROP TRIGGER fail_claim_route_command ON agent_claim_commands');
      await db.getPool().query('DROP FUNCTION fail_claim_route_command()');
    }
  });

  it('hides foreign, unlinked, and noninteger claims across all claim endpoints', async () => {
    await db.getPool().query(
      `INSERT INTO repos (id, org_id, repo_full_name, provider) VALUES ($1, $2, $3, 'github')`,
      [crypto.randomUUID(), 'claim-route-foreign-org', 'foreign/claim-route-tests'],
    );
    const foreign = await db.startCollabClaimExecution({
      actor: { principalId: foreignOwner.id, sessionVersion: foreignOwner.sessionVersion },
      taskId: foreignTaskId,
      expectedVersion: 1,
      idempotencyKey: 'foreign-execution-key',
      repo: 'foreign/claim-route-tests',
      prNumber: 99,
      claimType: 'spec',
    });
    const unlinked = await db.insertPendingClaim({
      orgId,
      repo,
      prNumber: 990,
      claimType: 'spec',
      payload: { source: 'unlinked' },
    });
    const paths = [
      `/claim-executions/${foreign.claim.id}`,
      `/claim-executions/${foreign.claim.id}/events`,
      `/claim-executions/${foreign.claim.id}/requests`,
      `/claim-executions/${unlinked.id}`,
      `/claim-executions/${unlinked.id}/events`,
      `/claim-executions/${unlinked.id}/requests`,
      '/claim-executions/not-an-integer',
      '/claim-executions/not-an-integer/events',
      '/claim-executions/not-an-integer/requests',
    ];
    for (const path of paths) {
      expectGenericError(await request('GET', path, { actor: controller }), 404, 'not_found');
    }
    for (const claimId of [foreign.claim.id, unlinked.id, 'not-an-integer']) {
      expectGenericError(
        await command(claimId, controller, `isolated-command-${claimId}`, {
          kind: 'prompt',
          payload: { text: 'Must stay hidden.' },
        }),
        404,
        'not_found',
      );
    }
    expectGenericError(
      await request('GET', `/tasks/${foreignTaskId}/claim-executions`, { actor: controller }),
      404,
      'not_found',
    );
  });
});
