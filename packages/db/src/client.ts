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

export const pool = new Pool({ connectionString: resolveDatabaseUrl() });

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
