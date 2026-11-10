import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createEnrollmentToken, exchangeEnrollmentToken } from '../../src/queries/index.js';
import { closePool, getPool } from '../../src/pool.js';
import { runMigrations } from '../../src/migrate.js';
import {
  resetCollabSchema,
  resolveCollabTestDatabaseUrl,
} from '../helpers/collab-db.js';

process.env.DATABASE_URL = resolveCollabTestDatabaseUrl();
const databaseUrl = process.env.DATABASE_URL;
const orgId = 'enrollment-exchange-test';
const agentId = 'portable-agent';

interface TokenRow {
  id: number;
  token_hash: string;
  label: string | null;
  revoked_at: Date | null;
}

describe('enrollment exchange transaction (real Postgres)', () => {
  beforeAll(async () => {
    await resetCollabSchema(databaseUrl);
    await runMigrations();
    await getPool().query('INSERT INTO orgs (id, name) VALUES ($1, $2)', [orgId, 'Enrollment exchange']);
    await getPool().query(
      `INSERT INTO agents (id, org_id, agent_type, transport)
       VALUES ($1, $2, $3, $4)`,
      [agentId, orgId, 'claude-code', 'long_poll'],
    );
  });

  afterAll(async () => {
    await closePool();
  });

  it('allows exactly one of two concurrent exchanges to consume the enrollment', async () => {
    const enrollment = await createEnrollmentToken({ orgId, agentId });

    const results = await Promise.all([
      exchangeEnrollmentToken({ plaintext: enrollment.plaintext, instanceId: 'instance-concurrent' }),
      exchangeEnrollmentToken({ plaintext: enrollment.plaintext, instanceId: 'instance-concurrent' }),
    ]);

    const successes = results.filter((result) => result !== null);
    expect(successes).toHaveLength(1);
    expect(results.filter((result) => result === null)).toHaveLength(1);
    const durable = successes[0]!;
    expect(durable).toEqual({
      plaintext: expect.stringMatching(/^ff_[0-9a-f]{64}$/),
      id: expect.any(Number),
      orgId,
      agentId,
    });

    const { rows } = await getPool().query<TokenRow>(
      `SELECT id, token_hash, label, revoked_at
       FROM agent_tokens
       WHERE org_id = $1 AND agent_id = $2
       ORDER BY id`,
      [orgId, agentId],
    );
    expect(rows).toHaveLength(2);
    const enrollmentRow = rows.find((row) => row.id === enrollment.id);
    const durableRows = rows.filter((row) => row.id !== enrollment.id);
    expect(enrollmentRow?.label).toMatch(/^enrollment:/);
    expect(enrollmentRow?.revoked_at).toBeInstanceOf(Date);
    expect(durableRows).toHaveLength(1);
    expect(durableRows[0].id).toBe(durable.id);
    expect(durableRows[0].label).toContain('instance-concurrent');
    expect(durableRows[0].revoked_at).toBeNull();
    expect(durableRows[0].token_hash).toBe(
      createHash('sha256').update(durable.plaintext).digest('hex'),
    );
  });

  it('rejects an explicitly expired enrollment without creating a durable token', async () => {
    const pool = getPool();
    const before = await pool.query<{ id: number }>(
      `SELECT id
       FROM agent_tokens
       WHERE org_id = $1 AND agent_id = $2`,
      [orgId, agentId],
    );
    const existingIds = new Set(before.rows.map((row) => row.id));
    const enrollment = await createEnrollmentToken({
      orgId,
      agentId,
      expiresAt: new Date('2000-01-01T00:00:00.000Z'),
    });

    const result = await exchangeEnrollmentToken({
      plaintext: enrollment.plaintext,
      instanceId: 'instance-expired',
    });

    expect(result).toBeNull();
    const after = await pool.query<TokenRow>(
      `SELECT id, token_hash, label, revoked_at
       FROM agent_tokens
       WHERE org_id = $1 AND agent_id = $2
       ORDER BY id`,
      [orgId, agentId],
    );
    const createdRows = after.rows.filter((row) => !existingIds.has(row.id));
    expect(createdRows).toHaveLength(1);
    expect(createdRows[0]).toEqual({
      id: enrollment.id,
      token_hash: createHash('sha256').update(enrollment.plaintext).digest('hex'),
      label: `enrollment:${agentId}`,
      revoked_at: null,
    });
  });
});
