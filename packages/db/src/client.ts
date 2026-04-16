import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema/index.js';

export type Schema = typeof schema;
export type Database = NodePgDatabase<Schema>;
export type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];

const { Pool } = pg;

// Fail fast in any non-test environment if DATABASE_URL isn't set, so a missing
// env var can't silently connect to a local dev DB in prod/staging.
function resolveDatabaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (url) return url;
  const isTest = process.env.NODE_ENV === 'test' || process.env.VITEST === 'true';
  if (isTest) return 'postgres://fluentflow:password@localhost:5432/fluentflow';
  throw new Error('DATABASE_URL environment variable must be set');
}

function parsePoolNumber(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

// Defaults carried over from the legacy raw-pg pool (pre-Drizzle):
// max=10, idleTimeoutMillis=30s, connectionTimeoutMillis=5s. Overridable via
// PGPOOL_* env vars for deployments that need different limits.
export const pool = new Pool({
  connectionString: resolveDatabaseUrl(),
  max: parsePoolNumber(process.env.PGPOOL_MAX, 10),
  idleTimeoutMillis: parsePoolNumber(process.env.PGPOOL_IDLE_TIMEOUT_MILLIS, 30_000),
  connectionTimeoutMillis: parsePoolNumber(process.env.PGPOOL_CONNECTION_TIMEOUT_MILLIS, 5_000),
});

// Without this handler a disconnected idle client crashes the process with an
// unhandled 'error' event. Logging keeps the process alive and alerts ops.
pool.on('error', (error) => {
  console.error('Unexpected error on idle PostgreSQL client', error);
});

/**
 * Drizzle DB instance — preferred for all new code.
 * Usage:
 *   import { db, schema } from '@fluent-flow/db';
 *   await db.insert(schema.orgs).values({ id: 'acme', name: 'ACME' });
 */
export const db = drizzle(pool, { schema });

export { schema };
export { sql } from 'drizzle-orm';

/**
 * Run `fn` inside a Postgres transaction. Rolls back on throw.
 */
export async function withTransaction<T>(fn: (tx: Transaction) => Promise<T>): Promise<T> {
  return db.transaction(fn);
}
