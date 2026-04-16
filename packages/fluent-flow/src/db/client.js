/**
 * Thin wrapper over @fluent-flow/db's drizzle client.
 * All data access now goes through the drizzle builder (`db`, `schema`, `sql`).
 * This file exists for the lifecycle helpers (runMigrations, closePool,
 * healthCheck) and the fire-and-forget audit helper.
 */
import { db, pool, schema, sql, runMigrations as drizzleRunMigrations } from '@fluent-flow/db';
import logger from '../logger.js';

export { db, pool, schema, sql };
export { withTransaction } from '@fluent-flow/db';

export async function runMigrations() {
  await drizzleRunMigrations();
  logger.info({ msg: 'Database connected, migrations applied' });
}

export async function closePool() {
  await pool.end();
  logger.info({ msg: 'Database pool closed' });
}

export async function healthCheck() {
  const result = await pool.query('SELECT 1 AS ok');
  return result.rows[0].ok === 1;
}

/**
 * Write an audit log entry (fire-and-forget — never throws).
 * @param {string} eventType
 * @param {object} [opts]
 * @param {string} [opts.repo]
 * @param {string} [opts.actor]
 * @param {object} [opts.data]
 */
export function audit(eventType, { repo, actor, data } = {}) {
  db.insert(schema.auditLog)
    .values({
      eventType,
      repo: repo ?? null,
      actor: actor ?? null,
      data: data ?? null,
    })
    .catch((err) => {
      logger.error({ msg: 'audit log write failed', eventType, error: err.message });
    });
}
