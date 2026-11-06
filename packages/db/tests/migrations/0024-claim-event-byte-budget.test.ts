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
const migrationPath = path.join(migrationsDir, '0024_claim_event_byte_budget.sql');
const journalPath = path.join(migrationsDir, 'meta/_journal.json');

process.env.DATABASE_URL = resolveCollabTestDatabaseUrl();
const databaseUrl = process.env.DATABASE_URL;

describe('migration 0024 claim event byte budget', () => {
  beforeAll(async () => {
    await resetCollabSchema(databaseUrl);
    await runMigrations();
  });

  afterAll(async () => {
    await closePool();
  });

  it('follows the claim idempotency migration', async () => {
    await expect(fs.access(migrationPath)).resolves.toBeUndefined();
    const journal = JSON.parse(await fs.readFile(journalPath, 'utf8')) as {
      entries: Array<{ idx: number; tag: string }>;
    };
    const previous = journal.entries.find((entry) => entry.tag === '0023_collab_claim_idempotency');
    const current = journal.entries.find((entry) => entry.tag === '0024_claim_event_byte_budget');

    expect(previous).toBeDefined();
    expect(current).toEqual(expect.objectContaining({
      idx: previous!.idx + 1,
      tag: '0024_claim_event_byte_budget',
    }));
  });

  it('stores a nonnegative byte count for every event payload', async () => {
    const columns = await getPool().query<{
      column_name: string;
      data_type: string;
      is_nullable: string;
      is_generated: string;
    }>(
      `SELECT column_name, data_type, is_nullable, is_generated
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'agent_claim_events'
         AND column_name = 'payload_bytes'`,
    );
    const constraints = await getPool().query<{ definition: string }>(
      `SELECT pg_get_constraintdef(oid) AS definition
       FROM pg_constraint
       WHERE conrelid = 'agent_claim_events'::regclass
         AND contype = 'c'`,
    );

    expect(columns.rows).toEqual([{
      column_name: 'payload_bytes',
      data_type: 'integer',
      is_nullable: 'NO',
      is_generated: 'ALWAYS',
    }]);
    expect(constraints.rows.some((row) => row.definition.includes('payload_bytes >= 0'))).toBe(true);

    await getPool().query(`INSERT INTO orgs (id, name) VALUES ('byte-budget-org', 'Byte Budget Org')`);
    const claim = await getPool().query<{ id: number }>(
      `INSERT INTO agent_claims (org_id, repo, attempt, claim_type, status, payload)
       VALUES ('byte-budget-org', 'acme/bytes', 1, 'spec', 'pending', '{}')
       RETURNING id`,
    );
    const payload = { nested: { alpha: 'a: b', beta: [1, true, null] }, text: 'µ' };
    const event = await getPool().query<{ payload_bytes: number; canonical_bytes: number }>(
      `INSERT INTO agent_claim_events (org_id, claim_id, seq, kind, payload)
       VALUES ('byte-budget-org', $1, 1, 'notice', $2)
       RETURNING payload_bytes, octet_length(payload::text) AS canonical_bytes`,
      [claim.rows[0].id, JSON.stringify(payload)],
    );
    expect(event.rows[0].payload_bytes).toBe(event.rows[0].canonical_bytes);
  });
});
