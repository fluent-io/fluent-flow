import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema/index.js';

export type Schema = typeof schema;
export type Database = NodePgDatabase<Schema>;
export type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];

const { Pool } = pg;

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://fluentflow:password@localhost:5432/fluentflow';

export const pool = new Pool({ connectionString: DATABASE_URL });

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
