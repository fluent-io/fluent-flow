import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { db, pool } from './client.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(__dirname, './migrations');

/** Minimal pool surface used by the stamper — lets tests inject a fake. */
export interface StampablePool {
  query<T = unknown>(text: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

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
  await stampBaselineIfLiveDb({ pool: pool as unknown as StampablePool, migrationsDir: MIGRATIONS_DIR });
  await migrate(db, { migrationsFolder: MIGRATIONS_DIR });
}

/**
 * Stamp `__drizzle_migrations` on a live DB so the migrator skips the baseline.
 * Exported + dependency-injected for unit testability.
 *
 * Outcomes by DB state:
 *   - fresh (no core tables): no-op; caller runs `migrate()` which applies the baseline
 *   - live (core tables exist, drizzle table missing/empty): creates drizzle table, inserts baseline hash
 *   - already-migrated (drizzle table has ≥1 row): no-op
 */
export async function stampBaselineIfLiveDb({
  pool: p,
  migrationsDir,
}: {
  pool: StampablePool;
  migrationsDir: string;
}): Promise<void> {
  const drizzleTableExists = await tableExists(p, '__drizzle_migrations');
  const liveDbSentinelTables = ['orgs', 'provider_installations'];

  if (drizzleTableExists) {
    const { rows } = await p.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM public.__drizzle_migrations`
    );
    if (Number(rows[0]?.count ?? 0) > 0) return;
  }

  const liveDbSentinelResults = await Promise.all(
    liveDbSentinelTables.map((tableName) => tableExists(p, tableName))
  );
  const hasLegacySchema = liveDbSentinelResults.some(Boolean);

  if (!hasLegacySchema) return;

  await p.query(
    `CREATE TABLE IF NOT EXISTS public.__drizzle_migrations (
       id SERIAL PRIMARY KEY,
       hash TEXT NOT NULL,
       created_at BIGINT
     )`
  );
  // __drizzle_migrations has no native unique constraint on hash, so a bare
  // ON CONFLICT DO NOTHING would never fire and two concurrent instances
  // could both stamp the baseline on first boot. Add the index ourselves so
  // the insert is truly idempotent under concurrency.
  await p.query(
    `CREATE UNIQUE INDEX IF NOT EXISTS __drizzle_migrations_hash_idx
       ON public.__drizzle_migrations (hash)`
  );
  const baselineHash = await computeBaselineHash(migrationsDir);
  await p.query(
    `INSERT INTO public.__drizzle_migrations (hash, created_at) VALUES ($1, $2)
     ON CONFLICT (hash) DO NOTHING`,
    [baselineHash, Date.now()]
  );
}

async function tableExists(p: StampablePool, name: string): Promise<boolean> {
  const { rows } = await p.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = $1
     ) AS exists`,
    [name]
  );
  return rows[0]?.exists ?? false;
}

/**
 * The migrator hashes the baseline SQL file content to dedupe. We hash the
 * same file here so the stamped row matches what migrate() would compare
 * against. If the baseline file changes, the hash changes, and the migrator
 * would try to re-apply — by design; editing an already-applied migration is
 * exactly the footgun this redesign exists to prevent.
 */
export async function computeBaselineHash(migrationsDir: string): Promise<string> {
  const journal = path.join(migrationsDir, 'meta', '_journal.json');
  try {
    const j = JSON.parse(await fs.readFile(journal, 'utf8')) as {
      entries: Array<{ idx: number; tag: string; when: number; hash?: string }>;
    };
    const baseline = j.entries[0];
    if (!baseline) throw new Error('no baseline entry in _journal.json');
    if (baseline.hash) return baseline.hash;
    const sqlFile = path.join(migrationsDir, `${baseline.tag}.sql`);
    const content = await fs.readFile(sqlFile, 'utf8');
    return crypto.createHash('sha256').update(content).digest('hex');
  } catch (err) {
    throw new Error(
      `Cannot compute baseline hash: ${(err as Error).message}. ` +
        `Run \`npx drizzle-kit generate\` to produce the baseline first.`
    );
  }
}
