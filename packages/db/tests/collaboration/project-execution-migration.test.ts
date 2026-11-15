import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePool, getPool } from '../../src/pool.js';
import { runMigrations } from '../../src/migrate.js';
import {
  CollabServiceError,
  bootstrapCollaborationWorkspace,
  createCollabProject,
  createCollabTask,
  createExecutionHost,
  createProjectHostMapping,
  ensureGithubPrincipal,
  getProjectChatSettings,
  getProjectSummarySettings,
  registerConnector,
  submitConnectorObservations,
  updateCollabProjectOverview,
  updateProjectChatSettings,
  updateProjectExecutionDefaults,
  updateProjectSummarySettings,
  type ConnectorRegistration,
} from '../../src/collaboration/index.js';
import {
  inspectLegacyProjectExecutionDefaults,
  migrateLegacyProjectExecutionDefaults,
} from '../../src/collaboration/project-execution-migration.js';
import { freezeLegacyExecution } from '../../src/collaboration/execution-retirement.js';
import {
  resetCollabSchema,
  resolveCollabTestDatabaseUrl,
  seedOrgMembership,
  seedUser,
} from '../helpers/collab-db.js';

process.env.DATABASE_URL = resolveCollabTestDatabaseUrl();
const databaseUrl = process.env.DATABASE_URL;
const orgId = 'legacy-migration-org';
const foreignOrgId = 'foreign-migration-org';
const REPO_KEY = 'acme/legacy';
const OTHER_REPO_KEY = 'acme/other';
const NATIVE_BASE_REF = 'origin/HEAD';
const LEGACY_INSTRUCTIONS = 'Legacy µnícødé instructions\nkeep byte-exact\ttrailing  \n';
const RUN_INSTRUCTIONS = 'Run on the legacy bench\nwith µnícødé steps';
const TEST_INSTRUCTIONS = 'npm test -- legacy suite\tkeep exact';
const HOST_PROFILES = [
  { id: 'legacy-profile', model: 'legacy-model' },
  { id: 'legacy-summary-profile', model: 'legacy-summary-model' },
];
const EMPTY_SUMMARY = { enabled: false, profileId: null, model: null };
const RUNNER_PROFILES = [
  { id: 'design', models: ['large'], default_model: 'large' },
  { id: 'build', models: ['small'], default_model: 'small' },
];
const CHAT_TARGET: ChatTarget = { agentId: 'migration-runner', profileId: 'design', model: null };
const SUMMARY_TARGET: SummaryTarget = { agentId: 'migration-runner', profileId: 'design', model: 'large' };
const BASELINE_CHAT = { profileId: null, model: null, instructions: '' };
const BASELINE_SUMMARY = { enabled: false, agentId: null, profileId: null, model: null };
const CANARIES = ['µnícødé', REPO_KEY, OTHER_REPO_KEY, 'legacy-host', 'legacy-profile', 'legacy-model', 'legacy-summary-model'];
type ChatTarget = { agentId: string; profileId: string; model: string | null };
type SummaryTarget = ChatTarget;
type LegacySummary = { enabled: boolean; profileId: string | null; model: string | null };

let actor: { principalId: string; sessionVersion: number };
let outsider: { principalId: string; sessionVersion: number };
let workspaceId: string;
let foreignWorkspaceId: string;
let sharedHostId: string;
let primaryProjectId: string;
let primarySeeded: { mappingId: string; version: number };
let connectorHost: { id: string; name: string; token: string };
let connector: ConnectorRegistration;

async function project(name: string) {
  return createCollabProject({ actor, workspaceId, name });
}

async function linkedProject(name: string) {
  return createCollabProject({ actor, workspaceId, name, repoFullName: REPO_KEY });
}

async function advertisedAgent(
  id: string,
  purpose: string[],
  live: boolean,
  agentOrg = orgId,
  capacity = 4,
  maxChatSlots: number | null = null,
) {
  await getPool().query(
    `INSERT INTO agents(id,org_id,agent_type,transport,max_chat_slots) VALUES($1,$2,'codex','long_poll',$3)`,
    [id, agentOrg, maxChatSlots],
  );
  await getPool().query(
    `INSERT INTO agent_sessions(org_id,agent_id,session_meta,status,last_seen_at,expires_at)
     VALUES($1,$2,$3,'online',NOW(),CASE WHEN $4 THEN NOW()+interval '10 minutes' ELSE NOW()-interval '1 minute' END)`,
    [agentOrg, id, JSON.stringify({ capacity, supported_claim_types: purpose, profiles: RUNNER_PROFILES }), live],
  );
}

async function seedHost(name: string, repositories: string[] = [REPO_KEY]) {
  return (
    await getPool().query<{ id: string }>(
      `INSERT INTO collab_hosts (name, token_hash, catalog, enrolled_by_principal_id)
       VALUES ($1, $2, $3::jsonb, $4) RETURNING id`,
      [name, `${name}-token-hash`, JSON.stringify({ repositories: repositories.map(key => ({ key })), profiles: HOST_PROFILES }), actor.principalId],
    )
  ).rows[0].id;
}

async function createMapping(projectId: string, repositoryKey: string = REPO_KEY, hostId: string = sharedHostId, baseRef: string = NATIVE_BASE_REF) {
  return createProjectHostMapping({
    actor,
    projectId,
    hostId,
    repositoryKey,
    baseRef,
    profileIds: ['legacy-profile', 'legacy-summary-profile'],
    defaultProfileId: 'legacy-profile',
  });
}

async function writeLegacyDefaults(projectId: string, mappingId: string, summary: LegacySummary) {
  const current = (
    await getPool().query<{ version: number }>('SELECT version FROM collab_projects WHERE id=$1', [projectId])
  ).rows[0];
  const saved = await updateProjectExecutionDefaults({
    actor,
    projectId,
    expectedVersion: current.version,
    executionDefaults: {
      mappingId,
      profileId: 'legacy-profile',
      model: 'legacy-model',
      instructions: LEGACY_INSTRUCTIONS,
      summary,
    },
  });
  return saved.version;
}

async function seedRawLegacyDefaults(projectId: string, legacy: Record<string, unknown>) {
  await getPool().query('UPDATE collab_projects SET execution_defaults=$2::jsonb WHERE id=$1', [projectId, JSON.stringify(legacy)]);
}

let fixtureCounter = 0;

async function legacyProject(name: string, summary: LegacySummary, hostId?: string) {
  fixtureCounter += 1;
  const host = hostId ?? (await seedHost(`legacy-fixture-host-${fixtureCounter}`));
  const target = await linkedProject(name);
  const mapping = await createMapping(target.id, REPO_KEY, host);
  const version = await writeLegacyDefaults(target.id, mapping.id, summary);
  return { id: target.id, seeded: { mappingId: mapping.id, version }, hostId: host };
}

async function nativeState(projectId: string) {
  return (
    await getPool().query<{
      execution_mode: string;
      default_agent_id: string | null;
      chat_execution_defaults: unknown;
      summary_execution_defaults: unknown;
      execution_defaults: unknown;
      version: number;
      board_version: number;
    }>(
      `SELECT execution_mode, default_agent_id, chat_execution_defaults, summary_execution_defaults, execution_defaults, version, board_version
       FROM collab_projects WHERE id=$1`,
      [projectId],
    )
  ).rows[0];
}

function migrateCall(
  projectId: string,
  expectedVersion: number,
  sourceHash: string | null,
  chat: ChatTarget,
  summary: SummaryTarget | null,
  apply?: boolean,
) {
  return migrateLegacyProjectExecutionDefaults({
    actor,
    workspaceId,
    projectId,
    expectedVersion,
    sourceHash,
    chat,
    summary,
    apply,
  });
}

async function rejectionOf(promise: Promise<unknown>): Promise<CollabServiceError> {
  let error: unknown;
  await promise.catch((caught: unknown) => {
    error = caught;
  });
  if (!(error instanceof CollabServiceError)) {
    throw new Error(`expected a CollabServiceError rejection, got ${String(error)}`);
  }
  return error;
}

async function waitForLockWaiters(monitor: pg.Client, minimum: number, label: string) {
  const monitorPid = (await monitor.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0].pid;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const result = await monitor.query<{ waiters: number }>(
      `SELECT count(*)::int AS waiters FROM pg_stat_activity
       WHERE datname = current_database()
         AND wait_event_type = 'Lock'
         AND pid <> $1`,
      [monitorPid],
    );
    if (result.rows[0].waiters >= minimum) return;
    await monitor.query('SELECT 1');
  }
  throw new Error(`timed out waiting for ${label}`);
}

