import { createHash, randomUUID, type Hash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { authorize } from './authorize.js';
import { collabActorSchema } from './principals.js';
import { CollabServiceError } from './errors.js';
import { withClientTransaction } from './tx.js';
import { getCollabRun, getSessionTimeline } from './runs.js';

type ArchiveExecutor = Pick<PoolClient, 'query'>;

const recordType = z.enum(['command', 'observation', 'run', 'session']);
export type ExecutionArchiveRecordType = z.infer<typeof recordType>;
const recordCounts = z.object({ command: z.number().int().nonnegative(), observation: z.number().int().nonnegative(), run: z.literal(1), session: z.number().int().nonnegative() }).strict();
const manifestSchema = z.object({
  id: z.string().uuid(), sourceRunId: z.string().uuid(), workspaceId: z.string().uuid(),
  orgId: z.string().nullable(), projectId: z.string().uuid(), taskId: z.string().uuid(),
  formatVersion: z.literal(1), capturedAt: z.string(), sourceState: z.string(), sourceStage: z.string(),
  sourceCreatedAt: z.string(), recordCounts, manifestSha256: z.string().regex(/^[0-9a-f]{64}$/),
  sealedAt: z.string().nullable(),
});
export type ExecutionArchiveManifest = z.infer<typeof manifestSchema>;
export interface ExecutionArchiveRecord {
  type: ExecutionArchiveRecordType;
  id: string;
  sessionId: string | null;
  sourceCreatedAt: string;
  eventKind: string | null;
  payloadJson: string;
  payloadSha256: string;
}
export interface ExecutionArchiveVerification {
  integrityValid: boolean;
  sourceMatches: boolean | null;
  issues: string[];
}

type ManifestIdentity = Omit<ExecutionArchiveManifest, 'recordCounts' | 'manifestSha256' | 'sealedAt'>;
const scopeSchema = z.object({ workspaceId: z.string().uuid(), archiveId: z.string().uuid() });
const paging = { cursor: z.string().min(1).max(1024).optional(), limit: z.number().int().positive().max(100).default(50) };
const exportCursor = z.object({ k: recordType, i: z.string().uuid() }).strict();
const timelineCursor = z.object({ t: z.string().datetime(), i: z.string().uuid() }).strict();
const utcFormat = `'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'`;
const manifestColumns = `a.id,a.source_run_id AS "sourceRunId",a.workspace_id AS "workspaceId",a.org_id AS "orgId",
  a.project_id AS "projectId",a.task_id AS "taskId",a.format_version AS "formatVersion",
  to_char(a.captured_at AT TIME ZONE 'UTC',${utcFormat}) AS "capturedAt",
  a.source_state AS "sourceState",a.source_stage AS "sourceStage",
  to_char(a.source_created_at AT TIME ZONE 'UTC',${utcFormat}) AS "sourceCreatedAt",
  a.record_counts AS "recordCounts",a.manifest_sha256 AS "manifestSha256",
  to_char(a.sealed_at AT TIME ZONE 'UTC',${utcFormat}) AS "sealedAt"`;
const archiveColumns = `record_type AS type,record_id AS id,session_id AS "sessionId",
  to_char(source_created_at AT TIME ZONE 'UTC',${utcFormat}) AS "sourceCreatedAt",
  event_kind AS "eventKind",payload_json AS "payloadJson",payload_sha256 AS "payloadSha256"`;
const sources = [
  { type: 'command', table: 'collab_connector_commands', key: 'run_id', session: 's.session_id', event: 'NULL::text' },
  { type: 'observation', table: 'collab_connector_observations', key: 'run_id', session: 's.session_id', event: 's.kind' },
  { type: 'run', table: 'collab_runs', key: 'id', session: 'NULL::uuid', event: 'NULL::text' },
  { type: 'session', table: 'collab_sessions', key: 'run_id', session: 's.id', event: 'NULL::text' },
] as const;

function missing(): never {
  throw new CollabServiceError(404, 'not_found', 'Not found.');
}
function invalidCursor(): never {
  throw new CollabServiceError(400, 'invalid_cursor', 'The cursor is invalid.');
}
function decodeCursor<T>(value: string | undefined, schema: z.ZodType<T>): T | null {
  if (value === undefined) return null;
  if (!/^[A-Za-z0-9_-]+$/.test(value)) invalidCursor();
  const bytes = Buffer.from(value, 'base64url');
  if (bytes.toString('base64url') !== value) invalidCursor();
  try {
    const parsed = schema.safeParse(JSON.parse(bytes.toString('utf8')));
    if (!parsed.success) invalidCursor();
    return parsed.data;
  } catch (error) {
    if (error instanceof SyntaxError) invalidCursor();
    throw error;
  }
}
function encodeCursor(value: unknown) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}
function payloadHash(value: string) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
function startManifestHash(manifest: ManifestIdentity) {
  return createHash('sha256').update(JSON.stringify([
    manifest.formatVersion, manifest.id, manifest.sourceRunId, manifest.workspaceId, manifest.orgId,
    manifest.projectId, manifest.taskId, manifest.capturedAt, manifest.sourceState, manifest.sourceStage, manifest.sourceCreatedAt,
  ]) + '\n');
}
function hashRecord(hash: Hash, record: ExecutionArchiveRecord) {
  hash.update(JSON.stringify([record.type, record.id, record.sessionId, record.sourceCreatedAt, record.eventKind, record.payloadSha256]) + '\n');
}
async function snapshot<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  return withClientTransaction(async client => {
    await client.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ; SET LOCAL TIME ZONE 'UTC'");
    return fn(client);
  });
}
async function sourceIdentity(client: PoolClient, workspaceId: string, runId: string) {
  const { rows } = await client.query<Omit<ManifestIdentity, 'id' | 'formatVersion' | 'capturedAt'>>(`SELECT
    r.id AS "sourceRunId",w.id AS "workspaceId",w.org_id AS "orgId",p.id AS "projectId",t.id AS "taskId",
    r.state AS "sourceState",r.stage AS "sourceStage",to_char(r.created_at AT TIME ZONE 'UTC',${utcFormat}) AS "sourceCreatedAt"
    FROM collab_runs r JOIN collab_tasks t ON t.id=r.task_id JOIN collab_projects p ON p.id=t.project_id
    JOIN collab_workspaces w ON w.id=p.workspace_id WHERE r.id=$1 AND w.id=$2`, [runId, workspaceId]);
  return rows[0] ?? null;
}
async function* sourceRecords(client: PoolClient, runId: string): AsyncGenerator<ExecutionArchiveRecord> {
  for (const source of sources) {
    let cursor: string | null = null;
    for (;;) {
      const { rows }: { rows: Omit<ExecutionArchiveRecord, 'type' | 'payloadSha256'>[] } = await client.query(`SELECT
        s.id,${source.session} AS "sessionId",to_char(s.created_at AT TIME ZONE 'UTC',${utcFormat}) AS "sourceCreatedAt",
        ${source.event} AS "eventKind",to_jsonb(s)::text AS "payloadJson"
        FROM ${source.table} s WHERE s.${source.key}=$1 AND ($2::uuid IS NULL OR s.id>$2)
        ORDER BY s.id LIMIT 100`, [runId, cursor]);
      for (const row of rows) yield { ...row, type: source.type, payloadSha256: payloadHash(row.payloadJson) };
      if (rows.length < 100) break;
      cursor = rows.at(-1)!.id;
    }
  }
}
async function loadManifest(client: ArchiveExecutor, archiveId: string, workspaceId?: string): Promise<ExecutionArchiveManifest> {
  const { rows } = await client.query(`SELECT ${manifestColumns} FROM collab_execution_archives a
    WHERE a.id=$1 AND ($2::uuid IS NULL OR a.workspace_id=$2)`, [archiveId, workspaceId ?? null]);
  if (!rows[0]) missing();
  return manifestSchema.parse(rows[0]);
}
async function authorizeArchive(client: PoolClient, actor: z.infer<typeof collabActorSchema>, manifest: ExecutionArchiveManifest) {
  const { rows } = await client.query<{ project_id: string }>('SELECT project_id FROM collab_tasks WHERE id=$1', [manifest.taskId]);
  if (!rows[0]) missing();
  await authorize(actor, { projectId: rows[0].project_id }, ['task.read', 'internal.read'], client);
}
async function* storedRecords(client: ArchiveExecutor, archiveId: string): AsyncGenerator<ExecutionArchiveRecord> {
  let cursor: { k: ExecutionArchiveRecordType; i: string } | null = null;
  for (;;) {
    const { rows }: { rows: ExecutionArchiveRecord[] } = await client.query(`SELECT ${archiveColumns} FROM collab_execution_archive_records
      WHERE archive_id=$1 AND ($2::text IS NULL OR (record_type,record_id)>($2,$3::uuid))
      ORDER BY record_type,record_id LIMIT 100`, [archiveId, cursor?.k ?? null, cursor?.i ?? null]);
    yield* rows;
    if (rows.length < 100) break;
    const last: ExecutionArchiveRecord = rows.at(-1)!;
    cursor = { k: last.type, i: last.id };
  }
}
async function verifyStored(client: ArchiveExecutor, manifest: ExecutionArchiveManifest): Promise<ExecutionArchiveVerification> {
  const issues = new Set<string>();
  const hash = startManifestHash(manifest);
  const counts: Record<ExecutionArchiveRecordType, number> = { command: 0, observation: 0, run: 0, session: 0 };
  for await (const record of storedRecords(client, manifest.id)) {
    if (payloadHash(record.payloadJson) !== record.payloadSha256) issues.add('record_hash_mismatch');
    counts[record.type] += 1;
    hashRecord(hash, record);
  }
  if (hash.digest('hex') !== manifest.manifestSha256) issues.add('manifest_hash_mismatch');
  if (recordType.options.some(type => counts[type] !== manifest.recordCounts[type])) issues.add('record_count_mismatch');
  return { integrityValid: issues.size === 0, sourceMatches: null, issues: [...issues] };
}

