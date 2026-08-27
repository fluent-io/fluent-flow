import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { runMigrations } from '../src/migrate.js';
import * as schema from '../src/schema/index.js';
import {
  insertVerificationResult,
  getVerificationResultByClaim,
  getVerificationResultsForPR,
} from '../src/queries/verification.js';

const hasDatabaseUrl = !!process.env.DATABASE_URL;

describe.skipIf(!hasDatabaseUrl)('verification results queries', () => {
  let pool;
  let db;
  let testOrgId;
  let testClaimId1;
  let testClaimId2;

  beforeEach(async () => {
    testOrgId = `test-org-${Date.now()}`;
    pool = new pg.Pool({
      connectionString: process.env.DATABASE_URL,
      max: 1,
    });
    db = drizzle(pool, { schema });

    await pool.query('BEGIN');

    await pool.query('INSERT INTO orgs (id, name) VALUES ($1, $2)', [testOrgId, 'Test Org']);

    const claimResult = await pool.query(
      `INSERT INTO agent_claims (org_id, repo, pr_number, attempt, claim_type, status, payload, head_sha)
       VALUES ($1, 'test-repo', 123, 1, 'verify', 'completed', '{"phase":"green"}', 'abc123')
       RETURNING id`,
      [testOrgId]
    );
    testClaimId1 = claimResult.rows[0].id;

    const claimResult2 = await pool.query(
      `INSERT INTO agent_claims (org_id, repo, pr_number, attempt, claim_type, status, payload, head_sha)
       VALUES ($1, 'test-repo', 123, 2, 'verify', 'completed', '{"phase":"red"}', 'def456')
       RETURNING id`,
      [testOrgId]
    );
    testClaimId2 = claimResult2.rows[0].id;
  });

  afterEach(async () => {
    await pool.query('ROLLBACK');
    await pool.end();
  });

  it('insert and fetch roundtrip', async () => {
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

    await pool.query('DELETE FROM agent_claims WHERE id = $1', [testClaimId1]);

    fetched = await getVerificationResultByClaim(testOrgId, testClaimId1);
    expect(fetched).toBeNull();
  });

  it('partial unique index - second green claim for same (org, repo, pr, head_sha) rejected', async () => {
    const firstGreenResult = await pool.query(
      `INSERT INTO agent_claims (org_id, repo, pr_number, attempt, claim_type, status, payload, head_sha)
       VALUES ($1, 'test-repo', 456, 1, 'verify', 'completed', '{"phase":"green"}', 'same-sha')
       RETURNING id`,
      [testOrgId]
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

    await expect(
      pool.query(
        `INSERT INTO agent_claims (org_id, repo, pr_number, attempt, claim_type, status, payload, head_sha)
         VALUES ($1, 'test-repo', 456, 2, 'verify', 'completed', '{"phase":"green"}', 'same-sha')`,
        [testOrgId]
      )
    ).rejects.toThrow(/duplicate key/);
  });

  it('partial unique index - different SHA allowed', async () => {
    const firstGreenResult = await pool.query(
      `INSERT INTO agent_claims (org_id, repo, pr_number, attempt, claim_type, status, payload, head_sha)
       VALUES ($1, 'test-repo', 789, 1, 'verify', 'completed', '{"phase":"green"}', 'sha1')
       RETURNING id`,
      [testOrgId]
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

    const secondGreenResult = await pool.query(
      `INSERT INTO agent_claims (org_id, repo, pr_number, attempt, claim_type, status, payload, head_sha)
       VALUES ($1, 'test-repo', 789, 2, 'verify', 'completed', '{"phase":"green"}', 'sha2')
       RETURNING id`,
      [testOrgId]
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
    const reviewClaimResult = await pool.query(
      `INSERT INTO agent_claims (org_id, repo, pr_number, attempt, claim_type, status, payload, head_sha)
       VALUES ($1, 'test-repo', 999, 1, 'review_fix', 'completed', '{}', 'same-sha')
       RETURNING id`,
      [testOrgId]
    );

    const secondGreenResult = await pool.query(
      `INSERT INTO agent_claims (org_id, repo, pr_number, attempt, claim_type, status, payload, head_sha)
       VALUES ($1, 'test-repo', 999, 2, 'verify', 'completed', '{"phase":"green"}', 'same-sha')
       RETURNING id`,
      [testOrgId]
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