const cliPath = fileURLToPath(new URL('../../scripts/project-execution-migration.mjs', import.meta.url));

function runCli(args: string[]) {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    encoding: 'utf8',
    timeout: 5000,
    env: { ...process.env, DATABASE_URL: databaseUrl },
  });
  if (result.error) throw result.error;
  if (result.status === null) throw new Error('The migration CLI did not exit normally');
  return result;
}

function mappingInput(
  projectId: string,
  expectedVersion: number,
  sourceHash: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    actor: { ...actor },
    workspaceId,
    projectId,
    expectedVersion,
    sourceHash,
    chat: CHAT_TARGET,
    summary: null,
    ...overrides,
  };
}

async function withMappingFile(input: Record<string, unknown>, run: (filePath: string) => Promise<void> | void) {
  const dir = await mkdtemp(path.join(tmpdir(), 'ff-migration-cli-'));
  const filePath = path.join(dir, 'mapping.json');
  try {
    await writeFile(filePath, JSON.stringify(input), { mode: 0o600 });
    await chmod(filePath, 0o600);
    await run(filePath);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function expectNoPrivateLeak(result: { stdout: string; stderr: string }, extraSecrets: string[] = []) {
  const blob = result.stdout + result.stderr;
  for (const canary of CANARIES) {
    expect(blob).not.toContain(canary);
  }
  for (const secret of extraSecrets) {
    expect(blob).not.toContain(secret);
  }
}

describe('legacy project execution defaults migration (real Postgres)', () => {
  beforeAll(async () => {
    await resetCollabSchema(databaseUrl);
    await runMigrations();
    const userId = await seedUser(databaseUrl, { githubId: 9851, login: 'legacy-migration-admin' });
    await seedOrgMembership(databaseUrl, userId, orgId, 'admin');
    await seedOrgMembership(databaseUrl, userId, foreignOrgId, 'admin');
    const principal = await ensureGithubPrincipal({
      userId,
      displayName: 'Migration admin',
      email: 'legacy-migration-admin@example.test',
    });
    actor = { principalId: principal.id, sessionVersion: principal.sessionVersion };
    const outsiderUser = await seedUser(databaseUrl, { githubId: 9852, login: 'legacy-migration-outsider' });
    const outsiderPrincipal = await ensureGithubPrincipal({
      userId: outsiderUser,
      displayName: 'Migration outsider',
      email: 'legacy-migration-outsider@example.test',
    });
    outsider = { principalId: outsiderPrincipal.id, sessionVersion: outsiderPrincipal.sessionVersion };
    workspaceId = (
      await bootstrapCollaborationWorkspace({ actor, orgId, name: 'Legacy migration', idempotencyKey: 'legacy-migration-workspace' })
    ).id;
    foreignWorkspaceId = (
      await bootstrapCollaborationWorkspace({
        actor,
        orgId: foreignOrgId,
        name: 'Foreign migration',
        idempotencyKey: 'foreign-migration-workspace',
      })
    ).id;
    await getPool().query(`INSERT INTO repos (id, org_id, repo_full_name) VALUES ('legacy-fixture-repo', $1, $2)`, [orgId, REPO_KEY]);
    sharedHostId = await seedHost('legacy-host');
    connectorHost = await createExecutionHost({ actor, name: 'migration-connector-host' });
    connector = await registerConnector({
      token: connectorHost.token,
      instanceId: 'legacy-migration-connector',
      protocolVersion: 1,
      sdkVersion: '0.12.0',
      capabilities: {},
      catalog: { repositories: [{ key: REPO_KEY }], profiles: HOST_PROFILES },
    });
    await advertisedAgent('migration-runner', ['chat', 'summary'], true);
    await advertisedAgent('chat-only-runner', ['chat'], true);
    await advertisedAgent('disabled-chat-runner', ['chat'], true, orgId, 1);
    await advertisedAgent('offline-runner', ['chat'], false);
    await advertisedAgent('foreign-runner', ['chat', 'summary'], true, foreignOrgId);
    const primary = await legacyProject('Legacy carrier', {
      enabled: true,
      profileId: 'legacy-summary-profile',
      model: 'legacy-summary-model',
    });
    primaryProjectId = primary.id;
    primarySeeded = primary.seeded;
  });

  afterAll(closePool);

  it('inspect exposes the source mapping and hash without private payloads and preview writes nothing', async () => {
    const inspection = await inspectLegacyProjectExecutionDefaults({ actor, workspaceId, projectId: primaryProjectId });
    expect(inspection).toMatchObject({
      projectId: primaryProjectId,
      version: primarySeeded.version,
      executionMode: 'chat',
      configured: true,
      sourceMappingId: primarySeeded.mappingId,
      requiresSummaryMapping: true,
    });
    expect(inspection.sourceHash).toMatch(/^[0-9a-f]{64}$/);
    const blob = JSON.stringify(inspection);
    for (const canary of CANARIES) {
      expect(blob).not.toContain(canary);
    }
    const preview = await migrateCall(primaryProjectId, primarySeeded.version, inspection.sourceHash, CHAT_TARGET, SUMMARY_TARGET);
    expect(preview).toMatchObject({
      projectId: primaryProjectId,
      version: primarySeeded.version,
      status: 'ready',
      sourceMappingId: primarySeeded.mappingId,
      mappedSummary: true,
    });
    const state = await nativeState(primaryProjectId);
    expect(state.version).toBe(primarySeeded.version);
    expect(state.execution_mode).toBe('chat');
    expect(state.default_agent_id).toBeNull();
    expect(state.chat_execution_defaults).toEqual(BASELINE_CHAT);
    expect(state.summary_execution_defaults).toEqual(BASELINE_SUMMARY);
    expect(state.execution_defaults).toEqual({
      mappingId: primarySeeded.mappingId,
      profileId: 'legacy-profile',
      model: 'legacy-model',
      instructions: LEGACY_INSTRUCTIONS,
      summary: { enabled: true, profileId: 'legacy-summary-profile', model: 'legacy-summary-model' },
    });
  });

  it('apply maps chat byte-exact with an explicit null model, preserves overviews, in one version bump', async () => {
    const target = await linkedProject('Mapped carrier');
    const overview = await updateCollabProjectOverview({
      actor,
      projectId: target.id,
      expectedVersion: 1,
      runInstructions: RUN_INSTRUCTIONS,
      testInstructions: TEST_INSTRUCTIONS,
    });
    const mapping = await createMapping(target.id);
    const version = await writeLegacyDefaults(target.id, mapping.id, {
      enabled: true,
      profileId: 'legacy-summary-profile',
      model: 'legacy-summary-model',
    });
    const seeded = { mappingId: mapping.id, version };
    expect(seeded.version).toBe(overview.version + 1);
    const inspection = await inspectLegacyProjectExecutionDefaults({ actor, workspaceId, projectId: target.id });
    const applied = await migrateCall(target.id, seeded.version, inspection.sourceHash, CHAT_TARGET, SUMMARY_TARGET, true);
    expect(applied).toMatchObject({
      projectId: target.id,
      version: seeded.version + 1,
      status: 'applied',
      sourceMappingId: seeded.mappingId,
      mappedSummary: true,
    });
    const state = await nativeState(target.id);
    expect(state.version).toBe(seeded.version + 1);
    expect(state.execution_mode).toBe('chat');
    expect(state.default_agent_id).toBe('migration-runner');
    expect(state.chat_execution_defaults).toEqual({ profileId: 'design', model: null, instructions: LEGACY_INSTRUCTIONS });
    expect(state.summary_execution_defaults).toEqual({ enabled: true, agentId: 'migration-runner', profileId: 'design', model: 'large' });
    expect(state.execution_defaults).toEqual({
      mappingId: seeded.mappingId,
      profileId: 'legacy-profile',
      model: 'legacy-model',
      instructions: LEGACY_INSTRUCTIONS,
      summary: { enabled: true, profileId: 'legacy-summary-profile', model: 'legacy-summary-model' },
    });
    const overviews = (
      await getPool().query<{ run_instructions: string; test_instructions: string }>(
        'SELECT run_instructions, test_instructions FROM collab_project_overviews WHERE project_id=$1',
        [target.id],
      )
    ).rows[0];
    expect(overviews).toEqual({ run_instructions: RUN_INSTRUCTIONS, test_instructions: TEST_INSTRUCTIONS });
    const mappingRow = (
      await getPool().query<{ profile_ids: string[]; repository_key: string; default_profile_id: string; host_id: string; base_ref: string }>(
        'SELECT profile_ids, repository_key, default_profile_id, host_id, base_ref FROM collab_project_host_mappings WHERE id=$1',
        [seeded.mappingId],
      )
    ).rows[0];
    expect(mappingRow).toEqual({
      profile_ids: ['legacy-profile', 'legacy-summary-profile'],
      repository_key: REPO_KEY,
      default_profile_id: 'legacy-profile',
      host_id: sharedHostId,
      base_ref: NATIVE_BASE_REF,
    });
  });

  it('replay of the matching mapped state acknowledges read-only with the original expected version', async () => {
    const context = await legacyProject('Replay carrier', EMPTY_SUMMARY);
    const inspection = await inspectLegacyProjectExecutionDefaults({ actor, workspaceId, projectId: context.id });
    const applied = await migrateCall(context.id, context.seeded.version, inspection.sourceHash, CHAT_TARGET, null, true);
    expect(applied).toMatchObject({ projectId: context.id, version: context.seeded.version + 1, status: 'applied', mappedSummary: false });
    const replay = await migrateCall(context.id, context.seeded.version, inspection.sourceHash, CHAT_TARGET, null);
    expect(replay).toMatchObject({
      projectId: context.id,
      version: context.seeded.version + 1,
      status: 'already_mapped',
      sourceMappingId: context.seeded.mappingId,
      mappedSummary: false,
    });
    expect((await nativeState(context.id)).version).toBe(context.seeded.version + 1);
  });

  it('migrates onto a known-offline agent whose catalog still matches and keeps model null despite an advertised default', async () => {
    const context = await legacyProject('Offline carrier', EMPTY_SUMMARY);
    const inspection = await inspectLegacyProjectExecutionDefaults({ actor, workspaceId, projectId: context.id });
    const applied = await migrateCall(
      context.id,
      context.seeded.version,
      inspection.sourceHash,
      { agentId: 'offline-runner', profileId: 'design', model: null },
      null,
      true,
    );
    expect(applied).toMatchObject({ projectId: context.id, version: context.seeded.version + 1, status: 'applied', mappedSummary: false });
    const state = await nativeState(context.id);
    expect(state.default_agent_id).toBe('offline-runner');
    expect(state.chat_execution_defaults).toEqual({ profileId: 'design', model: null, instructions: LEGACY_INSTRUCTIONS });
    expect(state.version).toBe(context.seeded.version + 1);
  });

  it('fails closed when the source repository or base ref is not the native equivalent', async () => {
    const unlinked = await project('Unlinked source');
    const unlinkedHostId = await seedHost('unlinked-source-host');
    const unlinkedMapping = await createMapping(unlinked.id, REPO_KEY, unlinkedHostId);
    const unlinkedVersion = await writeLegacyDefaults(unlinked.id, unlinkedMapping.id, EMPTY_SUMMARY);
    const unlinkedInspection = await inspectLegacyProjectExecutionDefaults({ actor, workspaceId, projectId: unlinked.id });
    expect(unlinkedInspection).toMatchObject({ projectId: unlinked.id, configured: true, sourceMappingId: unlinkedMapping.id });
    const unlinkedBefore = await nativeState(unlinked.id);
    expect((await rejectionOf(migrateCall(unlinked.id, unlinkedVersion, unlinkedInspection.sourceHash, CHAT_TARGET, null, true))).status).toBe(422);
    expect(await nativeState(unlinked.id)).toEqual(unlinkedBefore);

    const mismatched = await linkedProject('Mismatched repo source');
    const mismatchedHostId = await seedHost('mismatched-repo-host', [OTHER_REPO_KEY]);
    const mismatchedMapping = await createMapping(mismatched.id, OTHER_REPO_KEY, mismatchedHostId);
    const mismatchedVersion = await writeLegacyDefaults(mismatched.id, mismatchedMapping.id, EMPTY_SUMMARY);
    const mismatchedInspection = await inspectLegacyProjectExecutionDefaults({ actor, workspaceId, projectId: mismatched.id });
    expect(mismatchedInspection).toMatchObject({ projectId: mismatched.id, configured: true, sourceMappingId: mismatchedMapping.id });
    const mismatchedBefore = await nativeState(mismatched.id);
    expect((await rejectionOf(migrateCall(mismatched.id, mismatchedVersion, mismatchedInspection.sourceHash, CHAT_TARGET, null, true))).status).toBe(422);
    expect(await nativeState(mismatched.id)).toEqual(mismatchedBefore);

    for (const baseRef of ['main', 'release']) {
      const target = await linkedProject(`Wrong base ref ${baseRef}`);
      const mapping = await createMapping(target.id, REPO_KEY, sharedHostId, baseRef);
      const version = await writeLegacyDefaults(target.id, mapping.id, EMPTY_SUMMARY);
      const inspection = await inspectLegacyProjectExecutionDefaults({ actor, workspaceId, projectId: target.id });
      expect(inspection).toMatchObject({ projectId: target.id, configured: true, sourceMappingId: mapping.id });
      const before = await nativeState(target.id);
      expect((await rejectionOf(migrateCall(target.id, version, inspection.sourceHash, CHAT_TARGET, null, true))).status).toBe(422);
      expect(await nativeState(target.id)).toEqual(before);
    }

    const unregisteredRepo = await linkedProject('Unregistered linked repo');
    await getPool().query('UPDATE collab_projects SET linked_repo_full_name=$2 WHERE id=$1', [unregisteredRepo.id, OTHER_REPO_KEY]);
    const ghostHostId = await seedHost('unregistered-repo-host', [OTHER_REPO_KEY]);
    const ghostMapping = await createMapping(unregisteredRepo.id, OTHER_REPO_KEY, ghostHostId);
    const ghostVersion = await writeLegacyDefaults(unregisteredRepo.id, ghostMapping.id, EMPTY_SUMMARY);
    const ghostInspection = await inspectLegacyProjectExecutionDefaults({ actor, workspaceId, projectId: unregisteredRepo.id });
    expect(ghostInspection).toMatchObject({ projectId: unregisteredRepo.id, configured: true, sourceMappingId: ghostMapping.id });
    const ghostBefore = await nativeState(unregisteredRepo.id);
    expect(
      await rejectionOf(migrateCall(unregisteredRepo.id, ghostVersion, ghostInspection.sourceHash, CHAT_TARGET, null, true)),
    ).toMatchObject({ status: 422, code: 'repository_context_unavailable' });
    expect(await nativeState(unregisteredRepo.id)).toEqual(ghostBefore);
  });

  it('changing the host catalog or mapping source invalidates the hash without touching project version', async () => {
    const context = await legacyProject('Hash invalidation source', EMPTY_SUMMARY);
    const first = await inspectLegacyProjectExecutionDefaults({ actor, workspaceId, projectId: context.id });
    await getPool().query('UPDATE collab_hosts SET catalog=$2::jsonb WHERE id=$1', [
      context.hostId,
      JSON.stringify({ repositories: [{ key: REPO_KEY }], profiles: [HOST_PROFILES[0]] }),
    ]);
    const afterCatalog = await inspectLegacyProjectExecutionDefaults({ actor, workspaceId, projectId: context.id });
    expect(afterCatalog.configured).toBe(true);
    expect(afterCatalog.sourceHash).not.toBe(first.sourceHash);
    expect(afterCatalog.version).toBe(context.seeded.version);
    expect((await rejectionOf(migrateCall(context.id, context.seeded.version, first.sourceHash, CHAT_TARGET, null, true))).status).toBe(409);
    await getPool().query(`UPDATE collab_project_host_mappings SET profile_ids='{legacy-profile}' WHERE id=$1`, [context.seeded.mappingId]);
    const afterMapping = await inspectLegacyProjectExecutionDefaults({ actor, workspaceId, projectId: context.id });
    expect(afterMapping.sourceHash).not.toBe(afterCatalog.sourceHash);
    expect(afterMapping.version).toBe(context.seeded.version);
    expect((await rejectionOf(migrateCall(context.id, context.seeded.version, afterCatalog.sourceHash, CHAT_TARGET, null, true))).status).toBe(409);
    const state = await nativeState(context.id);
    expect(state.version).toBe(context.seeded.version);
    expect(state.default_agent_id).toBeNull();
    expect(state.chat_execution_defaults).toEqual(BASELINE_CHAT);
    expect(state.summary_execution_defaults).toEqual(BASELINE_SUMMARY);
  });

  it('rejects a stale project version without writes', async () => {
    const context = await legacyProject('Stale version source', EMPTY_SUMMARY);
    const beforeResave = await inspectLegacyProjectExecutionDefaults({ actor, workspaceId, projectId: context.id });
    const resaved = await updateProjectExecutionDefaults({
      actor,
      projectId: context.id,
      expectedVersion: context.seeded.version,
      executionDefaults: {
        mappingId: context.seeded.mappingId,
        profileId: 'legacy-profile',
        model: 'legacy-model',
        instructions: LEGACY_INSTRUCTIONS,
        summary: EMPTY_SUMMARY,
      },
    });
    expect(resaved.version).toBe(context.seeded.version + 1);
    const current = await inspectLegacyProjectExecutionDefaults({ actor, workspaceId, projectId: context.id });
    expect(current.version).toBe(context.seeded.version + 1);
    expect(current.sourceHash).toBe(beforeResave.sourceHash);
    const rejection = await rejectionOf(migrateCall(context.id, context.seeded.version, current.sourceHash, CHAT_TARGET, null, true));
    expect(rejection).toMatchObject({ status: 409, code: 'version_conflict' });
    const state = await nativeState(context.id);
    expect(state.version).toBe(context.seeded.version + 1);
    expect(state.default_agent_id).toBeNull();
    expect(state.chat_execution_defaults).toEqual(BASELINE_CHAT);
    expect(state.summary_execution_defaults).toEqual(BASELINE_SUMMARY);
    expect(state.execution_defaults).toEqual({
      mappingId: context.seeded.mappingId,
      profileId: 'legacy-profile',
      model: 'legacy-model',
      instructions: LEGACY_INSTRUCTIONS,
      summary: EMPTY_SUMMARY,
    });
  });

  it('rejects foreign org agents, unadvertised models and chat-disabled targets without writes', async () => {
    const context = await legacyProject('Rejected native targets', EMPTY_SUMMARY);
    const inspection = await inspectLegacyProjectExecutionDefaults({ actor, workspaceId, projectId: context.id });
    expect(
      (await rejectionOf(migrateCall(context.id, context.seeded.version, inspection.sourceHash, { agentId: 'foreign-runner', profileId: 'design', model: null }, null, true)))
        .status,
    ).toBe(422);
    expect(
      (await rejectionOf(migrateCall(context.id, context.seeded.version, inspection.sourceHash, { agentId: 'migration-runner', profileId: 'design', model: 'small' }, null, true)))
        .status,
    ).toBe(422);
    expect(
      (await rejectionOf(migrateCall(context.id, context.seeded.version, inspection.sourceHash, { agentId: 'disabled-chat-runner', profileId: 'design', model: null }, null, true)))
        .status,
    ).toBe(422);
    const state = await nativeState(context.id);
    expect(state.version).toBe(context.seeded.version);
    expect(state.default_agent_id).toBeNull();
    expect(state.chat_execution_defaults).toEqual(BASELINE_CHAT);
    expect(state.summary_execution_defaults).toEqual(BASELINE_SUMMARY);
    expect(state.execution_defaults).toEqual({
      mappingId: context.seeded.mappingId,
      profileId: 'legacy-profile',
      model: 'legacy-model',
      instructions: LEGACY_INSTRUCTIONS,
      summary: EMPTY_SUMMARY,
    });
  });

  it('requires an explicit summary mapping for a disabled-but-configured legacy summary and preserves the disabled flag', async () => {
    const context = await legacyProject('Disabled summary identity', {
      enabled: false,
      profileId: 'legacy-summary-profile',
      model: 'legacy-summary-model',
    });
    const inspection = await inspectLegacyProjectExecutionDefaults({ actor, workspaceId, projectId: context.id });
    expect(inspection.requiresSummaryMapping).toBe(true);
    expect((await rejectionOf(migrateCall(context.id, context.seeded.version, inspection.sourceHash, CHAT_TARGET, null, true))).status).toBe(422);
    expect(
      (await rejectionOf(migrateCall(context.id, context.seeded.version, inspection.sourceHash, CHAT_TARGET, { agentId: 'foreign-runner', profileId: 'design', model: null }, true)))
        .status,
    ).toBe(422);
    const applied = await migrateCall(
      context.id,
      context.seeded.version,
      inspection.sourceHash,
      CHAT_TARGET,
      { agentId: 'migration-runner', profileId: 'design', model: null },
      true,
    );
    expect(applied).toMatchObject({
      projectId: context.id,
      version: context.seeded.version + 1,
      status: 'applied',
      sourceMappingId: context.seeded.mappingId,
      mappedSummary: true,
    });
    const state = await nativeState(context.id);
    expect(state.version).toBe(context.seeded.version + 1);
    expect(state.summary_execution_defaults).toEqual({ enabled: false, agentId: 'migration-runner', profileId: 'design', model: null });
    expect(state.chat_execution_defaults).toEqual({ profileId: 'design', model: null, instructions: LEGACY_INSTRUCTIONS });
    expect(state.execution_defaults).toEqual({
      mappingId: context.seeded.mappingId,
      profileId: 'legacy-profile',
      model: 'legacy-model',
      instructions: LEGACY_INSTRUCTIONS,
      summary: { enabled: false, profileId: 'legacy-summary-profile', model: 'legacy-summary-model' },
    });
  });

  it('requires an explicit summary mapping for an enabled legacy summary without a configured identity', async () => {
    const target = await linkedProject('Enabled unconfigured summary');
    const mapping = await createMapping(target.id);
    const legacy = {
      mappingId: mapping.id,
      profileId: 'legacy-profile',
      model: 'legacy-model',
      instructions: LEGACY_INSTRUCTIONS,
      summary: { enabled: true, profileId: null, model: null },
    };
    await seedRawLegacyDefaults(target.id, legacy);
    const inspection = await inspectLegacyProjectExecutionDefaults({ actor, workspaceId, projectId: target.id });
    expect(inspection).toMatchObject({
      projectId: target.id,
      configured: true,
      sourceMappingId: mapping.id,
      requiresSummaryMapping: true,
    });
    const before = await nativeState(target.id);
    expect((await rejectionOf(migrateCall(target.id, before.version, inspection.sourceHash, CHAT_TARGET, null, true))).status).toBe(422);
    const unchanged = await nativeState(target.id);
    expect(unchanged.version).toBe(before.version);
    expect(unchanged.chat_execution_defaults).toEqual(BASELINE_CHAT);
    expect(unchanged.summary_execution_defaults).toEqual(BASELINE_SUMMARY);
    const applied = await migrateCall(target.id, before.version, inspection.sourceHash, CHAT_TARGET, SUMMARY_TARGET, true);
    expect(applied).toMatchObject({ projectId: target.id, version: before.version + 1, status: 'applied', sourceMappingId: mapping.id, mappedSummary: true });
    const state = await nativeState(target.id);
    expect(state.version).toBe(before.version + 1);
    expect(state.summary_execution_defaults).toEqual({ enabled: true, agentId: 'migration-runner', profileId: 'design', model: 'large' });
    expect(state.chat_execution_defaults).toEqual({ profileId: 'design', model: null, instructions: LEGACY_INSTRUCTIONS });
    expect(state.execution_defaults).toEqual(legacy);
  });

  it('pins the source host identity in the hash when the mapping switches to an identical catalog host', async () => {
    const target = await linkedProject('Host identity source');
    const firstHostId = await seedHost('host-identity-one');
    const secondHostId = await seedHost('host-identity-two');
    const mapping = await createMapping(target.id, REPO_KEY, firstHostId);
    const version = await writeLegacyDefaults(target.id, mapping.id, EMPTY_SUMMARY);
    const before = await inspectLegacyProjectExecutionDefaults({ actor, workspaceId, projectId: target.id });
    expect(before.configured).toBe(true);
    await getPool().query('UPDATE collab_project_host_mappings SET host_id=$2 WHERE id=$1', [mapping.id, secondHostId]);
    const after = await inspectLegacyProjectExecutionDefaults({ actor, workspaceId, projectId: target.id });
    expect(after.configured).toBe(true);
    expect(after.sourceMappingId).toBe(mapping.id);
    expect(after.sourceHash).not.toBe(before.sourceHash);
    expect(after.version).toBe(version);
    expect((await rejectionOf(migrateCall(target.id, version, before.sourceHash, CHAT_TARGET, null, true))).status).toBe(409);
    const state = await nativeState(target.id);
    expect(state.version).toBe(version);
    expect(state.default_agent_id).toBeNull();
    expect(state.chat_execution_defaults).toEqual(BASELINE_CHAT);
    expect(state.summary_execution_defaults).toEqual(BASELINE_SUMMARY);
  });

  it('keeps a revoked source host eligible as historical config for apply and replay', async () => {
    const context = await legacyProject('Revoked source host', EMPTY_SUMMARY);
    await getPool().query('UPDATE collab_hosts SET revoked_at=NOW() WHERE id=$1', [context.hostId]);
    const inspection = await inspectLegacyProjectExecutionDefaults({ actor, workspaceId, projectId: context.id });
    expect(inspection).toMatchObject({ projectId: context.id, configured: true, sourceMappingId: context.seeded.mappingId });
    const applied = await migrateCall(context.id, context.seeded.version, inspection.sourceHash, CHAT_TARGET, null, true);
    expect(applied).toMatchObject({ projectId: context.id, version: context.seeded.version + 1, status: 'applied', sourceMappingId: context.seeded.mappingId, mappedSummary: false });
    const replay = await migrateCall(context.id, context.seeded.version, inspection.sourceHash, CHAT_TARGET, null);
    expect(replay).toMatchObject({ projectId: context.id, version: context.seeded.version + 1, status: 'already_mapped', mappedSummary: false });
    const state = await nativeState(context.id);
    expect(state.default_agent_id).toBe('migration-runner');
    expect(state.chat_execution_defaults).toEqual({ profileId: 'design', model: null, instructions: LEGACY_INSTRUCTIONS });
    expect(state.version).toBe(context.seeded.version + 1);
  });

  it('an empty legacy summary leaves an independently configured native summary untouched', async () => {
    const context = await legacyProject('Empty legacy summary', EMPTY_SUMMARY);
    const inspection = await inspectLegacyProjectExecutionDefaults({ actor, workspaceId, projectId: context.id });
    expect(inspection.requiresSummaryMapping).toBe(false);
    const settings = await getProjectSummarySettings({ actor, projectId: context.id });
    const nativeSummary = { enabled: true, agentId: 'migration-runner', profileId: 'design', model: 'large' };
    await updateProjectSummarySettings({ actor, projectId: context.id, expectedVersion: settings.version, defaults: nativeSummary });
    const applied = await migrateCall(context.id, settings.version + 1, inspection.sourceHash, CHAT_TARGET, null, true);
    expect(applied).toMatchObject({ projectId: context.id, version: settings.version + 2, status: 'applied', sourceMappingId: context.seeded.mappingId, mappedSummary: false });
    const state = await nativeState(context.id);
    expect(state.version).toBe(settings.version + 2);
    expect(state.summary_execution_defaults).toEqual(nativeSummary);
    expect(state.default_agent_id).toBe('migration-runner');
    expect(state.chat_execution_defaults).toEqual({ profileId: 'design', model: null, instructions: LEGACY_INSTRUCTIONS });
    expect(state.execution_defaults).toEqual({
      mappingId: context.seeded.mappingId,
      profileId: 'legacy-profile',
      model: 'legacy-model',
      instructions: LEGACY_INSTRUCTIONS,
      summary: EMPTY_SUMMARY,
    });
  });

  it('conflicting preexisting native chat or mapped summary rejects without overwrite', async () => {
    const chatConflict = await legacyProject('Native chat conflict', EMPTY_SUMMARY);
    const chatSettings = await getProjectChatSettings({ actor, projectId: chatConflict.id });
    const existingChat = {
      executionMode: 'chat' as const,
      defaultAgentId: 'migration-runner',
      defaults: { profileId: 'build', model: null, instructions: 'Existing native instructions' },
    };
    await updateProjectChatSettings({ actor, projectId: chatConflict.id, expectedVersion: chatSettings.version, ...existingChat });
    const chatInspection = await inspectLegacyProjectExecutionDefaults({ actor, workspaceId, projectId: chatConflict.id });
    expect((await rejectionOf(migrateCall(chatConflict.id, chatInspection.version, chatInspection.sourceHash, CHAT_TARGET, null, true))).status).toBe(409);
    const chatState = await nativeState(chatConflict.id);
    expect(chatState.version).toBe(chatInspection.version);
    expect(chatState.default_agent_id).toBe('migration-runner');
    expect(chatState.chat_execution_defaults).toEqual(existingChat.defaults);

    const summaryConflict = await legacyProject('Mapped summary conflict', {
      enabled: true,
      profileId: 'legacy-summary-profile',
      model: 'legacy-summary-model',
    });
    const summarySettings = await getProjectSummarySettings({ actor, projectId: summaryConflict.id });
    const configuredSummary = { enabled: true, agentId: 'migration-runner', profileId: 'design', model: 'large' };
    await updateProjectSummarySettings({ actor, projectId: summaryConflict.id, expectedVersion: summarySettings.version, defaults: configuredSummary });
    const summaryInspection = await inspectLegacyProjectExecutionDefaults({ actor, workspaceId, projectId: summaryConflict.id });
    expect(
      (await rejectionOf(
        migrateCall(summaryConflict.id, summaryInspection.version, summaryInspection.sourceHash, CHAT_TARGET, { agentId: 'migration-runner', profileId: 'build', model: null }, true),
      )).status,
    ).toBe(409);
    const summaryState = await nativeState(summaryConflict.id);
    expect(summaryState.version).toBe(summaryInspection.version);
    expect(summaryState.summary_execution_defaults).toEqual(configuredSummary);
    expect(summaryState.chat_execution_defaults).toEqual(BASELINE_CHAT);
    expect(summaryState.default_agent_id).toBeNull();
  });

  it('an invalid summary mapping rolls back the valid chat mapping without partial writes', async () => {
    const context = await legacyProject('Summary mapping rollback', {
      enabled: true,
      profileId: 'legacy-summary-profile',
      model: 'legacy-summary-model',
    });
    const inspection = await inspectLegacyProjectExecutionDefaults({ actor, workspaceId, projectId: context.id });
    expect(
      (await rejectionOf(migrateCall(context.id, context.seeded.version, inspection.sourceHash, CHAT_TARGET, { agentId: 'chat-only-runner', profileId: 'build', model: null }, true)))
        .status,
    ).toBe(422);
    const state = await nativeState(context.id);
    expect(state.version).toBe(context.seeded.version);
    expect(state.default_agent_id).toBeNull();
    expect(state.chat_execution_defaults).toEqual(BASELINE_CHAT);
    expect(state.summary_execution_defaults).toEqual(BASELINE_SUMMARY);
    expect(state.execution_defaults).toEqual({
      mappingId: context.seeded.mappingId,
      profileId: 'legacy-profile',
      model: 'legacy-model',
      instructions: LEGACY_INSTRUCTIONS,
      summary: { enabled: true, profileId: 'legacy-summary-profile', model: 'legacy-summary-model' },
    });
  });

  it('missing, malformed or foreign legacy sources stay preserved and unavailable', async () => {
    const unconfigured = await project('Unconfigured source');
    const inspection = await inspectLegacyProjectExecutionDefaults({ actor, workspaceId, projectId: unconfigured.id });
    expect(inspection).toMatchObject({
      projectId: unconfigured.id,
      configured: false,
      sourceMappingId: null,
      sourceHash: null,
    });
    expect((await rejectionOf(migrateCall(unconfigured.id, inspection.version, null, CHAT_TARGET, null, true))).status).toBe(422);
    expect((await rejectionOf(migrateCall(unconfigured.id, inspection.version, '0'.repeat(64), CHAT_TARGET, null, true))).status).toBe(422);
    expect((await nativeState(unconfigured.id)).execution_defaults).toBeNull();

    const malformed = await project('Malformed source');
    const malformedLegacy = { broken: true };
    await seedRawLegacyDefaults(malformed.id, malformedLegacy);
    const malformedInspection = await inspectLegacyProjectExecutionDefaults({ actor, workspaceId, projectId: malformed.id });
    expect(malformedInspection).toMatchObject({ projectId: malformed.id, configured: false, sourceMappingId: null, sourceHash: null });
    expect(await rejectionOf(migrateCall(malformed.id, malformedInspection.version, '0'.repeat(64), CHAT_TARGET, null, true))).toMatchObject({
      status: 422,
      code: 'source_defaults_unavailable',
    });
    expect((await nativeState(malformed.id)).execution_defaults).toEqual(malformedLegacy);

    const foreignSource = await project('Foreign source');
    const foreignLegacy = {
      mappingId: primarySeeded.mappingId,
      profileId: 'legacy-profile',
      model: 'legacy-model',
      instructions: 'Foreign dangling source',
      summary: { enabled: false, profileId: null, model: null },
    };
    await seedRawLegacyDefaults(foreignSource.id, foreignLegacy);
    const foreignInspection = await inspectLegacyProjectExecutionDefaults({ actor, workspaceId, projectId: foreignSource.id });
    expect(foreignInspection).toMatchObject({
      projectId: foreignSource.id,
      configured: false,
      sourceMappingId: null,
      sourceHash: null,
    });
    expect(await rejectionOf(migrateCall(foreignSource.id, foreignInspection.version, '1'.repeat(64), CHAT_TARGET, null, true))).toMatchObject({
      status: 422,
      code: 'source_defaults_unavailable',
    });
    const state = await nativeState(foreignSource.id);
    expect(state.version).toBe(foreignInspection.version);
    expect(state.execution_defaults).toEqual(foreignLegacy);
    expect(state.chat_execution_defaults).toEqual(BASELINE_CHAT);
    expect(state.summary_execution_defaults).toEqual(BASELINE_SUMMARY);
  });

  it('requires current project-admin and internal-read authority for the exact workspace scope', async () => {
    const current = await inspectLegacyProjectExecutionDefaults({ actor, workspaceId, projectId: primaryProjectId });
    const migrateArgs = {
      projectId: primaryProjectId,
      expectedVersion: current.version,
      sourceHash: current.sourceHash,
      chat: CHAT_TARGET,
      summary: SUMMARY_TARGET,
    };
    await expect(inspectLegacyProjectExecutionDefaults({ actor: outsider, workspaceId, projectId: primaryProjectId })).rejects.toMatchObject({ status: 404 });
    await expect(migrateLegacyProjectExecutionDefaults({ actor: outsider, workspaceId, ...migrateArgs })).rejects.toMatchObject({ status: 404 });
    await expect(inspectLegacyProjectExecutionDefaults({ actor, workspaceId: foreignWorkspaceId, projectId: primaryProjectId })).rejects.toMatchObject({ status: 404 });
    await expect(migrateLegacyProjectExecutionDefaults({ actor, workspaceId: foreignWorkspaceId, ...migrateArgs })).rejects.toMatchObject({ status: 404 });

    await getPool().query(
      `UPDATE collab_memberships SET role_id=(SELECT r.id FROM collab_roles r WHERE r.workspace_id=$2 AND r.name='viewer')
       WHERE workspace_id=$2 AND principal_id=$1 AND project_id IS NULL`,
      [actor.principalId, workspaceId],
    );
    await expect(inspectLegacyProjectExecutionDefaults({ actor, workspaceId, projectId: primaryProjectId })).rejects.toMatchObject({ status: 403 });
    await expect(migrateLegacyProjectExecutionDefaults({ actor, workspaceId, ...migrateArgs })).rejects.toMatchObject({ status: 403 });
    await getPool().query(
      `UPDATE collab_memberships SET role_id=(SELECT r.id FROM collab_roles r WHERE r.workspace_id=$2 AND r.name='manager')
       WHERE workspace_id=$2 AND principal_id=$1 AND project_id IS NULL`,
      [actor.principalId, workspaceId],
    );
    expect((await inspectLegacyProjectExecutionDefaults({ actor, workspaceId, projectId: primaryProjectId })).configured).toBe(true);

    await getPool().query('UPDATE collab_principals SET disabled_at=NOW() WHERE id=$1', [actor.principalId]);
    await expect(inspectLegacyProjectExecutionDefaults({ actor, workspaceId, projectId: primaryProjectId })).rejects.toMatchObject({ status: 401 });
    await getPool().query('UPDATE collab_principals SET disabled_at=NULL WHERE id=$1', [actor.principalId]);
    expect((await inspectLegacyProjectExecutionDefaults({ actor, workspaceId, projectId: primaryProjectId })).configured).toBe(true);
  });

  it('settles a concurrent connector observation and migration without deadlock', async () => {
    const context = await legacyProject('Ingest race', EMPTY_SUMMARY, connectorHost.id);
    const task = await createCollabTask({ actor, projectId: context.id, title: 'Ingest race task' });
    const inspection = await inspectLegacyProjectExecutionDefaults({ actor, workspaceId, projectId: context.id });
    const runId = (
      await getPool().query<{ id: string }>(
        `INSERT INTO collab_runs (task_id, project_id, host_id, mapping_id, profile_id, created_by_principal_id, state)
         VALUES ($1, $2, $3, $4, 'legacy-profile', $5, 'queued') RETURNING id`,
        [task.id, context.id, connectorHost.id, context.seeded.mappingId, actor.principalId],
      )
    ).rows[0].id;
    const sessionId = (
      await getPool().query<{ id: string }>(
        `INSERT INTO collab_sessions (run_id, role, title, state) VALUES ($1, 'work', 'Ingest race work', 'needs_input') RETURNING id`,
        [runId],
      )
    ).rows[0].id;
    const before = await nativeState(context.id);
    const eventId = randomUUID();
    const gate = new pg.Client({ connectionString: databaseUrl });
    const monitor = new pg.Client({ connectionString: databaseUrl });
    await gate.connect();
    await monitor.connect();
    let gateOpen = false;
    let observation: Promise<{ acceptedEventIds: string[] }> | undefined;
    let migration: Promise<{ status: string; version: number }> | undefined;
    try {
      await gate.query('BEGIN');
      gateOpen = true;
      await gate.query('SELECT id FROM collab_tasks WHERE id=$1 FOR UPDATE', [task.id]);
      observation = submitConnectorObservations({
        token: connectorHost.token,
        connectorSessionId: connector.connectorSessionId,
        leaseEpoch: connector.leaseEpoch,
        events: [
          {
            eventId,
            runId,
            sessionId,
            kind: 'state',
            observedAt: new Date().toISOString(),
            payload: { state: 'running' },
          },
        ],
      });
      await waitForLockWaiters(monitor, 1, 'observation task lock');
      migration = migrateCall(context.id, context.seeded.version, inspection.sourceHash, CHAT_TARGET, null, true);
      await waitForLockWaiters(monitor, 2, 'migration source host lock');
      await gate.query('COMMIT');
      gateOpen = false;
      const [observationOutcome, migrationOutcome] = await Promise.all([
        observation.then(
          (value) => ({ settled: true as const, value }),
          (error: unknown) => ({ settled: false as const, error }),
        ),
        migration.then(
          (value) => ({ settled: true as const, value }),
          (error: unknown) => ({ settled: false as const, error }),
        ),
      ]);
      expect(observationOutcome.settled).toBe(true);
      if (observationOutcome.settled) expect(observationOutcome.value.acceptedEventIds).toEqual([eventId]);
      expect(migrationOutcome.settled).toBe(true);
      if (migrationOutcome.settled) {
        expect(migrationOutcome.value).toMatchObject({ projectId: context.id, version: context.seeded.version + 1, status: 'applied', mappedSummary: false });
      }
      const taskRow = (
        await getPool().query<{ status: string }>('SELECT status FROM collab_tasks WHERE id=$1', [task.id])
      ).rows[0];
      expect(taskRow.status).toBe('in_progress');
      const after = await nativeState(context.id);
      expect(after.default_agent_id).toBe('migration-runner');
      expect(after.chat_execution_defaults).toEqual({ profileId: 'design', model: null, instructions: LEGACY_INSTRUCTIONS });
      expect(after.version).toBe(context.seeded.version + 1);
      expect(after.board_version).toBeGreaterThan(before.board_version);
    } finally {
      if (gateOpen) await gate.query('ROLLBACK');
      await Promise.allSettled([observation, migration].filter(Boolean));
      await Promise.all([gate.end(), monitor.end()]);
    }
  });

  it('re-checks current authority after waiting for the project lock', async () => {
    const context = await legacyProject('Authority race', EMPTY_SUMMARY);
    const inspection = await inspectLegacyProjectExecutionDefaults({ actor, workspaceId, projectId: context.id });
    const gate = new pg.Client({ connectionString: databaseUrl });
    const monitor = new pg.Client({ connectionString: databaseUrl });
    await gate.connect();
    await monitor.connect();
    let gateOpen = false;
    let migration: Promise<unknown> | undefined;
    try {
      await gate.query('BEGIN');
      gateOpen = true;
      await gate.query('SELECT id FROM collab_projects WHERE id=$1 FOR UPDATE', [context.id]);
      migration = migrateCall(context.id, context.seeded.version, inspection.sourceHash, CHAT_TARGET, null, true);
      await waitForLockWaiters(monitor, 1, 'migration project lock');
      await getPool().query('UPDATE collab_principals SET disabled_at=NOW() WHERE id=$1', [actor.principalId]);
      await gate.query('COMMIT');
      gateOpen = false;
      const outcome = await migration.then(
        (value) => ({ settled: true as const, value }),
        (error: unknown) => ({ settled: false as const, error }),
      );
      expect(outcome.settled).toBe(false);
      if (!outcome.settled) expect(outcome.error).toMatchObject({ status: 401 });
      const state = await nativeState(context.id);
      expect(state.version).toBe(context.seeded.version);
      expect(state.default_agent_id).toBeNull();
      expect(state.chat_execution_defaults).toEqual(BASELINE_CHAT);
      expect(state.summary_execution_defaults).toEqual(BASELINE_SUMMARY);
      expect(state.execution_defaults).toEqual({
        mappingId: context.seeded.mappingId,
        profileId: 'legacy-profile',
        model: 'legacy-model',
        instructions: LEGACY_INSTRUCTIONS,
        summary: EMPTY_SUMMARY,
      });
    } finally {
      if (gateOpen) await gate.query('ROLLBACK');
      await Promise.allSettled([migration].filter(Boolean));
      await Promise.all([gate.end(), monitor.end()]);
      await getPool().query('UPDATE collab_principals SET disabled_at=NULL WHERE id=$1', [actor.principalId]);
    }
  });

  it('inspect through the operator CLI exposes usable metadata without private payloads', async () => {
    const result = runCli([
      'inspect',
      '--workspace-id', workspaceId,
      '--project-id', primaryProjectId,
      '--principal-id', actor.principalId,
      '--session-version', String(actor.sessionVersion),
    ]);
    expect(result.status).toBe(0);
    const payload = JSON.parse(result.stdout);
    expect(Object.keys(payload).sort()).toEqual([
      'configured',
      'executionMode',
      'projectId',
      'requiresSummaryMapping',
      'sourceHash',
      'sourceMappingId',
      'version',
    ]);
    expect(payload).toMatchObject({
      projectId: primaryProjectId,
      configured: true,
      sourceMappingId: primarySeeded.mappingId,
      requiresSummaryMapping: true,
    });
    expect(payload.sourceHash).toMatch(/^[0-9a-f]{64}$/);
    expectNoPrivateLeak(result);
  });

  it('preview through the operator CLI leaves the persisted native state untouched', async () => {
    const context = await legacyProject('CLI preview carrier', EMPTY_SUMMARY);
    const inspection = await inspectLegacyProjectExecutionDefaults({ actor, workspaceId, projectId: context.id });
    const before = await nativeState(context.id);
    await withMappingFile(mappingInput(context.id, context.seeded.version, inspection.sourceHash), async (filePath) => {
      const result = runCli(['preview', '--input', filePath]);
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        projectId: context.id,
        status: 'ready',
        sourceMappingId: context.seeded.mappingId,
        version: context.seeded.version,
        mappedSummary: false,
      });
    });
    expect(await nativeState(context.id)).toEqual(before);
  });

  it('rejects a preview whose input file sets apply without any write', async () => {
    const context = await legacyProject('CLI hostile preview', EMPTY_SUMMARY);
    const inspection = await inspectLegacyProjectExecutionDefaults({ actor, workspaceId, projectId: context.id });
    const before = await nativeState(context.id);
    await withMappingFile(mappingInput(context.id, context.seeded.version, inspection.sourceHash), async (filePath) => {
      const positive = runCli(['preview', '--input', filePath]);
      expect(positive.status).toBe(0);
      expect(JSON.parse(positive.stdout)).toMatchObject({ projectId: context.id, status: 'ready' });
    });
    expect(await nativeState(context.id)).toEqual(before);
    const hostileInput = mappingInput(context.id, context.seeded.version, inspection.sourceHash, { apply: true });
    const inputBytes = Buffer.from(JSON.stringify(hostileInput));
    await withMappingFile(hostileInput, async (filePath) => {
      const result = runCli(['preview', '--input', filePath]);
      expect(result.status).not.toBe(0);
      expectNoPrivateLeak(result, [filePath]);
      expect(await readFile(filePath)).toEqual(inputBytes);
    });
    expect(await nativeState(context.id)).toEqual(before);
  });

  it('apply through the operator CLI migrates with overview and source preservation and creates no claims', async () => {
    const target = await linkedProject('CLI apply carrier');
    await updateCollabProjectOverview({
      actor,
      projectId: target.id,
      expectedVersion: 1,
      runInstructions: RUN_INSTRUCTIONS,
      testInstructions: TEST_INSTRUCTIONS,
    });
    const mapping = await createMapping(target.id);
    const version = await writeLegacyDefaults(target.id, mapping.id, {
      enabled: true,
      profileId: 'legacy-summary-profile',
      model: 'legacy-summary-model',
    });
    const seeded = { mappingId: mapping.id, version };
    const inspection = await inspectLegacyProjectExecutionDefaults({ actor, workspaceId, projectId: target.id });
    await withMappingFile(
      mappingInput(target.id, seeded.version, inspection.sourceHash, { summary: SUMMARY_TARGET }),
      async (filePath) => {
        const result = runCli(['apply', '--input', filePath]);
        expect(result.status).toBe(0);
        expect(JSON.parse(result.stdout)).toMatchObject({
          projectId: target.id,
          status: 'applied',
          version: seeded.version + 1,
          sourceMappingId: seeded.mappingId,
          mappedSummary: true,
        });
      },
    );
    const state = await nativeState(target.id);
    expect(state.version).toBe(seeded.version + 1);
    expect(state.default_agent_id).toBe('migration-runner');
    expect(state.chat_execution_defaults).toEqual({ profileId: 'design', model: null, instructions: LEGACY_INSTRUCTIONS });
    expect(state.summary_execution_defaults).toEqual({ enabled: true, agentId: 'migration-runner', profileId: 'design', model: 'large' });
    expect(state.execution_defaults).toEqual({
      mappingId: seeded.mappingId,
      profileId: 'legacy-profile',
      model: 'legacy-model',
      instructions: LEGACY_INSTRUCTIONS,
      summary: { enabled: true, profileId: 'legacy-summary-profile', model: 'legacy-summary-model' },
    });
    const overviews = (
      await getPool().query<{ run_instructions: string; test_instructions: string }>(
        'SELECT run_instructions, test_instructions FROM collab_project_overviews WHERE project_id=$1',
        [target.id],
      )
    ).rows[0];
    expect(overviews).toEqual({ run_instructions: RUN_INSTRUCTIONS, test_instructions: TEST_INSTRUCTIONS });
    const claims = (
      await getPool().query<{ n: number }>('SELECT count(*)::int AS n FROM collab_claim_executions WHERE project_id=$1', [target.id])
    ).rows[0];
    expect(claims.n).toBe(0);
  });

  it('replays the original CLI input as already_mapped without a version bump', async () => {
    const context = await legacyProject('CLI replay carrier', EMPTY_SUMMARY);
    const inspection = await inspectLegacyProjectExecutionDefaults({ actor, workspaceId, projectId: context.id });
    await withMappingFile(mappingInput(context.id, context.seeded.version, inspection.sourceHash), async (filePath) => {
      const applied = runCli(['apply', '--input', filePath]);
      expect(applied.status).toBe(0);
      expect(JSON.parse(applied.stdout)).toMatchObject({ status: 'applied', version: context.seeded.version + 1 });
      const versionAfterApply = (await nativeState(context.id)).version;
      expect(versionAfterApply).toBe(context.seeded.version + 1);
      const replay = runCli(['apply', '--input', filePath]);
      expect(replay.status).toBe(0);
      expect(JSON.parse(replay.stdout)).toMatchObject({ projectId: context.id, status: 'already_mapped', version: context.seeded.version + 1, mappedSummary: false });
      expect((await nativeState(context.id)).version).toBe(versionAfterApply);
    });
  });

  it('rejects wrong scope, stale hash and conflicting native targets while preserving all data', async () => {
    const scopeContext = await legacyProject('CLI wrong scope', EMPTY_SUMMARY);
    const scopeInspection = await inspectLegacyProjectExecutionDefaults({ actor, workspaceId, projectId: scopeContext.id });
    const scopeBefore = await nativeState(scopeContext.id);
    await withMappingFile(mappingInput(scopeContext.id, scopeContext.seeded.version, scopeInspection.sourceHash), async (filePath) => {
      const positive = runCli(['preview', '--input', filePath]);
      expect(positive.status).toBe(0);
      expect(JSON.parse(positive.stdout)).toMatchObject({ status: 'ready' });
    });
    expect(await nativeState(scopeContext.id)).toEqual(scopeBefore);
    await withMappingFile(
      mappingInput(scopeContext.id, scopeContext.seeded.version, scopeInspection.sourceHash, { workspaceId: foreignWorkspaceId }),
      async (filePath) => {
        const result = runCli(['apply', '--input', filePath]);
        expect(result.status).not.toBe(0);
        expectNoPrivateLeak(result, [filePath]);
      },
    );
    expect(await nativeState(scopeContext.id)).toEqual(scopeBefore);

    const staleContext = await legacyProject('CLI stale hash', EMPTY_SUMMARY);
    const staleInspection = await inspectLegacyProjectExecutionDefaults({ actor, workspaceId, projectId: staleContext.id });
    const staleBefore = await nativeState(staleContext.id);
    await withMappingFile(mappingInput(staleContext.id, staleContext.seeded.version, staleInspection.sourceHash), async (filePath) => {
      const positive = runCli(['preview', '--input', filePath]);
      expect(positive.status).toBe(0);
      expect(JSON.parse(positive.stdout)).toMatchObject({ status: 'ready' });
    });
    expect(await nativeState(staleContext.id)).toEqual(staleBefore);
    await withMappingFile(mappingInput(staleContext.id, staleContext.seeded.version, '0'.repeat(64)), async (filePath) => {
      const result = runCli(['apply', '--input', filePath]);
      expect(result.status).not.toBe(0);
      expectNoPrivateLeak(result, [filePath]);
    });
    expect(await nativeState(staleContext.id)).toEqual(staleBefore);

    const conflictContext = await legacyProject('CLI native conflict', EMPTY_SUMMARY);
    const chatSettings = await getProjectChatSettings({ actor, projectId: conflictContext.id });
    const existingChat = {
      executionMode: 'chat' as const,
      defaultAgentId: 'migration-runner',
      defaults: { profileId: 'build', model: null, instructions: 'CLI preexisting instructions' },
    };
    await updateProjectChatSettings({ actor, projectId: conflictContext.id, expectedVersion: chatSettings.version, ...existingChat });
    const conflictInspection = await inspectLegacyProjectExecutionDefaults({ actor, workspaceId, projectId: conflictContext.id });
    const conflictBefore = await nativeState(conflictContext.id);
    const inspectResult = runCli([
      'inspect',
      '--workspace-id', workspaceId,
      '--project-id', conflictContext.id,
      '--principal-id', actor.principalId,
      '--session-version', String(actor.sessionVersion),
    ]);
    expect(inspectResult.status).toBe(0);
    expect(JSON.parse(inspectResult.stdout)).toMatchObject({ projectId: conflictContext.id, configured: true });
    await withMappingFile(mappingInput(conflictContext.id, conflictInspection.version, conflictInspection.sourceHash), async (filePath) => {
      const result = runCli(['apply', '--input', filePath]);
      expect(result.status).not.toBe(0);
      expectNoPrivateLeak(result, [filePath]);
    });
    const conflictAfter = await nativeState(conflictContext.id);
    expect(conflictAfter.version).toBe(conflictBefore.version);
    expect(conflictAfter.default_agent_id).toBe('migration-runner');
    expect(conflictAfter.chat_execution_defaults).toEqual(existingChat.defaults);
  });

  it('rejects a symlinked mapping input without leaking it and leaves fixture bytes untouched', async () => {
    const context = await legacyProject('CLI symlink source', EMPTY_SUMMARY);
    const inspection = await inspectLegacyProjectExecutionDefaults({ actor, workspaceId, projectId: context.id });
    const inputBytes = Buffer.from(JSON.stringify(mappingInput(context.id, context.seeded.version, inspection.sourceHash)));
    const before = await nativeState(context.id);
    const inspectResult = runCli([
      'inspect',
      '--workspace-id', workspaceId,
      '--project-id', context.id,
      '--principal-id', actor.principalId,
      '--session-version', String(actor.sessionVersion),
    ]);
    expect(inspectResult.status).toBe(0);
    expect(JSON.parse(inspectResult.stdout)).toMatchObject({ projectId: context.id, configured: true });
    const dir = await mkdtemp(path.join(tmpdir(), 'ff-migration-cli-symlink-'));
    const realPath = path.join(dir, 'mapping.json');
    const linkPath = path.join(dir, 'link.json');
    try {
      await writeFile(realPath, inputBytes, { mode: 0o600 });
      await symlink(realPath, linkPath);
      const result = runCli(['preview', '--input', linkPath]);
      expect(result.status).not.toBe(0);
      expectNoPrivateLeak(result, [linkPath, realPath, dir]);
      expect(await readFile(realPath)).toEqual(inputBytes);
      expect(await nativeState(context.id)).toEqual(before);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('rejects a mapping input readable by group or others', async () => {
    const context = await legacyProject('CLI unsafe mode', EMPTY_SUMMARY);
    const inspection = await inspectLegacyProjectExecutionDefaults({ actor, workspaceId, projectId: context.id });
    const input = mappingInput(context.id, context.seeded.version, inspection.sourceHash);
    const inputBytes = Buffer.from(JSON.stringify(input));
    const before = await nativeState(context.id);
    await withMappingFile(input, async (filePath) => {
      const positive = runCli(['preview', '--input', filePath]);
      expect(positive.status).toBe(0);
      expect(JSON.parse(positive.stdout)).toMatchObject({ status: 'ready' });
      await chmod(filePath, 0o644);
      const result = runCli(['preview', '--input', filePath]);
      expect(result.status).not.toBe(0);
      expectNoPrivateLeak(result, [filePath]);
      expect(await readFile(filePath)).toEqual(inputBytes);
    });
    expect(await nativeState(context.id)).toEqual(before);
  });

  it('rejects repeated flags instead of silently taking the last value', async () => {
    const inspectTarget = await project('CLI flag primary');
    const decoyTarget = await project('CLI flag decoy');
    const inspectResult = runCli([
      'inspect',
      '--workspace-id', workspaceId,
      '--project-id', inspectTarget.id,
      '--principal-id', actor.principalId,
      '--session-version', String(actor.sessionVersion),
    ]);
    expect(inspectResult.status).toBe(0);
    expect(JSON.parse(inspectResult.stdout)).toMatchObject({ projectId: inspectTarget.id, configured: false });
    const repeated = runCli([
      'inspect',
      '--workspace-id', workspaceId,
      '--project-id', inspectTarget.id,
      '--project-id', decoyTarget.id,
      '--principal-id', actor.principalId,
      '--session-version', String(actor.sessionVersion),
    ]);
    expect(repeated.status).not.toBe(0);
    expectNoPrivateLeak(repeated, [inspectTarget.id, decoyTarget.id]);
  });

  it('maps frozen legacy defaults into native settings without reopening admissions or rewriting the source', async () => {
    const target = await legacyProject('Frozen source mapping', { enabled: true, profileId: 'legacy-summary-profile', model: 'legacy-summary-model' });
    const inspection = await inspectLegacyProjectExecutionDefaults({ actor, workspaceId, projectId: target.id });
    const before = await nativeState(target.id);
    const host = (await getPool().query('SELECT * FROM collab_hosts WHERE id=$1', [target.hostId])).rows[0];
    const mapping = (await getPool().query('SELECT * FROM collab_project_host_mappings WHERE id=$1', [target.seeded.mappingId])).rows[0];
    const control = (await getPool().query('SELECT frozen_at FROM collab_legacy_execution_control WHERE singleton=true')).rows[0];
    try {
      await freezeLegacyExecution();
      const applied = await migrateCall(target.id, target.seeded.version, inspection.sourceHash, CHAT_TARGET, SUMMARY_TARGET, true);
      expect(applied.status).toBe('applied');
      const after = await nativeState(target.id);
      expect(after).toMatchObject({
        execution_mode: 'chat', default_agent_id: CHAT_TARGET.agentId, version: before.version + 1,
        chat_execution_defaults: { profileId: CHAT_TARGET.profileId, model: CHAT_TARGET.model, instructions: LEGACY_INSTRUCTIONS },
        summary_execution_defaults: { enabled: true, agentId: SUMMARY_TARGET.agentId, profileId: SUMMARY_TARGET.profileId, model: SUMMARY_TARGET.model },
      });
      expect(after.execution_defaults).toEqual(before.execution_defaults);
      expect(after.board_version).toBe(before.board_version);
      expect((await getPool().query('SELECT * FROM collab_hosts WHERE id=$1', [target.hostId])).rows[0]).toEqual(host);
      expect((await getPool().query('SELECT * FROM collab_project_host_mappings WHERE id=$1', [target.seeded.mappingId])).rows[0]).toEqual(mapping);
      expect((await migrateCall(target.id, target.seeded.version, inspection.sourceHash, CHAT_TARGET, SUMMARY_TARGET, true)).status).toBe('already_mapped');
      expect((await getPool().query('SELECT frozen_at IS NOT NULL AS frozen FROM collab_legacy_execution_control WHERE singleton=true')).rows[0].frozen).toBe(true);
    } finally {
      await getPool().query('UPDATE collab_legacy_execution_control SET frozen_at=$1 WHERE singleton=true', [control.frozen_at]);
    }
  });
});
