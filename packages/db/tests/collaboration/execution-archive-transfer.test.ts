import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { lstat, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, expect, it } from 'vitest';
import * as db from '../../src/collaboration/index.js';
import { CollabServiceError } from '../../src/collaboration/errors.js';
import {
  captureLegacyRunArchive,
  getCollabExecutionArchive,
  getExecutionArchiveTimeline,
  restoreExecutionArchiveDump,
  verifyExecutionArchive,
  writeExecutionArchiveDump,
  type ExecutionArchiveManifest,
  type ExecutionArchiveRecord,
} from '../../src/collaboration/execution-archives.js';
import { closePool, getPool } from '../../src/pool.js';
import { runMigrations } from '../../src/migrate.js';
import { resetCollabSchema, resolveCollabTestDatabaseUrl, seedOrgMembership, seedUser } from '../helpers/collab-db.js';

process.env.DATABASE_URL = resolveCollabTestDatabaseUrl();
const databaseUrl = process.env.DATABASE_URL;
const previousSecret = process.env.FF_COLLAB_AUTH_SECRET;
const orgId = 'execution-archive-transfer-org';
const foreignOrgId = 'other-transfer-org';
const canary = '/operator/private/transfer-canary';
const observationTime = '2026-11-13T12:00:00.654321Z';
const sealedAtFixture = '2026-11-13T12:30:00.111111Z';
const utc = `'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'`;
const cliPath = fileURLToPath(new URL('../../scripts/execution-archive.mjs', import.meta.url));

type ArchiveDumpHeader = {
  kind: 'header';
  format: string;
  version: number;
  manifest: ExecutionArchiveManifest;
};
type ArchiveDumpRecord = { kind: 'record'; record: ExecutionArchiveRecord };
type ArchiveDumpComplete = { kind: 'complete'; archiveId: string; recordCount: number; manifestSha256: string };
type ArchiveDumpEntry = ArchiveDumpHeader | ArchiveDumpRecord | ArchiveDumpComplete;

let actor: { principalId: string; sessionVersion: number };
let outsider: { principalId: string; sessionVersion: number };
let workspaceId: string;
let projectId: string;
let hostId: string;
let mappingId: string;
let matrixEntries: ArchiveDumpEntry[];
let scopeEntries: ArchiveDumpEntry[];
let scopeArchiveId: string;
let foreignObservationRecord: ExecutionArchiveRecord;
let foreignSessionRecord: ExecutionArchiveRecord;
let foreignWorkspaceId: string;
let foreignProjectId: string;
let foreignTaskId: string;

beforeAll(async () => {
  process.env.FF_COLLAB_AUTH_SECRET = 'archive-transfer-fixture-secret-0123456789abcdef';
  await resetCollabSchema(databaseUrl);
  await runMigrations();
  const userId = await seedUser(databaseUrl, { githubId: 88901, login: 'transfer-owner' });
  await seedOrgMembership(databaseUrl, userId, orgId, 'admin');
  const principal = await db.ensureGithubPrincipal({ userId, displayName: 'Transfer owner', email: 'transfer-owner@example.test' });
  actor = { principalId: principal.id, sessionVersion: principal.sessionVersion };
  workspaceId = (await db.bootstrapCollaborationWorkspace({ actor, orgId, name: 'Transfer workspace', idempotencyKey: randomUUID() })).id;
  projectId = (await db.createCollabProject({ actor, workspaceId, name: 'Transfer project' })).id;
  const otherUserId = await seedUser(databaseUrl, { githubId: 88902, login: 'transfer-outsider' });
  await seedOrgMembership(databaseUrl, otherUserId, foreignOrgId, 'admin');
  const otherPrincipal = await db.ensureGithubPrincipal({ userId: otherUserId, displayName: 'Transfer outsider', email: 'transfer-outsider@example.test' });
  outsider = { principalId: otherPrincipal.id, sessionVersion: otherPrincipal.sessionVersion };
  foreignWorkspaceId = (await db.bootstrapCollaborationWorkspace({ actor: outsider, orgId: foreignOrgId, name: 'Other transfer workspace', idempotencyKey: randomUUID() })).id;
  foreignProjectId = (await db.createCollabProject({ actor: outsider, workspaceId: foreignWorkspaceId, name: 'Other transfer project' })).id;
  foreignTaskId = (await db.createCollabTask({ actor: outsider, projectId: foreignProjectId, title: 'Other transfer task' })).id;
  const host = await db.createExecutionHost({ actor, name: 'Transfer host' });
  hostId = host.id;
  mappingId = (await db.createProjectHostMapping({ actor, projectId, hostId, repositoryKey: 'acme/transfer', profileIds: ['transfer-profile'], defaultProfileId: 'transfer-profile' })).id;
  await db.registerConnector({ token: host.token, instanceId: 'transfer-fixture', protocolVersion: 1, sdkVersion: '0.12.0', daemonVersion: '1.0.0', capabilities: {}, catalog: { repositories: [{ key: 'acme/transfer' }], profiles: [{ id: 'transfer-profile', name: 'Transfer profile', provider: 'omp', model: 'fixture' }] } });

  const matrixSource = await sourceFixture();
  const matrixArchive = await captureLegacyRunArchive({ workspaceId, runId: matrixSource.runId });
  await sealArchive(matrixArchive.id);
  matrixEntries = await collectDump(matrixArchive.id);

  const scopeSource = await sourceFixture();
  const scopeArchive = await captureLegacyRunArchive({ workspaceId, runId: scopeSource.runId });
  await sealArchive(scopeArchive.id);
  scopeArchiveId = scopeArchive.id;
  scopeEntries = await collectDump(scopeArchiveId);

  const spliceSource = await sourceFixture();
  const spliceArchive = await captureLegacyRunArchive({ workspaceId, runId: spliceSource.runId });
  await sealArchive(spliceArchive.id);
  const spliceRecords = recordEntries(await collectDump(spliceArchive.id));
  foreignObservationRecord = structuredClone(spliceRecords.find(record => record.type === 'observation')!);
  foreignSessionRecord = structuredClone(spliceRecords.find(record => record.type === 'session')!);
});

