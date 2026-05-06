import { describe, it, expect } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATION_PATH = path.resolve(
  __dirname,
  '../../src/migrations/0009_agent_claims_unique_include_claim_type.sql',
);

/**
 * Regression guards for migration 0009.
 *
 * The main unique index on agent_claims must NOT be partial. Drizzle's
 * `target: [columns]` form on `INSERT ... ON CONFLICT` emits no WHERE
 * predicate, and Postgres can only infer a partial index as the arbiter when
 * the conflict target's predicate matches the index predicate. A partial
 * `WHERE pr_number IS NOT NULL` index here would make every non-null-PR
 * `createClaim` INSERT fail at runtime with "no unique or exclusion
 * constraint matching the ON CONFLICT specification."
 */
describe('migration 0009 — agent_claims unique index includes claim_type', () => {
  it('main unique index is NOT partial (must match Drizzle ON CONFLICT target)', async () => {
    const sql = await fs.readFile(MIGRATION_PATH, 'utf8');

    const mainIndexBlock = sql.match(
      /CREATE UNIQUE INDEX agent_claims_org_id_repo_pr_number_attempt_key[\s\S]*?;/,
    );
    expect(mainIndexBlock, 'main unique index DDL should be present').toBeTruthy();
    // The main index must cover (org_id, repo, pr_number, claim_type, attempt)
    // and must NOT carry a partial-index predicate.
    expect(mainIndexBlock![0]).toContain('(org_id, repo, pr_number, claim_type, attempt)');
    expect(mainIndexBlock![0]).not.toMatch(/WHERE\s+pr_number\s+IS\s+NOT\s+NULL/i);
  });

  it('no-pr partial unique index keeps the WHERE pr_number IS NULL predicate', async () => {
    const sql = await fs.readFile(MIGRATION_PATH, 'utf8');

    const noPrBlock = sql.match(
      /CREATE UNIQUE INDEX agent_claims_org_repo_attempt_no_pr_key[\s\S]*?;/,
    );
    expect(noPrBlock, 'no-pr partial unique index DDL should be present').toBeTruthy();
    expect(noPrBlock![0]).toContain('(org_id, repo, claim_type, attempt)');
    expect(noPrBlock![0]).toMatch(/WHERE\s+pr_number\s+IS\s+NULL/i);
  });

  it('drops the prior versions of both indexes before recreating', async () => {
    const sql = await fs.readFile(MIGRATION_PATH, 'utf8');
    expect(sql).toMatch(/DROP INDEX IF EXISTS agent_claims_org_id_repo_pr_number_attempt_key/);
    expect(sql).toMatch(/DROP INDEX IF EXISTS agent_claims_org_repo_attempt_no_pr_key/);
  });
});
