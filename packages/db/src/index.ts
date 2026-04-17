// Legacy raw-pg exports — kept during the drizzle migration. New code should
// prefer `db` and `schema` below.
export { getPool, query, closePool } from './pool.js';
export * from './schemas/index.js';
export * from './queries/index.js';

// Drizzle client + schema.
export { db, pool, schema, sql, withTransaction } from './client.js';
export { runMigrations } from './migrate.js';
