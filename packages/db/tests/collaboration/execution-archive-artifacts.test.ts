import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as db from '../../src/collaboration/index.js';
import { getCollabArtifactContent, type CollabArtifactContent } from '../../src/collaboration/evidence.js';
import {
  captureLegacyRunArchive,
  getExecutionArchiveArtifactInventory,
  restoreExecutionArchiveDump,
  writeExecutionArchiveDump,
} from '../../src/collaboration/execution-archives.js';
import { CollabServiceError } from '../../src/collaboration/errors.js';
import { closePool, getPool } from '../../src/pool.js';
import { runMigrations } from '../../src/migrate.js';
import {
  resetCollabSchema,
  resolveCollabTestDatabaseUrl,
  seedOrgMembership,
  seedUser,
} from '../helpers/collab-db.js';

process.env.DATABASE_URL = resolveCollabTestDatabaseUrl();
const databaseUrl = process.env.DATABASE_URL;
const previousSecret = process.env.FF_COLLAB_AUTH_SECRET;
const orgId = 'execution-archive-artifact-org';
const sealedAtFixture = '2026-11-13T12:30:00.111111Z';

let actor: { principalId: string; sessionVersion: number };
let outsider: { principalId: string; sessionVersion: number };
let workspaceId: string;
let projectId: string;
const artifactConstraintRestores: string[] = [];

beforeAll(async () => {
  process.env.FF_COLLAB_AUTH_SECRET = 'archive-artifact-fixture-secret-0123456789abcdef';
  await resetCollabSchema(databaseUrl);
  await runMigrations();
  const userId = await seedUser(databaseUrl, { githubId: 88911, login: 'archive-artifact-owner' });
  await seedOrgMembership(databaseUrl, userId, orgId, 'admin');
  const principal = await db.ensureGithubPrincipal({ userId, displayName: 'Archive artifact owner', email: 'archive-artifact-owner@example.test' });
  actor = { principalId: principal.id, sessionVersion: principal.sessionVersion };
  workspaceId = (await db.bootstrapCollaborationWorkspace({ actor, orgId, name: 'Artifact archive workspace', idempotencyKey: randomUUID() })).id;
  projectId = (await db.createCollabProject({ actor, workspaceId, name: 'Artifact archive project' })).id;
  const otherUserId = await seedUser(databaseUrl, { githubId: 88912, login: 'archive-artifact-outsider' });
  await seedOrgMembership(databaseUrl, otherUserId, 'other-archive-artifact-org', 'admin');
  const otherPrincipal = await db.ensureGithubPrincipal({ userId: otherUserId, displayName: 'Archive artifact outsider', email: 'archive-artifact-outsider@example.test' });
  outsider = { principalId: otherPrincipal.id, sessionVersion: otherPrincipal.sessionVersion };
});

afterAll(async () => {
  if (artifactConstraintRestores.length > 0) {
    await getPool().query('DELETE FROM collab_artifacts WHERE project_id=$1', [projectId]);
    for (const restore of artifactConstraintRestores) await getPool().query(restore);
  }
  if (previousSecret === undefined) delete process.env.FF_COLLAB_AUTH_SECRET;
  else process.env.FF_COLLAB_AUTH_SECRET = previousSecret;
  await closePool();
});

function base64(bytes: Buffer) {
  return bytes.toString('base64');
}

function sha256Hex(value: string | Buffer) {
  return createHash('sha256').update(value).digest('hex');
}

interface RunFixture {
  taskId: string;
  runId: string;
  sessionId: string;
  hostId: string;
}

async function sourceFixture(): Promise<RunFixture> {
  const task = await db.createCollabTask({ actor, projectId, title: 'Archive artifact execution' });
  const host = await db.createExecutionHost({ actor, name: `Artifact archive host ${task.id.slice(0, 8)}` });
  const mappingId = (await db.createProjectHostMapping({ actor, projectId, hostId: host.id, repositoryKey: 'acme/archive-artifact', profileIds: ['artifact-profile'], defaultProfileId: 'artifact-profile' })).id;
  await db.registerConnector({ token: host.token, instanceId: `archive-artifact-${task.id.slice(0, 8)}`, protocolVersion: 1, sdkVersion: '0.12.0', daemonVersion: '1.0.0', capabilities: {}, catalog: { repositories: [{ key: 'acme/archive-artifact' }], profiles: [{ id: 'artifact-profile', name: 'Artifact profile', provider: 'omp', model: 'fixture' }] } });
  const started = await db.startCollabRun({ actor, taskId: task.id, expectedVersion: task.version, idempotencyKey: randomUUID(), mappingId, profileId: 'artifact-profile', instructions: 'Preserve the archived artifact bytes.' });
  if (!('sessionId' in started)) throw new Error('Artifact archive fixture requires internal execution access');
  return { taskId: task.id, runId: started.run.id, sessionId: started.sessionId, hostId: host.id };
}

async function insertFileArtifact(input: {
  run: RunFixture;
  artifactId: string;
  name: string;
  reference: string;
  mediaType: string;
  visibility: 'client' | 'internal';
  sha256: string | null;
  sizeBytes: number | null;
}): Promise<void> {
  await getPool().query(
    `INSERT INTO collab_artifacts
       (id, task_id, project_id, run_id, session_id, direction, kind, name, visibility,
        provenance, owner_principal_id, media_type, size_bytes, sha256, reference, created_by_principal_id)
     VALUES ($1, $2, $3, $4, $5, 'output', 'file', $6, $7, 'agent', $8, $9, $10, $11, $12, $8)`,
    [
      input.artifactId,
      input.run.taskId,
      projectId,
      input.run.runId,
      input.run.sessionId,
      input.name,
      input.visibility,
      actor.principalId,
      input.mediaType,
      input.sizeBytes,
      input.sha256,
      input.reference,
    ],
  );
}

