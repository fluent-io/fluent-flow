import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';

// Standard silencing only — real app, real DB, real assertion crypto.
vi.mock('../../src/tracing.cjs', () => ({}));
vi.mock('../../src/logger.js', async () => {
  const { createMockLogger } = await import('../helpers/mock-logger.js');
  return { default: createMockLogger() };
});

const { resolveCollabTestDatabaseUrl, resetCollabSchema } = await import(
  '../helpers/collab-db.js'
);

// The db package resolves DATABASE_URL at module load (eager pool creation),
// so the URL must be set before the first import of anything that transitively
// imports @fluent-flow/db.
process.env.DATABASE_URL = resolveCollabTestDatabaseUrl();
const { signCollaborationActor } = await import('@fluent-flow/db');
const { createApp } = await import('../../src/app.js');

const TEST_AUTH_SECRET = 'collab-test-secret-0123456789abcdef0123456789abcdef';
const KNOWN_PRINCIPAL_ID = '11111111-1111-4111-8111-111111111111';
const DISABLED_PRINCIPAL_ID = '22222222-2222-4222-8222-222222222222';
const KNOWN_SESSION_VERSION = 2;

async function insertPrincipal(id, { disabled = false, sessionVersion = KNOWN_SESSION_VERSION } = {}) {
  const { getPool } = await import('@fluent-flow/db');
  await getPool().query(
    `INSERT INTO collab_principals (id, display_name, email, legacy_user_id, disabled_at, session_version)
     VALUES ($1, $2, $3, NULL, $4, $5)`,
    [id, `Principal ${id.slice(0, 4)}`, `${id.slice(0, 4)}@example.test`, disabled ? new Date() : null, sessionVersion],
  );
}

function authHeader(principalId, sessionVersion, nowSeconds = Math.floor(Date.now() / 1000)) {
  return signCollaborationActor({ principalId, sessionVersion }, TEST_AUTH_SECRET, nowSeconds);
}

describe('collab actor boundary: principal identity re-check (DB-backed)', () => {
  let server;
  let baseUrl;

  beforeAll(async () => {
    process.env.FF_COLLAB_AUTH_SECRET = TEST_AUTH_SECRET;
    await resetCollabSchema(process.env.DATABASE_URL);
    const { runMigrations } = await import('@fluent-flow/db');
    await runMigrations();
    await insertPrincipal(KNOWN_PRINCIPAL_ID);
    await insertPrincipal(DISABLED_PRINCIPAL_ID, { disabled: true });

    const app = createApp();
    await new Promise((resolve) => {
      server = app.listen(0, '127.0.0.1', resolve);
    });
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  afterAll(async () => {
    delete process.env.FF_COLLAB_AUTH_SECRET;
    const { closePool } = await import('@fluent-flow/db');
    await closePool();
    if (server) await new Promise((resolve) => server.close(resolve));
  });

  it('rejects a validly signed assertion for an unknown principal with 401', async () => {
    const res = await fetch(`${baseUrl}/api/collab/v1/tasks`, {
      headers: { 'x-fluent-flow-actor': authHeader('99999999-9999-4999-8999-999999999999', 1) },
    });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.code).toBe('unauthenticated');
  });

  it('rejects a validly signed assertion for a disabled principal with 401', async () => {
    const res = await fetch(`${baseUrl}/api/collab/v1/tasks`, {
      headers: { 'x-fluent-flow-actor': authHeader(DISABLED_PRINCIPAL_ID, 1) },
    });
    expect(res.status).toBe(401);
  });

  it('rejects a signed assertion whose sessionVersion is stale with 401', async () => {
    const res = await fetch(`${baseUrl}/api/collab/v1/tasks`, {
      headers: { 'x-fluent-flow-actor': authHeader(KNOWN_PRINCIPAL_ID, KNOWN_SESSION_VERSION + 1) },
    });
    expect(res.status).toBe(401);
  });

  it('lets a current, enabled principal reach the task list (exact success shape)', async () => {
    const res = await fetch(`${baseUrl}/api/collab/v1/tasks`, {
      headers: { 'x-fluent-flow-actor': authHeader(KNOWN_PRINCIPAL_ID, KNOWN_SESSION_VERSION) },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    // The principal has no memberships: an empty authorized page, not an error.
    expect(body.data).toEqual([]);
    expect(body.nextCursor).toBeNull();
  });

  it('answers 503 with a generic message when the auth secret is unconfigured', async () => {
    delete process.env.FF_COLLAB_AUTH_SECRET;
    const res = await fetch(`${baseUrl}/api/collab/v1/tasks`, {
      headers: { 'x-fluent-flow-actor': authHeader(KNOWN_PRINCIPAL_ID, KNOWN_SESSION_VERSION) },
    });
    process.env.FF_COLLAB_AUTH_SECRET = TEST_AUTH_SECRET;
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error.code).toBe('unavailable_configuration');
    expect(body.error.message).not.toMatch(/FF_|secret|env/i);
  });
});