export async function captureLegacyRunArchive(input: { workspaceId: string; runId: string }): Promise<ExecutionArchiveManifest> {
  const parsed = z.object({ workspaceId: z.string().uuid(), runId: z.string().uuid() }).strict().parse(input);
  return snapshot(async client => {
    const identity = await sourceIdentity(client, parsed.workspaceId, parsed.runId);
    if (!identity) missing();
    const clock = await client.query<{ captured_at: string }>(`SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC',${utcFormat}) AS captured_at`);
    const manifest: ManifestIdentity = { ...identity, id: randomUUID(), formatVersion: 1, capturedAt: clock.rows[0].captured_at };
    const counts: Record<ExecutionArchiveRecordType, number> = { command: 0, observation: 0, run: 0, session: 0 };
    const hash = startManifestHash(manifest);
    for await (const record of sourceRecords(client, parsed.runId)) {
      await client.query(`INSERT INTO collab_execution_archive_records
        (archive_id,record_type,record_id,session_id,source_created_at,event_kind,payload_json,payload_sha256)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [manifest.id, record.type, record.id, record.sessionId, record.sourceCreatedAt, record.eventKind, record.payloadJson, record.payloadSha256]);
      counts[record.type] += 1;
      hashRecord(hash, record);
    }
    const manifestSha256 = hash.digest('hex');
    await client.query(`INSERT INTO collab_execution_archives
      (id,source_run_id,workspace_id,org_id,project_id,task_id,format_version,captured_at,source_state,source_stage,source_created_at,record_counts,manifest_sha256)
      VALUES ($1,$2,$3,$4,$5,$6,1,$7,$8,$9,$10,$11,$12)`, [manifest.id, manifest.sourceRunId, manifest.workspaceId, manifest.orgId, manifest.projectId, manifest.taskId, manifest.capturedAt, manifest.sourceState, manifest.sourceStage, manifest.sourceCreatedAt, JSON.stringify(counts), manifestSha256]);
    return manifestSchema.parse({ ...manifest, recordCounts: counts, manifestSha256, sealedAt: null });
  });
}

export async function verifyExecutionArchive(input: { workspaceId: string; archiveId: string; compareSource?: boolean }): Promise<ExecutionArchiveVerification> {
  const parsed = scopeSchema.extend({ compareSource: z.boolean().default(false) }).strict().parse(input);
  return snapshot(async client => {
    const manifest = await loadManifest(client, parsed.archiveId, parsed.workspaceId);
    const result = await verifyStored(client, manifest);
    if (parsed.compareSource) {
      const identity = await sourceIdentity(client, parsed.workspaceId, manifest.sourceRunId);
      if (identity) {
        const hash = startManifestHash({ ...manifest, ...identity });
        for await (const record of sourceRecords(client, manifest.sourceRunId)) hashRecord(hash, record);
        result.sourceMatches = hash.digest('hex') === manifest.manifestSha256;
      } else result.sourceMatches = false;
      if (!result.sourceMatches) result.issues.push('source_changed');
    }
    return result;
  });
}

export type ExecutionArchiveDumpEntry =
  | { kind: 'header'; format: 'fluent-flow.execution-archive'; version: 1; manifest: ExecutionArchiveManifest }
  | { kind: 'record'; record: ExecutionArchiveRecord }
  | { kind: 'complete'; archiveId: string; recordCount: number; manifestSha256: string };

const dumpFormat = 'fluent-flow.execution-archive';
const canonicalUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const canonicalTimestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const dumpManifestSchema = z.object({
  ...manifestSchema.shape,
  id: z.string().regex(canonicalUuid),
  sourceRunId: z.string().regex(canonicalUuid),
  workspaceId: z.string().regex(canonicalUuid),
  projectId: z.string().regex(canonicalUuid),
  taskId: z.string().regex(canonicalUuid),
  capturedAt: z.string().regex(canonicalTimestamp),
  sourceCreatedAt: z.string().regex(canonicalTimestamp),
  sealedAt: z.string().regex(canonicalTimestamp).nullable(),
}).strict();
const dumpHeaderSchema = z.object({
  kind: z.literal('header'), format: z.literal(dumpFormat), version: z.literal(1), manifest: dumpManifestSchema,
}).strict();
const dumpRecordSchema = z.object({
  kind: z.literal('record'),
  record: z.object({
    type: recordType,
    id: z.string().regex(canonicalUuid),
    sessionId: z.string().regex(canonicalUuid).nullable(),
    sourceCreatedAt: z.string().regex(canonicalTimestamp),
    eventKind: z.string().nullable(),
    payloadJson: z.string(),
    payloadSha256: z.string().regex(/^[0-9a-f]{64}$/),
  }).strict(),
}).strict();
const dumpCompleteSchema = z.object({
  kind: z.literal('complete'), archiveId: z.string().regex(canonicalUuid),
  recordCount: z.number().int().nonnegative(), manifestSha256: z.string().regex(/^[0-9a-f]{64}$/),
}).strict();
const recordOrder: Record<ExecutionArchiveRecordType, number> = { command: 0, observation: 1, run: 2, session: 3 };

function invalidDump(): never {
  throw new CollabServiceError(400, 'invalid_dump', 'The execution archive dump is invalid.');
}
function dumpConflict(): never {
  throw new CollabServiceError(409, 'archive_conflict', 'The execution archive dump conflicts with stored data.');
}
async function assertCanonicalParents(client: PoolClient, manifest: ExecutionArchiveManifest) {
  const { rows } = await client.query(`SELECT w.org_id FROM collab_tasks t
    JOIN collab_projects p ON p.id=t.project_id JOIN collab_workspaces w ON w.id=p.workspace_id
    WHERE t.id=$1 AND p.id=$2 AND w.id=$3`, [manifest.taskId, manifest.projectId, manifest.workspaceId]);
  if (!rows[0]) invalidDump();
  const currentOrg = rows[0].org_id ?? null;
  if (manifest.orgId !== null && manifest.orgId !== currentOrg) invalidDump();
}
function manifestMatches(stored: ExecutionArchiveManifest, manifest: ExecutionArchiveManifest) {
  return (Object.keys(manifestSchema.shape) as (keyof ExecutionArchiveManifest)[])
    .every(key => JSON.stringify(stored[key]) === JSON.stringify(manifest[key]));
}
function storedRecordMatches(stored: ExecutionArchiveRecord, record: ExecutionArchiveRecord) {
  return stored.type === record.type && stored.id === record.id && stored.sessionId === record.sessionId
    && stored.sourceCreatedAt === record.sourceCreatedAt && stored.eventKind === record.eventKind
    && stored.payloadJson === record.payloadJson && stored.payloadSha256 === record.payloadSha256;
}
const archiveSessionPayload = z.object({
  id: z.string(), run_id: z.string(), title: z.string().nullable(), state: z.string(), role: z.string(),
});
const sourceRowTime = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?(?:Z|\+00:00)$/;

function assertRecordScope(manifest: ExecutionArchiveManifest, record: ExecutionArchiveRecord) {
  if (record.type === 'run' && record.id !== manifest.sourceRunId) invalidDump();
  let payload: unknown;
  try {
    payload = JSON.parse(record.payloadJson);
  } catch (error) {
    if (error instanceof SyntaxError) invalidDump();
    throw error;
  }
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) invalidDump();
  const fields = payload as Record<string, unknown>;
  const createdAt = typeof fields.created_at === 'string' ? sourceRowTime.exec(fields.created_at) : null;
  if (!createdAt || `${createdAt[1]}.${(createdAt[2] ?? '').padEnd(6, '0')}Z` !== record.sourceCreatedAt) invalidDump();
  if (record.type !== 'observation' && record.eventKind !== null) invalidDump();
  if (record.type === 'session') {
    const session = archiveSessionPayload.safeParse(payload);
    if (!session.success) invalidDump();
    if (session.data.id !== record.id || record.sessionId !== record.id || session.data.run_id !== manifest.sourceRunId) invalidDump();
    return;
  }
  if (fields.id !== record.id) invalidDump();
  if (record.type === 'run') {
    if (record.sessionId !== null || fields.task_id !== manifest.taskId || fields.project_id !== manifest.projectId
      || record.sourceCreatedAt !== manifest.sourceCreatedAt || fields.state !== manifest.sourceState || fields.stage !== manifest.sourceStage) invalidDump();
    return;
  }
  if (fields.run_id !== manifest.sourceRunId) invalidDump();
  if ((fields.session_id ?? null) !== record.sessionId) invalidDump();
  if (record.type === 'observation' && fields.kind !== record.eventKind) invalidDump();
}
async function loadStoredManifestForReplay(client: PoolClient, manifest: ExecutionArchiveManifest): Promise<ExecutionArchiveManifest | null> {
  const { rows } = await client.query(`SELECT ${manifestColumns} FROM collab_execution_archives a WHERE a.id=$1`, [manifest.id]);
  if (!rows[0]) return null;
  if (manifest.workspaceId !== rows[0].workspaceId) dumpConflict();
  const stored = manifestSchema.parse(rows[0]);
  if (!manifestMatches(stored, manifest)) dumpConflict();
  return stored;
}
async function insertArchiveManifest(client: PoolClient, manifest: ExecutionArchiveManifest) {
  await client.query(`INSERT INTO collab_execution_archives
    (id,source_run_id,workspace_id,org_id,project_id,task_id,format_version,captured_at,source_state,source_stage,source_created_at,record_counts,manifest_sha256)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`, [
    manifest.id, manifest.sourceRunId, manifest.workspaceId, manifest.orgId, manifest.projectId, manifest.taskId,
    manifest.formatVersion, manifest.capturedAt, manifest.sourceState, manifest.sourceStage, manifest.sourceCreatedAt,
    JSON.stringify(manifest.recordCounts), manifest.manifestSha256,
  ]);
}
async function insertArchiveRecord(client: PoolClient, archiveId: string, record: ExecutionArchiveRecord) {
  await client.query(`INSERT INTO collab_execution_archive_records
    (archive_id,record_type,record_id,session_id,source_created_at,event_kind,payload_json,payload_sha256)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [archiveId, record.type, record.id, record.sessionId, record.sourceCreatedAt, record.eventKind, record.payloadJson, record.payloadSha256]);
}

export async function writeExecutionArchiveDump(
  input: { workspaceId: string; archiveId: string },
  writeEntry: (entry: ExecutionArchiveDumpEntry) => Promise<void> | void,
): Promise<void> {
  const parsed = scopeSchema.strict().parse(input);
  return snapshot(async client => {
    const manifest = await loadManifest(client, parsed.archiveId, parsed.workspaceId);
    const verification = await verifyStored(client, manifest);
    if (!verification.integrityValid) {
      throw new CollabServiceError(503, 'archive_integrity_error', 'Execution history is unavailable. Contact support.');
    }
    await writeEntry({ kind: 'header', format: dumpFormat, version: 1, manifest });
    let total = 0;
    for await (const record of storedRecords(client, manifest.id)) {
      await writeEntry({ kind: 'record', record });
      total += 1;
    }
    const expected = recordType.options.reduce((sum, type) => sum + manifest.recordCounts[type], 0);
    if (total !== expected) {
      throw new CollabServiceError(503, 'archive_integrity_error', 'Execution history is unavailable. Contact support.');
    }
    await writeEntry({ kind: 'complete', archiveId: manifest.id, recordCount: total, manifestSha256: manifest.manifestSha256 });
  });
}

export async function restoreExecutionArchiveDump(
  input: { workspaceId: string },
  entries: AsyncIterable<unknown>,
): Promise<ExecutionArchiveManifest> {
  const parsed = z.object({ workspaceId: z.string().uuid() }).strict().parse(input);
  return snapshot(async client => {
    const iterator = entries[Symbol.asyncIterator]();
    const first = await iterator.next();
    if (first.done) invalidDump();
    const header = dumpHeaderSchema.safeParse(first.value);
    if (!header.success) invalidDump();
    const manifest = header.data.manifest;
    if (manifest.workspaceId !== parsed.workspaceId) invalidDump();
    await assertCanonicalParents(client, manifest);
    const existing = await loadStoredManifestForReplay(client, manifest);
    const stored = existing ? storedRecords(client, manifest.id)[Symbol.asyncIterator]() : null;
    const hash = startManifestHash(manifest);
    const counts: Record<ExecutionArchiveRecordType, number> = { command: 0, observation: 0, run: 0, session: 0 };
    const sessionIds = new Set<string>();
    const referencedSessions = new Set<string>();
    let lastOrder = -1;
    let lastId = '';
    let total = 0;
    let manifestInserted = false;
    for (;;) {
      const next = await iterator.next();
      if (next.done) invalidDump();
      const complete = dumpCompleteSchema.safeParse(next.value);
      if (complete.success) {
        if (complete.data.archiveId !== manifest.id) invalidDump();
        if (complete.data.recordCount !== total) invalidDump();
        if (complete.data.manifestSha256 !== manifest.manifestSha256) invalidDump();
        if (hash.digest('hex') !== manifest.manifestSha256) invalidDump();
        for (const type of recordType.options) {
          if (counts[type] !== manifest.recordCounts[type]) invalidDump();
        }
        for (const sessionId of referencedSessions) {
          if (!sessionIds.has(sessionId)) invalidDump();
        }
        if (stored && !(await stored.next()).done) dumpConflict();
        const trailing = await iterator.next();
        if (!trailing.done) invalidDump();
        break;
      }
      const entry = dumpRecordSchema.safeParse(next.value);
      if (!entry.success) invalidDump();
      const record = entry.data.record;
      const order = recordOrder[record.type];
      if (order < lastOrder || (order === lastOrder && record.id <= lastId)) invalidDump();
      lastOrder = order;
      lastId = record.id;
      counts[record.type] += 1;
      total += 1;
      hashRecord(hash, record);
      if (payloadHash(record.payloadJson) !== record.payloadSha256) invalidDump();
      assertRecordScope(manifest, record);
      if (record.type === 'session') sessionIds.add(record.id);
      else if (record.sessionId) referencedSessions.add(record.sessionId);
      if (stored) {
        const current = await stored.next();
        if (current.done || !storedRecordMatches(current.value, record)) dumpConflict();
      } else {
        if (!manifestInserted) {
          await insertArchiveManifest(client, manifest);
          manifestInserted = true;
        }
        await insertArchiveRecord(client, manifest.id, record);
      }
    }
    if (!existing && manifestInserted) {
      await client.query('UPDATE collab_execution_archives SET sealed_at=$2 WHERE id=$1', [manifest.id, manifest.sealedAt]);
    }
    return manifest;
  });
}

export async function readExecutionArchiveExportPage(input: { workspaceId: string; archiveId: string; cursor?: string; limit?: number }) {
  const parsed = scopeSchema.extend(paging).strict().parse(input);
  const cursor = decodeCursor(parsed.cursor, exportCursor);
  return snapshot(async client => {
    await loadManifest(client, parsed.archiveId, parsed.workspaceId);
    if (cursor) {
      const anchor = await client.query('SELECT 1 FROM collab_execution_archive_records WHERE archive_id=$1 AND record_type=$2 AND record_id=$3', [parsed.archiveId, cursor.k, cursor.i]);
      if (!anchor.rows[0]) invalidCursor();
    }
    const { rows } = await client.query<ExecutionArchiveRecord>(`SELECT ${archiveColumns} FROM collab_execution_archive_records
      WHERE archive_id=$1 AND ($2::text IS NULL OR (record_type,record_id)>($2,$3::uuid))
      ORDER BY record_type,record_id LIMIT $4`, [parsed.archiveId, cursor?.k ?? null, cursor?.i ?? null, parsed.limit + 1]);
    const records = rows.slice(0, parsed.limit);
    for (const record of records) {
      if (payloadHash(record.payloadJson) !== record.payloadSha256) throw new CollabServiceError(503, 'archive_integrity_error', 'Execution history is unavailable. Contact support.');
    }
    const last = records.at(-1);
    return { records, nextCursor: rows.length > parsed.limit && last ? encodeCursor({ k: last.type, i: last.id }) : null };
  });
}

export async function getCollabExecutionArchive(input: { actor: z.infer<typeof collabActorSchema>; archiveId: string }) {
  const parsed = z.object({ actor: collabActorSchema, archiveId: z.string().uuid() }).strict().parse(input);
  return snapshot(async client => {
    const manifest = await loadManifest(client, parsed.archiveId);
    await authorizeArchive(client, parsed.actor, manifest);
    return manifest;
  });
}

export async function getExecutionArchiveTimeline(input: { actor: z.infer<typeof collabActorSchema>; archiveId: string; sessionId: string; cursor?: string; limit?: number }) {
  const parsed = z.object({ actor: collabActorSchema, archiveId: z.string().uuid(), sessionId: z.string().uuid(), ...paging }).strict().parse(input);
  const cursor = decodeCursor(parsed.cursor, timelineCursor);
  if (cursor && (!Number.isFinite(Date.parse(cursor.t)) || new Date(cursor.t).toISOString().slice(0, 19) !== cursor.t.slice(0, 19))) invalidCursor();
  return snapshot(async client => {
    const manifest = await loadManifest(client, parsed.archiveId);
    await authorizeArchive(client, parsed.actor, manifest);
    const session = await client.query("SELECT 1 FROM collab_execution_archive_records WHERE archive_id=$1 AND record_type='session' AND record_id=$2", [parsed.archiveId, parsed.sessionId]);
    if (!session.rows[0]) missing();
    const verification = await verifyStored(client, manifest);
    if (!verification.integrityValid) throw new CollabServiceError(503, 'archive_integrity_error', 'Execution history is unavailable. Contact support.');
    if (cursor) {
      const anchor = await client.query(`SELECT 1 FROM collab_execution_archive_records WHERE archive_id=$1 AND record_type='observation'
        AND session_id=$2 AND record_id=$3 AND source_created_at=$4 AND event_kind IN ('timeline','attention')`, [parsed.archiveId, parsed.sessionId, cursor.i, cursor.t]);
      if (!anchor.rows[0]) invalidCursor();
    }
    const { rows } = await client.query<ExecutionArchiveRecord>(`SELECT ${archiveColumns} FROM collab_execution_archive_records
      WHERE archive_id=$1 AND record_type='observation' AND session_id=$2 AND event_kind IN ('timeline','attention')
        AND ($3::timestamptz IS NULL OR (source_created_at,record_id)>($3,$4::uuid))
      ORDER BY source_created_at,record_id LIMIT $5`, [parsed.archiveId, parsed.sessionId, cursor?.t ?? null, cursor?.i ?? null, parsed.limit + 1]);
    const page = rows.slice(0, parsed.limit);
    const entries = page.map(record => {
      const value = JSON.parse(record.payloadJson);
      return { eventId: value.event_id as string, kind: value.kind as string, payload: value.payload as Record<string, unknown>, observedAt: new Date(value.observed_at).toISOString(),
        providerCursor: value.provider_epoch != null && value.provider_seq != null ? { epoch: String(value.provider_epoch), seq: String(value.provider_seq) } : null };
    });
    const last = page.at(-1);
    const lastCursor = last ? encodeCursor({ t: last.sourceCreatedAt, i: last.id }) : parsed.cursor ?? null;
    return { entries, cursor: lastCursor, nextCursor: rows.length > parsed.limit ? lastCursor : null };
  });
}

export interface ExecutionHistoryEntry {
  runId: string;
  state: string;
  stage: string;
  createdAt: string;
  source: { kind: 'legacy'; runId: string } | { kind: 'archive'; runId: string; archiveId: string };
}
export interface ArchivedExecutionSession {
  id: string;
  runId: string;
  title: string | null;
  state: string;
  role: string;
  profileId: string | null;
  model: string | null;
  createdAt: string;
}

const historyCandidates = `WITH history AS (
  SELECT r.id AS run_id,NULL::uuid AS archive_id,r.state::text,r.stage::text,r.created_at
    FROM collab_runs r WHERE r.task_id=$1
  UNION ALL
  SELECT a.source_run_id,a.id,a.source_state,a.source_stage,a.source_created_at
    FROM collab_execution_archives a WHERE a.task_id=$1 AND a.sealed_at IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM collab_runs r WHERE r.id=a.source_run_id)
)`;

export async function listTaskExecutionHistory(input: {
  actor: z.infer<typeof collabActorSchema>; taskId: string; cursor?: string; limit?: number;
}): Promise<{ entries: ExecutionHistoryEntry[]; nextCursor: string | null }> {
  const parsed = z.object({ actor: collabActorSchema, taskId: z.string().uuid(), ...paging, cursor: z.string().uuid().optional() }).strict().parse(input);
  return snapshot(async client => {
    const task = await client.query<{ project_id: string }>('SELECT project_id FROM collab_tasks WHERE id=$1', [parsed.taskId]);
    if (!task.rows[0]) missing();
    await authorize(parsed.actor, { projectId: task.rows[0].project_id }, ['task.read'], client);
    if (parsed.cursor) {
      const anchor = await client.query(`${historyCandidates} SELECT 1 FROM history WHERE run_id=$2`, [parsed.taskId, parsed.cursor]);
      if (!anchor.rows[0]) invalidCursor();
    }
    const { rows } = await client.query<Omit<ExecutionHistoryEntry, 'source'> & { archiveId: string | null }>(`${historyCandidates},
      boundary AS (SELECT run_id,created_at FROM history WHERE run_id=$2)
      SELECT h.run_id AS \"runId\",h.archive_id AS \"archiveId\",h.state,h.stage,
        to_char(h.created_at AT TIME ZONE 'UTC',${utcFormat}) AS \"createdAt\" FROM history h
      WHERE $2::uuid IS NULL OR EXISTS (SELECT 1 FROM boundary b WHERE h.created_at<b.created_at OR (h.created_at=b.created_at AND h.run_id>b.run_id))
      ORDER BY h.created_at DESC,h.run_id LIMIT $3`, [parsed.taskId, parsed.cursor ?? null, parsed.limit + 1]);
    const page = rows.slice(0, parsed.limit);
    return { entries: page.map(({ archiveId, ...row }) => ({ ...row, source: archiveId
      ? { kind: 'archive', runId: row.runId, archiveId } : { kind: 'legacy', runId: row.runId } })),
      nextCursor: rows.length > parsed.limit ? page.at(-1)!.runId : null };
  });
}

const archivedSessionPayload = z.object({
  id: z.string().uuid(), run_id: z.string().uuid(), title: z.string().nullable(),
  state: z.string(), role: z.string(),
});

export async function listExecutionArchiveSessions(input: {
  actor: z.infer<typeof collabActorSchema>; archiveId: string; cursor?: string; limit?: number;
}): Promise<{ sessions: ArchivedExecutionSession[]; nextCursor: string | null }> {
  const parsed = z.object({ actor: collabActorSchema, archiveId: z.string().uuid(), ...paging, cursor: z.string().uuid().optional() }).strict().parse(input);
  return snapshot(async client => {
    const manifest = await loadManifest(client, parsed.archiveId);
    await authorizeArchive(client, parsed.actor, manifest);
    const verification = await verifyStored(client, manifest);
    if (!verification.integrityValid) throw new CollabServiceError(503, 'archive_integrity_error', 'Execution history is unavailable. Contact support.');
    if (parsed.cursor) {
      const anchor = await client.query("SELECT 1 FROM collab_execution_archive_records WHERE archive_id=$1 AND record_type='session' AND record_id=$2", [parsed.archiveId, parsed.cursor]);
      if (!anchor.rows[0]) invalidCursor();
    }
    const { rows } = await client.query<ExecutionArchiveRecord & { profileId: string | null; model: string | null }>(`SELECT ${archiveColumns},
      launch.profile_id AS "profileId",launch.model FROM collab_execution_archive_records s
      LEFT JOIN LATERAL (
        SELECT cmd.payload_json::jsonb #>> '{payload,profileId}' AS profile_id,
          cmd.payload_json::jsonb #>> '{payload,model}' AS model
        FROM collab_execution_archive_records cmd WHERE cmd.archive_id=s.archive_id AND cmd.session_id=s.record_id
          AND cmd.record_type='command' AND cmd.payload_json::jsonb->>'kind' IN ('launch','create_session')
        ORDER BY cmd.source_created_at,cmd.record_id LIMIT 1
      ) launch ON true
      WHERE s.archive_id=$1 AND s.record_type='session' AND ($2::uuid IS NULL OR s.record_id>$2)
      ORDER BY s.record_id LIMIT $3`, [parsed.archiveId, parsed.cursor ?? null, parsed.limit + 1]);
    const page = rows.slice(0, parsed.limit);
    const sessions = page.map(record => {
      const value = archivedSessionPayload.parse(JSON.parse(record.payloadJson));
      if (value.run_id !== manifest.sourceRunId || value.id !== record.id) throw new CollabServiceError(503, 'archive_integrity_error', 'Execution history is unavailable. Contact support.');
      return { id: value.id, runId: value.run_id, title: value.title, state: value.state, role: value.role, profileId: record.profileId, model: record.model, createdAt: record.sourceCreatedAt };
    });
    return { sessions, nextCursor: rows.length > parsed.limit ? page.at(-1)!.id : null };
  });
}

const historyScopeSchema = z.object({
  actor: collabActorSchema, taskId: z.string().uuid().toLowerCase(), runId: z.string().uuid().toLowerCase(),
});

export async function getExecutionHistoryEntry(input: z.input<typeof historyScopeSchema>): Promise<ExecutionHistoryEntry> {
  const parsed = historyScopeSchema.strict().parse(input);
  return snapshot(async client => {
    const task = await client.query<{ project_id: string }>('SELECT project_id FROM collab_tasks WHERE id=$1', [parsed.taskId]);
    if (!task.rows[0]) missing();
    await authorize(parsed.actor, { projectId: task.rows[0].project_id }, ['task.read', 'internal.read'], client);
    const { rows } = await client.query<Omit<ExecutionHistoryEntry, 'source'> & { archiveId: string | null }>(`${historyCandidates}
      SELECT h.run_id AS "runId",h.archive_id AS "archiveId",h.state,h.stage,
        to_char(h.created_at AT TIME ZONE 'UTC',${utcFormat}) AS "createdAt" FROM history h WHERE h.run_id=$2`, [parsed.taskId, parsed.runId]);
    if (!rows[0]) missing();
    const { archiveId, ...row } = rows[0];
    return { ...row, source: archiveId ? { kind: 'archive', runId: row.runId, archiveId } : { kind: 'legacy', runId: row.runId } };
  });
}

export interface ExecutionHistorySession extends Omit<ArchivedExecutionSession, 'createdAt'> {
  createdAt: string | null;
}

export async function listExecutionHistorySessions(input: z.input<typeof historyScopeSchema> & { cursor?: string; limit?: number }): Promise<{ sessions: ExecutionHistorySession[]; nextCursor: string | null }> {
  const parsed = historyScopeSchema.extend({ ...paging, cursor: z.string().uuid().optional() }).strict().parse(input);
  const entry = await getExecutionHistoryEntry({ actor: parsed.actor, taskId: parsed.taskId, runId: parsed.runId });
  if (entry.source.kind === 'archive') return listExecutionArchiveSessions({ actor: parsed.actor, archiveId: entry.source.archiveId, cursor: parsed.cursor, limit: parsed.limit });
  if (parsed.cursor) invalidCursor();
  const detail = await getCollabRun(parsed.actor, parsed.runId);
  return { sessions: detail.sessions.map(session => ({ id: session.id, runId: session.runId, title: session.title, state: session.state, role: session.role,
    profileId: null, model: null, createdAt: null })), nextCursor: null };
}

export async function getExecutionHistoryTimeline(input: z.input<typeof historyScopeSchema> & { sessionId: string; cursor?: string; limit?: number }) {
  const parsed = historyScopeSchema.extend({ sessionId: z.string().uuid().toLowerCase(), ...paging }).strict().parse(input);
  const entry = await getExecutionHistoryEntry({ actor: parsed.actor, taskId: parsed.taskId, runId: parsed.runId });
  if (entry.source.kind === 'archive') return getExecutionArchiveTimeline({ actor: parsed.actor, archiveId: entry.source.archiveId, sessionId: parsed.sessionId, cursor: parsed.cursor, limit: parsed.limit });
  const detail = await getCollabRun(parsed.actor, parsed.runId);
  if (!detail.sessions.some(session => session.id === parsed.sessionId)) missing();
  return getSessionTimeline({ actor: parsed.actor, sessionId: parsed.sessionId, cursor: parsed.cursor, limit: parsed.limit });
}

const summarySourceScope = z.object({
  actor: collabActorSchema,
  taskId: z.string().uuid().toLowerCase(),
  runId: z.string().uuid().toLowerCase(),
  sessionId: z.string().uuid().toLowerCase(),
});

export interface FrozenSummaryEntry {
  kind: string;
  payload: unknown;
  providerCursor: { epoch: string; seq: string } | null;
}

export interface FrozenExecutionSummarySource {
  identity: { kind: 'legacy'; runId: string; sessionId: string } | { kind: 'archive'; runId: string; sessionId: string; archiveId: string };
  cursor: { epoch: string; seq: string } | null;
  history: FrozenSummaryEntry[];
}

function summaryEntry(kind: string, payload: unknown, providerEpoch: string | null, providerSeq: string | null): FrozenSummaryEntry {
  return { kind, payload, providerCursor: providerEpoch && providerSeq ? { epoch: providerEpoch, seq: providerSeq } : null };
}

export async function freezeExecutionSummarySource(input: z.input<typeof summarySourceScope>): Promise<FrozenExecutionSummarySource> {
  const parsed = summarySourceScope.strict().parse(input);
  return snapshot(async client => {
    const { rows: live } = await client.query<{ project_id: string }>(
      `SELECT t.project_id FROM collab_runs r JOIN collab_tasks t ON t.id=r.task_id WHERE r.id=$1 AND r.task_id=$2`,
      [parsed.runId, parsed.taskId]);
    if (live[0]) {
      await authorize(parsed.actor, { projectId: live[0].project_id }, ['task.read', 'internal.read'], client);
      const { rows: session } = await client.query<{ timeline_epoch: string | null; timeline_seq: string | null }>(
        'SELECT timeline_epoch,timeline_seq FROM collab_sessions WHERE id=$1 AND run_id=$2', [parsed.sessionId, parsed.runId]);
      if (!session[0]) missing();
      const { rows: page } = await client.query<{ kind: string; payload: unknown; provider_epoch: string | null; provider_seq: string | null }>(
        `SELECT kind,payload,provider_epoch,provider_seq FROM collab_connector_observations
         WHERE session_id=$1 AND kind IN ('timeline','attention') ORDER BY created_at DESC,id DESC LIMIT 100`, [parsed.sessionId]);
      const newest = page.find(row => row.provider_epoch && row.provider_seq);
      const newestEpoch = newest?.provider_epoch ?? null;
      const newestSeq = newest?.provider_seq ?? null;
      const queueEpoch = session[0].timeline_epoch;
      const queueSeq = session[0].timeline_seq;
      return {
        identity: { kind: 'legacy', runId: parsed.runId, sessionId: parsed.sessionId },
        cursor: newestEpoch && newestSeq ? { epoch: newestEpoch, seq: newestSeq } : queueEpoch && queueSeq ? { epoch: queueEpoch, seq: queueSeq } : null,
        history: page.reverse().map(row => summaryEntry(row.kind, row.payload, row.provider_epoch, row.provider_seq)),
      };
    }
    const { rows: archives } = await client.query<{ id: string; project_id: string }>(
      `SELECT a.id,t.project_id FROM collab_execution_archives a JOIN collab_tasks t ON t.id=a.task_id
       WHERE a.source_run_id=$1 AND a.task_id=$2 AND a.sealed_at IS NOT NULL ORDER BY a.captured_at DESC,a.id DESC LIMIT 1`,
      [parsed.runId, parsed.taskId]);
    if (!archives[0]) missing();
    await authorize(parsed.actor, { projectId: archives[0].project_id }, ['task.read', 'internal.read'], client);
    const manifest = await loadManifest(client, archives[0].id);
    const verification = await verifyStored(client, manifest);
    if (!verification.integrityValid) throw new CollabServiceError(503, 'archive_integrity_error', 'Execution history is unavailable. Contact support.');
    const { rows: sessionRecord } = await client.query<{ payload_json: string; timeline_epoch: string | null; timeline_seq: string | null }>(
      `SELECT payload_json,payload_json::jsonb->>'timeline_epoch' AS timeline_epoch,payload_json::jsonb->>'timeline_seq' AS timeline_seq
       FROM collab_execution_archive_records WHERE archive_id=$1 AND record_type='session' AND record_id=$2`, [manifest.id, parsed.sessionId]);
    if (!sessionRecord[0]) missing();
    const sessionPayload = archivedSessionPayload.safeParse(JSON.parse(sessionRecord[0].payload_json));
    if (!sessionPayload.success || sessionPayload.data.run_id !== manifest.sourceRunId || sessionPayload.data.id !== parsed.sessionId) missing();
    const { rows: page } = await client.query<{ kind: string; payload: unknown; provider_epoch: string | null; provider_seq: string | null }>(
      `SELECT event_kind AS kind,payload_json::jsonb->'payload' AS payload,payload_json::jsonb->>'provider_epoch' AS provider_epoch,payload_json::jsonb->>'provider_seq' AS provider_seq
       FROM collab_execution_archive_records
       WHERE archive_id=$1 AND record_type='observation' AND session_id=$2 AND event_kind IN ('timeline','attention')
       ORDER BY source_created_at DESC,record_id DESC LIMIT 100`, [manifest.id, parsed.sessionId]);
    const newest = page.find(row => row.provider_epoch && row.provider_seq);
    const newestEpoch = newest?.provider_epoch ?? null;
    const newestSeq = newest?.provider_seq ?? null;
    const queueEpoch = sessionRecord[0].timeline_epoch;
    const queueSeq = sessionRecord[0].timeline_seq;
    return {
      identity: { kind: 'archive', runId: parsed.runId, sessionId: parsed.sessionId, archiveId: manifest.id },
      cursor: newestEpoch && newestSeq ? { epoch: newestEpoch, seq: newestSeq } : queueEpoch && queueSeq ? { epoch: queueEpoch, seq: queueSeq } : null,
      history: page.reverse().map(row => summaryEntry(row.kind, row.payload, row.provider_epoch, row.provider_seq)),
    };
  });
}

export async function readArchivedRunWorkspace(input: { taskId: string; archiveId: string }, executor: ArchiveExecutor): Promise<{ headCommit: string | null; dirty: boolean | null }> {
  const manifest = await loadManifest(executor, input.archiveId);
  if (manifest.taskId !== input.taskId || manifest.sealedAt === null) missing();
  const integrity = await verifyStored(executor, manifest);
  if (!integrity.integrityValid) throw new CollabServiceError(503, 'archive_integrity_error', 'Execution history is unavailable. Contact support.');
  const { rows } = await executor.query<{ payload_json: string }>(
    "SELECT payload_json FROM collab_execution_archive_records WHERE archive_id=$1 AND record_type='run' AND record_id=$2",
    [manifest.id, manifest.sourceRunId],
  );
  const parsed = z.object({
    id: z.string().uuid(), task_id: z.string().uuid(), project_id: z.string().uuid(),
    head_commit: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i).nullable().default(null),
    dirty: z.boolean().nullable().default(null),
  }).safeParse(rows[0] ? JSON.parse(rows[0].payload_json) : null);
  if (!parsed.success || parsed.data.id !== manifest.sourceRunId || parsed.data.task_id !== manifest.taskId || parsed.data.project_id !== manifest.projectId) {
    throw new CollabServiceError(503, 'archive_integrity_error', 'Execution history is unavailable. Contact support.');
  }
  return { headCommit: parsed.data.head_commit, dirty: parsed.data.dirty };
}

export interface ArchivedArtifactCapture {
  mediaType: string;
  sizeBytes: number;
  sha256: string;
  contentBase64: string;
}

export interface ExecutionArchiveArtifactInventory {
  required: number;
  captured: number;
  blockers: Array<{ artifactId: string; reason: 'missing_hash' | 'missing_capture' | 'invalid_capture' }>;
}

export type ArchivedArtifactCaptureLookup =
  | { status: 'none' }
  | { status: 'unavailable' }
  | { status: 'capture'; capture: ArchivedArtifactCapture };

const MAX_ARTIFACT_CAPTURE_BYTES = 524288;

const archivedArtifactCaptureResultSchema = z.object({
  status: z.literal('available'),
  mediaType: z.string().max(200),
  sizeBytes: z.number().int().nonnegative().max(MAX_ARTIFACT_CAPTURE_BYTES),
  sha256: z.string().regex(/^[a-f0-9]{64}$/i),
  contentBase64: z.string().max(699052).regex(/^[A-Za-z0-9+/]*={0,2}$/),
  truncated: z.literal(false),
});

const archivedArtifactCommandSchema = z.object({
  kind: z.literal('artifact_read'),
  state: z.literal('applied'),
  run_id: z.string(),
  session_id: z.string().nullable(),
  payload: z.object({ artifactId: z.string(), reference: z.string().nullable().optional() }),
  result: z.unknown(),
});

type ArchivedArtifactCommand = z.infer<typeof archivedArtifactCommandSchema>;

interface CanonicalArtifactIdentity {
  id: string;
  sessionId: string | null;
  reference: string | null;
  sha256: string | null;
  sizeBytes: number | null;
}

function decodeArchivedArtifactCommand(payloadJson: string): ArchivedArtifactCommand | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payloadJson);
  } catch (error) {
    if (error instanceof SyntaxError) throw new CollabServiceError(503, 'archive_integrity_error', 'Execution history is unavailable. Contact support.');
    throw error;
  }
  const command = archivedArtifactCommandSchema.safeParse(parsed);
  return command.success ? command.data : null;
}

