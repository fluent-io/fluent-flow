import pg from 'pg';
import { sql } from 'drizzle-orm';

const { Pool } = pg;

/**
 * Connect once and cache. Returns null (never throws) if the DB isn't reachable —
 * suites call `skipIfNoDb(it)` to conditionally skip.
 */
let _dbAvailable;
export async function isDbAvailable() {
  if (_dbAvailable !== undefined) return _dbAvailable;
  const url = process.env.DATABASE_URL ?? process.env.TEST_DATABASE_URL;
  if (!url) return (_dbAvailable = false);
  const probe = new Pool({ connectionString: url, connectionTimeoutMillis: 500 });
  try {
    await probe.query('SELECT 1');
    _dbAvailable = true;
  } catch {
    _dbAvailable = false;
  } finally {
    await probe.end().catch(() => {});
  }
  return _dbAvailable;
}

/**
 * Wrap a describe block in this: if the DB is not available the suite is
 * skipped with a message, otherwise runs normally.
 *
 * Usage:
 *   const describeDb = await integrationDescribe();
 *   describeDb('mySuite', () => { ... });
 */
export async function integrationDescribe() {
  const { describe } = await import('vitest');
  const ok = await isDbAvailable();
  if (ok) return describe;
  return describe.skip;
}

/**
 * Truncate all app tables between tests (fast reset without re-migrating).
 */
export async function resetDb(db) {
  await db.execute(sql`
    TRUNCATE TABLE
      provider_outbound_queue,
      provider_installation_repos,
      provider_installations,
      repo_config_history,
      repo_configs,
      org_config,
      repos,
      agent_claims,
      agent_sessions,
      agent_tokens,
      agents,
      user_orgs,
      users,
      orgs,
      audit_log,
      pauses,
      project_items,
      state_transitions,
      review_retries,
      test_failures,
      config_cache
    RESTART IDENTITY CASCADE
  `);
}
