import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import {
  resolveCollabTestDatabaseUrl,
  resetCollabSchema,
  seedLegacyUser,
  seedLegacyOrgMembership,
} from '../helpers/collab-db.js';
import { runMigrations } from '../../src/migrate.js';
import { closePool } from '../../src/pool.js';
import {
  ensureGithubPrincipal,
  bootstrapCollaborationWorkspace,
  createCollabProject,
  createCollabTask,
  createExecutionHost,
  createProjectHostMapping,
  startCollabRun,
  createRunSession,
  registerConnector,
  pollConnectorCommands,
  getCollabRun,
  updateProjectExecutionDefaults,
  submitSessionCommand,
  submitConnectorObservations,
  getSessionPendingRequests,
} from '../../src/collaboration/identity.js';
import { queueCollabSummary, recordCollabSummaryReport } from '../../src/collaboration/evidence.js';
import { READINESS_STATES, REQUIRED_CAPABILITIES, selectCatalogProfile, deliveryExecutionCheck } from '../../src/collaboration/execution.js';

process.env.DATABASE_URL = resolveCollabTestDatabaseUrl();
const DATABASE_URL = process.env.DATABASE_URL;
const MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src/migrations');

const CLAUDE_CAPS = ['timeline', 'permissions', 'questions', 'local_answers', 'steer', 'cancel', 'usage', 'summary', 'artifacts', 'wrapup', 'reporting'];
const CODEX_CAPS = [...CLAUDE_CAPS, 'secret_questions'];
const PASEO_CAPS = ['timeline', 'permissions', 'cancel', 'artifacts', 'wrapup'];
const SEVEN_STATES = ['ready', 'incomplete', 'not_installed', 'incompatible', 'invalid_config', 'sign_in_required', 'platform_unsupported'];

const COPY = {
  profile_incomplete: 'Choose a complete execution profile before starting.',
  profile_unavailable: 'This execution profile is unavailable. Contact the execution host owner.',
  execution_settings_changed: 'Execution settings changed. Ask a project administrator to select an available profile.',
  sign_in_required: 'Sign in to the selected tool on the execution host, then try again.',
};

function entry(id: string, backend: 'claude-code' | 'codex' | 'paseo', overrides: Record<string, unknown> = {}) {
  const base = {
    id,
    name: `Profile ${id}`,
    backend,
    model: backend === 'paseo' ? null : `${backend}-model-x`,
    revision: 'rev-1',
    capabilities: backend === 'claude-code' ? CLAUDE_CAPS : backend === 'codex' ? CODEX_CAPS : PASEO_CAPS,
    readiness: { state: 'ready' },
    harness: backend === 'claude-code' ? { name: 'claude-code', version: '2.1.317' } : backend === 'codex' ? { name: 'codex', version: '0.162.1' } : null,
    policy:
      backend === 'claude-code'
        ? { permissionMode: 'manual' }
        : backend === 'codex'
          ? { approvalPolicy: 'on-request', sandbox: 'workspace-write', networkAccess: false }
          : null,
    authExpectation: backend === 'claude-code' ? 'claude-subscription' : backend === 'codex' ? 'chatgpt-subscription' : 'paseo',
    limits: backend === 'paseo' ? null : { maxActiveSessions: 1 },
  };
  return { ...base, ...overrides };
}

function v2Catalog(repo: string, profiles: Array<Record<string, unknown>>) {
  return { formatVersion: 2, capacity: { 'claude-code': 1, codex: 1 }, repositories: [{ key: repo }], profiles };
}

const FREE_SLOTS = { 'claude-code': 64, codex: 64 };

const readinessProfiles = SEVEN_STATES.map((state) => entry(`cc-${state}`, 'claude-code', { readiness: { state } }));

async function rawQuery(text: string, params?: unknown[]) {
  const client = new pg.Client({ connectionString: DATABASE_URL });
  try {
    await client.connect();
    return (await client.query(text, params)).rows;
  } finally {
    await client.end();
  }
}

async function regclass(name: string): Promise<string | null> {
  return (await rawQuery(`SELECT to_regclass($1)::text AS r`, [name]))[0].r;
}

async function columnsOfExistingTables() {
  return rawQuery(
    `SELECT table_name, column_name, data_type, is_nullable, column_default
     FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name NOT IN ('collab_run_execution', 'collab_session_execution')
     ORDER BY table_name, column_name`,
  );
}

async function triggersAndIndexesOfExistingTables() {
  return rawQuery(
    `SELECT c.relname AS table_name, x.name
     FROM pg_class c
     JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
     JOIN LATERAL (
       SELECT t.tgname::text AS name FROM pg_trigger t WHERE t.tgrelid = c.oid
       UNION ALL SELECT i.indexrelid::regclass::text FROM pg_index i WHERE i.indrelid = c.oid
       UNION ALL SELECT k.conname::text FROM pg_constraint k WHERE k.conrelid = c.oid OR k.confrelid = c.oid
     ) x ON true
     WHERE c.relkind = 'r' AND c.relname NOT IN ('collab_run_execution', 'collab_session_execution')
     ORDER BY 1, 2`,
  );
}