function artifactCaptureKey(runId: string, sessionId: string | null, artifactId: string, reference: string | null) {
  return JSON.stringify([runId, sessionId, artifactId, reference]);
}

function validateArchivedArtifactCapture(artifact: CanonicalArtifactIdentity, result: unknown): ArchivedArtifactCapture | 'missing_hash' | 'invalid_capture' {
  if (artifact.sha256 === null || !/^[a-f0-9]{64}$/i.test(artifact.sha256)) return 'missing_hash';
  const parsed = archivedArtifactCaptureResultSchema.safeParse(result);
  if (!parsed.success) return 'invalid_capture';
  const bytes = Buffer.from(parsed.data.contentBase64, 'base64');
  if (bytes.toString('base64') !== parsed.data.contentBase64) return 'invalid_capture';
  const sha = createHash('sha256').update(bytes).digest('hex');
  if (bytes.length !== parsed.data.sizeBytes || sha !== parsed.data.sha256 || sha !== artifact.sha256) return 'invalid_capture';
  if (artifact.sizeBytes !== null && bytes.length !== artifact.sizeBytes) return 'invalid_capture';
  return { mediaType: parsed.data.mediaType, sizeBytes: bytes.length, sha256: sha, contentBase64: parsed.data.contentBase64 };
}

async function loadCanonicalArchiveArtifacts(client: ArchiveExecutor, manifest: ExecutionArchiveManifest): Promise<CanonicalArtifactIdentity[]> {
  const { rows } = await client.query<{ id: string; session_id: string | null; reference: string | null; sha256: string | null; size_bytes: string | number | null }>(
    `SELECT id,session_id,reference,sha256,size_bytes FROM collab_artifacts
     WHERE run_id=$1 AND task_id=$2 AND project_id=$3 AND kind='file' AND provenance IN ('agent','runner') ORDER BY id`,
    [manifest.sourceRunId, manifest.taskId, manifest.projectId]);
  return rows.map(row => ({
    id: row.id, sessionId: row.session_id, reference: row.reference, sha256: row.sha256,
    sizeBytes: row.size_bytes === null ? null : Number(row.size_bytes),
  }));
}

