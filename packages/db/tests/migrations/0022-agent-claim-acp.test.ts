import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { closePool, getPool } from '../../src/pool.js';
import { runMigrations } from '../../src/migrate.js';
import {
  resetCollabSchema,
  resolveCollabTestDatabaseUrl,
} from '../helpers/collab-db.js';

const dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.resolve(dirname, '../../src/migrations');
const migrationPath = path.join(migrationsDir, '0022_agent_claim_acp.sql');
const journalPath = path.join(migrationsDir, 'meta/_journal.json');

process.env.DATABASE_URL = resolveCollabTestDatabaseUrl();
const databaseUrl = process.env.DATABASE_URL;

const expectedColumns = {
  agent_claim_events: ['org_id', 'claim_id', 'seq', 'kind', 'payload', 'created_at'],
  agent_claim_requests: [
    'org_id',
    'claim_id',
    'request_key',
    'kind',
    'payload',
    'status',
    'response',
    'created_at',
    'resolved_at',
  ],
  agent_claim_commands: [
    'org_id',
    'claim_id',
    'idempotency_key',
    'request_key',
    'kind',
    'payload',
    'status',
    'result',
    'created_at',
    'delivered_at',
    'acked_at',
  ],
  collab_claim_executions: [
    'task_id',
    'project_id',
    'claim_id',
    'root_claim_id',
    'created_by_principal_id',
    'created_at',
  ],
} as const;

describe('migration 0022 agent claim ACP interactions', () => {
  beforeAll(async () => {
    await resetCollabSchema(databaseUrl);
    await runMigrations();
  });

  afterAll(async () => {
    await closePool();
  });

  it('is the journal entry immediately following migration 0021', async () => {
    await expect(fs.access(migrationPath)).resolves.toBeUndefined();
    const journal = JSON.parse(await fs.readFile(journalPath, 'utf8')) as {
      entries: Array<{ idx: number; tag: string }>;
    };
    const previous = journal.entries.find((entry) => entry.tag === '0021_collab_project_overviews');
    const current = journal.entries.find((entry) => entry.tag === '0022_agent_claim_acp');

    expect(previous).toBeDefined();
    expect(current).toEqual(expect.objectContaining({ idx: 22, tag: '0022_agent_claim_acp' }));
    expect(current!.idx).toBe(previous!.idx + 1);
  });

  it('adds the four interaction tables with the designed columns', async () => {
    const { rows } = await getPool().query<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name
       FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = ANY($1::text[])
       ORDER BY ordinal_position`,
      [Object.keys(expectedColumns)],
    );

    for (const [table, columns] of Object.entries(expectedColumns)) {
      expect(rows.filter((row) => row.table_name === table).map((row) => row.column_name)).toEqual(
        expect.arrayContaining(columns),
      );
    }
  });

  it('enforces claim-scoped replay identities and one collaboration link per claim', async () => {
    const { rows } = await getPool().query<{ table_name: string; columns: string[] }>(
      `SELECT tab.relname AS table_name,
              array_agg(att.attname::text ORDER BY keys.ordinality) AS columns
       FROM pg_index idx
       JOIN pg_class tab ON tab.oid = idx.indrelid
       JOIN pg_namespace ns ON ns.oid = tab.relnamespace
       JOIN LATERAL unnest(idx.indkey) WITH ORDINALITY AS keys(attnum, ordinality) ON true
       JOIN pg_attribute att ON att.attrelid = tab.oid AND att.attnum = keys.attnum
       WHERE ns.nspname = 'public'
         AND idx.indisunique
         AND tab.relname = ANY($1::text[])
       GROUP BY tab.relname, idx.indexrelid`,
      [Object.keys(expectedColumns)],
    );

    expect(rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ table_name: 'agent_claim_events', columns: ['org_id', 'claim_id', 'seq'] }),
      expect.objectContaining({ table_name: 'agent_claim_requests', columns: ['org_id', 'claim_id', 'request_key'] }),
      expect.objectContaining({ table_name: 'agent_claim_commands', columns: ['org_id', 'claim_id', 'idempotency_key'] }),
      expect.objectContaining({ table_name: 'collab_claim_executions', columns: ['claim_id'] }),
    ]));
  });

  it('ties every interaction and collaboration link to an existing claim', async () => {
    const { rows } = await getPool().query<{ table_name: string; column_name: string; foreign_table: string }>(
      `SELECT tc.table_name, kcu.column_name, ccu.table_name AS foreign_table
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON kcu.constraint_schema = tc.constraint_schema
        AND kcu.constraint_name = tc.constraint_name
       JOIN information_schema.constraint_column_usage ccu
         ON ccu.constraint_schema = tc.constraint_schema
        AND ccu.constraint_name = tc.constraint_name
       WHERE tc.constraint_schema = 'public'
         AND tc.constraint_type = 'FOREIGN KEY'
         AND tc.table_name = ANY($1::text[])
         AND kcu.column_name IN ('claim_id', 'root_claim_id')`,
      [Object.keys(expectedColumns)],
    );

    for (const table of Object.keys(expectedColumns)) {
      expect(rows).toContainEqual(expect.objectContaining({
        table_name: table,
        column_name: 'claim_id',
        foreign_table: 'agent_claims',
      }));
    }
    expect(rows).toContainEqual(expect.objectContaining({
      table_name: 'collab_claim_executions',
      column_name: 'root_claim_id',
      foreign_table: 'agent_claims',
    }));
  });
});