async function recordAppliedArtifactRead(input: {
  run: RunFixture;
  artifactId: string;
  reference: string;
  mediaType: string;
  content: Buffer;
  resultSha256: string;
}): Promise<void> {
  const result = {
    status: 'available',
    mediaType: input.mediaType,
    sizeBytes: input.content.length,
    sha256: input.resultSha256,
    contentBase64: base64(input.content),
    truncated: false,
  };
  await getPool().query(
    `INSERT INTO collab_connector_commands
       (host_id, run_id, session_id, kind, payload, state, result, created_by_principal_id)
     VALUES ($1, $2, $3, 'artifact_read', $4, 'applied', $5, $6)`,
    [
      input.run.hostId,
      input.run.runId,
      input.run.sessionId,
      JSON.stringify({ artifactId: input.artifactId, reference: input.reference, maxBytes: 524288 }),
      JSON.stringify(result),
      actor.principalId,
    ],
  );
}

async function collectDump(archiveId: string): Promise<unknown[]> {
  const entries: unknown[] = [];
  await writeExecutionArchiveDump({ workspaceId, archiveId }, entry => {
    entries.push(entry);
  });
  return entries;
}

function streamOf(entries: unknown[]): AsyncIterable<unknown> {
  return (async function* () {
    for (const entry of entries) yield entry;
  })();
}

async function sealArchive(archiveId: string) {
  await getPool().query('UPDATE collab_execution_archives SET sealed_at=$2 WHERE id=$1', [archiveId, sealedAtFixture]);
}

async function truncateArchives() {
  await getPool().query('TRUNCATE collab_execution_archive_records, collab_execution_archives');
}

async function retireLiveExecution(run: RunFixture) {
  if (artifactConstraintRestores.length === 0) {
    const constraints = await getPool().query<{ drop_sql: string; restore_sql: string }>(`SELECT
      format('ALTER TABLE collab_artifacts DROP CONSTRAINT %I',conname) AS drop_sql,
      format('ALTER TABLE collab_artifacts ADD CONSTRAINT %I %s',conname,pg_get_constraintdef(oid)) AS restore_sql
      FROM pg_constraint WHERE conrelid='collab_artifacts'::regclass AND contype='f'
        AND confrelid IN ('collab_runs'::regclass,'collab_sessions'::regclass)`);
    for (const constraint of constraints.rows) {
      await getPool().query(constraint.drop_sql);
      artifactConstraintRestores.push(constraint.restore_sql);
    }
  }
  const identity = await getPool().query('SELECT id,run_id,session_id,sha256,size_bytes,reference FROM collab_artifacts WHERE run_id=$1 ORDER BY id', [run.runId]);
  await db.revokeExecutionHost({ actor, hostId: run.hostId });
  await getPool().query('DELETE FROM collab_connector_commands WHERE run_id=$1', [run.runId]);
  await getPool().query('DELETE FROM collab_connector_observations WHERE run_id=$1', [run.runId]);
  await getPool().query('DELETE FROM collab_scoped_tokens WHERE run_id=$1', [run.runId]);
  await getPool().query('DELETE FROM collab_sessions WHERE run_id=$1', [run.runId]);
  await getPool().query('DELETE FROM collab_runs WHERE id=$1', [run.runId]);
  expect((await getPool().query('SELECT id,run_id,session_id,sha256,size_bytes,reference FROM collab_artifacts WHERE run_id=$1 ORDER BY id', [run.runId])).rows).toEqual(identity.rows);
}

function commandCount(runId: string) {
  return getPool().query<{ n: number }>('SELECT count(*)::int AS n FROM collab_connector_commands WHERE run_id=$1', [runId]).then(r => r.rows[0].n);
}

function contentBase64Of(result: CollabArtifactContent): string | undefined {
  if ('state' in result) return undefined;
  return result.contentBase64;
}

function textOf(result: CollabArtifactContent): string | undefined {
  if ('state' in result || !('content' in result)) return undefined;
  return result.content;
}

