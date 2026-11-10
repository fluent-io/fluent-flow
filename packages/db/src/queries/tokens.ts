import crypto from 'node:crypto';
import { getPool, query } from '../pool.js';

const TOKEN_PREFIX = 'ff_';
const ENROLLMENT_TOKEN_PREFIX = 'enroll_';
const DEFAULT_TTL_MS = 365 * 24 * 60 * 60 * 1000;
const ENROLLMENT_TTL_MS = 15 * 60 * 1000;

function generateToken(): string {
  return TOKEN_PREFIX + crypto.randomBytes(32).toString('hex');
}

function generateEnrollmentToken(): string {
  return ENROLLMENT_TOKEN_PREFIX + crypto.randomBytes(32).toString('hex');
}

function hashToken(plaintext: string): string {
  return crypto.createHash('sha256').update(plaintext).digest('hex');
}

export async function regenerateKey(orgId: string, agentId: string): Promise<{ plaintext: string; id: number }> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');

    await client.query(
      `UPDATE agent_tokens SET revoked_at = NOW() WHERE org_id = $1 AND agent_id = $2 AND revoked_at IS NULL`,
      [orgId, agentId],
    );

    const plaintext = generateToken();
    const hash = hashToken(plaintext);

    const result = await client.query(
      `INSERT INTO agent_tokens (org_id, agent_id, token_hash, label) VALUES ($1, $2, $3, $4) RETURNING id, org_id, agent_id, created_at`,
      [orgId, agentId, hash, 'default'],
    );

    await client.query('COMMIT');
    return { plaintext, ...result.rows[0] };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function getKeyInfo(orgId: string, agentId: string): Promise<{ id: number; created_at: Date } | null> {
  const result = await query(
    `SELECT id, created_at FROM agent_tokens WHERE org_id = $1 AND agent_id = $2 AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 1`,
    [orgId, agentId],
  );
  return result.rows[0] ?? null;
}

export interface CreateTokenInput {
  orgId: string;
  agentId: string;
  label: string;
  /**
   * - `undefined`: apply the default 1-year TTL.
   * - `Date`: explicit expiry.
   * - `null`: persist NULL — token never expires (validateToken treats NULL
   *   expires_at as always-valid).
   */
  expiresAt?: Date | null;
}

/**
 * Insert a new long-lived agent token row and return the plaintext (shown
 * once). Used by the dashboard's "+ New agent" flow and by the fluent-flow
 * server's MCP admin API. Plaintext is SHA-256-hashed before storage — only
 * the hash lives in the DB.
 */
export async function createToken(input: CreateTokenInput): Promise<{ plaintext: string; id: number }> {
  const plaintext = generateToken();
  const hash = hashToken(plaintext);
  // Distinguish `undefined` (apply default) from `null` (persist NULL).
  const expiresAt = input.expiresAt === undefined
    ? new Date(Date.now() + DEFAULT_TTL_MS)
    : input.expiresAt;

  const result = await query(
    `INSERT INTO agent_tokens (org_id, agent_id, token_hash, label, expires_at)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id`,
    [input.orgId, input.agentId, hash, input.label, expiresAt],
  );
  return { plaintext, id: result.rows[0].id };
}

export async function createEnrollmentToken(
  input: { orgId: string; agentId: string; expiresAt?: Date },
  executor?: {
    query(text: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
  },
): Promise<{ plaintext: string; id: number }> {
  const plaintext = generateEnrollmentToken();
  const hash = hashToken(plaintext);
  const expiresAt = input.expiresAt ?? new Date(Date.now() + ENROLLMENT_TTL_MS);
  const result = await (executor ?? { query }).query(
    `INSERT INTO agent_tokens (org_id, agent_id, token_hash, label, expires_at)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id`,
    [input.orgId, input.agentId, hash, `enrollment:${input.agentId}`, expiresAt],
  );
  const row = result.rows[0];
  if (typeof row !== 'object' || row === null || !('id' in row) || typeof row.id !== 'number') {
    throw new Error('Enrollment token insert did not return an id');
  }
  return { plaintext, id: row.id };
}

interface EnrollmentTokenRow {
  id: number;
  org_id: string;
  agent_id: string;
  label: string | null;
  expires_at: Date | null;
  revoked_at: Date | null;
}

export async function exchangeEnrollmentToken(input: {
  plaintext: string;
  instanceId: string;
}): Promise<{
  plaintext: string;
  id: number;
  orgId: string;
  agentId: string;
} | null> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const enrollmentResult = await client.query<EnrollmentTokenRow>(
      `SELECT id, org_id, agent_id, label, expires_at, revoked_at
       FROM agent_tokens
       WHERE token_hash = $1
         AND revoked_at IS NULL
         AND expires_at > NOW()
         AND label LIKE 'enrollment:%'
       FOR UPDATE`,
      [hashToken(input.plaintext)],
    );
    const enrollment = enrollmentResult.rows[0];
    const isActiveEnrollment = enrollment !== undefined
      && enrollment.revoked_at === null
      && enrollment.label?.startsWith('enrollment:') === true;

    if (!isActiveEnrollment) {
      await client.query('COMMIT');
      return null;
    }

    const revoked = await client.query(
      `UPDATE agent_tokens
       SET revoked_at = NOW()
       WHERE id = $1
         AND revoked_at IS NULL
         AND expires_at > NOW()
         AND label LIKE 'enrollment:%'
       RETURNING id`,
      [enrollment.id],
    );
    if (revoked.rows.length === 0) {
      await client.query('COMMIT');
      return null;
    }

    const plaintext = generateToken();
    const inserted = await client.query(
      `INSERT INTO agent_tokens (org_id, agent_id, token_hash, label, expires_at)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id`,
      [
        enrollment.org_id,
        enrollment.agent_id,
        hashToken(plaintext),
        `instance:${input.instanceId}`,
        new Date(Date.now() + DEFAULT_TTL_MS),
      ],
    );
    await client.query('COMMIT');
    return {
      plaintext,
      id: inserted.rows[0].id,
      orgId: enrollment.org_id,
      agentId: enrollment.agent_id,
    };
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackError) {
      throw new AggregateError(
        [err, rollbackError],
        'Enrollment token exchange and rollback both failed.',
      );
    }
    throw err;
  } finally {
    client.release();
  }
}
