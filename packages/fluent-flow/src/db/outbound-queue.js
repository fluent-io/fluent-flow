import { query } from './client.js';
import logger from '../logger.js';

export async function enqueue({ installationId, kind, clientRef, payload }) {
  const result = await query(
    `INSERT INTO provider_outbound_queue (installation_id, kind, client_ref, payload)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (client_ref) DO NOTHING
     RETURNING *`,
    [installationId, kind, clientRef, JSON.stringify(payload)]
  );
  const row = result.rows[0] ?? null;
  if (row) logger.info({ msg: 'outbound enqueued', id: row.id, kind, clientRef });
  else logger.debug({ msg: 'outbound enqueue dedup', clientRef });
  return row;
}

export async function claimNext() {
  const result = await query(
    `UPDATE provider_outbound_queue SET attempts = attempts
     WHERE id = (
       SELECT id FROM provider_outbound_queue
       WHERE succeeded_at IS NULL
         AND parked_at IS NULL
         AND next_attempt_at <= NOW()
       ORDER BY next_attempt_at ASC
       FOR UPDATE SKIP LOCKED
       LIMIT 1
     )
     RETURNING *`
  );
  return result.rows[0] ?? null;
}

export async function markSucceeded(id) {
  await query(
    `UPDATE provider_outbound_queue SET succeeded_at = NOW() WHERE id = $1`,
    [id]
  );
  logger.info({ msg: 'outbound succeeded', id });
}

export async function rescheduleWithBackoff(id, errorMessage, delaySeconds) {
  await query(
    `UPDATE provider_outbound_queue
       SET attempts = attempts + 1,
           last_error = $2,
           next_attempt_at = NOW() + ($3 || ' seconds')::interval
     WHERE id = $1`,
    [id, errorMessage, delaySeconds]
  );
  logger.warn({ msg: 'outbound rescheduled', id, delaySeconds, error: errorMessage });
}

export async function markRateLimited(id, delaySeconds) {
  await query(
    `UPDATE provider_outbound_queue
       SET rate_limited_attempts = rate_limited_attempts + 1,
           next_attempt_at = NOW() + ($2 || ' seconds')::interval
     WHERE id = $1`,
    [id, delaySeconds]
  );
  logger.warn({ msg: 'outbound rate-limited', id, delaySeconds });
}

export async function park(id, errorMessage) {
  await query(
    `UPDATE provider_outbound_queue
       SET parked_at = NOW(),
           last_error = $2
     WHERE id = $1`,
    [id, errorMessage]
  );
  logger.error({ msg: 'outbound parked', id, error: errorMessage });
}
