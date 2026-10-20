import { beforeAll, beforeEach, expect, it } from 'vitest';
import { db, schema } from '@fluent-flow/db';
import { sql } from 'drizzle-orm';
import { integrationDescribe, resetDb } from '../helpers/integration-db.js';
import { claimPendingWork } from '../../src/routes/runner.js';

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
});
