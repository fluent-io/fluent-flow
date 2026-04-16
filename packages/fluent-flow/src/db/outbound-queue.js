import { and, eq, isNull, lte, sql } from 'drizzle-orm';
import { db, schema } from '@fluent-flow/db';
import logger from '../logger.js';

const { providerOutboundQueue } = schema;

/**
 * Enqueue a provider action. If client_ref already exists, returns the existing row (idempotent).
 */
export async function enqueue({ installation_id, kind, payload, client_ref }) {
  const inserted = await db
    .insert(providerOutboundQueue)
    .values({
      installationId: installation_id,
      kind,
      payload,
      clientRef: client_ref,
    })
    .onConflictDoNothing({ target: providerOutboundQueue.clientRef })
    .returning();

  if (inserted[0]) {
    logger.info({ msg: 'enqueue', kind, client_ref });
    return inserted[0];
  }

  const existing = await db
    .select()
    .from(providerOutboundQueue)
    .where(eq(providerOutboundQueue.clientRef, client_ref))
    .limit(1);

  return existing[0] ?? null;
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
  return db.transaction(async (tx) => {
    // ORDER BY next_attempt_at ASC ensures FIFO drain and prevents starvation.
    const rows = await tx
      .select()
      .from(providerOutboundQueue)
      .where(
        and(
          lte(providerOutboundQueue.nextAttemptAt, sql`NOW()`),
          isNull(providerOutboundQueue.parkedAt),
          isNull(providerOutboundQueue.succeededAt),
        ),
      )
      .orderBy(providerOutboundQueue.nextAttemptAt)
      .limit(1)
      .for('update', { skipLocked: true });

    const row = rows[0];
    if (!row) return null;

    await tx
      .update(providerOutboundQueue)
      .set({
        nextAttemptAt: sql`NOW() + (${CLAIM_VISIBILITY_SECS} * interval '1 second')`,
      })
      .where(eq(providerOutboundQueue.id, row.id));

    logger.info({ msg: 'claimNext', id: row.id, kind: row.kind });
    return row;
  });
}

/**
 * Mark a queue row as successfully processed.
 */
export async function markSucceeded(id) {
  const [row] = await db
    .update(providerOutboundQueue)
    .set({ succeededAt: sql`NOW()` })
    .where(eq(providerOutboundQueue.id, id))
    .returning();
  logger.info({ msg: 'markSucceeded', id });
  return row;
}

/**
 * Mark a queue row as failed. Owns all attempt/backoff accounting
 * (claimNext only sets a short visibility timeout and never mutates counters).
 * - Ordinary failure: increments `attempts`; backoff = least(300, 2 ^ attempts) seconds.
 * - Rate-limited:     increments `rate_limited_attempts` only; backoff uses
 *                     `rate_limited_attempts` (or `retryAfter` when provided by GitHub).
 */
export async function markFailed(id, { error, rateLimited = false, retryAfter = null }) {
  let row;
  if (rateLimited) {
    const useRetryAfter = retryAfter != null && !Number.isNaN(Number(retryAfter));
    const nextAttemptSql = useRetryAfter
      ? sql`NOW() + (${Number(retryAfter)} * interval '1 second')`
      : sql`NOW() + (LEAST(300, power(2, ${providerOutboundQueue.rateLimitedAttempts} + 1)) * interval '1 second')`;
    [row] = await db
      .update(providerOutboundQueue)
      .set({
        rateLimitedAttempts: sql`${providerOutboundQueue.rateLimitedAttempts} + 1`,
        lastError: error,
        nextAttemptAt: nextAttemptSql,
      })
      .where(eq(providerOutboundQueue.id, id))
      .returning();
  } else {
    [row] = await db
      .update(providerOutboundQueue)
      .set({
        attempts: sql`${providerOutboundQueue.attempts} + 1`,
        lastError: error,
        nextAttemptAt: sql`NOW() + (LEAST(300, power(2, ${providerOutboundQueue.attempts} + 1)) * interval '1 second')`,
      })
      .where(eq(providerOutboundQueue.id, id))
      .returning();
  }
  logger.info({ msg: 'markFailed', id, rateLimited, error });
  return row;
}

/**
 * Park all open queue rows for a given installation (e.g. on suspend).
 */
export async function parkForInstallation(installationId) {
  await db
    .update(providerOutboundQueue)
    .set({ parkedAt: sql`NOW()` })
    .where(
      and(
        eq(providerOutboundQueue.installationId, installationId),
        isNull(providerOutboundQueue.succeededAt),
        isNull(providerOutboundQueue.parkedAt),
      ),
    );
  logger.info({ msg: 'parkForInstallation', installationId });
}

/**
 * Un-park queue rows for an installation, only those newer than sinceHours.
 */
export async function unparkForInstallation(installationId, sinceHours = 24) {
  await db
    .update(providerOutboundQueue)
    .set({ parkedAt: null })
    .where(
      and(
        eq(providerOutboundQueue.installationId, installationId),
        sql`${providerOutboundQueue.parkedAt} IS NOT NULL`,
        sql`${providerOutboundQueue.createdAt} >= NOW() - (${sinceHours} * interval '1 hour')`,
      ),
    );
  logger.info({ msg: 'unparkForInstallation', installationId, sinceHours });
}
