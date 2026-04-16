// Legacy raw-pg exports — kept during the drizzle migration. New code should
// prefer `db` and `schema` below.
export { getPool, query, closePool } from './pool';
export * from './schemas/index';
export * from './queries/index';

// Drizzle client + schema.
export { db, pool, schema, sql, withTransaction } from './client.js';
export { runMigrations } from './migrate.js';