describe('execution archive artifact parity', () => {
  describe('getExecutionArchiveArtifactInventory', () => {
    it('counts only file artifacts with a complete valid capture as required', async () => {
      const run = await sourceFixture();
      const goodBytes = Buffer.from('genuine historic artifact bytes', 'utf8');
      const goodId = randomUUID();
      await insertFileArtifact({ run, artifactId: goodId, name: 'good.txt', reference: 'reports/good.txt', mediaType: 'text/plain', visibility: 'client', sha256: sha256Hex(goodBytes), sizeBytes: goodBytes.length });
      const textId = randomUUID();
      await getPool().query(
        `INSERT INTO collab_artifacts
           (id, task_id, project_id, run_id, session_id, direction, kind, name, visibility, provenance,
            owner_principal_id, media_type, content, created_by_principal_id)
         VALUES ($1,$2,$3,$4,$5,'output','text',$6,'client','agent',$7,'text/plain',$8,$7)`,
        [textId, run.taskId, projectId, run.runId, run.sessionId, 'notes.txt', actor.principalId, 'inline text body'],
      );
      const noShaId = randomUUID();
      await insertFileArtifact({ run, artifactId: noShaId, name: 'unhashed.bin', reference: 'reports/unhashed.bin', mediaType: 'application/octet-stream', visibility: 'client', sha256: null, sizeBytes: 12 });
      const archive = await captureLegacyRunArchive({ workspaceId, runId: run.runId });
      await sealArchive(archive.id);

      const inventory = await getExecutionArchiveArtifactInventory({ workspaceId, archiveId: archive.id });
      expect(inventory.required).toBe(2);
      expect(inventory.captured).toBe(0);
      const blockers = [...inventory.blockers].sort((a, b) => a.artifactId.localeCompare(b.artifactId));
      expect(blockers.map(({ artifactId }) => artifactId)).toEqual([goodId, noShaId].sort());
      expect(Object.fromEntries(inventory.blockers.map(({ artifactId, reason }) => [artifactId, reason]))).toMatchObject({
        [goodId]: 'missing_capture',
        [noShaId]: 'missing_hash',
      });
    });

    it('treats a valid capture as captured with no blockers', async () => {
      const run = await sourceFixture();
      const bytes = Buffer.from('captured artifact payload', 'utf8');
      const sha = sha256Hex(bytes);
      const artifactId = randomUUID();
      await insertFileArtifact({ run, artifactId, name: 'report.txt', reference: 'reports/report.txt', mediaType: 'text/plain', visibility: 'client', sha256: sha, sizeBytes: bytes.length });
      await recordAppliedArtifactRead({ run, artifactId, reference: 'reports/report.txt', mediaType: 'text/plain', content: bytes, resultSha256: sha });
      const archive = await captureLegacyRunArchive({ workspaceId, runId: run.runId });

      const inventory = await getExecutionArchiveArtifactInventory({ workspaceId, archiveId: archive.id });
      expect(inventory.required).toBe(1);
      expect(inventory.captured).toBe(1);
      expect(inventory.blockers).toEqual([]);
    });


    it('reports missing_hash when the canonical artifact has no declared sha', async () => {
      const run = await sourceFixture();
      const artifactId = randomUUID();
      await insertFileArtifact({ run, artifactId, name: 'unhashed.txt', reference: 'reports/unhashed.txt', mediaType: 'text/plain', visibility: 'client', sha256: null, sizeBytes: 4 });
      const bytes = Buffer.from('four', 'utf8');
      await recordAppliedArtifactRead({ run, artifactId, reference: 'reports/unhashed.txt', mediaType: 'text/plain', content: bytes, resultSha256: sha256Hex(bytes) });
      const archive = await captureLegacyRunArchive({ workspaceId, runId: run.runId });
      await sealArchive(archive.id);

      const inventory = await getExecutionArchiveArtifactInventory({ workspaceId, archiveId: archive.id });
      expect(inventory.required).toBe(1);
      expect(inventory.blockers).toEqual([{ artifactId, reason: 'missing_hash' }]);
    });

    it('reports invalid_capture for a truncated or size-mismatched capture', async () => {
      const run = await sourceFixture();
      const bytes = Buffer.from('original bytes that are longer than the captured slice', 'utf8');
      const artifactId = randomUUID();
      await insertFileArtifact({ run, artifactId, name: 'truncated.txt', reference: 'reports/truncated.txt', mediaType: 'text/plain', visibility: 'client', sha256: sha256Hex(bytes), sizeBytes: bytes.length });
      const short = bytes.subarray(0, 8);
      await recordAppliedArtifactRead({ run, artifactId, reference: 'reports/truncated.txt', mediaType: 'text/plain', content: short, resultSha256: sha256Hex(short) });
      const archive = await captureLegacyRunArchive({ workspaceId, runId: run.runId });
      await sealArchive(archive.id);

      const inventory = await getExecutionArchiveArtifactInventory({ workspaceId, archiveId: archive.id });
      expect(inventory.blockers).toEqual([{ artifactId, reason: 'invalid_capture' }]);
    });

    it('reports invalid_capture when the declared sha does not match the canonical artifact sha', async () => {
      const run = await sourceFixture();
      const bytes = Buffer.from('content whose hash was recorded incorrectly', 'utf8');
      const artifactId = randomUUID();
      await insertFileArtifact({ run, artifactId, name: 'mismatch.txt', reference: 'reports/mismatch.txt', mediaType: 'text/plain', visibility: 'client', sha256: '0'.repeat(64), sizeBytes: bytes.length });
      await recordAppliedArtifactRead({ run, artifactId, reference: 'reports/mismatch.txt', mediaType: 'text/plain', content: bytes, resultSha256: sha256Hex(bytes) });
      const archive = await captureLegacyRunArchive({ workspaceId, runId: run.runId });
      await sealArchive(archive.id);

      const inventory = await getExecutionArchiveArtifactInventory({ workspaceId, archiveId: archive.id });
      expect(inventory.blockers).toEqual([{ artifactId, reason: 'invalid_capture' }]);
    });

    it('treats a forged reference as a missing capture', async () => {
      const run = await sourceFixture();
      const bytes = Buffer.from('reference forged to another artifact', 'utf8');
      const sha = sha256Hex(bytes);
      const artifactId = randomUUID();
      await insertFileArtifact({ run, artifactId, name: 'forged.txt', reference: 'reports/forged.txt', mediaType: 'text/plain', visibility: 'client', sha256: sha, sizeBytes: bytes.length });
      await recordAppliedArtifactRead({ run, artifactId, reference: 'reports/other.txt', mediaType: 'text/plain', content: bytes, resultSha256: sha });
      const archive = await captureLegacyRunArchive({ workspaceId, runId: run.runId });
      await sealArchive(archive.id);

      const inventory = await getExecutionArchiveArtifactInventory({ workspaceId, archiveId: archive.id });
      expect(inventory.required).toBe(1);
      expect(inventory.captured).toBe(0);
      expect(inventory.blockers).toEqual([{ artifactId, reason: 'missing_capture' }]);
    });

    it('denies a foreign workspace with 404', async () => {
      const run = await sourceFixture();
      const archive = await captureLegacyRunArchive({ workspaceId, runId: run.runId });
      await expect(getExecutionArchiveArtifactInventory({ workspaceId: '11111111-1111-4111-8111-111111111111', archiveId: archive.id })).rejects.toMatchObject({ status: 404 });
    });

    it('fails a corrupt archive with 503', async () => {
      const run = await sourceFixture();
      const archive = await captureLegacyRunArchive({ workspaceId, runId: run.runId });
      await getPool().query("UPDATE collab_execution_archive_records SET payload_json=payload_json || ' ' WHERE archive_id=$1 AND record_type='run'", [archive.id]);
      const error = await getExecutionArchiveArtifactInventory({ workspaceId, archiveId: archive.id }).catch((e) => e);
      expect(error).toBeInstanceOf(CollabServiceError);
      expect(error).toMatchObject({ status: 503, code: 'archive_integrity_error' });
    });

    it('rejects a capture recorded under a forged session while a true-session control capture holds', async () => {
      const run = await sourceFixture();
      const controlBytes = Buffer.from('control capture under the true session', 'utf8');
      const controlId = randomUUID();
      await insertFileArtifact({ run, artifactId: controlId, name: 'session-control.txt', reference: 'reports/session-control.txt', mediaType: 'text/plain', visibility: 'client', sha256: sha256Hex(controlBytes), sizeBytes: controlBytes.length });
      await recordAppliedArtifactRead({ run, artifactId: controlId, reference: 'reports/session-control.txt', mediaType: 'text/plain', content: controlBytes, resultSha256: sha256Hex(controlBytes) });
      const forgedBytes = Buffer.from('bytes attributed to a foreign session', 'utf8');
      const forgedId = randomUUID();
      await insertFileArtifact({ run, artifactId: forgedId, name: 'forged-session.txt', reference: 'reports/forged-session.txt', mediaType: 'text/plain', visibility: 'client', sha256: sha256Hex(forgedBytes), sizeBytes: forgedBytes.length });
      const otherSession = await db.createRunSession({ actor, runId: run.runId, idempotencyKey: randomUUID(), title: 'Other artifact session', instructions: 'Keep artifacts scoped to their original session.' });
      if (!('session' in otherSession)) throw new Error('Artifact archive fixture requires the created session');
      await getPool().query(
        `INSERT INTO collab_connector_commands
           (host_id, run_id, session_id, kind, payload, state, result, created_by_principal_id)
         VALUES ($1,$2,$3,'artifact_read',$4,'applied',$5,$6)`,
        [run.hostId, run.runId, otherSession.session.id, JSON.stringify({ artifactId: forgedId, reference: 'reports/forged-session.txt', maxBytes: 524288 }),
         JSON.stringify({ status: 'available', mediaType: 'text/plain', sizeBytes: forgedBytes.length, sha256: sha256Hex(forgedBytes), contentBase64: base64(forgedBytes), truncated: false }),
         actor.principalId],
      );
      const archive = await captureLegacyRunArchive({ workspaceId, runId: run.runId });
      await sealArchive(archive.id);

      const inventory = await getExecutionArchiveArtifactInventory({ workspaceId, archiveId: archive.id });
      expect(inventory.required).toBe(2);
      expect(inventory.captured).toBe(1);
      expect(inventory.blockers).toEqual([{ artifactId: forgedId, reason: 'missing_capture' }]);
    });

    it('reports invalid_capture for malformed and noncanonical base64 while a canonical control capture holds', async () => {
      const run = await sourceFixture();
      const controlBytes = Buffer.from('canonical control capture', 'utf8');
      const controlId = randomUUID();
      await insertFileArtifact({ run, artifactId: controlId, name: 'base64-control.txt', reference: 'reports/base64-control.txt', mediaType: 'text/plain', visibility: 'client', sha256: sha256Hex(controlBytes), sizeBytes: controlBytes.length });
      await recordAppliedArtifactRead({ run, artifactId: controlId, reference: 'reports/base64-control.txt', mediaType: 'text/plain', content: controlBytes, resultSha256: sha256Hex(controlBytes) });
      const malformedBytes = Buffer.from('malformed base64 payload', 'utf8');
      const malformedId = randomUUID();
      await insertFileArtifact({ run, artifactId: malformedId, name: 'malformed.txt', reference: 'reports/malformed.txt', mediaType: 'text/plain', visibility: 'client', sha256: sha256Hex(malformedBytes), sizeBytes: malformedBytes.length });
      await getPool().query(
        `INSERT INTO collab_connector_commands
           (host_id, run_id, session_id, kind, payload, state, result, created_by_principal_id)
         VALUES ($1,$2,$3,'artifact_read',$4,'applied',$5,$6)`,
        [run.hostId, run.runId, run.sessionId, JSON.stringify({ artifactId: malformedId, reference: 'reports/malformed.txt', maxBytes: 524288 }),
         JSON.stringify({ status: 'available', mediaType: 'text/plain', sizeBytes: malformedBytes.length, sha256: sha256Hex(malformedBytes), contentBase64: 'not-base64!!', truncated: false }),
         actor.principalId],
      );
      const decoded = Buffer.from('ab', 'utf8');
      const noncanonical = 'YWJ=';
      const noncanonicalId = randomUUID();
      await insertFileArtifact({ run, artifactId: noncanonicalId, name: 'noncanonical.txt', reference: 'reports/noncanonical.txt', mediaType: 'text/plain', visibility: 'client', sha256: sha256Hex(decoded), sizeBytes: decoded.length });
      await getPool().query(
        `INSERT INTO collab_connector_commands
           (host_id, run_id, session_id, kind, payload, state, result, created_by_principal_id)
         VALUES ($1,$2,$3,'artifact_read',$4,'applied',$5,$6)`,
        [run.hostId, run.runId, run.sessionId, JSON.stringify({ artifactId: noncanonicalId, reference: 'reports/noncanonical.txt', maxBytes: 524288 }),
         JSON.stringify({ status: 'available', mediaType: 'text/plain', sizeBytes: decoded.length, sha256: sha256Hex(decoded), contentBase64: noncanonical, truncated: false }),
         actor.principalId],
      );
      const archive = await captureLegacyRunArchive({ workspaceId, runId: run.runId });
      await sealArchive(archive.id);

      const inventory = await getExecutionArchiveArtifactInventory({ workspaceId, archiveId: archive.id });
      expect(inventory.required).toBe(3);
      expect(inventory.captured).toBe(1);
      const blockers = [...inventory.blockers].sort((a, b) => a.artifactId.localeCompare(b.artifactId));
      expect(blockers).toEqual([
        { artifactId: malformedId, reason: 'invalid_capture' },
        { artifactId: noncanonicalId, reason: 'invalid_capture' },
      ].sort((a, b) => a.artifactId.localeCompare(b.artifactId)));
    });

    it('reports invalid_capture for oversized bytes, a truncated flag, and a lying result sha while a control capture holds', async () => {
      const run = await sourceFixture();
      const controlBytes = Buffer.from('integrity control capture', 'utf8');
      const controlId = randomUUID();
      await insertFileArtifact({ run, artifactId: controlId, name: 'integrity-control.txt', reference: 'reports/integrity-control.txt', mediaType: 'text/plain', visibility: 'client', sha256: sha256Hex(controlBytes), sizeBytes: controlBytes.length });
      await recordAppliedArtifactRead({ run, artifactId: controlId, reference: 'reports/integrity-control.txt', mediaType: 'text/plain', content: controlBytes, resultSha256: sha256Hex(controlBytes) });
      const oversized = Buffer.alloc(524289, 97);
      const oversizedId = randomUUID();
      await insertFileArtifact({ run, artifactId: oversizedId, name: 'oversized.bin', reference: 'reports/oversized.bin', mediaType: 'application/octet-stream', visibility: 'client', sha256: sha256Hex(oversized), sizeBytes: oversized.length });
      await recordAppliedArtifactRead({ run, artifactId: oversizedId, reference: 'reports/oversized.bin', mediaType: 'application/octet-stream', content: oversized, resultSha256: sha256Hex(oversized) });
      const flaggedBytes = Buffer.from('full bytes the host flagged truncated', 'utf8');
      const flaggedId = randomUUID();
      await insertFileArtifact({ run, artifactId: flaggedId, name: 'flagged.txt', reference: 'reports/flagged.txt', mediaType: 'text/plain', visibility: 'client', sha256: sha256Hex(flaggedBytes), sizeBytes: flaggedBytes.length });
      await getPool().query(
        `INSERT INTO collab_connector_commands
           (host_id, run_id, session_id, kind, payload, state, result, created_by_principal_id)
         VALUES ($1,$2,$3,'artifact_read',$4,'applied',$5,$6)`,
        [run.hostId, run.runId, run.sessionId, JSON.stringify({ artifactId: flaggedId, reference: 'reports/flagged.txt', maxBytes: 524288 }),
         JSON.stringify({ status: 'available', mediaType: 'text/plain', sizeBytes: flaggedBytes.length, sha256: sha256Hex(flaggedBytes), contentBase64: base64(flaggedBytes), truncated: true }),
         actor.principalId],
      );
      const lyingBytes = Buffer.from('bytes whose result sha lies about the payload', 'utf8');
      const lyingId = randomUUID();
      await insertFileArtifact({ run, artifactId: lyingId, name: 'lying-sha.txt', reference: 'reports/lying-sha.txt', mediaType: 'text/plain', visibility: 'client', sha256: sha256Hex(lyingBytes), sizeBytes: lyingBytes.length });
      await getPool().query(
        `INSERT INTO collab_connector_commands
           (host_id, run_id, session_id, kind, payload, state, result, created_by_principal_id)
         VALUES ($1,$2,$3,'artifact_read',$4,'applied',$5,$6)`,
        [run.hostId, run.runId, run.sessionId, JSON.stringify({ artifactId: lyingId, reference: 'reports/lying-sha.txt', maxBytes: 524288 }),
         JSON.stringify({ status: 'available', mediaType: 'text/plain', sizeBytes: lyingBytes.length, sha256: 'f'.repeat(64), contentBase64: base64(lyingBytes), truncated: false }),
         actor.principalId],
      );
      const archive = await captureLegacyRunArchive({ workspaceId, runId: run.runId });
      await sealArchive(archive.id);

      const inventory = await getExecutionArchiveArtifactInventory({ workspaceId, archiveId: archive.id });
      expect(inventory.required).toBe(4);
      expect(inventory.captured).toBe(1);
      expect([...inventory.blockers].sort((a, b) => a.artifactId.localeCompare(b.artifactId))).toEqual([
        { artifactId: flaggedId, reason: 'invalid_capture' },
        { artifactId: lyingId, reason: 'invalid_capture' },
        { artifactId: oversizedId, reason: 'invalid_capture' },
      ].sort((a, b) => a.artifactId.localeCompare(b.artifactId)));
    });

    it('accepts a capture at exactly 524288 bytes and serves the original bytes', async () => {
      const run = await sourceFixture();
      const exact = Buffer.alloc(524288, 65);
      expect(base64(exact)).toHaveLength(699052);
      const artifactId = randomUUID();
      await insertFileArtifact({ run, artifactId, name: 'exact-limit.bin', reference: 'reports/exact-limit.bin', mediaType: 'application/octet-stream', visibility: 'client', sha256: sha256Hex(exact), sizeBytes: exact.length });
      await recordAppliedArtifactRead({ run, artifactId, reference: 'reports/exact-limit.bin', mediaType: 'application/octet-stream', content: exact, resultSha256: sha256Hex(exact) });
      const archive = await captureLegacyRunArchive({ workspaceId, runId: run.runId });
      await sealArchive(archive.id);

      const inventory = await getExecutionArchiveArtifactInventory({ workspaceId, archiveId: archive.id });
      expect(inventory).toEqual({ required: 1, captured: 1, blockers: [] });
      const content = await getCollabArtifactContent({ actor, taskId: run.taskId, artifactId });
      expect(contentBase64Of(content)).toBe(base64(exact));
      expect(textOf(content)).toBeUndefined();
    });

  });

  describe('getCollabArtifactContent after archive restore and retirement', () => {
    it('returns original verified bytes from the archive after host retirement and storage loss', async () => {
      const run = await sourceFixture();
      const bytes = Buffer.from('genuine historic artifact bytes for archive restore', 'utf8');
      const sha = sha256Hex(bytes);
      const artifactId = randomUUID();
      await insertFileArtifact({ run, artifactId, name: 'restored.txt', reference: 'reports/restored.txt', mediaType: 'text/plain', visibility: 'client', sha256: sha, sizeBytes: bytes.length });
      expect(await getCollabArtifactContent({ actor, taskId: run.taskId, artifactId })).toMatchObject({ state: 'queued' });
      await recordAppliedArtifactRead({ run, artifactId, reference: 'reports/restored.txt', mediaType: 'text/plain', content: bytes, resultSha256: sha });
      const archive = await captureLegacyRunArchive({ workspaceId, runId: run.runId });
      await sealArchive(archive.id);
      const entries = await collectDump(archive.id);

      const live = await getCollabArtifactContent({ actor, taskId: run.taskId, artifactId });
      expect(live).toMatchObject({ name: 'restored.txt', mediaType: 'text/plain', truncated: false });

      await retireLiveExecution(run);
      await truncateArchives();
      const restored = await restoreExecutionArchiveDump({ workspaceId }, streamOf(entries));
      expect(restored.id).toBe(archive.id);

      const afterRestore = await getCollabArtifactContent({ actor, taskId: run.taskId, artifactId });
      expect(afterRestore).toMatchObject({ name: 'restored.txt' });
      expect(contentBase64Of(afterRestore)).toBe(base64(bytes));
      expect(textOf(afterRestore)).toBe(bytes.toString('utf8'));
    });


    it('denies a foreign or disabled principal after archive restore', async () => {
      const run = await sourceFixture();
      const bytes = Buffer.from('internal artifact that a task reader cannot see', 'utf8');
      const sha = sha256Hex(bytes);
      const artifactId = randomUUID();
      await insertFileArtifact({ run, artifactId, name: 'internal.txt', reference: 'reports/internal.txt', mediaType: 'text/plain', visibility: 'internal', sha256: sha, sizeBytes: bytes.length });
      await recordAppliedArtifactRead({ run, artifactId, reference: 'reports/internal.txt', mediaType: 'text/plain', content: bytes, resultSha256: sha });
      const archive = await captureLegacyRunArchive({ workspaceId, runId: run.runId });
      await sealArchive(archive.id);
      const entries = await collectDump(archive.id);
      await retireLiveExecution(run);
      await restoreExecutionArchiveDump({ workspaceId }, streamOf(entries));

      await expect(getCollabArtifactContent({ actor: outsider, taskId: run.taskId, artifactId })).rejects.toMatchObject({ status: 404 });
      await getPool().query('UPDATE collab_principals SET disabled_at=now() WHERE id=$1', [actor.principalId]);
      try {
        await expect(getCollabArtifactContent({ actor, taskId: run.taskId, artifactId })).rejects.toMatchObject({ status: 401 });
      } finally {
        await getPool().query('UPDATE collab_principals SET disabled_at=NULL WHERE id=$1', [actor.principalId]);
      }
    });

    it('does not queue a new artifact read once the archived path applies', async () => {
      const run = await sourceFixture();
      const bytes = Buffer.from('no new queue after archive', 'utf8');
      const sha = sha256Hex(bytes);
      const artifactId = randomUUID();
      await insertFileArtifact({ run, artifactId, name: 'noqueue.txt', reference: 'reports/noqueue.txt', mediaType: 'text/plain', visibility: 'client', sha256: sha, sizeBytes: bytes.length });
      await recordAppliedArtifactRead({ run, artifactId, reference: 'reports/noqueue.txt', mediaType: 'text/plain', content: bytes, resultSha256: sha });
      const archive = await captureLegacyRunArchive({ workspaceId, runId: run.runId });
      await sealArchive(archive.id);
      const entries = await collectDump(archive.id);
      await retireLiveExecution(run);
      await restoreExecutionArchiveDump({ workspaceId }, streamOf(entries));
      const before = await commandCount(run.runId);
      expect(contentBase64Of(await getCollabArtifactContent({ actor, taskId: run.taskId, artifactId }))).toBe(bytes.toString('base64'));
      expect(await commandCount(run.runId)).toBe(before);
    });

    it('serves verified bytes then fails with 503 once the sealed archive is corrupt', async () => {
      const run = await sourceFixture();
      const bytes = Buffer.from('bytes served before the archive went corrupt', 'utf8');
      const sha = sha256Hex(bytes);
      const artifactId = randomUUID();
      await insertFileArtifact({ run, artifactId, name: 'corrupt-later.txt', reference: 'reports/corrupt-later.txt', mediaType: 'text/plain', visibility: 'client', sha256: sha, sizeBytes: bytes.length });
      await recordAppliedArtifactRead({ run, artifactId, reference: 'reports/corrupt-later.txt', mediaType: 'text/plain', content: bytes, resultSha256: sha });
      const served = await getCollabArtifactContent({ actor, taskId: run.taskId, artifactId });
      expect(contentBase64Of(served)).toBe(base64(bytes));
      const archive = await captureLegacyRunArchive({ workspaceId, runId: run.runId });
      await getPool().query("UPDATE collab_execution_archive_records SET payload_json=payload_json || ' ' WHERE archive_id=$1 AND record_type='run'", [archive.id]);
      await sealArchive(archive.id);
      await retireLiveExecution(run);
      await expect(getCollabArtifactContent({ actor, taskId: run.taskId, artifactId })).rejects.toMatchObject({ status: 503, code: 'archive_integrity_error' });
    });

    it('returns unavailable for a missing canonical sha without queueing while a control capture stays readable', async () => {
      const run = await sourceFixture();
      const controlBytes = Buffer.from('control capture with a declared sha', 'utf8');
      const controlId = randomUUID();
      await insertFileArtifact({ run, artifactId: controlId, name: 'sha-control.txt', reference: 'reports/sha-control.txt', mediaType: 'text/plain', visibility: 'client', sha256: sha256Hex(controlBytes), sizeBytes: controlBytes.length });
      await recordAppliedArtifactRead({ run, artifactId: controlId, reference: 'reports/sha-control.txt', mediaType: 'text/plain', content: controlBytes, resultSha256: sha256Hex(controlBytes) });
      const orphanBytes = Buffer.from('captured bytes for an artifact with no declared sha', 'utf8');
      const noShaId = randomUUID();
      await insertFileArtifact({ run, artifactId: noShaId, name: 'no-sha.txt', reference: 'reports/no-sha.txt', mediaType: 'text/plain', visibility: 'client', sha256: null, sizeBytes: orphanBytes.length });
      await recordAppliedArtifactRead({ run, artifactId: noShaId, reference: 'reports/no-sha.txt', mediaType: 'text/plain', content: orphanBytes, resultSha256: sha256Hex(orphanBytes) });
      const archive = await captureLegacyRunArchive({ workspaceId, runId: run.runId });
      await sealArchive(archive.id);
      const entries = await collectDump(archive.id);
      await retireLiveExecution(run);
      await restoreExecutionArchiveDump({ workspaceId }, streamOf(entries));

      const control = await getCollabArtifactContent({ actor, taskId: run.taskId, artifactId: controlId });
      expect(contentBase64Of(control)).toBe(base64(controlBytes));
      const noSha = await getCollabArtifactContent({ actor, taskId: run.taskId, artifactId: noShaId });
      expect(noSha).toEqual({ state: 'unavailable', reason: 'This preview is unavailable.' });
      expect(await commandCount(run.runId)).toBe(0);
    });

    it('denies a task-only principal on an internal archived artifact that an authorized principal reads', async () => {
      const run = await sourceFixture();
      const bytes = Buffer.from('internal bytes a task reader must not see', 'utf8');
      const sha = sha256Hex(bytes);
      const artifactId = randomUUID();
      await insertFileArtifact({ run, artifactId, name: 'internal-guarded.txt', reference: 'reports/internal-guarded.txt', mediaType: 'text/plain', visibility: 'internal', sha256: sha, sizeBytes: bytes.length });
      await recordAppliedArtifactRead({ run, artifactId, reference: 'reports/internal-guarded.txt', mediaType: 'text/plain', content: bytes, resultSha256: sha });
      const archive = await captureLegacyRunArchive({ workspaceId, runId: run.runId });
      await sealArchive(archive.id);

      const authorized = await getCollabArtifactContent({ actor, taskId: run.taskId, artifactId });
      expect(contentBase64Of(authorized)).toBe(base64(bytes));
      const readerUserId = await seedUser(databaseUrl, { githubId: 88913, login: 'archive-artifact-task-reader' });
      const readerPrincipal = await db.ensureGithubPrincipal({ userId: readerUserId, displayName: 'Archive artifact task reader', email: 'archive-artifact-task-reader@example.test' });
      const role = await getPool().query<{ id: string }>(
        `INSERT INTO collab_roles (workspace_id, name, capabilities, is_system)
         VALUES ($1, 'artifact-task-reader', ARRAY['task.read']::text[], false) RETURNING id`,
        [workspaceId],
      );
      await getPool().query(
        'INSERT INTO collab_memberships (workspace_id, principal_id, role_id) VALUES ($1,$2,$3)',
        [workspaceId, readerPrincipal.id, role.rows[0].id],
      );
      await expect(getCollabArtifactContent({ actor: { principalId: readerPrincipal.id, sessionVersion: readerPrincipal.sessionVersion }, taskId: run.taskId, artifactId })).rejects.toMatchObject({ status: 404 });
    });
  });

  describe('roundtrip through writeExecutionArchiveDump + restoreExecutionArchiveDump', () => {
    it('preserves a superseded version readable by its exact id', async () => {
      const run = await sourceFixture();
      const v1Bytes = Buffer.from('superseded v1 bytes', 'utf8');
      const v2Bytes = Buffer.from('canonical v2 bytes', 'utf8');
      const v1Id = randomUUID();
      const v2Id = randomUUID();
      await insertFileArtifact({ run, artifactId: v1Id, name: 'versioned.txt', reference: 'reports/versioned.txt', mediaType: 'text/plain', visibility: 'client', sha256: sha256Hex(v1Bytes), sizeBytes: v1Bytes.length });
      await getPool().query(
        `INSERT INTO collab_artifacts
           (id, task_id, project_id, run_id, session_id, direction, kind, name, visibility, provenance,
            owner_principal_id, media_type, size_bytes, sha256, reference, created_by_principal_id)
         VALUES ($1,$2,$3,$4,$5,'output','file',$6,'client','agent',$7,'text/plain',$8,$9,$10,$7)`,
        [v2Id, run.taskId, projectId, run.runId, run.sessionId, 'versioned.txt', actor.principalId, v2Bytes.length, sha256Hex(v2Bytes), 'reports/versioned.txt'],
      );
      await getPool().query('UPDATE collab_artifacts SET superseded_by_artifact_id=$2 WHERE id=$1', [v1Id, v2Id]);
      await recordAppliedArtifactRead({ run, artifactId: v1Id, reference: 'reports/versioned.txt', mediaType: 'text/plain', content: v1Bytes, resultSha256: sha256Hex(v1Bytes) });
      await recordAppliedArtifactRead({ run, artifactId: v2Id, reference: 'reports/versioned.txt', mediaType: 'text/plain', content: v2Bytes, resultSha256: sha256Hex(v2Bytes) });
      const archive = await captureLegacyRunArchive({ workspaceId, runId: run.runId });
      await sealArchive(archive.id);
      const entries = await collectDump(archive.id);
      await retireLiveExecution(run);
      await restoreExecutionArchiveDump({ workspaceId }, streamOf(entries));

      const v1 = await getCollabArtifactContent({ actor, taskId: run.taskId, artifactId: v1Id });
      const v2 = await getCollabArtifactContent({ actor, taskId: run.taskId, artifactId: v2Id });
      expect(contentBase64Of(v1)).toBe(base64(v1Bytes));
      expect(contentBase64Of(v2)).toBe(base64(v2Bytes));
    });
  });
});

