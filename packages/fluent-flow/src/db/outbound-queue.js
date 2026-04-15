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

// Visibility timeout: after claiming, the row is hidden for this many seconds so
// concurrent workers don't re-pick it. If the worker crashes before mark*,
// the row reappears after the lease expires and can be retried.
const CLAIM_VISIBILITY_SECS = 60;

/**
 * Claim the next ready row from the queue using FOR UPDATE SKIP LOCKED.
 * Only sets an in-flight visibility timeout on `next_attempt_at`; does NOT
 * increment `attempts` or `rate_limited_attempts`. Attempt/backoff accounting
 * is performed solely in markFailed().
 * Returns null if the queue is empty.
 */
export async function claimNext() {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // ORDER BY next_attempt_at ASC ensures FIFO drain and prevents starvation of
    // older rows when newer ones are continuously enqueued.
    const selectResult = await client.query(
      `SELECT * FROM provider_outbound_queue
       WHERE next_attempt_at <= NOW()
         AND parked_at IS NULL
         AND succeeded_at IS NULL
       ORDER BY next_attempt_at ASC
       FOR UPDATE SKIP LOCKED
       LIMIT 1`
    );

    const row = selectResult.rows[0];
    if (!row) {
      await client.query('COMMIT');
      return null;
    }

    await client.query(
      `UPDATE provider_outbound_queue
       SET next_attempt_at = NOW() + ($1 * interval '1 second')
       WHERE id = $2`,
      [CLAIM_VISIBILITY_SECS, row.id]
    );

    await client.query('COMMIT');
    logger.info({ msg: 'claimNext', id: row.id, kind: row.kind });
    return row;
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
 * Mark a queue row as failed. Owns all attempt/backoff accounting
 * (claimNext only sets a short visibility timeout and never mutates counters).
 * - Ordinary failure: increments `attempts`; backoff = least(300, 2 ^ attempts) seconds.
 * - Rate-limited:     increments `rate_limited_attempts` only; backoff uses
 *                     `rate_limited_attempts` (or `retryAfter` when provided by GitHub).
 */
export async function markFailed(id, { error, rateLimited = false, retryAfter = null }) {
  let result;
  if (rateLimited) {
    const useRetryAfter = retryAfter != null && !Number.isNaN(Number(retryAfter));
    if (useRetryAfter) {
      result = await query(
        `UPDATE provider_outbound_queue
         SET rate_limited_attempts = rate_limited_attempts + 1,
             last_error = $1,
             next_attempt_at = NOW() + ($3 * interval '1 second')
         WHERE id = $2
         RETURNING *`,
        [error, id, Number(retryAfter)]
      );
    } else {
      result = await query(
        `UPDATE provider_outbound_queue
         SET rate_limited_attempts = rate_limited_attempts + 1,
             last_error = $1,
             next_attempt_at = NOW() + (LEAST(300, power(2, rate_limited_attempts + 1)) * interval '1 second')
         WHERE id = $2
         RETURNING *`,
        [error, id]
      );
    }
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
