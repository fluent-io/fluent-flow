import { createHash } from 'node:crypto';
import { getPool } from '../pool.js';
import { CollabRateLimitError } from './errors.js';
import { withClientTransaction } from './tx.js';

const WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 20;

/** Hash so raw client addresses / target accounts are never stored. */
export function rateLimitBucket(kind: string, rateLimitKey: string, target: string): string {
  return createHash('sha256').update(`${kind}:${rateLimitKey}:${target}`).digest('hex');
}

/**
 * Sliding-window attempt counter. The count+reserve pair is serialized per
 * bucket with an advisory lock inside a transaction: N concurrent requests
 * see strictly ordered counts, so exactly MAX_ATTEMPTS ever pass per window.
 * rateLimitKey must be server-derived (hashed peer address), never a
 * caller-supplied or forwarded value.
 */
export async function enforceRateLimitBucket(bucket: string): Promise<void> {
  await withClientTransaction(async (tx) => {
    await tx.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [bucket]);
    const cutoff = new Date(Date.now() - WINDOW_MS);
    const { rows } = await tx.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM collab_rate_limit_events
       WHERE bucket = $1 AND attempted_at > $2`,
      [bucket, cutoff],
    );
    if (rows[0].n >= MAX_ATTEMPTS) {
      throw new CollabRateLimitError();
    }
    await tx.query(`INSERT INTO collab_rate_limit_events (bucket) VALUES ($1)`, [bucket]);
  });
}
