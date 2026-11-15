import type { PoolClient } from 'pg';
import { getPool } from '../pool.js';

export async function withClientTransaction<T>(
  fn: (client: PoolClient) => Promise<T>,
  executor?: PoolClient,
): Promise<T> {
  if (executor) return fn(executor);
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    try {
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    }
  } finally {
    client.release();
  }
}
