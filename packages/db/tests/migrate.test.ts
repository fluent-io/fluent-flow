import { describe, it, expect, vi, beforeEach } from 'vitest';
import { stampBaselineIfLiveDb, computeBaselineHash } from '../src/migrate.js';
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import crypto from 'node:crypto';

interface QueryCall {
  sql: string;
  params?: unknown[];
}

function makePool(scriptedRows: Record<string, unknown[]>) {
  const calls: QueryCall[] = [];
  return {
    calls,
    async query<T = unknown>(sql: string, params?: unknown[]) {
      calls.push({ sql, params });
      for (const [pattern, rows] of Object.entries(scriptedRows)) {
        if (sql.includes(pattern)) return { rows: rows as T[] };
      }
      return { rows: [] as T[] };
    },
  };
}

async function makeFakeMigrationsDir(hash = 'deadbeef'): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ff-migrations-'));
  await fs.mkdir(path.join(dir, 'meta'), { recursive: true });
  await fs.writeFile(
    path.join(dir, 'meta', '_journal.json'),
    JSON.stringify({
      entries: [{ idx: 0, tag: '0000_baseline', when: 0, hash }],
    }),
  );
  return dir;
}

describe('stampBaselineIfLiveDb', () => {
  let migrationsDir: string;
  beforeEach(async () => {
    migrationsDir = await makeFakeMigrationsDir();
  });

  it('does nothing on a fresh DB (no core tables)', async () => {
    const pool = makePool({
      "table_name = $1": [{ exists: false }],
    });
    await stampBaselineIfLiveDb({ pool, migrationsDir });
    // Only the two tableExists probes — no INSERT, no CREATE TABLE.
    expect(pool.calls.every((c) => c.sql.includes('information_schema.tables'))).toBe(true);
    expect(pool.calls.some((c) => c.sql.includes('INSERT INTO'))).toBe(false);
    expect(pool.calls.some((c) => c.sql.includes('CREATE TABLE'))).toBe(false);
  });

  it('stamps when live DB has legacy baseline tables but no drizzle tracking', async () => {
    const pool = makePool({});
    const originalQuery = pool.query.bind(pool);
    pool.query = async <T = unknown>(sql: string, params?: unknown[]) => {
      if (sql.includes('information_schema.tables')) {
        const tableName = params?.[0];
        if (tableName === '__drizzle_migrations') return { rows: [{ exists: false }] as T[] };
        if (tableName === 'orgs') return { rows: [{ exists: true }] as T[] };
        if (tableName === 'provider_installations') return { rows: [{ exists: false }] as T[] };
      }
      return originalQuery(sql, params);
    };
    await stampBaselineIfLiveDb({ pool, migrationsDir });
    const sqls = pool.calls.map((c) => c.sql);
    expect(sqls.some((s) => s.includes('CREATE TABLE IF NOT EXISTS public.__drizzle_migrations'))).toBe(true);
    // Unique index on hash is required for ON CONFLICT (hash) to fire under
    // concurrent first-boot; without it duplicate baseline stamps could slip in.
    expect(sqls.some((s) => s.includes('CREATE UNIQUE INDEX IF NOT EXISTS __drizzle_migrations_hash_idx'))).toBe(true);
    const insert = pool.calls.find((c) => c.sql.includes('INSERT INTO public.__drizzle_migrations'));
    expect(insert).toBeDefined();
    expect(insert!.sql).toContain('ON CONFLICT (hash) DO NOTHING');
    expect(insert!.params?.[0]).toBe('deadbeef');
  });

  it('stamps when provider_installations exists but orgs does not', async () => {
    const pool = makePool({});
    const originalQuery = pool.query.bind(pool);
    pool.query = async <T = unknown>(sql: string, params?: unknown[]) => {
      if (sql.includes('information_schema.tables')) {
        const tableName = params?.[0];
        if (tableName === '__drizzle_migrations') return { rows: [{ exists: false }] as T[] };
        if (tableName === 'orgs') return { rows: [{ exists: false }] as T[] };
        if (tableName === 'provider_installations') return { rows: [{ exists: true }] as T[] };
      }
      return originalQuery(sql, params);
    };
    await stampBaselineIfLiveDb({ pool, migrationsDir });
    expect(pool.calls.some((c) => c.sql.includes('INSERT INTO public.__drizzle_migrations'))).toBe(true);
  });

  it('does nothing when drizzle table already has rows (already migrated)', async () => {
    let probeCount = 0;
    const pool = {
      calls: [] as QueryCall[],
      async query<T = unknown>(sql: string, params?: unknown[]) {
        pool.calls.push({ sql, params });
        if (sql.includes('information_schema.tables')) {
          probeCount++;
          return { rows: [{ exists: true }] as T[] }; // both tables exist
        }
        if (sql.includes('COUNT(*)::text AS count')) {
          return { rows: [{ count: '3' }] as T[] }; // already-applied migrations
        }
        return { rows: [] as T[] };
      },
    };
    await stampBaselineIfLiveDb({ pool, migrationsDir });
    expect(pool.calls.some((c) => c.sql.includes('INSERT INTO public.__drizzle_migrations'))).toBe(false);
    expect(pool.calls.some((c) => c.sql.includes('CREATE TABLE'))).toBe(false);
  });
});

describe('computeBaselineHash', () => {
  it('returns the journal hash when present', async () => {
    const dir = await makeFakeMigrationsDir('journal-hash-abc');
    expect(await computeBaselineHash(dir)).toBe('journal-hash-abc');
  });

  it('falls back to sha256 of the .sql file when journal has no hash', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ff-migrations-'));
    await fs.mkdir(path.join(dir, 'meta'), { recursive: true });
    await fs.writeFile(
      path.join(dir, 'meta', '_journal.json'),
      JSON.stringify({ entries: [{ idx: 0, tag: '0000_baseline', when: 0 }] }),
    );
    const content = 'CREATE TABLE foo (id int);';
    await fs.writeFile(path.join(dir, '0000_baseline.sql'), content);
    const expected = crypto.createHash('sha256').update(content).digest('hex');
    expect(await computeBaselineHash(dir)).toBe(expected);
  });

  it('throws if there is no baseline entry', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ff-migrations-'));
    await fs.mkdir(path.join(dir, 'meta'), { recursive: true });
    await fs.writeFile(path.join(dir, 'meta', '_journal.json'), JSON.stringify({ entries: [] }));
    await expect(computeBaselineHash(dir)).rejects.toThrow(/baseline/i);
  });
});
