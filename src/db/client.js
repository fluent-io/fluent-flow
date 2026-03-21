import pg from 'pg';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const { Pool } = pg;

const __dirname = dirname(fileURLToPath(import.meta.url));

let pool;

export function getPool() {
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
    });

    pool.on('error', (err) => {
      console.error({ msg: 'Unexpected pg pool error', error: err.message });
    });
  }
  return pool;
}

export async function query(text, params) {
  const client = getPool();
  return client.query(text, params);
}

export async function runMigrations() {
  const migrationPath = join(__dirname, 'migrations', '001_initial.sql');
  const sql = readFileSync(migrationPath, 'utf8');
  const pool = getPool();
  await pool.query(sql);
  console.log({ msg: 'Database migrations applied' });
}

export async function closePool() {
  if (pool) {
    await pool.end();
    pool = null;
    console.log({ msg: 'Database pool closed' });
  }
}

export async function healthCheck() {
  const result = await query('SELECT 1 AS ok');
  return result.rows[0].ok === 1;
}
