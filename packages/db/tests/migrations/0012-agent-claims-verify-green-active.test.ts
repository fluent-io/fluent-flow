import { describe, it, expect } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATION_PATH = path.resolve(
  __dirname,
  '../../src/migrations/0012_agent_claims_verify_green_active_unique.sql',
);

/**
 * Regression guards for migration 0012.
 *
 * The per-SHA green uniqueness index (introduced in 0010) must only cover
 * ACTIVE green verify claims. Without a status predicate, a terminal green
 * claim at head_sha X (expired/failed/completed) keeps blocking ON CONFLICT
 * DO NOTHING inserts forever, so redispatchClaim can never create attempt+1
 * at the same SHA and transient infra failures escalate to needs-human on
 * the first hit instead of retrying under MAX_RETRY_ATTEMPTS. Two ACTIVE
 * greens for one SHA must still be impossible — webhook redelivery relies
 * on that (createGreenClaim's duplicate SELECT is status-agnostic).
 */
describe('migration 0012 — verify green unique index scoped to active claims', () => {
  it('recreates the per-SHA green index with a pending/claimed predicate', async () => {
    const sql = await fs.readFile(MIGRATION_PATH, 'utf8');

    const createBlock = sql.match(
      /CREATE UNIQUE INDEX idx_agent_claims_verify_green_per_sha[\s\S]*?;/,
    );
    expect(createBlock, 'per-SHA green unique index DDL should be present').toBeTruthy();
    // Same columns as 0010 — only the predicate changes.
    expect(createBlock![0]).toContain('(org_id, repo, pr_number, head_sha)');
    expect(createBlock![0]).toMatch(
      /WHERE\s+claim_type\s*=\s*'verify'\s+AND\s+\(?payload\s*->\>\s*'phase'\)?\s*=\s*'green'/i,
    );
    const predicate = createBlock![0].slice(
      createBlock[0].search(/WHERE/i),
    ).match(/status\s+(?:IN|in)\s*\(([^)]*)\)/);
    expect(predicate, 'predicate must constrain status to an explicit list').toBeTruthy();
    const statuses = predicate![1].split(',').map((s) => s.trim().replace(/'/g, ''));
    expect(statuses).toEqual(['pending', 'claimed']);
  });

  it('drops the unscoped 0010 index before recreating (forward-only)', async () => {
    const sql = await fs.readFile(MIGRATION_PATH, 'utf8');
    expect(sql).toMatch(
      /DROP INDEX IF EXISTS\s+(?:CONCURRENTLY\s+)?idx_agent_claims_verify_green_per_sha/i,
    );
  });

  it('keeps the index name so existing DDL references stay valid', async () => {
    const sql = await fs.readFile(MIGRATION_PATH, 'utf8');
    // One DROP + one CREATE, same identifier.
    const occurrences = sql.match(/idx_agent_claims_verify_green_per_sha/g) ?? [];
    expect(occurrences.length).toBeGreaterThanOrEqual(2);
  });
});
