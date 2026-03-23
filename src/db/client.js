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
  const pool = getPool();
  const migrations = ['001_initial.sql', '002_audit_log.sql', '003_mcp_pending.sql'];
  for (const file of migrations) {
    const migrationPath = join(__dirname, 'migrations', file);
    const sql = readFileSync(migrationPath, 'utf8');
    await pool.query(sql);
    console.log({ msg: 'Migration applied', file });
  }
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

/**
 * Write an audit log entry (fire-and-forget — never throws).
 * @param {string} eventType - e.g. 'webhook_received', 'state_transition', 'agent_woken'
 * @param {object} [opts]
 * @param {string} [opts.repo] - "owner/repo"
 * @param {string} [opts.actor]
 * @param {object} [opts.data] - Any additional JSON data
 */
export function audit(eventType, { repo, actor, data } = {}) {
  query(
    `INSERT INTO audit_log (event_type, repo, actor, data) VALUES ($1, $2, $3, $4)`,
    [eventType, repo ?? null, actor ?? null, data ? JSON.stringify(data) : null]
  ).catch((err) => {
    console.error({ msg: 'audit log write failed', eventType, error: err.message });
  });
}
