import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { runMigrations } from '../src/migrate.js';
import { db } from '../src/client.js';
import * as schema from '../src/schema/index.js';
import {
  insertVerificationResult,
  getVerificationResultByClaim,
  getVerificationResultsForPR,
} from '../src/queries/verification.js';

const hasDatabaseUrl = !!process.env.DATABASE_URL;

describe.skipIf(!hasDatabaseUrl)('verification results queries', () => {
  let testOrgId;
  let testClaimId1;
  let testClaimId2;

  beforeAll(async () => {
    if (hasDatabaseUrl) {
      await runMigrations();
    }
  });

  beforeEach(() => {
    testOrgId = `test-org-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  });

  afterEach(async () => {
    if (!hasDatabaseUrl) return;

    // Clean up in FK-safe order: verification_results → agent_claims → orgs
    await db.delete(schema.verificationResults).where(eq(schema.verificationResults.orgId, testOrgId));
    await db.execute(`DELETE FROM agent_claims WHERE org_id = '${testOrgId}'`);
    await db.execute(`DELETE FROM orgs WHERE id = '${testOrgId}'`);
  });

  it('insert and fetch roundtrip', async () => {
    await db.execute(`INSERT INTO orgs (id, name) VALUES ('${testOrgId}', 'Test Org')`);

    const claimResult = await db.execute(
      `INSERT INTO agent_claims (org_id, repo, pr_number, attempt, claim_type, status, payload, head_sha)
       VALUES ('${testOrgId}', 'test-repo', 123, 1, 'verify', 'completed', '{"phase":"green"}', 'abc123')
       RETURNING id`
    );
    testClaimId1 = claimResult.rows[0].id;

    const row = {
      orgId: testOrgId,
      claimId: testClaimId1,
      repo: 'test-repo',
      prNumber: 123,
      phase: 'green',
      framework: 'vitest',
      outcome: 'PASS',
      matrix: { foo: 'bar' },
      testHashes: ['hash1', 'hash2'],
      artifactSha: 'sha789',
      redBaseSha: 'abc123',
      greenSha: 'def456',
    };

    const inserted = await insertVerificationResult(row);
    expect(inserted.id).toBeDefined();
    expect(inserted.orgId).toBe(testOrgId);
    expect(inserted.claimId).toBe(testClaimId1);
    expect(inserted.phase).toBe('green');
    expect(inserted.outcome).toBe('PASS');

    const fetched = await getVerificationResultByClaim(testOrgId, testClaimId1);
    expect(fetched).not.toBeNull();
    expect(fetched.id).toBe(inserted.id);
    expect(fetched.framework).toBe('vitest');
    expect(fetched.matrix).toEqual({ foo: 'bar' });
    expect(fetched.testHashes).toEqual(['hash1', 'hash2']);
  });

  it('onConflictDoUpdate on same claim_id replaces', async () => {
    await db.execute(`INSERT INTO orgs (id, name) VALUES ('${testOrgId}', 'Test Org')`);

    const claimResult = await db.execute(
      `INSERT INTO agent_claims (org_id, repo, pr_number, attempt, claim_type, status, payload, head_sha)
       VALUES ('${testOrgId}', 'test-repo', 123, 1, 'verify', 'completed', '{"phase":"green"}', 'abc123')
       RETURNING id`
    );
    testClaimId1 = claimResult.rows[0].id;

    const firstRow = {
      orgId: testOrgId,
      claimId: testClaimId1,
      repo: 'test-repo',
      prNumber: 123,
      phase: 'green',
      framework: 'vitest',
      outcome: 'PASS',
      matrix: null,
      testHashes: null,
      artifactSha: 'sha1',
      redBaseSha: 'abc123',
      greenSha: 'def456',
    };

    await insertVerificationResult(firstRow);

    const updatedRow = {
      ...firstRow,
      outcome: 'FAIL',
      matrix: { error: 'test failed' },
      artifactSha: 'sha2',
    };

    const updated = await insertVerificationResult(updatedRow);
    expect(updated.outcome).toBe('FAIL');
    expect(updated.matrix).toEqual({ error: 'test failed' });
    expect(updated.artifactSha).toBe('sha2');

    const fetched = await getVerificationResultByClaim(testOrgId, testClaimId1);
    expect(fetched.outcome).toBe('FAIL');
    expect(fetched.matrix).toEqual({ error: 'test failed' });
  });

  it('cascade delete - deleting claim removes result', async () => {
    await db.execute(`INSERT INTO orgs (id, name) VALUES ('${testOrgId}', 'Test Org')`);

    const claimResult = await db.execute(
      `INSERT INTO agent_claims (org_id, repo, pr_number, attempt, claim_type, status, payload, head_sha)
       VALUES ('${testOrgId}', 'test-repo', 123, 1, 'verify', 'completed', '{"phase":"green"}', 'abc123')
       RETURNING id`
    );
    testClaimId1 = claimResult.rows[0].id;

    const row = {
      orgId: testOrgId,
      claimId: testClaimId1,
      repo: 'test-repo',
      prNumber: 123,
      phase: 'green',
      framework: 'vitest',
      outcome: 'PASS',
      matrix: null,
      testHashes: null,
      artifactSha: null,
      redBaseSha: null,
      greenSha: null,
    };

    await insertVerificationResult(row);
    let fetched = await getVerificationResultByClaim(testOrgId, testClaimId1);
    expect(fetched).not.toBeNull();

    await db.execute(`DELETE FROM agent_claims WHERE id = ${testClaimId1}`);

    fetched = await getVerificationResultByClaim(testOrgId, testClaimId1);
    expect(fetched).toBeNull();
  });

  it('partial unique index - second green claim for same (org, repo, pr, head_sha) rejected', async () => {
    await db.execute(`INSERT INTO orgs (id, name) VALUES ('${testOrgId}', 'Test Org')`);

    const firstGreenResult = await db.execute(
      `INSERT INTO agent_claims (org_id, repo, pr_number, attempt, claim_type, status, payload, head_sha)
       VALUES ('${testOrgId}', 'test-repo', 456, 1, 'verify', 'completed', '{"phase":"green"}', 'same-sha')
       RETURNING id`
    );

    const firstRow = {
      orgId: testOrgId,
      claimId: firstGreenResult.rows[0].id,
      repo: 'test-repo',
      prNumber: 456,
      phase: 'green',
      framework: 'vitest',
      outcome: 'PASS',
      matrix: null,
      testHashes: null,
      artifactSha: null,
      redBaseSha: null,
      greenSha: null,
    };

    await insertVerificationResult(firstRow);

    let thrown = null;
    try {
      await db.execute(
        `INSERT INTO agent_claims (org_id, repo, pr_number, attempt, claim_type, status, payload, head_sha)
         VALUES ('${testOrgId}', 'test-repo', 456, 2, 'verify', 'completed', '{"phase":"green"}', 'same-sha')`
      );
    } catch (err) {
      thrown = err;
    }
    // drizzle wraps query failures as "Failed query: …" with the pg error as cause
    expect(thrown).toBeTruthy();
    expect(`${thrown.message} :: ${thrown.cause?.message ?? ''}`).toMatch(
      /duplicate key|violates unique constraint/u,
    );
  });

  it('partial unique index - different SHA allowed', async () => {
    await db.execute(`INSERT INTO orgs (id, name) VALUES ('${testOrgId}', 'Test Org')`);

    const firstGreenResult = await db.execute(
      `INSERT INTO agent_claims (org_id, repo, pr_number, attempt, claim_type, status, payload, head_sha)
       VALUES ('${testOrgId}', 'test-repo', 789, 1, 'verify', 'completed', '{"phase":"green"}', 'sha1')
       RETURNING id`
    );

    const firstRow = {
      orgId: testOrgId,
      claimId: firstGreenResult.rows[0].id,
      repo: 'test-repo',
      prNumber: 789,
      phase: 'green',
      framework: 'vitest',
      outcome: 'PASS',
      matrix: null,
      testHashes: null,
      artifactSha: null,
      redBaseSha: null,
      greenSha: null,
    };

    await insertVerificationResult(firstRow);

    const secondGreenResult = await db.execute(
      `INSERT INTO agent_claims (org_id, repo, pr_number, attempt, claim_type, status, payload, head_sha)
       VALUES ('${testOrgId}', 'test-repo', 789, 2, 'verify', 'completed', '{"phase":"green"}', 'sha2')
       RETURNING id`
    );

    const secondRow = {
      orgId: testOrgId,
      claimId: secondGreenResult.rows[0].id,
      repo: 'test-repo',
      prNumber: 789,
      phase: 'green',
      framework: 'vitest',
      outcome: 'PASS',
      matrix: null,
      testHashes: null,
      artifactSha: null,
      redBaseSha: null,
      greenSha: null,
    };

    await insertVerificationResult(secondRow);
  });

  it('partial unique index - non-verify claims unaffected', async () => {
    await db.execute(`INSERT INTO orgs (id, name) VALUES ('${testOrgId}', 'Test Org')`);

    const reviewClaimResult = await db.execute(
      `INSERT INTO agent_claims (org_id, repo, pr_number, attempt, claim_type, status, payload, head_sha)
       VALUES ('${testOrgId}', 'test-repo', 999, 1, 'review_fix', 'completed', '{}', 'same-sha')
       RETURNING id`
    );

    const secondGreenResult = await db.execute(
      `INSERT INTO agent_claims (org_id, repo, pr_number, attempt, claim_type, status, payload, head_sha)
       VALUES ('${testOrgId}', 'test-repo', 999, 2, 'verify', 'completed', '{"phase":"green"}', 'same-sha')
       RETURNING id`
    );

    const greenRow = {
      orgId: testOrgId,
      claimId: secondGreenResult.rows[0].id,
      repo: 'test-repo',
      prNumber: 999,
      phase: 'green',
      framework: 'vitest',
      outcome: 'PASS',
      matrix: null,
      testHashes: null,
      artifactSha: null,
      redBaseSha: null,
      greenSha: null,
    };

    await insertVerificationResult(greenRow);
  });

  it('getVerificationResultsForPR returns results ordered by createdAt desc', async () => {
    await db.execute(`INSERT INTO orgs (id, name) VALUES ('${testOrgId}', 'Test Org')`);

    const claimResult1 = await db.execute(
      `INSERT INTO agent_claims (org_id, repo, pr_number, attempt, claim_type, status, payload, head_sha)
       VALUES ('${testOrgId}', 'test-repo', 123, 1, 'verify', 'completed', '{"phase":"green"}', 'abc123')
       RETURNING id`
    );
    testClaimId1 = claimResult1.rows[0].id;

    const firstRow = {
      orgId: testOrgId,
      claimId: testClaimId1,
      repo: 'test-repo',
      prNumber: 123,
      phase: 'green',
      framework: 'vitest',
      outcome: 'PASS',
      matrix: null,
      testHashes: null,
      artifactSha: null,
      redBaseSha: null,
      greenSha: null,
    };

    await insertVerificationResult(firstRow);

    await new Promise(resolve => setTimeout(resolve, 10));

    const claimResult2 = await db.execute(
      `INSERT INTO agent_claims (org_id, repo, pr_number, attempt, claim_type, status, payload, head_sha)
       VALUES ('${testOrgId}', 'test-repo', 123, 2, 'verify', 'completed', '{"phase":"red"}', 'def456')
       RETURNING id`
    );
    testClaimId2 = claimResult2.rows[0].id;

    const secondRow = {
      orgId: testOrgId,
      claimId: testClaimId2,
      repo: 'test-repo',
      prNumber: 123,
      phase: 'red',
      framework: 'vitest',
      outcome: 'FAIL',
      matrix: null,
      testHashes: null,
      artifactSha: null,
      redBaseSha: null,
      greenSha: null,
    };

    await insertVerificationResult(secondRow);

    const results = await getVerificationResultsForPR(testOrgId, 'test-repo', 123);
    expect(results).toHaveLength(2);
    expect(results[0].phase).toBe('red');
    expect(results[1].phase).toBe('green');
  });
});