afterAll(async () => {
  if (previousSecret === undefined) delete process.env.FF_COLLAB_AUTH_SECRET;
  else process.env.FF_COLLAB_AUTH_SECRET = previousSecret;
  await closePool();
});

async function sourceFixture() {
  const task = await db.createCollabTask({ actor, projectId, title: 'Transfer execution' });
  const started = await db.startCollabRun({ actor, taskId: task.id, expectedVersion: task.version, idempotencyKey: randomUUID(), mappingId, profileId: 'transfer-profile', instructions: 'Preserve the transfer rehearsal.' });
  if (!('sessionId' in started)) throw new Error('Transfer fixture requires internal execution access');
  const runId = started.run.id;
  const sessionId = started.sessionId;
  await getPool().query('UPDATE collab_runs SET workspace_id=$2 WHERE id=$1', [runId, canary]);
  const observationIds = [randomUUID(), randomUUID()].sort();
  for (const [index, id] of observationIds.entries()) {
    await getPool().query(`INSERT INTO collab_connector_observations
      (id,event_id,host_id,run_id,session_id,kind,payload,provider_epoch,provider_seq,observed_at,created_at)
      VALUES ($1,$2,$3,$4,$5,'timeline',$6,'transfer-epoch',$7,$8,$8)`,
    [id, `transfer-event-${id}`, hostId, runId, sessionId, JSON.stringify({ type: 'agent_message', text: index === 0 ? 'Überzug µ\nfirst' : 'Second message' }), String(9007199254740993n + BigInt(index)), observationTime]);
  }
  return { taskId: task.id, runId, sessionId, observationIds };
}

async function sealArchive(archiveId: string) {
  await getPool().query('UPDATE collab_execution_archives SET sealed_at=$2 WHERE id=$1', [archiveId, sealedAtFixture]);
}

async function truncateArchives() {
  await getPool().query('TRUNCATE collab_execution_archive_records, collab_execution_archives');
}

async function collectDump(archiveId: string): Promise<ArchiveDumpEntry[]> {
  const entries: ArchiveDumpEntry[] = [];
  await writeExecutionArchiveDump({ workspaceId, archiveId }, async entry => {
    entries.push(entry);
  });
  return entries;
}

