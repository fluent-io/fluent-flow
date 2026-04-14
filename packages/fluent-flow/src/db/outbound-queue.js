import { query, getPool } from './client.js';
import logger from '../logger.js';

/**
 * Enqueue a provider action. If client_ref already exists, returns the existing row (idempotent).
 */
export async function enqueue({ installation_id, kind, payload, client_ref }) {
  const result = await query(
    `INSERT INTO provider_outbound_queue (installation_id, kind, payload, client_ref)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (client_ref) DO NOTHING
     RETURNING *`,
    [installation_id, kind, JSON.stringify(payload), client_ref]
  );

  if (result.rows[0]) {
    logger.info({ msg: 'enqueue', kind, client_ref });
    return result.rows[0];
  }

  // Conflict: return the existing row
  const existing = await query(
    `SELECT * FROM provider_outbound_queue WHERE client_ref = $1`,
    [client_ref]
  );
  return existing.rows[0] ?? null;
}

/**
 * Claim the next ready row from the queue using FOR UPDATE SKIP LOCKED.
 * Increments attempts and updates next_attempt_at for the claimed row.
 * Returns null if the queue is empty.
 */
export async function claimNext() {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const selectResult = await client.query(
      `SELECT * FROM provider_outbound_queue
       WHERE next_attempt_at <= NOW()
         AND parked_at IS NULL
         AND succeeded_at IS NULL
       FOR UPDATE SKIP LOCKED
       LIMIT 1`
    );

    const row = selectResult.rows[0];
    if (!row) {
      await client.query('COMMIT');
      return null;
    }

    const attempts = (row.attempts ?? 0) + 1;
    const backoffSecs = Math.min(300, Math.pow(2, attempts));

    await client.query(
      `UPDATE provider_outbound_queue
       SET attempts = $1,
           next_attempt_at = NOW() + ($2 * interval '1 second')
       WHERE id = $3`,
      [attempts, backoffSecs, row.id]
    );

    await client.query('COMMIT');
    logger.info({ msg: 'claimNext', id: row.id, kind: row.kind });
    return { ...row, attempts };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Mark a queue row as successfully processed.
 */
export async function markSucceeded(id) {
  const result = await query(
    `UPDATE provider_outbound_queue
     SET succeeded_at = NOW()
     WHERE id = $1
     RETURNING *`,
    [id]
  );
  logger.info({ msg: 'markSucceeded', id });
  return result.rows[0];
}

/**
 * Mark a queue row as failed.
 * If rateLimited is true, increments rate_limited_attempts only (not ordinary attempts).
 * Backoff formula: next_attempt_at = now() + interval '1 second' * least(300, 2 ^ attempts)
 */
export async function markFailed(id, { error, rateLimited = false }) {
  let result;
  if (rateLimited) {
    result = await query(
      `UPDATE provider_outbound_queue
       SET rate_limited_attempts = rate_limited_attempts + 1,
           last_error = $1,
           next_attempt_at = NOW() + (LEAST(300, power(2, attempts + rate_limited_attempts)) * interval '1 second')
       WHERE id = $2
       RETURNING *`,
      [error, id]
    );
  } else {
    result = await query(
      `UPDATE provider_outbound_queue
       SET attempts = attempts + 1,
           last_error = $1,
           next_attempt_at = NOW() + (LEAST(300, power(2, attempts + 1)) * interval '1 second')
       WHERE id = $2
       RETURNING *`,
      [error, id]
    );
  }
  logger.info({ msg: 'markFailed', id, rateLimited, error });
  return result.rows[0];
}

/**
 * Park all open queue rows for a given installation (e.g. on suspend).
 */
export async function parkForInstallation(installationId) {
  await query(
    `UPDATE provider_outbound_queue
     SET parked_at = NOW()
     WHERE installation_id = $1
       AND succeeded_at IS NULL
       AND parked_at IS NULL`,
    [installationId]
  );
  logger.info({ msg: 'parkForInstallation', installationId });
}

/**
 * Un-park queue rows for an installation, only those newer than sinceHours.
 */
export async function unparkForInstallation(installationId, sinceHours = 24) {
  await query(
    `UPDATE provider_outbound_queue
     SET parked_at = NULL
     WHERE installation_id = $1
       AND parked_at IS NOT NULL
       AND created_at >= NOW() - ($2 * interval '1 hour')`,
    [installationId, sinceHours]
  );
  logger.info({ msg: 'unparkForInstallation', installationId, sinceHours });
}