async function loadAppliedArtifactCommands(client: ArchiveExecutor, archiveId: string): Promise<Map<string, ArchivedArtifactCommand>> {
  const { rows } = await client.query<{ payload_json: string }>(
    `SELECT payload_json FROM collab_execution_archive_records
     WHERE archive_id=$1 AND record_type='command'
       AND payload_json::jsonb->>'kind'='artifact_read' AND payload_json::jsonb->>'state'='applied'
     ORDER BY source_created_at DESC,record_id DESC`,
    [archiveId]);
  const commands = new Map<string, ArchivedArtifactCommand>();
  for (const row of rows) {
    const command = decodeArchivedArtifactCommand(row.payload_json);
    if (!command) continue;
    const key = artifactCaptureKey(command.run_id, command.session_id, command.payload.artifactId, command.payload.reference ?? null);
    if (!commands.has(key)) commands.set(key, command);
  }
  return commands;
}

export async function getExecutionArchiveArtifactInventory(input: { workspaceId: string; archiveId: string }): Promise<ExecutionArchiveArtifactInventory> {
  const parsed = scopeSchema.strict().parse(input);
  return snapshot(async client => {
    const manifest = await loadManifest(client, parsed.archiveId, parsed.workspaceId);
    const integrity = await verifyStored(client, manifest);
    if (!integrity.integrityValid) throw new CollabServiceError(503, 'archive_integrity_error', 'Execution history is unavailable. Contact support.');
    const artifacts = await loadCanonicalArchiveArtifacts(client, manifest);
    const commands = await loadAppliedArtifactCommands(client, manifest.id);
    let captured = 0;
    const blockers: ExecutionArchiveArtifactInventory['blockers'] = [];
    for (const artifact of artifacts) {
      if (artifact.sha256 === null || !/^[a-f0-9]{64}$/i.test(artifact.sha256)) {
        blockers.push({ artifactId: artifact.id, reason: 'missing_hash' });
        continue;
      }
      const command = commands.get(artifactCaptureKey(manifest.sourceRunId, artifact.sessionId, artifact.id, artifact.reference));
      if (!command) {
        blockers.push({ artifactId: artifact.id, reason: 'missing_capture' });
        continue;
      }
      const outcome = validateArchivedArtifactCapture(artifact, command.result);
      if (typeof outcome === 'string') blockers.push({ artifactId: artifact.id, reason: outcome });
      else captured += 1;
    }
    return { required: artifacts.length, captured, blockers };
  });
}

