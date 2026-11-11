import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePool, getPool } from '../../src/pool.js';
import { runMigrations } from '../../src/migrate.js';
import {
  resetCollabSchema,
  resolveCollabTestDatabaseUrl,
} from '../helpers/collab-db.js';

process.env.DATABASE_URL = resolveCollabTestDatabaseUrl();
const databaseUrl = process.env.DATABASE_URL;

describe('migration 0027 collab principal constraint names', () => {
  beforeAll(async () => {
    await resetCollabSchema(databaseUrl);
    await runMigrations();
  });

  afterAll(async () => {
    await closePool();
  });

  it('names the collab org/user link constraints and indexes without the legacy qualifier', async () => {
    const constraints = await getPool().query<{ conname: string; definition: string }>(
      `SELECT conname, pg_get_constraintdef(oid) AS definition
       FROM pg_constraint
       WHERE conrelid IN ('collab_principals'::regclass, 'collab_workspaces'::regclass)
       ORDER BY conname`,
    );
    const indexes = await getPool().query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes
       WHERE schemaname = 'public' AND tablename IN ('collab_principals', 'collab_workspaces')`,
    );

    expect(constraints.rows.map((row) => row.conname).filter((name) => name.includes('legacy'))).toEqual([]);
    expect(indexes.rows.map((row) => row.indexname).filter((name) => name.includes('legacy'))).toEqual([]);
    expect(constraints.rows).toEqual(expect.arrayContaining([
      { conname: 'collab_principals_user_id_key', definition: 'UNIQUE (user_id)' },
      { conname: 'collab_principals_user_id_fkey', definition: 'FOREIGN KEY (user_id) REFERENCES users(id)' },
    ]));
  });
});
