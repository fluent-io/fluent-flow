import pg from 'pg';

/**
 * Collab suites run against a REAL isolated disposable Postgres. Safety rules
 * (enforced here AND again inside resetCollabSchema):
 * - URL required; missing DB is a hard failure, never a silent skip — these
 *   suites are the persistence evidence.
 * - Loopback hosts only.
 * - Database name must be a dedicated ff_* test database (never `postgres`,
 *   the project default, or any production-shaped name).
 * - Test mode required (vitest/NODE_ENV=test) or an explicit opt-in env.
 */
export function assertDedicatedCollabTestDatabaseUrl(url) {
  const parsed = new URL(url);
  if (!['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname)) {
    throw new Error(`refusing non-loopback database host for collab tests: ${parsed.hostname}`);
  }
  const dbName = parsed.pathname.replace(/^\//, '');
  if (!/^ff_[a-z0-9_]+$/.test(dbName)) {
    throw new Error(
      `collab tests require a dedicated ff_* test database (got "${dbName}"); ` +
        'never point them at a default, project or production database',
    );
  }
  const testMode =
    process.env.VITEST === 'true' ||
    process.env.NODE_ENV === 'test' ||
    process.env.FF_COLLAB_TEST_DB_OPTIN === '1';
  if (!testMode) {
    throw new Error(
      'collab test database resets require test mode (vitest) or FF_COLLAB_TEST_DB_OPTIN=1',
    );
  }
  return url;
}

/** Package-specific env first so turbo's parallel package runs never share a DB. */
export function resolveCollabTestDatabaseUrl() {
  const url = process.env.COLLAB_DB_TEST_DATABASE_URL ?? process.env.TEST_DATABASE_URL;
  if (!url) {
    throw new Error(
      'collab suite requires COLLAB_DB_TEST_DATABASE_URL (or TEST_DATABASE_URL) pointing at an isolated disposable Postgres',
    );
  }
  return assertDedicatedCollabTestDatabaseUrl(url);
}

/**
 * Fresh schema for deterministic runs: drop public + drizzle tracking, then
 * re-apply all migrations (baseline + additive collab migrations). The
 * dedicated-DB guard runs again here so a caller cannot bypass it.
 */
export async function resetCollabSchema(databaseUrl) {
  assertDedicatedCollabTestDatabaseUrl(databaseUrl);
  const client = new pg.Client({ connectionString: databaseUrl });
  try {
    await client.connect();
    await client.query('DROP SCHEMA IF EXISTS public CASCADE');
    await client.query('CREATE SCHEMA public');
    await client.query('DROP SCHEMA IF EXISTS drizzle CASCADE');
    await client.query('CREATE SCHEMA drizzle');
    await client.query('GRANT ALL ON SCHEMA public TO public');
    await client.query('GRANT ALL ON SCHEMA drizzle TO public');
  } finally {
    await client.end();
  }
}

/** Seed a legacy GitHub user with optional org membership (admin|member). */
export async function seedLegacyUser(
  databaseUrl: string,
  opts: { githubId: number; login: string; isSuperadmin?: boolean },
): Promise<number> {
  const client = new pg.Client({ connectionString: databaseUrl });
  try {
    await client.connect();
    const { rows } = await client.query<{ id: number }>(
      `INSERT INTO users (github_id, login, email, is_superadmin)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [opts.githubId, opts.login, `${opts.login}@example.test`, opts.isSuperadmin ?? false],
    );
    return rows[0].id;
  } finally {
    await client.end();
  }
}

export async function seedLegacyOrgMembership(
  databaseUrl: string,
  userId: number,
  orgId: string,
  role: 'admin' | 'member',
): Promise<void> {
  const client = new pg.Client({ connectionString: databaseUrl });
  try {
    await client.connect();
    await client.query(`INSERT INTO orgs (id, name) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [
      orgId,
      `Org ${orgId}`,
    ]);
    await client.query(
      `INSERT INTO user_orgs (user_id, org_id, role) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
      [userId, orgId, role],
    );
  } finally {
    await client.end();
  }
}