it('makes the operator inventory fail closed on missing bytes and succeed only after a fresh complete capture', async () => {
  const run = await sourceFixture();
  const bytes = Buffer.from('PRIVATE_ARCHIVED_ARTIFACT_BODY\n');
  const sha256 = sha256Hex(bytes);
  const capturedId = randomUUID();
  const missingId = randomUUID();
  await insertFileArtifact({ run, artifactId: capturedId, name: 'Captured inventory file', reference: 'reports/captured-inventory.txt', mediaType: 'text/plain', visibility: 'internal', sha256, sizeBytes: bytes.length });
  await insertFileArtifact({ run, artifactId: missingId, name: 'Missing inventory file', reference: 'reports/missing-inventory.txt', mediaType: 'text/plain', visibility: 'internal', sha256, sizeBytes: bytes.length });
  await recordAppliedArtifactRead({ run, artifactId: capturedId, reference: 'reports/captured-inventory.txt', mediaType: 'text/plain', content: bytes, resultSha256: sha256 });
  const incomplete = await captureLegacyRunArchive({ workspaceId, runId: run.runId });
  const cli = fileURLToPath(new URL('../../scripts/execution-archive.mjs', import.meta.url));
  const blocked = spawnSync(process.execPath, [cli, 'artifacts', '--workspace-id', workspaceId, '--archive-id', incomplete.id],
    { encoding: 'utf8', timeout: 10000, env: { ...process.env, DATABASE_URL: databaseUrl } });
  expect(blocked.status).toBe(2);
  expect(JSON.parse(blocked.stdout)).toEqual({ archiveId: incomplete.id, required: 2, captured: 1, blockers: [{ artifactId: missingId, reason: 'missing_capture' }] });
  expect(blocked.stderr).toBe('');
  expect(blocked.stdout).not.toContain(bytes.toString());
  expect(blocked.stdout).not.toContain(base64(bytes));
  expect((await getPool().query("SELECT id FROM collab_connector_commands WHERE kind='artifact_read' AND payload->>'artifactId'=$1", [missingId])).rows).toEqual([]);
  await recordAppliedArtifactRead({ run, artifactId: missingId, reference: 'reports/missing-inventory.txt', mediaType: 'text/plain', content: bytes, resultSha256: sha256 });
  const complete = await captureLegacyRunArchive({ workspaceId, runId: run.runId });
  const ready = spawnSync(process.execPath, [cli, 'artifacts', '--workspace-id', workspaceId, '--archive-id', complete.id],
    { encoding: 'utf8', timeout: 10000, env: { ...process.env, DATABASE_URL: databaseUrl } });
  expect(ready.status).toBe(0);
  expect(JSON.parse(ready.stdout)).toEqual({ archiveId: complete.id, required: 2, captured: 2, blockers: [] });
  expect(ready.stderr).toBe('');
  expect((await getPool().query('SELECT sealed_at FROM collab_execution_archives WHERE id=ANY($1)', [[incomplete.id, complete.id]])).rows)
    .toEqual([{ sealed_at: null }, { sealed_at: null }]);
});