describe('native execution ownership and catalog-exact Start (real Postgres)', () => {
  let manager;
  let operator;
  let projectId;
  let project2Id;
  const hosts: Record<string, { id: string; token: string; mappingId: string; connector?: Awaited<ReturnType<typeof registerConnector>> }> = {};
  let columnsBefore;
  let indexesBefore;
  let taskCounter = 0;

  async function newTask(pid = projectId) {
    taskCounter += 1;
    return (await createCollabTask({ actor: manager, projectId: pid, title: `Native task ${taskCounter}` })).id;
  }

  async function start(host: string, profileId: string, extra: Record<string, unknown> = {}) {
    const taskId = await newTask();
    return { taskId, result: startCollabRun({ actor: operator, taskId, expectedVersion: 1, idempotencyKey: `native-${taskCounter}-key`, mappingId: hosts[host].mappingId, profileId, ...extra }) };
  }

  async function addHost(name: string, catalog: Record<string, unknown>, profileIds: string[], pid = projectId) {
    const host = await createExecutionHost({ actor: manager, name });
    const mapping = await createProjectHostMapping({ actor: manager, projectId: pid, hostId: host.id, repositoryKey: `repo/${name}`, profileIds, defaultProfileId: profileIds[0] });
    hosts[name] = { id: host.id, token: host.token, mappingId: mapping.id };
    hosts[name].connector = await registerConnector({ token: host.token, instanceId: `inst-${name}`, protocolVersion: 1, sdkVersion: '0.12.0', capabilities: {}, catalog: catalog as never });
  }

  beforeAll(async () => {
    process.env.FF_COLLAB_AUTH_SECRET = 'collab-test-secret-0123456789abcdef0123456789abcdef';
    await resetCollabSchema(DATABASE_URL);
    const tmp = mkdtempSync(path.join(tmpdir(), 'ff-mig-'));
    try {
      cpSync(MIGRATIONS_DIR, tmp, { recursive: true });
      rmSync(path.join(tmp, '0022_collab_native_execution.sql'));
      const journal = JSON.parse(readFileSync(path.join(tmp, 'meta/_journal.json'), 'utf8'));
      journal.entries = journal.entries.filter((e: { idx: number }) => e.idx < 22);
      writeFileSync(path.join(tmp, 'meta/_journal.json'), JSON.stringify(journal));
      const pool = new pg.Pool({ connectionString: DATABASE_URL });
      try {
        await migrate(drizzle(pool), { migrationsFolder: tmp, migrationsTable: '__drizzle_migrations', migrationsSchema: 'drizzle' });
      } finally {
        await pool.end();
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
    columnsBefore = await columnsOfExistingTables();
    indexesBefore = await triggersAndIndexesOfExistingTables();
    await runMigrations();

    const legacy = await seedLegacyUser(DATABASE_URL, { githubId: 9701, login: 'native-owner' });
    await seedLegacyOrgMembership(DATABASE_URL, legacy, 'native-org', 'admin');
    const principal = await ensureGithubPrincipal({ legacyUserId: legacy, displayName: 'Native Owner', email: 'native-owner@example.test' });
    manager = { principalId: principal.id, sessionVersion: principal.sessionVersion };
    const ws = await bootstrapCollaborationWorkspace({ actor: manager, legacyOrgId: 'native-org', name: 'Native Client', idempotencyKey: 'native-ws-01' });
    projectId = (await createCollabProject({ actor: manager, workspaceId: ws.id, name: 'Native P1' })).id;
    project2Id = (await createCollabProject({ actor: manager, workspaceId: ws.id, name: 'Native P2' })).id;
    const role = await rawQuery(`SELECT id FROM collab_roles WHERE workspace_id = $1 AND name = 'operator'`, [ws.id]);
    const op = await rawQuery(`INSERT INTO collab_principals (display_name, email) VALUES ('Native Operator', 'native-op@example.test') RETURNING id, session_version`);
    await rawQuery(`INSERT INTO collab_memberships (workspace_id, principal_id, role_id) VALUES ($1, $2, $3)`, [ws.id, op[0].id, role[0].id]);
    operator = { principalId: op[0].id, sessionVersion: op[0].session_version };

    await addHost(
      'alpha',
      v2Catalog('repo/alpha', [
        entry('cc-main', 'claude-code'),
        entry('cc-alt', 'claude-code', { revision: 'rev-alt' }),
        entry('cx-main', 'codex'),
        entry('cc-nocaps', 'claude-code', { capabilities: CLAUDE_CAPS.filter((c) => c !== 'reporting') }),
        entry('cx-nosecret', 'codex', { capabilities: CLAUDE_CAPS }),
        entry('px-main', 'paseo'),
        ...readinessProfiles,
      ]),
      ['cc-main', 'cc-alt', 'cx-main', 'cc-nocaps', 'cx-nosecret', 'px-main', 'cc-ghost', ...readinessProfiles.map((p) => p.id as string)],
    );
    await addHost('legacy', { repositories: [{ key: 'repo/legacy' }], profiles: [{ id: 'ai3-coder', provider: 'omp', model: 'glm' }] }, ['ai3-coder', 'legacy-ghost']);
    await addHost('withdrawn', v2Catalog('repo/withdrawn', [entry('cc-w', 'claude-code'), entry('cc-gone', 'claude-code')]), ['cc-w', 'cc-gone']);
    await addHost('downgrade', v2Catalog('repo/downgrade', [entry('cc-d', 'claude-code')]), ['cc-d']);
    await addHost('controls', v2Catalog('repo/controls', [entry('cc-c', 'claude-code')]), ['cc-c']);
    await addHost('gate', v2Catalog('repo/gate', [entry('cc-g', 'claude-code')]), ['cc-g']);
    await addHost('offline', v2Catalog('repo/offline', [entry('cc-o', 'claude-code')]), ['cc-o']);
    await addHost('summary', v2Catalog('repo/summary', [entry('cc-s', 'claude-code'), entry('cc-sum', 'claude-code', { revision: 'rev-sum' }), entry('cx-sum', 'codex')]), ['cc-s', 'cc-sum', 'cx-sum'], project2Id);
  });

  afterAll(async () => {
    delete process.env.FF_COLLAB_AUTH_SECRET;
    await closePool();
  });

  it('0022 creates only the two side tables', async () => {
    expect(await regclass('collab_run_execution')).not.toBeNull();
    expect(await regclass('collab_session_execution')).not.toBeNull();
    expect(await columnsOfExistingTables()).toEqual(columnsBefore);
    const fks = await rawQuery(
      `SELECT conname FROM pg_constraint
       WHERE conrelid IN ('collab_run_execution'::regclass, 'collab_session_execution'::regclass)
         AND (contype = 'f' OR confrelid <> 0)`,
    );
    expect(fks).toEqual([]);
    expect(await triggersAndIndexesOfExistingTables()).toEqual(indexesBefore);
  });

  it('exports the readiness states and required capabilities exactly', () => {
    expect(READINESS_STATES).toEqual(SEVEN_STATES);
    expect(REQUIRED_CAPABILITIES['claude-code']).toEqual(CLAUDE_CAPS);
    expect(REQUIRED_CAPABILITIES.codex).toEqual(CODEX_CAPS);
    expect(REQUIRED_CAPABILITIES.paseo).toEqual(PASEO_CAPS);
  });

  it('v2 Start freezes the exact entry, the primary session and both ownership rows', async () => {
    expect(await regclass('collab_run_execution')).not.toBeNull();
    expect(await regclass('collab_session_execution')).not.toBeNull();
    const { result } = await start('alpha', 'cc-alt');
    const started = await result;
    expect(started.created).toBe(true);
    const runId = started.run.id;
    const execution = await rawQuery(`SELECT * FROM collab_run_execution WHERE run_id = $1`, [runId]);
    expect(execution).toHaveLength(1);
    expect(execution[0]).toMatchObject({ schema_version: 2, backend: 'claude-code', host_id: hosts.alpha.id, profile_id: 'cc-alt', profile_revision: 'rev-alt', workspace_ref: null });
    expect(execution[0].snapshot).toEqual({
      harness: { name: 'claude-code', version: '2.1.317' },
      model: 'claude-code-model-x',
      policy: { permissionMode: 'manual' },
      authExpectation: 'claude-subscription',
      capabilities: CLAUDE_CAPS,
      summary: null,
      reporting: { scopes: ['report.check', 'report.artifact', 'report.idea', 'report.progress'] },
    });
    const sessions = await rawQuery(`SELECT id FROM collab_sessions WHERE run_id = $1`, [runId]);
    expect(sessions).toHaveLength(1);
    const owned = await rawQuery(`SELECT * FROM collab_session_execution WHERE run_id = $1`, [runId]);
    expect(owned).toHaveLength(1);
    expect(owned[0]).toMatchObject({ session_id: sessions[0].id, backend: 'claude-code', native_session_id: null, binding_generation: 0 });
    const launch = await rawQuery(`SELECT payload FROM collab_connector_commands WHERE run_id = $1 AND kind = 'launch'`, [runId]);
    expect(launch[0].payload.execution).toEqual({ schemaVersion: 2, backend: 'claude-code', profileId: 'cc-alt', profileRevision: 'rev-alt' });
    expect(launch[0].payload.model).toBe('claude-code-model-x');
    expect(JSON.stringify(launch[0].payload)).not.toMatch(/ffag_|secret/i);

    const view = await getCollabRun(manager, runId);
    expect(view.execution).toEqual({
      backend: 'claude-code',
      profileId: 'cc-alt',
      model: 'claude-code-model-x',
      harness: { name: 'claude-code', version: '2.1.317' },
      policy: { permissionMode: 'manual' },
    });
  });

  it('v2 Start freezes the summary profile only on the same backend', async () => {
    expect(await regclass('collab_run_execution')).not.toBeNull();
    const setDefaults = async (summaryProfileId: string) => {
      const version = (await rawQuery(`SELECT version FROM collab_projects WHERE id = $1`, [project2Id]))[0].version;
      await updateProjectExecutionDefaults({
        actor: manager,
        projectId: project2Id,
        expectedVersion: version,
        executionDefaults: { mappingId: hosts.summary.mappingId, profileId: 'cc-s', summary: { enabled: true, profileId: summaryProfileId } },
      });
    };
    await setDefaults('cc-sum');
    const taskId = await newTask(project2Id);
    const started = await startCollabRun({ actor: operator, taskId, expectedVersion: 1, idempotencyKey: 'native-summary-1' });
    const execution = await rawQuery(`SELECT snapshot FROM collab_run_execution WHERE run_id = $1`, [started.run.id]);
    expect(execution[0].snapshot.summary).toEqual({
      profileId: 'cc-sum',
      revision: 'rev-sum',
      model: 'claude-code-model-x',
      harness: { name: 'claude-code', version: '2.1.317' },
      policy: { permissionMode: 'manual' },
      authExpectation: 'claude-subscription',
      capabilities: CLAUDE_CAPS,
    });

    await setDefaults('cx-sum');
    const other = await newTask(project2Id);
    await expect(startCollabRun({ actor: operator, taskId: other, expectedVersion: 1, idempotencyKey: 'native-summary-2' })).rejects.toMatchObject({
      status: 422,
      code: 'execution_settings_changed',
      message: COPY.execution_settings_changed,
    });
    expect(await rawQuery(`SELECT id FROM collab_runs WHERE task_id = $1`, [other])).toEqual([]);
  });

  it('a v2 summary uses the summary profile frozen at Start', async () => {
    expect(await regclass('collab_session_execution')).not.toBeNull();
    const setDefaults = async (summaryProfileId: string) => {
      const version = (await rawQuery(`SELECT version FROM collab_projects WHERE id = $1`, [project2Id]))[0].version;
      await updateProjectExecutionDefaults({
        actor: manager,
        projectId: project2Id,
        expectedVersion: version,
        executionDefaults: { mappingId: hosts.summary.mappingId, profileId: 'cc-s', summary: { enabled: true, profileId: summaryProfileId } },
      });
    };
    await setDefaults('cc-sum');
    const taskId = await newTask(project2Id);
    const started = await startCollabRun({ actor: operator, taskId, expectedVersion: 1, idempotencyKey: 'native-summary-q1' });
    await rawQuery(`UPDATE collab_runs SET workspace_id = 'ws-native-1' WHERE id = $1`, [started.run.id]);
    await rawQuery(`UPDATE collab_sessions SET timeline_epoch = 'ff-native-v1:claude-code', timeline_seq = 12 WHERE run_id = $1 AND role = 'work'`, [started.run.id]);
    await setDefaults('cx-sum');
    const queued = await queueCollabSummary({ actor: manager, runId: started.run.id, idempotencyKey: 'native-summary-q1' });
    const command = await rawQuery(`SELECT session_id, payload FROM collab_connector_commands WHERE id = $1`, [queued.commandId]);
    expect(command[0].payload.profileId).toBe('cc-sum');
    expect(command[0].payload.execution).toEqual({ schemaVersion: 2, backend: 'claude-code', profileId: 'cc-sum', profileRevision: 'rev-sum' });
    expect(await rawQuery(`SELECT backend FROM collab_session_execution WHERE session_id = $1`, [command[0].session_id])).toEqual([{ backend: 'claude-code' }]);
  });

  it('a native summary freezes the work session supervisor cursor, embeds no history and is refused without a cursor in its backend domain (Task 8)', async () => {
    const version = (await rawQuery(`SELECT version FROM collab_projects WHERE id = $1`, [project2Id]))[0].version;
    await updateProjectExecutionDefaults({ actor: manager, projectId: project2Id, expectedVersion: version,
      executionDefaults: { mappingId: hosts.summary.mappingId, profileId: 'cc-s', summary: { enabled: true, profileId: 'cc-sum' } } });
    const taskId = await newTask(project2Id);
    const started = await startCollabRun({ actor: operator, taskId, expectedVersion: 1, idempotencyKey: 'native-summary-t8' });
    await rawQuery(`UPDATE collab_runs SET workspace_id = 'ws-native-t8' WHERE id = $1`, [started.run.id]);
    const work = (await rawQuery(`SELECT id FROM collab_sessions WHERE run_id = $1 AND role = 'work'`, [started.run.id]))[0].id;
    await expect(queueCollabSummary({ actor: manager, runId: started.run.id, idempotencyKey: 'native-summary-t8-a' })).rejects.toMatchObject({ status: 422, code: 'summary_unavailable', message: 'There is no session history to summarize yet.' });
    for (const epoch of ['paseo-epoch-1', 'ff-native-v1:codex']) {
      await rawQuery(`UPDATE collab_sessions SET timeline_epoch = $2, timeline_seq = 9 WHERE id = $1`, [work, epoch]);
      await expect(queueCollabSummary({ actor: manager, runId: started.run.id, idempotencyKey: `native-summary-t8-${epoch}` })).rejects.toMatchObject({ status: 422, code: 'summary_unavailable' });
    }
    expect(await rawQuery(`SELECT id FROM collab_sessions WHERE run_id = $1 AND role = 'summary'`, [started.run.id])).toEqual([]);
    await rawQuery(`UPDATE collab_sessions SET timeline_epoch = 'ff-native-v1:claude-code', timeline_seq = 41 WHERE id = $1`, [work]);
    const queued = await queueCollabSummary({ actor: manager, runId: started.run.id, idempotencyKey: 'native-summary-t8-b' });
    const [command] = await rawQuery(`SELECT session_id, payload FROM collab_connector_commands WHERE id = $1`, [queued.commandId]);
    expect(command.payload.sourceSessionId).toBe(work);
    expect(command.payload.sourceCursor).toEqual({ epoch: 'ff-native-v1:claude-code', seq: '41' });
    expect(command.payload.prompt).toContain('"sourceCursor":{"epoch":"ff-native-v1:claude-code","seq":"41"}');
    expect(command.payload.prompt).not.toContain('"history"');
  });

  it('a repeated summary report from the same summary session is recorded once (Task 8)', async () => {
    const [cmd] = await rawQuery(`SELECT c.run_id, c.session_id, r.task_id FROM collab_connector_commands c JOIN collab_runs r ON r.id = c.run_id WHERE c.kind = 'summarize' AND c.payload->'sourceCursor'->>'seq' = '41'`);
    const report = (body: string) => recordCollabSummaryReport({ taskId: cmd.task_id, runId: cmd.run_id, sessionId: cmd.session_id, body, model: null, sourceEpoch: null, sourceSeq: null, visibility: 'internal' });
    const first = await report('The run summary.');
    const again = await Promise.all([report('The run summary.'), report('The run summary.')]);
    expect(again.map((r) => r.id)).toEqual([first.id, first.id]);
    expect(first).toMatchObject({ body: 'The run summary.', sourceCursor: 'ff-native-v1:claude-code:41', provenance: 'agent' });
    const other = await report('A different summary.');
    expect(other.id).not.toBe(first.id);
    expect((await rawQuery(`SELECT body FROM collab_summaries WHERE session_id = $1 ORDER BY created_at, id`, [cmd.session_id])).map((r) => r.body)).toEqual(['The run summary.', 'A different summary.']);
  });

  it('summary report dedup is scoped to the same native summary session and visibility; other sessions and legacy sessions keep every report (Task 8 C5)', async () => {
    const [cmd] = await rawQuery(`SELECT c.run_id, c.session_id, r.task_id FROM collab_connector_commands c JOIN collab_runs r ON r.id = c.run_id WHERE c.kind = 'summarize' AND c.payload->'sourceCursor'->>'seq' = '41'`);
    const report = (sessionId: string, body: string) => recordCollabSummaryReport({ taskId: cmd.task_id, runId: cmd.run_id, sessionId, body, model: null, sourceEpoch: null, sourceSeq: null, visibility: 'internal' });
    const body = 'Scoped summary body.';
    const queued = await queueCollabSummary({ actor: manager, runId: cmd.run_id, idempotencyKey: 'native-summary-t8-c5' });
    const [other] = await rawQuery(`SELECT session_id FROM collab_connector_commands WHERE id = $1`, [queued.commandId]);
    const mine = await report(cmd.session_id, body);
    expect((await report(cmd.session_id, body)).id).toBe(mine.id);
    const theirs = await report(other.session_id, body);
    expect(theirs.id).not.toBe(mine.id);
    await rawQuery(`UPDATE collab_summaries SET visibility = 'client' WHERE id = $1`, [theirs.id]);
    const internal = await report(other.session_id, body);
    expect(internal.id).not.toBe(theirs.id);
    expect(internal.visibility).toBe('internal');
    const [legacy] = await rawQuery(`INSERT INTO collab_sessions(run_id, role, title) VALUES ($1, 'summary', 'Legacy summary') RETURNING id`, [cmd.run_id]);
    const a = await report(legacy.id, body);
    const b = await report(legacy.id, body);
    expect(b.id).not.toBe(a.id);
    expect((await rawQuery(`SELECT count(*)::int AS n FROM collab_summaries WHERE session_id = $1`, [legacy.id]))[0].n).toBe(2);
  });

  it('v2 Start never fabricates a snapshot for a missing entry', async () => {
    expect(await regclass('collab_run_execution')).not.toBeNull();
    const before = (await rawQuery(`SELECT count(*)::int AS n FROM collab_run_execution`))[0].n;
    for (const profileId of ['cc-ghost', 'cc-nocaps', 'cx-nosecret']) {
      const { taskId, result } = await start('alpha', profileId);
      await expect(result).rejects.toMatchObject({ status: 422, code: 'execution_settings_changed', message: COPY.execution_settings_changed });
      expect(await rawQuery(`SELECT id FROM collab_runs WHERE task_id = $1`, [taskId])).toEqual([]);
    }
    expect((await rawQuery(`SELECT count(*)::int AS n FROM collab_run_execution`))[0].n).toBe(before);
  });

  it('a duplicated v2 profile id is ambiguous, never resolved by order', async () => {
    const catalog = v2Catalog('repo/x', [entry('dup', 'claude-code'), entry('dup', 'codex', { revision: 'rev-2' })]);
    let selection: unknown = null;
    try {
      selectCatalogProfile(catalog, 'dup');
    } catch (err) {
      selection = err;
    }
    expect(selection).toMatchObject({ status: 422, code: 'execution_settings_changed' });
    expect(selectCatalogProfile({ repositories: [], profiles: [{ id: 'dup' }, { id: 'dup' }] }, 'dup')).toEqual({ format: 'v1' });
    await expect(
      registerConnector({ token: hosts.downgrade.token, instanceId: 'inst-downgrade', protocolVersion: 1, sdkVersion: '0.12.0', capabilities: {}, catalog: catalog as never }),
    ).rejects.toMatchObject({ name: 'ZodError' });
    await rawQuery(`UPDATE collab_hosts SET catalog = jsonb_set(catalog, '{profiles}', (catalog->'profiles') || (catalog->'profiles')) WHERE id = $1`, [hosts.offline.id]);
    const { result } = await start('offline', 'cc-o');
    await expect(result).rejects.toMatchObject({ status: 422, code: 'execution_settings_changed' });
    await rawQuery(`UPDATE collab_hosts SET catalog = $1 WHERE id = $2`, [JSON.stringify(v2Catalog('repo/offline', [entry('cc-o', 'claude-code')])), hosts.offline.id]);
  });

  it('deliveryExecutionCheck compares the frozen primary entry', () => {
    const frozen = {
      runId: '00000000-0000-0000-0000-000000000001', schemaVersion: 2 as const, backend: 'claude-code' as const, hostId: '00000000-0000-0000-0000-000000000002',
      profileId: 'cc', profileRevision: 'rev-1', workspaceRef: null,
      snapshot: { harness: null, model: null, policy: null, authExpectation: 'claude-subscription' as const, capabilities: CLAUDE_CAPS, summary: null, reporting: { scopes: [] } },
    };
    const v2 = (e: Record<string, unknown>) => v2Catalog('r', [e]);
    expect(deliveryExecutionCheck(null, {})).toBeNull();
    expect(deliveryExecutionCheck(frozen, v2(entry('cc', 'claude-code')))).toBeNull();
    expect(deliveryExecutionCheck(frozen, v2(entry('cc', 'claude-code', { revision: 'rev-2' })))).toBe('execution_settings_changed');
    expect(deliveryExecutionCheck(frozen, v2(entry('cc', 'codex')))).toBe('execution_settings_changed');
    expect(deliveryExecutionCheck(frozen, v2(entry('cc', 'claude-code', { capabilities: [...CLAUDE_CAPS, 'extra'] })))).toBe('execution_settings_changed');
    expect(deliveryExecutionCheck(frozen, v2(entry('other', 'claude-code')))).toBe('execution_settings_changed');
    expect(deliveryExecutionCheck(frozen, { repositories: [], profiles: [{ id: 'cc' }] })).toBe('execution_settings_changed');
  });

  it('capability sets compare exactly even when a duplicate masks a removal', () => {
    const frozen = {
      runId: '00000000-0000-0000-0000-000000000001', schemaVersion: 2 as const, backend: 'claude-code' as const, hostId: '00000000-0000-0000-0000-000000000002',
      profileId: 'cc', profileRevision: 'rev-1', workspaceRef: null,
      snapshot: { harness: null, model: null, policy: null, authExpectation: 'claude-subscription' as const, capabilities: CLAUDE_CAPS, summary: null, reporting: { scopes: [] } },
    };
    const masked = [...CLAUDE_CAPS.filter((c) => c !== 'reporting'), 'timeline'];
    expect(masked).toHaveLength(CLAUDE_CAPS.length);
    expect(deliveryExecutionCheck(frozen, v2Catalog('r', [entry('cc', 'claude-code', { capabilities: masked })]))).toBe('execution_settings_changed');
  });

  it('duplicate v2 capability names are rejected at registration and in cached selection', async () => {
    const duplicated = entry('cc-dupcap', 'claude-code', { capabilities: [...CLAUDE_CAPS, 'timeline'] });
    const registration = await registerConnector({
      token: hosts.offline.token, instanceId: 'inst-offline', protocolVersion: 1, sdkVersion: '0.12.0', capabilities: {},
      catalog: v2Catalog('repo/offline', [entry('cc-o', 'claude-code'), duplicated]) as never,
    }).then(() => null, (err: unknown) => err);
    expect(registration).toMatchObject({ name: 'ZodError' });
    expect((await rawQuery(`SELECT catalog FROM collab_hosts WHERE id = $1`, [hosts.offline.id]))[0].catalog.profiles.map((p: { id: string }) => p.id)).not.toContain('cc-dupcap');
    let selection: unknown = null;
    try {
      selectCatalogProfile(v2Catalog('r', [duplicated]), 'cc-dupcap');
    } catch (err) {
      selection = err;
    }
    expect(selection).toMatchObject({ status: 422, code: 'execution_settings_changed' });
  });

  it('v1 catalogs keep the legacy fallback', async () => {
    expect(await regclass('collab_run_execution')).not.toBeNull();
    const { result } = await start('legacy', 'legacy-ghost');
    const started = await result;
    expect(started.created).toBe(true);
    const launch = await rawQuery(`SELECT payload FROM collab_connector_commands WHERE run_id = $1 AND kind = 'launch'`, [started.run.id]);
    expect(launch[0].payload.profileSnapshot).toEqual({ id: 'legacy-ghost', model: null });
    expect(launch[0].payload).not.toHaveProperty('execution');
    expect(await rawQuery(`SELECT run_id FROM collab_run_execution WHERE run_id = $1`, [started.run.id])).toEqual([]);
    expect(await rawQuery(`SELECT s.session_id FROM collab_session_execution s WHERE s.run_id = $1`, [started.run.id])).toEqual([]);
    expect((await getCollabRun(manager, started.run.id)).execution).toBeNull();
  });

  it('readiness states map to the exact Start errors', async () => {
    expect(READINESS_STATES).toHaveLength(7);
    const expected: Record<string, string | null> = {
      ready: null,
      incomplete: 'profile_incomplete',
      not_installed: 'profile_unavailable',
      incompatible: 'profile_unavailable',
      invalid_config: 'profile_unavailable',
      platform_unsupported: 'profile_unavailable',
      sign_in_required: 'sign_in_required',
    };
    for (const state of READINESS_STATES) {
      const { taskId, result } = await start('alpha', `cc-${state}`);
      const code = expected[state];
      if (code === null) {
        expect((await result).created).toBe(true);
      } else {
        await expect(result).rejects.toMatchObject({ status: 422, code, message: COPY[code as keyof typeof COPY] });
        expect(await rawQuery(`SELECT id FROM collab_runs WHERE task_id = $1`, [taskId])).toEqual([]);
      }
    }
  });

  it('an offline host with a cached v2 catalog still queues', async () => {
    expect(await regclass('collab_run_execution')).not.toBeNull();
    await rawQuery(`UPDATE collab_hosts SET last_heartbeat_at = now() - interval '1 hour' WHERE id = $1`, [hosts.offline.id]);
    const { result } = await start('offline', 'cc-o');
    const started = await result;
    expect(started.run.state).toBe('queued');
    expect(started.run.hostReachability).toBe('offline');
    expect(await rawQuery(`SELECT backend FROM collab_run_execution WHERE run_id = $1`, [started.run.id])).toEqual([{ backend: 'claude-code' }]);
  });

  it('a withdrawn profile fails the pending command at claim without delivery', async () => {
    const kept = await (await start('withdrawn', 'cc-w')).result;
    const gone = await (await start('withdrawn', 'cc-gone')).result;
    await registerConnector({
      token: hosts.withdrawn.token,
      instanceId: 'inst-withdrawn',
      protocolVersion: 1,
      sdkVersion: '0.12.0',
      capabilities: {},
      catalog: v2Catalog('repo/withdrawn', [entry('cc-w', 'claude-code', { revision: 'rev-2' })]) as never,
    });
    const polled = await pollConnectorCommands({ token: hosts.withdrawn.token, connectorSessionId: hosts.withdrawn.connector!.connectorSessionId, leaseEpoch: hosts.withdrawn.connector!.leaseEpoch, waitMs: 0, limit: 10, availableSlots: FREE_SLOTS });
    expect(polled.commands).toEqual([]);
    for (const runId of [kept.run.id, gone.run.id]) {
      const command = await rawQuery(`SELECT state, error_code FROM collab_connector_commands WHERE run_id = $1`, [runId]);
      expect(command).toEqual([{ state: 'failed', error_code: 'execution_settings_changed' }]);
      const run = await rawQuery(`SELECT state, error_code FROM collab_runs WHERE id = $1`, [runId]);
      expect(run).toEqual([{ state: 'failed', error_code: 'execution_settings_changed' }]);
    }
  });

  it('a cancel for a v2 run still reaches a still-v2 host after its profile is withdrawn', async () => {
    const host = 'withdrawn';
    const started = await (await start(host, 'cc-w')).result;
    const register = (profiles: Array<Record<string, unknown>>) =>
      registerConnector({ token: hosts[host].token, instanceId: `inst-${host}`, protocolVersion: 1, sdkVersion: '0.12.0', capabilities: {}, catalog: v2Catalog(`repo/${host}`, profiles) as never });
    const poll = () => pollConnectorCommands({ token: hosts[host].token, connectorSessionId: hosts[host].connector!.connectorSessionId, leaseEpoch: hosts[host].connector!.leaseEpoch, waitMs: 0, limit: 10, availableSlots: FREE_SLOTS });
    expect((await poll()).commands.map((c) => c.kind)).toEqual(['launch']);
    await rawQuery(`INSERT INTO collab_connector_commands (host_id, run_id, session_id, kind, payload) SELECT host_id, id, (SELECT id FROM collab_sessions WHERE run_id = $1), 'cancel', '{"kind":"cancel"}' FROM collab_runs WHERE id = $1`, [started.run.id]);
    await register([entry('cc-other', 'claude-code')]);
    expect((await poll()).commands.map((c) => c.kind)).toEqual(['cancel']);
    await register([entry('cc-w', 'claude-code', { revision: 'rev-2' })]);
  });

  it('a known-unready entry stops execution-bearing delivery but not controls on a v2 host', async () => {
    const started = await (await start('gate', 'cc-g')).result;
    await registerConnector({
      token: hosts.gate.token, instanceId: 'inst-gate', protocolVersion: 1, sdkVersion: '0.12.0', capabilities: {},
      catalog: v2Catalog('repo/gate', [entry('cc-g', 'claude-code', { readiness: { state: 'sign_in_required' } })]) as never,
    });
    const sessionId = (await rawQuery(`SELECT id FROM collab_sessions WHERE run_id = $1`, [started.run.id]))[0].id;
    await rawQuery(`INSERT INTO collab_connector_commands (host_id, run_id, session_id, kind, payload) SELECT host_id, id, $2, 'cancel', '{"kind":"cancel"}' FROM collab_runs WHERE id = $1`, [started.run.id, sessionId]);
    const polled = await pollConnectorCommands({ token: hosts.gate.token, connectorSessionId: hosts.gate.connector!.connectorSessionId, leaseEpoch: hosts.gate.connector!.leaseEpoch, waitMs: 0, limit: 10, availableSlots: FREE_SLOTS });
    expect(polled.commands.map((c) => c.kind)).toEqual(['cancel']);
    expect(await rawQuery(`SELECT state, error_code FROM collab_connector_commands WHERE run_id = $1 AND kind = 'launch'`, [started.run.id])).toEqual([
      { state: 'failed', error_code: 'execution_settings_changed' },
    ]);
  });

  it('v2 deliveries attach the reporting credential at claim without storing it', async () => {
    await registerConnector({
      token: hosts.withdrawn.token,
      instanceId: 'inst-withdrawn',
      protocolVersion: 1,
      sdkVersion: '0.12.0',
      capabilities: {},
      catalog: v2Catalog('repo/withdrawn', [entry('cc-w', 'claude-code', { revision: 'rev-2' })]) as never,
    });
    const started = await (await start('withdrawn', 'cc-w')).result;
    const polled = await pollConnectorCommands({ token: hosts.withdrawn.token, connectorSessionId: hosts.withdrawn.connector!.connectorSessionId, leaseEpoch: hosts.withdrawn.connector!.leaseEpoch, waitMs: 0, limit: 10, availableSlots: FREE_SLOTS });
    expect(polled.commands).toHaveLength(1);
    expect(polled.commands[0].payload.execution).toEqual({ schemaVersion: 2, backend: 'claude-code', profileId: 'cc-w', profileRevision: 'rev-2' });
    expect(String(polled.commands[0].payload.reportingCredential)).toMatch(/^ffag_/);
    const stored = await rawQuery(`SELECT payload FROM collab_connector_commands WHERE run_id = $1`, [started.run.id]);
    expect(JSON.stringify(stored[0].payload)).not.toMatch(/ffag_/);
  });

  it('a v1 re-registration never receives v2 commands', async () => {
    const started = await (await start('downgrade', 'cc-d')).result;
    await registerConnector({
      token: hosts.downgrade.token,
      instanceId: 'inst-downgrade',
      protocolVersion: 1,
      sdkVersion: '0.12.0',
      capabilities: {},
      catalog: { repositories: [{ key: 'repo/downgrade' }], profiles: [{ id: 'cc-d', provider: 'claude', model: 'claude-code-model-x' }] },
    });
    const polled = await pollConnectorCommands({ token: hosts.downgrade.token, connectorSessionId: hosts.downgrade.connector!.connectorSessionId, leaseEpoch: hosts.downgrade.connector!.leaseEpoch, waitMs: 0, limit: 10, availableSlots: FREE_SLOTS });
    expect(polled.commands).toEqual([]);
    expect(await rawQuery(`SELECT state, error_code FROM collab_connector_commands WHERE run_id = $1`, [started.run.id])).toEqual([
      { state: 'failed', error_code: 'execution_settings_changed' },
    ]);
  });

  it('a v1 re-registration never receives v2 controls and never marks the run cancelled', async () => {
    const started = await (await start('controls', 'cc-c')).result;
    const poll = () => pollConnectorCommands({ token: hosts.controls.token, connectorSessionId: hosts.controls.connector!.connectorSessionId, leaseEpoch: hosts.controls.connector!.leaseEpoch, waitMs: 0, limit: 10, availableSlots: FREE_SLOTS });
    expect((await poll()).commands.map((c) => c.kind)).toEqual(['launch']);
    const sessionId = (await rawQuery(`SELECT id FROM collab_sessions WHERE run_id = $1`, [started.run.id]))[0].id;
    const cancel = await submitSessionCommand({ actor: manager, sessionId, idempotencyKey: 'native-controls-cancel', command: { kind: 'cancel' } });
    const c = hosts.controls.connector!;
    const observed = await submitConnectorObservations({ token: hosts.controls.token, connectorSessionId: c.connectorSessionId, leaseEpoch: c.leaseEpoch, events: [
      { eventId: 'controls-bound', runId: started.run.id, sessionId, observedAt: new Date().toISOString(), kind: 'session_bound', payload: { backend: 'claude-code', nativeSessionId: 'native-controls', generation: 1 } },
      { eventId: 'controls-request', runId: started.run.id, sessionId, observedAt: new Date().toISOString(), kind: 'attention', payload: { nativeRequestId: 'req-1', kind: 'permission', fingerprint: 'f'.repeat(64), secret: false, questions: null,
        choices: [{ id: 'allow_once', label: 'Allow once', scope: 'once', behavior: 'allow' }], state: 'pending', attention: 'permission', requestId: 'req-1', source: { backend: 'claude-code', generation: 1, nativeEventId: 'request:req-1', seq: 1 } } },
    ] });
    expect(observed.rejectedEventIds).toEqual([]);
    const [request] = (await getSessionPendingRequests(manager, sessionId)).requests;
    const permission = await submitSessionCommand({
      actor: manager, sessionId, idempotencyKey: 'native-controls-permission',
      command: { kind: 'permission', requestId: request.requestId, fingerprint: request.fingerprint!, generation: 1, response: { behavior: 'allow', selectedActionId: 'allow_once' } },
    });
    await registerConnector({
      token: hosts.controls.token, instanceId: 'inst-controls', protocolVersion: 1, sdkVersion: '0.12.0', capabilities: {},
      catalog: { repositories: [{ key: 'repo/controls' }], profiles: [{ id: 'cc-c', provider: 'claude', model: 'claude-code-model-x' }] },
    });
    expect((await poll()).commands).toEqual([]);
    expect(await rawQuery(`SELECT kind, state, error_code FROM collab_connector_commands WHERE id = ANY($1) ORDER BY kind`, [[cancel.commandId, permission.commandId]])).toEqual([
      { kind: 'cancel', state: 'failed', error_code: 'execution_settings_changed' },
      { kind: 'permission', state: 'failed', error_code: 'execution_settings_changed' },
    ]);
    const run = await rawQuery(`SELECT state, error_code FROM collab_runs WHERE id = $1`, [started.run.id]);
    expect(run[0].state).not.toMatch(/^cancel/);
    expect(run[0].error_code).toBe('execution_settings_changed');
  });

  it('an additional session on another backend is refused', async () => {
    expect(await regclass('collab_session_execution')).not.toBeNull();
    const started = await (await start('alpha', 'cc-main')).result;
    await expect(
      createRunSession({ actor: operator, runId: started.run.id, idempotencyKey: 'native-extra-1', title: 'Other backend', profileId: 'cx-main', instructions: '' }),
    ).rejects.toMatchObject({ status: 422, code: 'execution_settings_changed', message: COPY.execution_settings_changed });
    const same = await createRunSession({ actor: operator, runId: started.run.id, idempotencyKey: 'native-extra-2', title: 'Same backend', profileId: 'cc-alt', instructions: '' });
    expect(await rawQuery(`SELECT backend, run_id FROM collab_session_execution WHERE session_id = $1`, [same.session.id])).toEqual([
      { backend: 'claude-code', run_id: started.run.id },
    ]);
    const command = await rawQuery(`SELECT payload FROM collab_connector_commands WHERE id = $1`, [same.commandId]);
    expect(command[0].payload.execution).toEqual({ schemaVersion: 2, backend: 'claude-code', profileId: 'cc-alt', profileRevision: 'rev-alt' });
  });

  it('registration preserves v2 catalog fields', async () => {
    const leaky = entry('cc-leaky', 'claude-code', {
      policy: { permissionMode: 'manual', settingsPath: '/home/owner/.claude/settings.json', nested: { token: 'x' } },
    });
    await registerConnector({
      token: hosts.offline.token,
      instanceId: 'inst-offline',
      protocolVersion: 1,
      sdkVersion: '0.12.0',
      capabilities: {},
      catalog: v2Catalog('repo/offline', [entry('cc-o', 'claude-code'), leaky, entry('px-o', 'paseo', { policy: { modeId: 'default', thinkingOptionId: 'high', raw: { a: 1 } } })]) as never,
    });
    const stored = (await rawQuery(`SELECT catalog FROM collab_hosts WHERE id = $1`, [hosts.offline.id]))[0].catalog;
    expect(stored.formatVersion).toBe(2);
    expect(stored.capacity).toEqual({ 'claude-code': { limit: 1, available: null, observedAt: null }, codex: { limit: 1, available: null, observedAt: null } });
    expect(stored.profiles[0]).toEqual(entry('cc-o', 'claude-code'));
    expect(stored.profiles[1].policy).toEqual({ permissionMode: 'manual' });
    expect(stored.profiles[2].policy).toEqual({ modeId: 'default', thinkingOptionId: 'high' });
  });

  it('a v2 catalog registers under protocolVersion 1 and protocolVersion 2 is still rejected', async () => {
    await expect(
      registerConnector({ token: hosts.offline.token, instanceId: 'inst-offline', protocolVersion: 2 as 1, sdkVersion: '0.12.0', capabilities: {}, catalog: v2Catalog('repo/offline', [entry('cc-o', 'claude-code')]) as never }),
    ).rejects.toMatchObject({ name: 'ZodError', issues: [expect.objectContaining({ path: ['protocolVersion'] })] });
    const ok = await registerConnector({ token: hosts.offline.token, instanceId: 'inst-offline', protocolVersion: 1, sdkVersion: '0.12.0', capabilities: {}, catalog: v2Catalog('repo/offline', [entry('cc-o', 'claude-code')]) as never });
    expect(ok.hostId).toBe(hosts.offline.id);
    expect((await rawQuery(`SELECT catalog->'formatVersion' AS f FROM collab_hosts WHERE id = $1`, [hosts.offline.id]))[0].f).toBe(2);
  });

  it('client-only members still cannot Start', async () => {
    const ws = (await rawQuery(`SELECT workspace_id FROM collab_projects WHERE id = $1`, [projectId]))[0].workspace_id;
    const role = await rawQuery(`SELECT id FROM collab_roles WHERE workspace_id = $1 AND name = 'collaborator'`, [ws]);
    const reader = await rawQuery(`INSERT INTO collab_principals (display_name, email) VALUES ('Native Reader', 'native-reader@example.test') RETURNING id, session_version`);
    await rawQuery(`INSERT INTO collab_memberships (workspace_id, project_id, principal_id, role_id) VALUES ($1, $2, $3, $4)`, [ws, projectId, reader[0].id, role[0].id]);
    const taskId = await newTask();
    await expect(
      startCollabRun({ actor: { principalId: reader[0].id, sessionVersion: reader[0].session_version }, taskId, expectedVersion: 1, idempotencyKey: 'native-client-1', mappingId: hosts.alpha.mappingId, profileId: 'cc-main' }),
    ).rejects.toMatchObject({ status: 403 });
    expect(await rawQuery(`SELECT id FROM collab_runs WHERE task_id = $1`, [taskId])).toEqual([]);
  });
});