async function storedSnapshot(archiveId: string) {
  const manifest = await getPool().query(`SELECT id, source_run_id AS "sourceRunId", workspace_id AS "workspaceId", org_id AS "orgId",
    project_id AS "projectId", task_id AS "taskId", format_version AS "formatVersion",
    to_char(captured_at AT TIME ZONE 'UTC', ${utc}) AS "capturedAt",
    source_state AS "sourceState", source_stage AS "sourceStage",
    to_char(source_created_at AT TIME ZONE 'UTC', ${utc}) AS "sourceCreatedAt",
    record_counts AS "recordCounts", manifest_sha256 AS "manifestSha256",
    to_char(sealed_at AT TIME ZONE 'UTC', ${utc}) AS "sealedAt"
    FROM collab_execution_archives WHERE id=$1`, [archiveId]);
  const records = await getPool().query(`SELECT archive_id AS "archiveId", record_type AS "recordType", record_id AS "recordId",
    session_id AS "sessionId", to_char(source_created_at AT TIME ZONE 'UTC', ${utc}) AS "sourceCreatedAt",
    event_kind AS "eventKind", payload_json AS "payloadJson", payload_sha256 AS "payloadSha256"
    FROM collab_execution_archive_records WHERE archive_id=$1 ORDER BY record_type, record_id`, [archiveId]);
  return { manifest: manifest.rows, records: records.rows };
}

async function parentCounts() {
  const { rows } = await getPool().query(`SELECT (SELECT count(*) FROM collab_workspaces)::int AS workspaces,
    (SELECT count(*) FROM collab_projects)::int AS projects, (SELECT count(*) FROM collab_tasks)::int AS tasks`);
  return rows[0];
}

function sha256Hex(value: string) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function recomputeManifestSha256(manifest: ExecutionArchiveManifest, records: ExecutionArchiveRecord[]) {
  const hash = createHash('sha256');
  hash.update(JSON.stringify([
    manifest.formatVersion, manifest.id, manifest.sourceRunId, manifest.workspaceId, manifest.orgId,
    manifest.projectId, manifest.taskId, manifest.capturedAt, manifest.sourceState, manifest.sourceStage, manifest.sourceCreatedAt,
  ]) + '\n');
  for (const record of records) {
    hash.update(JSON.stringify([record.type, record.id, record.sessionId, record.sourceCreatedAt, record.eventKind, record.payloadSha256]) + '\n');
  }
  return hash.digest('hex');
}

function recordEntries(entries: ArchiveDumpEntry[]): ExecutionArchiveRecord[] {
  return entries.filter((entry): entry is ArchiveDumpRecord => entry.kind === 'record').map(entry => entry.record);
}

function dumpParts(entries: ArchiveDumpEntry[]) {
  const header = structuredClone(entries[0]) as ArchiveDumpHeader;
  const complete = structuredClone(entries.at(-1)) as ArchiveDumpComplete;
  const records = recordEntries(entries).map(record => structuredClone(record));
  return { header, records, complete };
}

function assemble(header: ArchiveDumpHeader, records: ExecutionArchiveRecord[], complete: ArchiveDumpComplete): unknown[] {
  return [header, ...records.map(record => ({ kind: 'record', record })), complete];
}

const typeOrder: Record<ExecutionArchiveRecord['type'], number> = { command: 0, observation: 1, run: 2, session: 3 };

