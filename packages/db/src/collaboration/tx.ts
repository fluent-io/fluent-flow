import type { PoolClient } from 'pg';
import { getPool } from '../pool.js';

/**
 * Explicit client transaction over the shared pg pool (repo convention: raw
 * pg + BEGIN/COMMIT/ROLLBACK, no ORM transaction API). ROLLBACK on any error;
 * the error always propagates.
 */
export async function withClientTransaction<T>(
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
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
