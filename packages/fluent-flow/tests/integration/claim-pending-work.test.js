import { beforeAll, beforeEach, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import { db, enqueueClaimCommand, schema, upsertClaimRequest } from '@fluent-flow/db';
import { sql } from 'drizzle-orm';
import { integrationDescribe, resetDb } from '../helpers/integration-db.js';
import { claimPendingWork, handlePoll, releaseUndeliveredClaim } from '../../src/routes/runner.js';
import { completeClaim } from '../../src/agents/claim-manager.js';

/**
 * Integration coverage for the `FOR UPDATE SKIP LOCKED` atomic claim path in
 * runner.js. Requires a live Postgres (TEST_DATABASE_URL). The runner's polling
 * concurrency is critical — two sessions polling simultaneously must never
 * both win the same pending claim, and repo-scoped agents must skip claims
 * outside their scope.
 */
const describeDb = await integrationDescribe();

describeDb('claimPendingWork (integration)', () => {
  const ORG = 'ff-test-org';
  const AGENT_A = 'agent-a'; // scoped to ff-test-org/repo-a
  const AGENT_B = 'agent-b'; // unscoped (matches any repo)

  async function seed({ repos = ['ff-test-org/repo-a'] } = {}) {
    await db.insert(schema.orgs).values({ id: ORG, name: 'Test Org' });
    await db.insert(schema.agents).values([
      { id: AGENT_A, orgId: ORG, agentType: 'test', transport: 'webhook', repos },
      { id: AGENT_B, orgId: ORG, agentType: 'test', transport: 'webhook', repos: [] },
    ]);
  }

  async function makeSession(agentId) {
    const [row] = await db
      .insert(schema.agentSessions)
      .values({
        orgId: ORG,
        agentId,
        status: 'online',
        expiresAt: sql`NOW() + INTERVAL '1 hour'`,
      })
      .returning({ id: schema.agentSessions.id });
    return row.id;
  }

  async function makePendingClaim(repo, prNumber) {
    const [row] = await db
      .insert(schema.agentClaims)
      .values({
        orgId: ORG,
        repo,
        prNumber,
        attempt: 1,
        status: 'pending',
        sessionId: null,
      })
      .returning({ id: schema.agentClaims.id });
    return row.id;
  }

  function makeResponse() {
    const response = new EventEmitter();
    return Object.assign(response, {
      body: null,
      destroyed: false,
      headersSent: false,
      statusCode: 200,
      writableFinished: false,
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(body) {
        this.body = body;
        this.headersSent = true;
        this.writableFinished = true;
        return this;
      },
    });
  }

  beforeAll(async () => {
    await resetDb(db);
  });

  beforeEach(async () => {
    await resetDb(db);
  });

  it('only one concurrent session wins a single pending claim', async () => {
    await seed();
    const sessionA = await makeSession(AGENT_A);
    const sessionB = await makeSession(AGENT_A);
    const claimId = await makePendingClaim('ff-test-org/repo-a', 101);

    // Fire both claim attempts in parallel — SKIP LOCKED must serialize them.
    const [resA, resB] = await Promise.all([
      claimPendingWork(ORG, AGENT_A, sessionA),
      claimPendingWork(ORG, AGENT_A, sessionB),
    ]);

    const winners = [resA, resB].filter(Boolean);
    expect(winners).toHaveLength(1);
    expect(winners[0].id).toBe(claimId);
    // The winning session must be one of the two; the other got null.
    expect([sessionA, sessionB]).toContain(winners[0].session_id);
    expect([resA,resB].filter(result=>result===null)).toHaveLength(1);
    const stored=await db.execute(sql`SELECT status,session_id FROM agent_claims WHERE id=${claimId}`);
    expect(stored.rows[0]).toMatchObject({status:'claimed',session_id:winners[0].session_id});
  });

  it('allows only an online unexpired session to claim work', async () => {
    await seed();
    const busy = await makeSession(AGENT_A);
    const offline = await makeSession(AGENT_A);
    const expired = await makeSession(AGENT_A);
    const active = await makeSession(AGENT_A);
    const claimId = await makePendingClaim('ff-test-org/repo-a', 151);
    await db.execute(sql`UPDATE agent_sessions SET status = 'busy' WHERE id = ${busy}`);
    await db.execute(sql`UPDATE agent_sessions SET status = 'offline' WHERE id = ${offline}`);
    await db.execute(sql`UPDATE agent_sessions SET expires_at = NOW() - INTERVAL '1 second' WHERE id = ${expired}`);

    await expect(claimPendingWork(ORG, AGENT_A, busy)).resolves.toBeNull();
    await expect(claimPendingWork(ORG, AGENT_A, offline)).resolves.toBeNull();
    await expect(claimPendingWork(ORG, AGENT_A, expired)).resolves.toBeNull();
    await expect(claimPendingWork(ORG, AGENT_A, active)).resolves.toMatchObject({ id: claimId, session_id: active });
    const stored = await db.execute(sql`SELECT status, session_id FROM agent_claims WHERE id = ${claimId}`);
    expect(stored.rows[0]).toMatchObject({ status: 'claimed', session_id: active });
  });

  it('returns an undelivered assignment to the pending queue', async () => {
    await seed();
    const session = await makeSession(AGENT_A);
    const claimId = await makePendingClaim('ff-test-org/repo-a', 152);
    await expect(claimPendingWork(ORG, AGENT_A, session)).resolves.toMatchObject({ id: claimId });
    await expect(releaseUndeliveredClaim(ORG, AGENT_A, session, claimId)).resolves.toBe(true);
    const stored = await db.execute(sql`SELECT status, session_id, claimed_at, expires_at FROM agent_claims WHERE id = ${claimId}`);
    expect(stored.rows[0]).toEqual({ status: 'pending', session_id: null, claimed_at: null, expires_at: null });
    const sessionState = await db.execute(sql`SELECT status FROM agent_sessions WHERE id = ${session}`);
    expect(sessionState.rows[0]).toEqual({ status: 'online' });
  });

  it('does not revive an expired session while releasing its undelivered claim', async () => {
    await seed();
    const session = await makeSession(AGENT_A);
    const claimId = await makePendingClaim('ff-test-org/repo-a', 153);
    await claimPendingWork(ORG, AGENT_A, session);
    await db.execute(sql`UPDATE agent_sessions SET expires_at = NOW() - INTERVAL '1 second' WHERE id = ${session}`);

    await expect(releaseUndeliveredClaim(ORG, AGENT_A, session, claimId)).resolves.toBe(false);
    const stored = await db.execute(sql`SELECT status, session_id FROM agent_claims WHERE id = ${claimId}`);
    expect(stored.rows[0]).toEqual({ status: 'pending', session_id: null });
    const sessionState = await db.execute(sql`SELECT status FROM agent_sessions WHERE id = ${session}`);
    expect(sessionState.rows[0]).toEqual({ status: 'busy' });
  });

  it('closes open interactions when repo-keyed completion makes a claim terminal', async () => {
    await seed();
    const session = await makeSession(AGENT_A);
    const claimId = await makePendingClaim('ff-test-org/repo-a', 154);
    await claimPendingWork(ORG, AGENT_A, session);
    await upsertClaimRequest({
      orgId: ORG,
      claimId,
      requestKey: 'terminal-request',
      kind: 'permission',
      payload: { action: 'write' },
    });
    const command = await enqueueClaimCommand({
      orgId: ORG,
      claimId,
      idempotencyKey: 'terminal-command',
      kind: 'cancel',
      payload: {},
    });

    await completeClaim(ORG, 'ff-test-org/repo-a', 154, 1);
    const requestState = await db.execute(sql`SELECT status FROM agent_claim_requests WHERE org_id = ${ORG} AND claim_id = ${claimId}`);
    expect(requestState.rows).toEqual([{ status: 'cancelled' }]);
    const commandState = await db.execute(sql`SELECT status FROM agent_claim_commands WHERE id = ${command.command.id}`);
    expect(commandState.rows).toEqual([{ status: 'cancelled' }]);
  });

  it('repo-scoped agent skips claims outside its repos[]', async () => {
    await seed({ repos: ['ff-test-org/repo-a'] });
    const sessionA = await makeSession(AGENT_A);
    // Claim is for a different repo — scoped agent should not pick it up.
    await makePendingClaim('ff-test-org/repo-b', 202);

    const res = await claimPendingWork(ORG, AGENT_A, sessionA);
    expect(res).toBeNull();
  });

  it('unscoped agent (repos=[]) claims any repo', async () => {
    await seed({ repos: ['ff-test-org/repo-a'] });
    const sessionB = await makeSession(AGENT_B);
    const claimId = await makePendingClaim('ff-test-org/repo-b', 303);

    const res = await claimPendingWork(ORG, AGENT_B, sessionB);
    expect(res).not.toBeNull();
    expect(res.id).toBe(claimId);
    expect(res.status).toBe('claimed');
  });

  it('returns a claim to pending when its payload cannot be delivered', async () => {
    await seed();
    const session = await makeSession(AGENT_A);
    const claimId = await makePendingClaim('ff-test-org/repo-a', 304);
    await db.execute(sql`UPDATE agent_claims SET payload = to_jsonb(${'{'}::text) WHERE id = ${claimId}`);
    const response = makeResponse();

    await handlePoll(
      { body: { session_id: session }, tokenInfo: { org_id: ORG, agent_id: AGENT_A } },
      response,
      { pollTimeoutMs: 0 },
    );

    expect(response.statusCode).toBe(500);
    const stored = await db.execute(sql`SELECT status, session_id FROM agent_claims WHERE id = ${claimId}`);
    expect(stored.rows[0]).toEqual({ status: 'pending', session_id: null });
    const sessionState = await db.execute(sql`SELECT status FROM agent_sessions WHERE id = ${session}`);
    expect(sessionState.rows[0]).toEqual({ status: 'online' });
  });
});