function ordered(records: ExecutionArchiveRecord[]) {
  return records.sort((a, b) => typeOrder[a.type] - typeOrder[b.type] || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

async function* streamOf(entries: unknown[]): AsyncIterable<unknown> {
  for (const entry of entries) yield entry;
}

function runCli(args: string[]) {
  return spawnSync(process.execPath, [cliPath, ...args], { encoding: 'utf8', env: { ...process.env, DATABASE_URL: databaseUrl } });
}

it('round-trips a sealed archive through the operator CLI after storage loss', async () => {
  const source = await sourceFixture();
  const captured = runCli(['capture', '--workspace-id', workspaceId, '--run-id', source.runId]);
  expect(captured.status).toBe(0);
  expect(captured.stdout + captured.stderr).not.toContain(canary);
  const archive = await getCollabExecutionArchive({ actor, archiveId: JSON.parse(captured.stdout).archiveId });
  await sealArchive(archive.id);
  const before = await storedSnapshot(archive.id);
  const verified = runCli(['verify', '--workspace-id', workspaceId, '--archive-id', archive.id, '--compare-source']);
  expect(verified.status).toBe(0);
  expect(JSON.parse(verified.stdout)).toMatchObject({ integrityValid: true, sourceMatches: true, issues: [] });
  expect(verified.stdout + verified.stderr).not.toContain(canary);
  const dir = await mkdtemp(path.join(tmpdir(), 'ff-archive-transfer-'));
  const dumpPath = path.join(dir, 'execution-archive.dump');
  try {
    const exported = runCli(['export', '--workspace-id', workspaceId, '--archive-id', archive.id, '--output', dumpPath]);
    expect(exported.status).toBe(0);
    expect((await stat(dumpPath)).mode & 0o777).toBe(0o600);
    const dumpText = await readFile(dumpPath, 'utf8');
    expect(dumpText).toContain(canary);
    expect(exported.stdout + exported.stderr).not.toContain(canary);
    await truncateArchives();
    const imported = runCli(['import', '--workspace-id', workspaceId, '--input', dumpPath]);
    expect(imported.status).toBe(0);
    expect(imported.stdout + imported.stderr).not.toContain(canary);
    expect(await storedSnapshot(archive.id)).toEqual(before);
    expect(await verifyExecutionArchive({ workspaceId, archiveId: archive.id, compareSource: true })).toMatchObject({ integrityValid: true, sourceMatches: true, issues: [] });
    const timeline = await getExecutionArchiveTimeline({ actor, archiveId: archive.id, sessionId: source.sessionId });
    expect(timeline.entries.map(entry => entry.payload.text)).toEqual(['Überzug µ\nfirst', 'Second message']);
    expect(timeline.entries.map(entry => entry.providerCursor?.seq)).toEqual(['9007199254740993', '9007199254740994']);
    expect(JSON.parse(Buffer.from(timeline.cursor!, 'base64url').toString('utf8')).t).toBe(observationTime);
    expect(JSON.stringify(await getCollabExecutionArchive({ actor, archiveId: archive.id }))).not.toContain(canary);
    const history = await db.listTaskExecutionHistory({ actor, taskId: source.taskId });
    expect(history.entries[0].source).toEqual({ kind: 'legacy', runId: source.runId });
    const replay = runCli(['import', '--workspace-id', workspaceId, '--input', dumpPath]);
    expect(replay.status).toBe(0);
    expect(await storedSnapshot(archive.id)).toEqual(before);
    await getPool().query('DELETE FROM collab_connector_observations WHERE run_id=$1', [source.runId]);
    await getPool().query('DELETE FROM collab_connector_commands WHERE run_id=$1', [source.runId]);
    await getPool().query('DELETE FROM collab_scoped_tokens WHERE run_id=$1', [source.runId]);
    await getPool().query('DELETE FROM collab_sessions WHERE run_id=$1', [source.runId]);
    await getPool().query('DELETE FROM collab_runs WHERE id=$1', [source.runId]);
    const archived = await db.listTaskExecutionHistory({ actor, taskId: source.taskId });
    expect(archived.entries[0].source).toEqual({ kind: 'archive', runId: source.runId, archiveId: archive.id });
    const sessions = await db.listExecutionHistorySessions({ actor, taskId: source.taskId, runId: source.runId });
    expect(sessions.sessions).toEqual([expect.objectContaining({ id: source.sessionId, runId: source.runId })]);
    const transcript = await db.getExecutionHistoryTimeline({ actor, taskId: source.taskId, runId: source.runId, sessionId: source.sessionId });
    expect(transcript.entries.map(entry => entry.payload.text)).toEqual(['Überzug µ\nfirst', 'Second message']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it('streams header, ordered records and completion through an awaited sink and refuses corrupt sources', async () => {
  const source = await sourceFixture();
  const archive = await captureLegacyRunArchive({ workspaceId, runId: source.runId });
  await sealArchive(archive.id);
  const metadata = await getCollabExecutionArchive({ actor, archiveId: archive.id });
  const entries: ArchiveDumpEntry[] = [];
  await writeExecutionArchiveDump({ workspaceId, archiveId: archive.id }, async entry => {
    entries.push(entry);
  });
  expect(entries[0]).toEqual({ kind: 'header', format: 'fluent-flow.execution-archive', version: 1, manifest: metadata });
  expect(entries.at(-1)).toEqual({ kind: 'complete', archiveId: archive.id, recordCount: 5, manifestSha256: archive.manifestSha256 });
  const records = recordEntries(entries);
  const commandId = (await getPool().query('SELECT id FROM collab_connector_commands WHERE run_id=$1', [source.runId])).rows[0].id;
  expect(records.map(record => `${record.type}:${record.id}`)).toEqual([
    `command:${commandId}`,
    ...source.observationIds.map(id => `observation:${id}`),
    `run:${source.runId}`,
    `session:${source.sessionId}`,
  ]);
  for (const record of records) expect(record.payloadSha256).toBe(sha256Hex(record.payloadJson));
  await expect(writeExecutionArchiveDump({ workspaceId, archiveId: archive.id }, async entry => {
    if (entry.kind === 'record') throw new Error('sink refused entry');
  })).rejects.toThrow('sink refused entry');
  const breakableSource = await sourceFixture();
  const breakable = await captureLegacyRunArchive({ workspaceId, runId: breakableSource.runId });
  await getPool().query("UPDATE collab_execution_archive_records SET payload_json=payload_json || ' ' WHERE archive_id=$1", [breakable.id]);
  await expect(writeExecutionArchiveDump({ workspaceId, archiveId: breakable.id }, async () => {})).rejects.toBeInstanceOf(CollabServiceError);
});

it('replays a dump exactly and repeats idempotently against existing content', async () => {
  const source = await sourceFixture();
  const archive = await captureLegacyRunArchive({ workspaceId, runId: source.runId });
  await sealArchive(archive.id);
  const entries = await collectDump(archive.id);
  const before = await storedSnapshot(archive.id);
  await truncateArchives();
  const restored = await restoreExecutionArchiveDump({ workspaceId }, streamOf(entries));
  expect(restored).toMatchObject({
    id: archive.id,
    sourceRunId: source.runId,
    manifestSha256: archive.manifestSha256,
    sealedAt: sealedAtFixture,
    recordCounts: { command: 1, observation: 2, run: 1, session: 1 },
  });
  expect(await storedSnapshot(archive.id)).toEqual(before);
  const replayed = await restoreExecutionArchiveDump({ workspaceId }, streamOf(entries));
  expect(replayed).toMatchObject({ id: archive.id, manifestSha256: archive.manifestSha256 });
  expect(await storedSnapshot(archive.id)).toEqual(before);
});

const matrixCases: [string, (entries: ArchiveDumpEntry[]) => unknown[]][] = [
  ['denies a tampered payload with a stale record digest', entries => {
    const { header, records, complete } = dumpParts(entries);
    const record = records.find(candidate => candidate.type === 'observation' && JSON.parse(candidate.payloadJson).payload?.text === 'Second message')!;
    record.payloadJson = JSON.stringify({ ...JSON.parse(record.payloadJson), text: 'Second message tampered' });
    return assemble(header, records, complete);
  }],
  ['denies a tampered payload with only its own digest recomputed', entries => {
    const { header, records, complete } = dumpParts(entries);
    const record = records.find(candidate => candidate.type === 'observation' && JSON.parse(candidate.payloadJson).payload?.text === 'Second message')!;
    record.payloadJson = JSON.stringify({ ...JSON.parse(record.payloadJson), text: 'Second message tampered' });
    record.payloadSha256 = sha256Hex(record.payloadJson);
    return assemble(header, records, complete);
  }],
  ['denies reordered records', entries => {
    const { header, records, complete } = dumpParts(entries);
    const swapped = [...records];
    [swapped[1], swapped[2]] = [swapped[2], swapped[1]];
    return assemble(header, swapped, complete);
  }],
  ['denies a duplicated record', entries => {
    const { header, records, complete } = dumpParts(entries);
    records.splice(1, 0, structuredClone(records[0]));
    return assemble(header, records, complete);
  }],
  ['denies a stream without its completion footer', entries => entries.slice(0, -1)],
  ['denies a trailing record after the completion footer', entries => [...entries, { kind: 'record', record: structuredClone(recordEntries(entries)[0]) }]],
  ['denies a completion footer with a wrong record count', entries => {
    const { header, records, complete } = dumpParts(entries);
    complete.recordCount = records.length - 1;
    return assemble(header, records, complete);
  }],
  ['denies a stream without its header', entries => entries.slice(1)],
  ['denies an unrecognized header format marker', entries => {
    const { header, records, complete } = dumpParts(entries);
    header.format = 'other.pipeline';
    header.version = 2;
    return assemble(header, records, complete);
  }],
];

it.each(matrixCases)('%s', async (_name, corrupt) => {
  await truncateArchives();
  await expect(restoreExecutionArchiveDump({ workspaceId }, streamOf(corrupt(matrixEntries)))).rejects.toBeInstanceOf(CollabServiceError);
  const leftover = await getPool().query(`SELECT (SELECT count(*) FROM collab_execution_archives)::int AS archives,
    (SELECT count(*) FROM collab_execution_archive_records)::int AS records`);
  expect(leftover.rows[0]).toEqual({ archives: 0, records: 0 });
});

const incoherentRecords: [string, ExecutionArchiveRecord['type'], (record: ExecutionArchiveRecord, records: ExecutionArchiveRecord[]) => void][] = [
  ['session metadata identifies another session', 'session', record => { record.sessionId = randomUUID(); }],
  ['run metadata incorrectly carries a session', 'run', (record, records) => { record.sessionId = records.find(candidate => candidate.type === 'session')!.id; }],
  ['observation cursor time differs from the source row', 'observation', record => { record.sourceCreatedAt = '2000-01-01T00:00:00.000001Z'; }],
  ['command metadata carries an observation kind', 'command', record => { record.eventKind = 'timeline'; }],
  ['run payload omits its project', 'run', record => { const value = JSON.parse(record.payloadJson); delete value.project_id; record.payloadJson = JSON.stringify(value); }],
  ['run state differs from its manifest', 'run', record => { const value = JSON.parse(record.payloadJson); value.state = value.state === 'failed' ? 'running' : 'failed'; record.payloadJson = JSON.stringify(value); }],
  ['source row omits its creation time', 'observation', record => { const value = JSON.parse(record.payloadJson); delete value.created_at; record.payloadJson = JSON.stringify(value); }],
];

const scopeCases: [string, (entries: ArchiveDumpEntry[]) => unknown[]][] = [
  ['denies an observation record captured from a foreign run even with every digest recomputed', entries => {
    const { header, records, complete } = dumpParts(entries);
    records[records.findIndex(record => record.type === 'observation')] = structuredClone(foreignObservationRecord);
    header.manifest.manifestSha256 = recomputeManifestSha256(header.manifest, ordered(records));
    complete.manifestSha256 = header.manifest.manifestSha256;
    return assemble(header, ordered(records), complete);
  }],
  ['denies a session record captured from a foreign run even with every digest recomputed', entries => {
    const { header, records, complete } = dumpParts(entries);
    records[records.findIndex(record => record.type === 'session')] = structuredClone(foreignSessionRecord);
    header.manifest.manifestSha256 = recomputeManifestSha256(header.manifest, ordered(records));
    complete.manifestSha256 = header.manifest.manifestSha256;
    return assemble(header, ordered(records), complete);
  }],
  ['denies an observation whose session is absent from the stream even with every digest recomputed', entries => {
    const { header, records, complete } = dumpParts(entries);
    records.find(record => record.type === 'observation')!.sessionId = randomUUID();
    header.manifest.manifestSha256 = recomputeManifestSha256(header.manifest, ordered(records));
    complete.manifestSha256 = header.manifest.manifestSha256;
    return assemble(header, ordered(records), complete);
  }],
  ['denies a manifest bound to another workspace even with every digest recomputed', entries => {
    const { header, records, complete } = dumpParts(entries);
    header.manifest.workspaceId = foreignWorkspaceId;
    header.manifest.projectId = foreignProjectId;
    header.manifest.taskId = foreignTaskId;
    header.manifest.orgId = foreignOrgId;
    header.manifest.manifestSha256 = recomputeManifestSha256(header.manifest, ordered(records));
    complete.manifestSha256 = header.manifest.manifestSha256;
    return assemble(header, ordered(records), complete);
  }],
  ['denies a manifest bound to unknown canonical parents without inventing them', entries => {
    const { header, records, complete } = dumpParts(entries);
    header.manifest.projectId = randomUUID();
    header.manifest.taskId = randomUUID();
    header.manifest.manifestSha256 = recomputeManifestSha256(header.manifest, ordered(records));
    complete.manifestSha256 = header.manifest.manifestSha256;
    return assemble(header, ordered(records), complete);
  }],
  ['denies a session record missing required source fields even with every digest recomputed', entries => {
    const { header, records, complete } = dumpParts(entries);
    const record = records.find(candidate => candidate.type === 'session')!;
    record.payloadJson = JSON.stringify({});
    record.payloadSha256 = sha256Hex(record.payloadJson);
    header.manifest.manifestSha256 = recomputeManifestSha256(header.manifest, records);
    complete.manifestSha256 = header.manifest.manifestSha256;
    return assemble(header, records, complete);
  }],
  ['denies a run record bound to a foreign task even with every digest recomputed', entries => {
    const { header, records, complete } = dumpParts(entries);
    const record = records.find(candidate => candidate.type === 'run')!;
    record.payloadJson = JSON.stringify({ ...JSON.parse(record.payloadJson), task_id: foreignTaskId });
    record.payloadSha256 = sha256Hex(record.payloadJson);
    header.manifest.manifestSha256 = recomputeManifestSha256(header.manifest, records);
    complete.manifestSha256 = header.manifest.manifestSha256;
    return assemble(header, records, complete);
  }],
  ['denies a noncanonical uppercase archive identity even with every digest recomputed', entries => {
    const { header, records, complete } = dumpParts(entries);
    header.manifest.id = header.manifest.id.toUpperCase();
    header.manifest.manifestSha256 = recomputeManifestSha256(header.manifest, records);
    complete.manifestSha256 = header.manifest.manifestSha256;
    return assemble(header, records, complete);
  }],
  ['denies a noncanonical truncated timestamp even with every digest recomputed', entries => {
    const { header, records, complete } = dumpParts(entries);
    const record = records.find(candidate => candidate.type === 'observation')!;
    record.sourceCreatedAt = record.sourceCreatedAt.replace(/\.\d{6}Z$/, '.65432Z');
    header.manifest.manifestSha256 = recomputeManifestSha256(header.manifest, records);
    complete.manifestSha256 = header.manifest.manifestSha256;
    return assemble(header, records, complete);
  }],
  ...incoherentRecords.map(([name, type, mutate]): [string, (entries: ArchiveDumpEntry[]) => unknown[]] => [
    `denies incoherent source metadata: ${name} even with every digest recomputed`, entries => {
      const { header, records, complete } = dumpParts(entries);
      const record = records.find(candidate => candidate.type === type)!;
      mutate(record, records);
      record.payloadSha256 = sha256Hex(record.payloadJson);
      header.manifest.manifestSha256 = recomputeManifestSha256(header.manifest, records);
      complete.manifestSha256 = header.manifest.manifestSha256;
      return assemble(header, records, complete);
    },
  ]),
];

it.each(scopeCases)('%s', async (_name, corrupt) => {
  await truncateArchives();
  await expect(restoreExecutionArchiveDump({ workspaceId }, streamOf(corrupt(scopeEntries)))).rejects.toBeInstanceOf(CollabServiceError);
  const leftover = await getPool().query(`SELECT (SELECT count(*) FROM collab_execution_archives)::int AS archives,
    (SELECT count(*) FROM collab_execution_archive_records)::int AS records`);
  expect(leftover.rows[0]).toEqual({ archives: 0, records: 0 });
  const restored = await restoreExecutionArchiveDump({ workspaceId }, streamOf(scopeEntries));
  expect(restored).toMatchObject({ id: scopeArchiveId });
  const before = await storedSnapshot(scopeArchiveId);
  const parentsBefore = await parentCounts();
  await expect(restoreExecutionArchiveDump({ workspaceId }, streamOf(corrupt(scopeEntries)))).rejects.toBeInstanceOf(CollabServiceError);
  expect(await storedSnapshot(scopeArchiveId)).toEqual(before);
  expect(await parentCounts()).toEqual(parentsBefore);
});

it('rejects an internally consistent dump that conflicts with stored archive content', async () => {
  await truncateArchives();
  await restoreExecutionArchiveDump({ workspaceId }, streamOf(scopeEntries));
  const before = await storedSnapshot(scopeArchiveId);
  const { header, records, complete } = dumpParts(scopeEntries);
  const record = records.find(candidate => candidate.type === 'observation' && JSON.parse(candidate.payloadJson).payload?.text === 'Second message')!;
  record.payloadJson = JSON.stringify({ ...JSON.parse(record.payloadJson), text: 'Rewritten history' });
  record.payloadSha256 = sha256Hex(record.payloadJson);
  header.manifest.manifestSha256 = recomputeManifestSha256(header.manifest, records);
  complete.manifestSha256 = header.manifest.manifestSha256;
  await expect(restoreExecutionArchiveDump({ workspaceId }, streamOf(assemble(header, records, complete)))).rejects.toBeInstanceOf(CollabServiceError);
  expect(await storedSnapshot(scopeArchiveId)).toEqual(before);
});

it('refuses unsafe CLI output paths and malformed input without leaking private content', async () => {
  const source = await sourceFixture();
  const archive = await captureLegacyRunArchive({ workspaceId, runId: source.runId });
  await sealArchive(archive.id);
  const before = await storedSnapshot(archive.id);
  const dir = await mkdtemp(path.join(tmpdir(), 'ff-archive-transfer-negative-'));
  const dumpPath = path.join(dir, 'execution-archive.dump');
  try {
    const exported = runCli(['export', '--workspace-id', workspaceId, '--archive-id', archive.id, '--output', dumpPath]);
    expect(exported.status).toBe(0);
    const originalBytes = await readFile(dumpPath);
    const overwrite = runCli(['export', '--workspace-id', workspaceId, '--archive-id', archive.id, '--output', dumpPath]);
    expect(overwrite.status).not.toBe(0);
    expect(overwrite.stdout + overwrite.stderr).not.toContain(canary);
    expect(await readFile(dumpPath)).toEqual(originalBytes);
    const targetPath = path.join(dir, 'target.dump');
    await writeFile(targetPath, 'sentinel');
    await symlink(targetPath, path.join(dir, 'link.dump'));
    const throughLink = runCli(['export', '--workspace-id', workspaceId, '--archive-id', archive.id, '--output', path.join(dir, 'link.dump')]);
    expect(throughLink.status).not.toBe(0);
    expect(throughLink.stdout + throughLink.stderr).not.toContain(canary);
    expect((await lstat(path.join(dir, 'link.dump'))).isSymbolicLink()).toBe(true);
    expect(await readFile(targetPath, 'utf8')).toBe('sentinel');
    const malformedPath = path.join(dir, 'malformed.dump');
    await writeFile(malformedPath, originalBytes.toString('utf8').replace('"complete"', '"finished"'));
    const malformedImport = runCli(['import', '--workspace-id', workspaceId, '--input', malformedPath]);
    expect(malformedImport.status).not.toBe(0);
    expect(malformedImport.stdout + malformedImport.stderr).not.toContain(canary);
    expect(await storedSnapshot(archive.id)).toEqual(before);
    const truncatedPath = path.join(dir, 'truncated.dump');
    await writeFile(truncatedPath, originalBytes.subarray(0, Math.floor(originalBytes.length / 2)));
    const truncatedImport = runCli(['import', '--workspace-id', workspaceId, '--input', truncatedPath]);
    expect(truncatedImport.status).not.toBe(0);
    expect(truncatedImport.stdout + truncatedImport.stderr).not.toContain(canary);
    expect(await storedSnapshot(archive.id)).toEqual(before);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it('restores a nullable historical organization without adopting the current one', async () => {
  const source = await sourceFixture();
  let archive: ExecutionArchiveManifest | undefined;
  let entries: ArchiveDumpEntry[] | undefined;
  await getPool().query('UPDATE collab_workspaces SET org_id=NULL WHERE id=$1', [workspaceId]);
  try {
    archive = await captureLegacyRunArchive({ workspaceId, runId: source.runId });
    expect(archive.orgId).toBeNull();
    await sealArchive(archive.id);
    entries = await collectDump(archive.id);
  } finally {
    await getPool().query('UPDATE collab_workspaces SET org_id=$2 WHERE id=$1', [workspaceId, orgId]);
  }
  await truncateArchives();
  const restored = await restoreExecutionArchiveDump({ workspaceId }, streamOf(entries!));
  expect(restored.orgId).toBeNull();
  const before = await storedSnapshot(archive!.id);
  expect((await getCollabExecutionArchive({ actor, archiveId: archive!.id })).orgId).toBeNull();
  expect(await verifyExecutionArchive({ workspaceId, archiveId: archive!.id })).toMatchObject({ integrityValid: true });
  const replayed = await restoreExecutionArchiveDump({ workspaceId }, streamOf(entries!));
  expect(replayed.orgId).toBeNull();
  const timeline = await getExecutionArchiveTimeline({ actor, archiveId: archive!.id, sessionId: source.sessionId });
  expect(timeline.entries.map(entry => entry.payload.text)).toEqual(['Überzug µ\nfirst', 'Second message']);
  const { header, records, complete } = dumpParts(entries!);
  header.manifest.orgId = foreignOrgId;
  header.manifest.manifestSha256 = recomputeManifestSha256(header.manifest, records);
  complete.manifestSha256 = header.manifest.manifestSha256;
  await expect(restoreExecutionArchiveDump({ workspaceId }, streamOf(assemble(header, records, complete)))).rejects.toBeInstanceOf(CollabServiceError);
  expect(await storedSnapshot(archive!.id)).toEqual(before);
});