export async function readArchivedArtifactCapture(input: { taskId: string; artifactId: string }): Promise<ArchivedArtifactCaptureLookup> {
  const parsed = z.object({ taskId: z.string().uuid(), artifactId: z.string().uuid() }).strict().parse(input);
  return snapshot(async client => {
    const { rows } = await client.query<{ id: string; run_id: string; session_id: string | null; reference: string | null; sha256: string | null; size_bytes: string | number | null; project_id: string; workspace_id: string }>(
      `SELECT a.id,a.run_id,a.session_id,a.reference,a.sha256,a.size_bytes,p.id AS project_id,w.id AS workspace_id
       FROM collab_artifacts a JOIN collab_projects p ON p.id=a.project_id JOIN collab_workspaces w ON w.id=p.workspace_id
       WHERE a.id=$1 AND a.task_id=$2 AND a.kind='file' AND a.provenance IN ('agent','runner') AND a.run_id IS NOT NULL`,
      [parsed.artifactId, parsed.taskId]);
    const row = rows[0];
    if (!row) return { status: 'none' };
    const { rows: archives } = await client.query<{ id: string }>(
      `SELECT id FROM collab_execution_archives WHERE source_run_id=$1 AND task_id=$2 AND project_id=$3 AND workspace_id=$4 AND sealed_at IS NOT NULL
       ORDER BY captured_at DESC,id DESC LIMIT 1`,
      [row.run_id, parsed.taskId, row.project_id, row.workspace_id]);
    if (!archives[0]) return { status: 'none' };
    const manifest = await loadManifest(client, archives[0].id);
    const integrity = await verifyStored(client, manifest);
    if (!integrity.integrityValid) throw new CollabServiceError(503, 'archive_integrity_error', 'Execution history is unavailable. Contact support.');
    const artifact: CanonicalArtifactIdentity = {
      id: row.id, sessionId: row.session_id, reference: row.reference, sha256: row.sha256,
      sizeBytes: row.size_bytes === null ? null : Number(row.size_bytes),
    };
    const commands = await loadAppliedArtifactCommands(client, manifest.id);
    const command = commands.get(artifactCaptureKey(manifest.sourceRunId, artifact.sessionId, artifact.id, artifact.reference));
    if (!command) return { status: 'unavailable' };
    const outcome = validateArchivedArtifactCapture(artifact, command.result);
    return typeof outcome === 'string' ? { status: 'unavailable' } : { status: 'capture', capture: outcome };
  });
}

