import pg from 'pg';
import { sql } from 'drizzle-orm';

const { Pool } = pg;

const LOCAL_HOSTS = new Set([
  'localhost',
  '127.0.0.1',
  '::1',
  'host.docker.internal',
  'postgres', // common docker-compose service name
  'db', // common docker-compose service name
]);

/**
 * Resolve the DB URL used by integration tests. `resetDb()` TRUNCATEs every
 * app table, so we must NEVER let it connect to a prod/staging DATABASE_URL by
 * accident.
 *
 * Precedence (safer first): TEST_DATABASE_URL > INTEGRATION_DATABASE_URL >
 * DATABASE_URL. DATABASE_URL is only accepted when it points at a local host;
 * to allow a remote DATABASE_URL (e.g. ephemeral CI DB), set
 * FF_ALLOW_REMOTE_TEST_DB=1 as an explicit opt-in.
 */
export function resolveTestDatabaseUrl() {
  const testUrl = process.env.TEST_DATABASE_URL ?? process.env.INTEGRATION_DATABASE_URL;
  if (testUrl) return testUrl;
  const fallback = process.env.DATABASE_URL;
  if (!fallback) return null;
  if (process.env.FF_ALLOW_REMOTE_TEST_DB === '1') return fallback;
  try {
    const host = new URL(fallback).hostname;
    if (LOCAL_HOSTS.has(host)) return fallback;
  } catch {
    // Unparseable URL — fall through to null and treat as unavailable.
  }
  return null;
}

/**
 * Connect once and cache. Returns false (never throws) if the DB isn't reachable —
 * suites call `integrationDescribe()` to conditionally skip.
 */
let _dbAvailable;
export async function isDbAvailable() {
  if (_dbAvailable !== undefined) return _dbAvailable;
  const url = resolveTestDatabaseUrl();
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
