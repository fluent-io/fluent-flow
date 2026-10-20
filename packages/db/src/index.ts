// Legacy raw-pg exports — kept during the drizzle migration. New code should
// prefer `db` and `schema` below.
export { getPool, query, closePool } from './pool.js';
export * from './schemas/index.js';
export * from './queries/index.js';

// Drizzle client + schema.
export { db, pool, schema, sql, withTransaction } from './client.js';
export { runMigrations } from './migrate.js';

// Collaboration — server-only (never import from client bundles).
export * from './collaboration/index.js';

// A4 evidence/workpad module (content by B; registration wiring by A).
export * from './collaboration/evidence.js';