export interface ExecutionHistoryReferenceSelection {
  runId: string;
  sessionId: string | null;
  source: ExecutionHistoryEntry['source'];
}

export async function resolveExecutionHistoryReference(input: {
  actor: z.infer<typeof collabActorSchema>;
  taskId: string;
  sessionId?: string;
  commandId?: string;
}): Promise<ExecutionHistoryReferenceSelection> {
  const parsed = z.object({
    actor: collabActorSchema,
    taskId: z.string().uuid().toLowerCase(),
    sessionId: z.string().uuid().toLowerCase().optional(),
    commandId: z.string().uuid().toLowerCase().optional(),
  }).strict().refine(value => Boolean(value.sessionId) !== Boolean(value.commandId), { message: 'Choose one execution reference.' }).parse(input);
  return snapshot(async client => {
    const task = (await client.query<{ project_id: string }>('SELECT project_id FROM collab_tasks WHERE id=$1', [parsed.taskId])).rows[0];
    if (!task) missing();
    await authorize(parsed.actor, { projectId: task.project_id }, ['task.read', 'internal.read'], client);
    const kind = parsed.sessionId ? 'session' : 'command';
    const referenceId = parsed.sessionId ?? parsed.commandId!;
    const live = await client.query<{ run_id: string; session_id: string | null }>(kind === 'session'
      ? `SELECT r.id AS run_id,s.id AS session_id FROM collab_sessions s JOIN collab_runs r ON r.id=s.run_id
          WHERE s.id=$1 AND r.task_id=$2`
      : `SELECT r.id AS run_id,c.session_id FROM collab_connector_commands c JOIN collab_runs r ON r.id=c.run_id
          WHERE c.id=$1 AND r.task_id=$2`, [referenceId, parsed.taskId]);
    if (live.rows[0]) return { runId: live.rows[0].run_id, sessionId: live.rows[0].session_id, source: { kind: 'legacy', runId: live.rows[0].run_id } };
    const candidates = await client.query<{ archive_id: string }>(
      `SELECT a.id AS archive_id FROM collab_execution_archive_records record
        JOIN collab_execution_archives a ON a.id=record.archive_id
        WHERE record.record_type=$1 AND record.record_id=$2 AND a.task_id=$3 AND a.project_id=$4 AND a.sealed_at IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM collab_runs live WHERE live.id=a.source_run_id)
        ORDER BY a.captured_at DESC,a.id DESC LIMIT 2`, [kind, referenceId, parsed.taskId, task.project_id]);
    if (candidates.rows.length !== 1) missing();
    const manifest = await loadManifest(client, candidates.rows[0].archive_id);
    const verification = await verifyStored(client, manifest);
    if (!verification.integrityValid) throw new CollabServiceError(503, 'archive_integrity_error', 'Execution history is unavailable. Contact support.');
    const record = (await client.query<ExecutionArchiveRecord>(
      `SELECT ${archiveColumns} FROM collab_execution_archive_records WHERE archive_id=$1 AND record_type=$2 AND record_id=$3`,
      [manifest.id, kind, referenceId])).rows[0];
    if (!record) throw new CollabServiceError(503, 'archive_integrity_error', 'Execution history is unavailable. Contact support.');
    const sessionId = kind === 'session' ? referenceId : record.sessionId;
    try {
      assertRecordScope(manifest, record);
      if (kind === 'command' && sessionId !== null) {
        const session = (await client.query<ExecutionArchiveRecord>(
          `SELECT ${archiveColumns} FROM collab_execution_archive_records WHERE archive_id=$1 AND record_type='session' AND record_id=$2`,
          [manifest.id, sessionId])).rows[0];
        if (!session) invalidDump();
        assertRecordScope(manifest, session);
      }
    } catch (error) {
      if (error instanceof CollabServiceError && error.code === 'invalid_dump') throw new CollabServiceError(503, 'archive_integrity_error', 'Execution history is unavailable. Contact support.');
      throw error;
    }
    return { runId: manifest.sourceRunId, sessionId, source: { kind: 'archive', runId: manifest.sourceRunId, archiveId: manifest.id } };
  });
}
