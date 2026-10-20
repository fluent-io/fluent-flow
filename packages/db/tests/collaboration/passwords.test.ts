import { scrypt, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveCollabTestDatabaseUrl } from '../helpers/collab-db.js';
import { runMigrations } from '../../src/migrate.js';
import { closePool, getPool } from '../../src/pool.js';
import { authenticateCollabPassword, hashPassword, verifyPassword } from '../../src/collaboration/passwords.js';
import { rateLimitBucket } from '../../src/collaboration/rate-limit.js';

// Observe the actual expensive crypto boundary, without replacing its work or
// comparing noisy wall-clock durations.
vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return { ...actual, scrypt: vi.fn(actual.scrypt) };
});

resolveCollabTestDatabaseUrl();
const suffix = randomUUID();
const password = 'Correct synthetic password \u212b';
const ids: string[] = [];
const buckets = new Set<string>();
const email = (name: string) => `${name}-${suffix}@example.test`;
let encoded: string;

async function seed(name: string, passwordHash: string | null, disabled = false) {
  const result = await getPool().query('INSERT INTO collab_principals(display_name,email,disabled_at) VALUES($1,$2,$3) RETURNING id', [name, email(name), disabled ? new Date() : null]);
  ids.push(result.rows[0].id);
  if (passwordHash !== null) await getPool().query('INSERT INTO collab_password_credentials(principal_id,password_hash) VALUES($1,$2)', [result.rows[0].id, passwordHash]);
}

async function login(name: string, suppliedPassword = 'incorrect synthetic password', rateLimitKey = `password-test-${randomUUID()}`) {
  const account = email(name);
  buckets.add(rateLimitBucket('login', rateLimitKey, account.toLowerCase()));
  return authenticateCollabPassword({ email: account, password: suppliedPassword, rateLimitKey });
}

function expectOneFixedKdf() {
  expect(scrypt).toHaveBeenCalledTimes(1);
  const [, salt, keylen, options] = vi.mocked(scrypt).mock.calls[0];
  expect(Buffer.isBuffer(salt)).toBe(true);
  expect((salt as Buffer).length).toBe(16);
  expect(keylen).toBe(64);
  expect(options).toMatchObject({ N: 16384, r: 8, p: 1 });
}

describe('password authentication failure work (real Postgres and scrypt)', () => {
  beforeAll(async () => {
    await runMigrations();
    encoded = await hashPassword(password);
    await seed('enabled', encoded);
    await seed('disabled', encoded, true);
    await seed('no-credential', null);
    await seed('malformed', 'not-a-password-encoding');
    await seed('invalid-base64', 'scrypt$16384$8$1$!!!!$!!!!');
    await seed('invalid-parameters', encoded.replace('$16384$', '$not-a-number$'));
  });

  beforeEach(() => { vi.mocked(scrypt).mockClear(); });

  afterAll(async () => {
    await getPool().query('DELETE FROM collab_principals WHERE id=ANY($1::uuid[])', [ids]);
    await getPool().query('DELETE FROM collab_rate_limit_events WHERE bucket=ANY($1::text[])', [[...buckets]]);
    await closePool();
  });

  it.each(['enabled', 'unknown', 'disabled', 'no-credential', 'malformed', 'invalid-base64', 'invalid-parameters'])('%s rejects uniformly after exactly one fixed-cost KDF', async (name) => {
    await expect(login(name)).resolves.toBeNull();
    expectOneFixedKdf();
  });

  it('keeps a disabled account invalid even with the correct password', async () => {
    await expect(login('disabled', password)).resolves.toBeNull();
    expectOneFixedKdf();
  });

  it('keeps valid normalized login and credential metadata unchanged', async () => {
    const before = await getPool().query('SELECT c.* FROM collab_password_credentials c JOIN collab_principals p ON p.id=c.principal_id WHERE p.email=$1', [email('enabled')]);
    const principal = await authenticateCollabPassword({ email: email('enabled').toUpperCase(), password: password.normalize('NFKC'), rateLimitKey: `valid-login-${suffix}` });
    buckets.add(rateLimitBucket('login', `valid-login-${suffix}`, email('enabled').toLowerCase()));
    expect(principal).toMatchObject({ email: email('enabled'), disabledAt: null, legacyUserId: null });
    expectOneFixedKdf();
    const after = await getPool().query('SELECT * FROM collab_password_credentials WHERE principal_id=$1', [principal?.id]);
    expect(after.rows).toEqual(before.rows);
  });

  it.each([
    ['null', null], ['empty', ''], ['base64', 'scrypt$16384$8$1$!!!!$!!!!'],
    ['short key', `scrypt$16384$8$1$${Buffer.alloc(16).toString('base64')}$${Buffer.alloc(1).toString('base64')}`],
    ['unsupported cost', `scrypt$32768$8$1$${Buffer.alloc(16).toString('base64')}$${Buffer.alloc(64).toString('base64')}`],
    ['oversized', 'x'.repeat(10_000)],
  ])('invalid stored encoding (%s) cannot crash or authenticate', async (_name, stored) => {
    await expect(verifyPassword(password, stored as unknown as string)).resolves.toBe(false);
    expectOneFixedKdf();
  });

  it('keeps the login rate limit ahead of expensive crypto work', async () => {
    const key = `limited-login-${suffix}`;
    for (let attempt = 0; attempt < 20; attempt++) {
      vi.mocked(scrypt).mockClear();
      await expect(login('unknown', password, key)).resolves.toBeNull();
      expectOneFixedKdf();
    }
    vi.mocked(scrypt).mockClear();
    await expect(login('unknown', password, key)).rejects.toMatchObject({ status: 429 });
    expect(scrypt).not.toHaveBeenCalled();
  });
});
