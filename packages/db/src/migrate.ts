import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { sql } from 'drizzle-orm';
import { db, pool } from './client.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(__dirname, './migrations');

/**
 * Baseline-aware migrator.
 *
 * The live DB was provisioned by 17 homegrown `.sql` files; drizzle-kit was then
 * introspected against the live schema to produce the `0000_baseline.sql`
 * checked in under src/migrations. On a *live* DB we must NOT re-run the
 * baseline (the DDL already exists), so we stamp `__drizzle_migrations` with
 * the baseline hash on first boot; on a *fresh* DB (no core tables yet) we let
 * the migrator run normally.
 *
 * After the baseline, normal drizzle-kit generated migrations run on every
 * boot in both environments.
 */
export async function runMigrations(): Promise<void> {
  await stampBaselineIfLiveDb();
  await migrate(db, { migrationsFolder: MIGRATIONS_DIR });
}

async function stampBaselineIfLiveDb(): Promise<void> {
  // Only stamp if __drizzle_migrations is empty/missing AND core tables already exist.
  const drizzleTableExists = await tableExists('__drizzle_migrations');
  const providerInstallationsExists = await tableExists('provider_installations');

  if (drizzleTableExists) {
    const { rows } = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM public.__drizzle_migrations`
    );
    if (Number(rows[0]?.count ?? 0) > 0) {
      return; // already migrated (either stamped or real migrations applied)
    }
  }

  if (!providerInstallationsExists) {
    return; // fresh DB — let the migrator run the baseline normally
  }

  // Live DB without drizzle tracking: stamp the baseline so migrator skips it.
  await ensureDrizzleMigrationsTable();
  const baselineHash = await computeBaselineHash();
  await pool.query(
    `INSERT INTO public.__drizzle_migrations (hash, created_at) VALUES ($1, $2)
     ON CONFLICT DO NOTHING`,
    [baselineHash, Date.now()]
  );
}

async function tableExists(name: string): Promise<boolean> {
  const { rows } = await pool.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = $1
     ) AS exists`,
    [name]
  );
  return rows[0]?.exists ?? false;
}

async function ensureDrizzleMigrationsTable(): Promise<void> {
  // Mirrors drizzle-orm's internal schema — node-postgres dialect.
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS public.__drizzle_migrations (
      id SERIAL PRIMARY KEY,
      hash TEXT NOT NULL,
      created_at BIGINT
    )
  `);
}

/**
 * The migrator hashes the baseline SQL file content to dedupe. We hash the
 * same file here so the stamped row matches what migrate() would compare
 * against. If the baseline file changes, the hash changes, and the migrator
 * would try to re-apply — by design; editing an already-applied migration is
 * exactly the footgun this redesign exists to prevent.
 */
async function computeBaselineHash(): Promise<string> {
  const journal = path.join(MIGRATIONS_DIR, 'meta', '_journal.json');
  try {
    const j = JSON.parse(await fs.readFile(journal, 'utf8')) as {
      entries: Array<{ idx: number; tag: string; when: number; hash?: string }>;
    };
    const baseline = j.entries[0];
    if (!baseline) throw new Error('no baseline entry in _journal.json');
    if (baseline.hash) return baseline.hash;
    // drizzle-kit writes the hash into the snapshot file; if absent, fall back
    // to hashing the .sql file itself.
    const sqlFile = path.join(MIGRATIONS_DIR, `${baseline.tag}.sql`);
    const content = await fs.readFile(sqlFile, 'utf8');
    return crypto.createHash('sha256').update(content).digest('hex');
  } catch (err) {
    throw new Error(
      `Cannot compute baseline hash: ${(err as Error).message}. ` +
        `Run \`npx drizzle-kit generate\` to produce the baseline first.`
    );
  }
}
