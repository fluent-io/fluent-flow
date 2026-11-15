import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  bootstrapCollaborationWorkspace,
  createCollabProject,
  createCollabTask,
  ensureGithubPrincipal,
  startCollabClaimExecution,
} from '../../src/collaboration/index.js';
import {
  recordCollabCheckReport,
  recordCollabIdeaReport,
  recordWorkpadPlanReport,
} from '../../src/collaboration/evidence.js';
import { recordAgentProgress } from '../../src/collaboration/tokens.js';
import { createToken } from '../../src/queries/tokens.js';
import { closePool, getPool } from '../../src/pool.js';
import { runMigrations } from '../../src/migrate.js';
import { withClientTransaction } from '../../src/collaboration/tx.js';
import {
  ensureClaimReportingBinding,
  resolveClaimReportingContext,
} from '../../src/collaboration/claim-reporting.js';
import {
  resetCollabSchema,
  resolveCollabTestDatabaseUrl,
  seedOrgMembership,
  seedUser,
} from '../helpers/collab-db.js';

process.env.DATABASE_URL = resolveCollabTestDatabaseUrl();
const databaseUrl = process.env.DATABASE_URL;
const orgId = 'claim-reporting-org';
const repo = 'acme/claim-reporting';
const HEAD = 'a'.repeat(40);
const OPERATOR_CAPABILITIES = ['task.read', 'task.write', 'comment.write', 'internal.read', 'run.start', 'run.steer', 'run.cancel'];

type Binding = { bindingId: string; credential: string; captureKey: string };
type ReportSource = { kind: 'claim'; claimId: number; reportingBindingId: string };

let managerActor: { principalId: string; sessionVersion: number };
let managerVersion: number;
let downgraderPrincipalId: string;
let downgraderVersion: number;
let downgraderRoleId: string;
let projectId: string;
let taskA: string;
let taskB: string;
let runnerSessionId: number;
let agentTokenId: number;

async function seedClaim(input: {
  sessionId: number;
  createdBy: string;
  createdBySessionVersion: number;
  claimedAt: string;
  withSnapshot?: boolean;
}): Promise<number> {
  const claim = await getPool().query<{ id: number }>(
    `INSERT INTO agent_claims
       (org_id, repo, pr_number, attempt, session_id, claim_type, status, payload, claimed_at, expires_at)
     VALUES ($1, $2, NULL,
       (SELECT COALESCE(MAX(attempt), 0) + 1 FROM agent_claims WHERE org_id = $1 AND repo = $2 AND pr_number IS NULL AND claim_type = 'spec'),
       $3, 'spec', 'claimed', '{}'::jsonb, $4::timestamptz, now() + interval '15 minutes')
     RETURNING id`,
    [orgId, repo, input.sessionId, input.claimedAt],
  );
  const claimId = claim.rows[0].id;
  await getPool().query(
    `INSERT INTO collab_claim_executions
       (task_id, project_id, claim_id, root_claim_id, created_by_principal_id, created_by_session_version)
     VALUES ($1, $2, $3, $3, $4, $5)`,
    [taskA, projectId, claimId, input.createdBy, input.withSnapshot === false ? null : input.createdBySessionVersion],
  );
  return claimId;
}

async function mint(claimId: number): Promise<Binding> {
  return withClientTransaction((tx) => ensureClaimReportingBinding(tx, {
    orgId,
    agentId: 'reporting-runner',
    runnerSessionId,
    claimId,
    agentTokenId,
  }));
}

async function seedRunnerSession(): Promise<number> {
  const session = await getPool().query<{ id: number }>(
    `INSERT INTO agent_sessions (org_id, agent_id, session_meta, status, last_seen_at, expires_at)
     VALUES ($1, 'reporting-runner', '{"capacity": 1, "instance_id": "inst-2", "slot_id": 1}'::jsonb, 'online', NOW(), NOW() + interval '15 minutes')
     RETURNING id`,
    [orgId],
  );
  return session.rows[0].id;
}

async function reportIdea(binding: Binding, claimId: number, title: string) {
  return recordCollabIdeaReport({
    taskId: taskA,
    source: sourceFor(binding, claimId),
    title,
    body: 'Claim-bound idea.',
  });
}

async function ideaCount(title: string): Promise<number> {
  const rows = await getPool().query('SELECT id FROM collab_ideas WHERE title = $1', [title]);
  return rows.rows.length;
}

function sourceFor(binding: Binding, claimId: number): ReportSource {
  return { kind: 'claim', claimId, reportingBindingId: binding.bindingId };
}

beforeAll(async () => {
  process.env.FF_COLLAB_AUTH_SECRET = 'claim-reporting-test-secret-0123456789abcdef0123456789abcdef';
  await resetCollabSchema(databaseUrl);
  await runMigrations();

  const managerUserId = await seedUser(databaseUrl, { githubId: 9401, login: 'claim-reporting-manager' });
  await seedOrgMembership(databaseUrl, managerUserId, orgId, 'admin');
  const manager = await ensureGithubPrincipal({
    userId: managerUserId,
    displayName: 'Claim Reporting Manager',
    email: 'claim-reporting-manager@example.test',
  });
  managerActor = { principalId: manager.id, sessionVersion: manager.sessionVersion };
  managerVersion = manager.sessionVersion;

  const downgraderUserId = await seedUser(databaseUrl, { githubId: 9402, login: 'claim-reporting-downgrader' });
  await seedOrgMembership(databaseUrl, downgraderUserId, orgId, 'member');
  const downgrader = await ensureGithubPrincipal({
    userId: downgraderUserId,
    displayName: 'Claim Reporting Downgrader',
    email: 'claim-reporting-downgrader@example.test',
  });
  downgraderPrincipalId = downgrader.id;
  downgraderVersion = downgrader.sessionVersion;

  const workspace = await bootstrapCollaborationWorkspace({
    actor: managerActor,
    orgId,
    name: 'Claim Reporting Workspace',
    idempotencyKey: 'claim-reporting-workspace',
  });
  const project = await createCollabProject({ actor: managerActor, workspaceId: workspace.id, name: 'Claim Reporting Project' });
  projectId = project.id;
  taskA = (await createCollabTask({ actor: managerActor, projectId, title: 'Claim reporting task A' })).id;
  taskB = (await createCollabTask({ actor: managerActor, projectId, title: 'Claim reporting task B' })).id;

  const operatorRole = await getPool().query<{ id: string }>(
    `INSERT INTO collab_roles (workspace_id, name, capabilities, is_system)
     VALUES ($1, 'reporting-operator', $2::text[], false)
     RETURNING id`,
    [workspace.id, OPERATOR_CAPABILITIES],
  );
  downgraderRoleId = operatorRole.rows[0].id;
  await getPool().query(
    `INSERT INTO collab_memberships (workspace_id, principal_id, role_id) VALUES ($1, $2, $3)`,
    [workspace.id, downgraderPrincipalId, downgraderRoleId],
  );

  await getPool().query(
    `INSERT INTO repos (id, org_id, repo_full_name, provider) VALUES ($1, $2, $3, 'github')`,
    [crypto.randomUUID(), orgId, repo],
  );
  await getPool().query(
    `INSERT INTO agents (id, org_id, agent_type, transport, transport_meta)
     VALUES ('reporting-runner', $1, 'codex', 'long_poll', '{"capacity": 2}'::jsonb)`,
    [orgId],
  );
  const token = await createToken({ orgId, agentId: 'reporting-runner', label: 'parity-acceptance' });
  agentTokenId = token.id;
  const session = await getPool().query<{ id: number }>(
    `INSERT INTO agent_sessions (org_id, agent_id, session_meta, status, last_seen_at, expires_at)
     VALUES ($1, 'reporting-runner', '{"capacity": 2, "instance_id": "inst-1", "slot_id": 0}'::jsonb, 'online', NOW(), NOW() + interval '15 minutes')
     RETURNING id`,
    [orgId],
  );
  runnerSessionId = session.rows[0].id;
});

afterAll(async () => {
  delete process.env.FF_COLLAB_AUTH_SECRET;
  await closePool();
});

describe('claim-bound reporting authority', () => {
  it('bootstraps an idempotent scoped-token binding for one acquisition with stored hashes and no legacy aliases', async () => {
    const claimId = await seedClaim({ sessionId: runnerSessionId, createdBy: managerActor.principalId, createdBySessionVersion: managerVersion, claimedAt: '2026-11-13 12:00:00.000001+00' });
    const first = await mint(claimId);
    const second = await mint(claimId);
    expect(first).toEqual(second);
    expect(first.bindingId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    const row = await getPool().query<{
      token_hash: string;
      token_prefix: string;
      scopes: string[];
      run_id: string | null;
      session_id: string | null;
      principal_id: string;
    }>('SELECT token_hash, token_prefix, scopes, run_id, session_id, principal_id FROM collab_scoped_tokens WHERE id = $1', [first.bindingId]);
    expect(row.rows).toHaveLength(1);
    expect(row.rows[0].token_hash).toBe(createHash('sha256').update(first.credential).digest('hex'));
    expect(row.rows[0].token_hash).not.toContain(first.credential);
    expect(row.rows[0].token_prefix).toBe(first.credential.slice(0, 12));
    expect(row.rows[0].principal_id).toBe(managerActor.principalId);
    expect(row.rows[0].run_id).toBeNull();
    expect(row.rows[0].session_id).toBeNull();
    expect(row.rows[0].scopes).toContain('report.progress');
    expect(row.rows[0].scopes).not.toContain('report.summary');
  });

  it('derives a distinct binding for a different acquisition of the same claim', async () => {
    const claimId = await seedClaim({ sessionId: runnerSessionId, createdBy: managerActor.principalId, createdBySessionVersion: managerVersion, claimedAt: '2026-11-13 12:00:01.000001+00' });
    const first = await mint(claimId);
    await getPool().query("UPDATE agent_claims SET claimed_at = claimed_at + interval '1 microsecond' WHERE id = $1", [claimId]);
    const second = await mint(claimId);
    expect(second.bindingId).not.toBe(first.bindingId);
    expect(second.credential).not.toBe(first.credential);
  });

  it('reports a canonical check through the claim source with persisted attribution', async () => {
    const claimId = await seedClaim({ sessionId: runnerSessionId, createdBy: managerActor.principalId, createdBySessionVersion: managerVersion, claimedAt: '2026-11-13 12:00:02.000001+00' });
    const binding = await mint(claimId);
    const view = await recordCollabCheckReport({
      taskId: taskA,
      source: sourceFor(binding, claimId),
      name: 'unit',
      command: 'npm test',
      status: 'passed',
      commit: HEAD,
      dirty: false,
      exitCode: 0,
      provenance: 'agent',
    });
    expect(view.runId).toBeNull();
    expect(view.status).toBe('passed');
    expect(view.actorId).toBe(managerActor.principalId);
    expect(view.provenance).toBe('agent');
    const checkRow = await getPool().query<{ name: string; command: string; created_by_principal_id: string }>(
      'SELECT name, command, created_by_principal_id FROM collab_checks WHERE id = $1',
      [view.checkId],
    );
    expect(checkRow.rows[0]).toEqual({ name: 'unit', command: 'npm test', created_by_principal_id: managerActor.principalId });
    const evidenceRow = await getPool().query<{ status: string; commit_sha: string; actor_principal_id: string; run_id: string | null }>(
      'SELECT status, commit_sha, actor_principal_id, run_id FROM collab_check_evidence WHERE id = $1',
      [view.id],
    );
    expect(evidenceRow.rows[0]).toEqual({ status: 'passed', commit_sha: HEAD, actor_principal_id: managerActor.principalId, run_id: null });
  });

  it('reports a canonical idea through the claim source with persisted attribution', async () => {
    const claimId = await seedClaim({ sessionId: runnerSessionId, createdBy: managerActor.principalId, createdBySessionVersion: managerVersion, claimedAt: '2026-11-13 12:00:03.000001+00' });
    const binding = await mint(claimId);
    const view = await recordCollabIdeaReport({
      taskId: taskA,
      source: sourceFor(binding, claimId),
      title: 'Native idea',
      body: 'Reported through a claim-bound binding.',
    });
    expect(view.runId).toBeNull();
    const row = await getPool().query<{ title: string; body: string; author_principal_id: string; run_id: string | null }>(
      'SELECT title, body, author_principal_id, run_id FROM collab_ideas WHERE id = $1',
      [view.id],
    );
    expect(row.rows[0]).toEqual({ title: 'Native idea', body: 'Reported through a claim-bound binding.', author_principal_id: managerActor.principalId, run_id: null });
  });

  it('reports a canonical workpad plan through the claim source with persisted attribution', async () => {
    const claimId = await seedClaim({ sessionId: runnerSessionId, createdBy: managerActor.principalId, createdBySessionVersion: managerVersion, claimedAt: '2026-11-13 12:00:04.000001+00' });
    const binding = await mint(claimId);
    const view = await recordWorkpadPlanReport({
      taskId: taskA,
      source: sourceFor(binding, claimId),
      items: [{ text: 'Ship parity', status: 'in_progress' }],
    });
    expect(view.items).toEqual([{ text: 'Ship parity', status: 'in_progress' }]);
    const row = await getPool().query<{ items: unknown; created_by_principal_id: string; run_id: string | null }>(
      'SELECT items, created_by_principal_id, run_id FROM collab_workpad_plans WHERE id = $1',
      [view.id],
    );
    expect(row.rows[0].items).toEqual([{ text: 'Ship parity', status: 'in_progress' }]);
    expect(row.rows[0].created_by_principal_id).toBe(managerActor.principalId);
    expect(row.rows[0].run_id).toBeNull();
  });

  it('authenticates a claim-bound agent context for progress without run or session aliases', async () => {
    const claimId = await seedClaim({ sessionId: runnerSessionId, createdBy: managerActor.principalId, createdBySessionVersion: managerVersion, claimedAt: '2026-11-13 12:00:05.000001+00' });
    const binding = await mint(claimId);
    const context = await withClientTransaction((tx) => resolveClaimReportingContext(tx, {
      claimId,
      reportingBindingId: binding.bindingId,
    }));
    expect(context.kind).toBe('agent');
    expect(context.projectId).toBe(projectId);
    expect(context.capabilities).toContain('report.progress');
    expect(context.capabilities).not.toContain('report.summary');
    expect('runId' in context).toBe(false);
    expect('sessionId' in context).toBe(false);
    const runsBefore = await getPool().query<{ count: string }>('SELECT count(*)::text AS count FROM collab_runs');
    const progress = await recordAgentProgress(context, {
      text: 'Working',
      percent: 10,
    });
    expect(progress.text).toBe('Working');
    expect(progress.percent).toBe(10);
    expect(progress.provenance).toBe('agent');
    const runsAfter = await getPool().query<{ count: string }>('SELECT count(*)::text AS count FROM collab_runs');
    expect(runsAfter.rows[0].count).toBe(runsBefore.rows[0].count);
  });

  it('rejects a claim source pointed at a different task and persists nothing', async () => {
    const claimId = await seedClaim({ sessionId: runnerSessionId, createdBy: managerActor.principalId, createdBySessionVersion: managerVersion, claimedAt: '2026-11-13 12:00:06.000001+00' });
    const binding = await mint(claimId);
    await expect(recordCollabIdeaReport({
      taskId: taskB,
      source: sourceFor(binding, claimId),
      title: 'Cross-task idea',
      body: 'Must not persist.',
    })).rejects.toMatchObject({ status: 403 });
    const persisted = await getPool().query('SELECT id FROM collab_ideas WHERE title = $1', ['Cross-task idea']);
    expect(persisted.rows).toHaveLength(0);
  });

  it('denies reporting after a capability downgrade of the formerly authorized initiator', async () => {
    const claimId = await seedClaim({ sessionId: runnerSessionId, createdBy: downgraderPrincipalId, createdBySessionVersion: downgraderVersion, claimedAt: '2026-11-13 12:00:07.000001+00' });
    const binding = await mint(claimId);
    const granted = await recordCollabIdeaReport({
      taskId: taskA,
      source: sourceFor(binding, claimId),
      title: 'Before downgrade',
      body: 'Authorized at initiation.',
    });
    expect(granted.authorId).toBe(downgraderPrincipalId);
    await getPool().query(
      'UPDATE collab_roles SET capabilities = $2::text[] WHERE id = $1',
      [downgraderRoleId, ['task.read', 'task.write', 'comment.write']],
    );
    try {
      await expect(recordCollabIdeaReport({
        taskId: taskA,
        source: sourceFor(binding, claimId),
        title: 'After downgrade',
        body: 'Must not persist.',
      })).rejects.toMatchObject({ status: 403 });
      const persisted = await getPool().query('SELECT id FROM collab_ideas WHERE title = $1', ['After downgrade']);
      expect(persisted.rows).toHaveLength(0);
      const beforeRow = await getPool().query('SELECT id FROM collab_ideas WHERE title = $1', ['Before downgrade']);
      expect(beforeRow.rows).toHaveLength(1);
    } finally {
      await getPool().query(
        'UPDATE collab_roles SET capabilities = $2::text[] WHERE id = $1',
        [downgraderRoleId, OPERATOR_CAPABILITIES],
      );
    }
  });

  it('fails closed on a missing claim-link session-version snapshot and never infers the current version', async () => {
    const claimId = await seedClaim({ sessionId: runnerSessionId, createdBy: managerActor.principalId, createdBySessionVersion: managerVersion, claimedAt: '2026-11-13 12:00:08.000001+00', withSnapshot: false });
    await expect(mint(claimId)).rejects.toMatchObject({ status: 403 });
    const tokens = await getPool().query('SELECT id FROM collab_scoped_tokens WHERE claim_id = $1', [claimId]);
    expect(tokens.rows).toHaveLength(0);
  });

  it('revokes reporting authority when the initiator session version advances past the stored snapshot', async () => {
    const claimId = await seedClaim({ sessionId: runnerSessionId, createdBy: managerActor.principalId, createdBySessionVersion: managerVersion, claimedAt: '2026-11-13 12:00:09.000001+00' });
    const binding = await mint(claimId);
    await getPool().query('UPDATE collab_principals SET session_version = session_version + 1 WHERE id = $1', [managerActor.principalId]);
    try {
      await expect(recordCollabIdeaReport({
        taskId: taskA,
        source: sourceFor(binding, claimId),
        title: 'After session bump',
        body: 'Must not persist.',
      })).rejects.toMatchObject({ status: 403 });
      await expect(mint(claimId)).rejects.toMatchObject({ status: 403 });
      const persisted = await getPool().query('SELECT id FROM collab_ideas WHERE title = $1', ['After session bump']);
      expect(persisted.rows).toHaveLength(0);
    } finally {
      await getPool().query('UPDATE collab_principals SET session_version = $2 WHERE id = $1', [managerActor.principalId, managerVersion]);
    }
  });

  it('revokes reporting authority when the originating agent token is revoked', async () => {
    const claimId = await seedClaim({ sessionId: runnerSessionId, createdBy: managerActor.principalId, createdBySessionVersion: managerVersion, claimedAt: '2026-11-13 12:00:10.000001+00' });
    const binding = await mint(claimId);
    await getPool().query('UPDATE agent_tokens SET revoked_at = NOW() WHERE id = $1', [agentTokenId]);
    try {
      await expect(recordCollabIdeaReport({
        taskId: taskA,
        source: sourceFor(binding, claimId),
        title: 'After token revocation',
        body: 'Must not persist.',
      })).rejects.toMatchObject({ status: 403 });
      expect(await ideaCount('After token revocation')).toBe(0);
    } finally {
      await getPool().query('UPDATE agent_tokens SET revoked_at = NULL WHERE id = $1', [agentTokenId]);
    }
  });

  it('revokes reporting authority when the claim lease has expired', async () => {
    const claimId = await seedClaim({ sessionId: runnerSessionId, createdBy: managerActor.principalId, createdBySessionVersion: managerVersion, claimedAt: '2026-11-13 12:00:11.000001+00' });
    const binding = await mint(claimId);
    await getPool().query("UPDATE agent_claims SET expires_at = NOW() - interval '1 second' WHERE id = $1", [claimId]);
    await expect(recordCollabIdeaReport({
      taskId: taskA,
      source: sourceFor(binding, claimId),
      title: 'After lease expiry',
      body: 'Must not persist.',
    })).rejects.toMatchObject({ status: 403 });
    const persisted = await getPool().query('SELECT id FROM collab_ideas WHERE title = $1', ['After lease expiry']);
    expect(persisted.rows).toHaveLength(0);
  });

  it('fences re-acquisition with one-microsecond claimed_at precision on the same claim', async () => {
    const claimId = await seedClaim({ sessionId: runnerSessionId, createdBy: managerActor.principalId, createdBySessionVersion: managerVersion, claimedAt: '2026-11-13 12:00:12.000001+00' });
    const stale = await mint(claimId);
    await getPool().query("UPDATE agent_claims SET claimed_at = claimed_at + interval '1 microsecond' WHERE id = $1", [claimId]);
    await expect(recordCollabIdeaReport({
      taskId: taskA,
      source: sourceFor(stale, claimId),
      title: 'Stale acquisition',
      body: 'Must not persist.',
    })).rejects.toMatchObject({ status: 403 });
    const fresh = await mint(claimId);
    expect(fresh.bindingId).not.toBe(stale.bindingId);
    const view = await recordCollabIdeaReport({
      taskId: taskA,
      source: sourceFor(fresh, claimId),
      title: 'Current acquisition',
      body: 'Reported by the live acquisition.',
    });
    expect(view.runId).toBeNull();
    const persisted = await getPool().query('SELECT id FROM collab_ideas WHERE title = $1', ['Stale acquisition']);
    expect(persisted.rows).toHaveLength(0);
  });

  it('rejects an unknown reporting binding id', async () => {
    const claimId = await seedClaim({ sessionId: runnerSessionId, createdBy: managerActor.principalId, createdBySessionVersion: managerVersion, claimedAt: '2026-11-13 12:00:13.000001+00' });
    await expect(recordCollabIdeaReport({
      taskId: taskA,
      source: { kind: 'claim', claimId, reportingBindingId: crypto.randomUUID() },
      title: 'Unknown binding',
      body: 'Must not persist.',
    })).rejects.toMatchObject({ status: 404 });
    const persisted = await getPool().query('SELECT id FROM collab_ideas WHERE title = $1', ['Unknown binding']);
    expect(persisted.rows).toHaveLength(0);
  });

  it('stores the exact database acquisition timestamp on the binding without millisecond rounding', async () => {
    const claimId = await seedClaim({ sessionId: runnerSessionId, createdBy: managerActor.principalId, createdBySessionVersion: managerVersion, claimedAt: '2026-11-13 12:00:14.123457+00' });
    const binding = await mint(claimId);
    const fence = await getPool().query<{ exact: boolean; micros: string }>(
      `SELECT token.claimed_at = claim.claimed_at AS exact,
         to_char(token.claimed_at AT TIME ZONE 'UTC', 'US') AS micros
       FROM collab_scoped_tokens token JOIN agent_claims claim ON claim.id = token.claim_id
       WHERE token.id = $1`,
      [binding.bindingId],
    );
    expect(fence.rows[0]).toEqual({ exact: true, micros: '123457' });
    const view = await reportIdea(binding, claimId, 'Exact acquisition');
    expect(view.authorId).toBe(managerActor.principalId);
  });

  it('persists the initiator session-version snapshot when a claim execution starts', async () => {
    const task = await createCollabTask({ actor: managerActor, projectId, title: 'Snapshot at initiation' });
    const started = await startCollabClaimExecution({
      actor: managerActor,
      taskId: task.id,
      expectedVersion: task.version,
      idempotencyKey: `snapshot-${crypto.randomUUID()}`,
      repo,
      prNumber: 4101,
      branch: 'feature/snapshot',
      claimType: 'spec',
    });
    const link = await getPool().query<{ created_by_principal_id: string; created_by_session_version: number | null }>(
      'SELECT created_by_principal_id, created_by_session_version FROM collab_claim_executions WHERE claim_id = $1',
      [started.claim.id],
    );
    expect(link.rows[0]).toEqual({ created_by_principal_id: managerActor.principalId, created_by_session_version: managerActor.sessionVersion });
  });

  it('rejects bootstrap for a foreign org, another agent or a runner session that does not own the claim', async () => {
    const claimId = await seedClaim({ sessionId: runnerSessionId, createdBy: managerActor.principalId, createdBySessionVersion: managerVersion, claimedAt: '2026-11-13 12:00:15.000001+00' });
    const otherSession = await seedRunnerSession();
    const base = { orgId, agentId: 'reporting-runner', runnerSessionId, claimId, agentTokenId };
    await expect(withClientTransaction((tx) => ensureClaimReportingBinding(tx, { ...base, orgId: 'claim-reporting-foreign-org' }))).rejects.toMatchObject({ status: 404 });
    await expect(withClientTransaction((tx) => ensureClaimReportingBinding(tx, { ...base, agentId: 'claim-reporting-other-agent' }))).rejects.toMatchObject({ status: 403 });
    await expect(withClientTransaction((tx) => ensureClaimReportingBinding(tx, { ...base, runnerSessionId: otherSession }))).rejects.toMatchObject({ status: 403 });
    const tokens = await getPool().query('SELECT id FROM collab_scoped_tokens WHERE claim_id = $1', [claimId]);
    expect(tokens.rows).toHaveLength(0);
  });

  it('revokes reporting authority when the claim moves to another runner session at the same acquisition timestamp', async () => {
    const claimId = await seedClaim({ sessionId: runnerSessionId, createdBy: managerActor.principalId, createdBySessionVersion: managerVersion, claimedAt: '2026-11-13 12:00:16.000001+00' });
    const binding = await mint(claimId);
    const otherSession = await seedRunnerSession();
    await getPool().query('UPDATE agent_claims SET session_id = $2 WHERE id = $1', [claimId, otherSession]);
    await expect(reportIdea(binding, claimId, 'Moved slot')).rejects.toMatchObject({ status: 403 });
    expect(await ideaCount('Moved slot')).toBe(0);
  });

  it('revokes reporting authority when the owning runner session expires', async () => {
    const session = await seedRunnerSession();
    const claimId = await seedClaim({ sessionId: session, createdBy: managerActor.principalId, createdBySessionVersion: managerVersion, claimedAt: '2026-11-13 12:00:17.000001+00' });
    const binding = await withClientTransaction((tx) => ensureClaimReportingBinding(tx, { orgId, agentId: 'reporting-runner', runnerSessionId: session, claimId, agentTokenId }));
    await getPool().query("UPDATE agent_sessions SET expires_at = NOW() - interval '1 second' WHERE id = $1", [session]);
    await expect(reportIdea(binding, claimId, 'Expired runner session')).rejects.toMatchObject({ status: 403 });
    expect(await ideaCount('Expired runner session')).toBe(0);
  });

  it('revokes reporting authority when the originating agent token expires', async () => {
    const claimId = await seedClaim({ sessionId: runnerSessionId, createdBy: managerActor.principalId, createdBySessionVersion: managerVersion, claimedAt: '2026-11-13 12:00:18.000001+00' });
    const binding = await mint(claimId);
    const original = await getPool().query<{ expires_at: Date | null }>('SELECT expires_at FROM agent_tokens WHERE id = $1', [agentTokenId]);
    await getPool().query("UPDATE agent_tokens SET expires_at = NOW() - interval '1 second' WHERE id = $1", [agentTokenId]);
    try {
      await expect(reportIdea(binding, claimId, 'Expired agent token')).rejects.toMatchObject({ status: 403 });
      await expect(mint(claimId)).rejects.toMatchObject({ status: 403 });
      expect(await ideaCount('Expired agent token')).toBe(0);
    } finally {
      await getPool().query('UPDATE agent_tokens SET expires_at = $2 WHERE id = $1', [agentTokenId, original.rows[0].expires_at]);
    }
  });

  it('does not revive a revoked binding on repeated bootstrap of the same acquisition', async () => {
    const claimId = await seedClaim({ sessionId: runnerSessionId, createdBy: managerActor.principalId, createdBySessionVersion: managerVersion, claimedAt: '2026-11-13 12:00:19.000001+00' });
    const binding = await mint(claimId);
    await getPool().query('UPDATE collab_scoped_tokens SET revoked_at = NOW() WHERE id = $1', [binding.bindingId]);
    await expect(reportIdea(binding, claimId, 'Revoked binding')).rejects.toMatchObject({ status: 403 });
    await expect(mint(claimId)).rejects.toMatchObject({ status: 403 });
    expect(await ideaCount('Revoked binding')).toBe(0);
  });

  it('denies reporting when the formerly authorized initiator loses run.start', async () => {
    const claimId = await seedClaim({ sessionId: runnerSessionId, createdBy: downgraderPrincipalId, createdBySessionVersion: downgraderVersion, claimedAt: '2026-11-13 12:00:20.000001+00' });
    const binding = await mint(claimId);
    await reportIdea(binding, claimId, 'Before run.start removal');
    await getPool().query('UPDATE collab_roles SET capabilities = $2::text[] WHERE id = $1', [downgraderRoleId, OPERATOR_CAPABILITIES.filter((capability) => capability !== 'run.start')]);
    try {
      await expect(reportIdea(binding, claimId, 'After run.start removal')).rejects.toMatchObject({ status: 403 });
      expect(await ideaCount('After run.start removal')).toBe(0);
    } finally {
      await getPool().query('UPDATE collab_roles SET capabilities = $2::text[] WHERE id = $1', [downgraderRoleId, OPERATOR_CAPABILITIES]);
    }
  });

  it('revokes reporting authority and bootstrap when the initiator is disabled', async () => {
    const claimId = await seedClaim({ sessionId: runnerSessionId, createdBy: downgraderPrincipalId, createdBySessionVersion: downgraderVersion, claimedAt: '2026-11-13 12:00:21.000001+00' });
    const binding = await mint(claimId);
    await getPool().query('UPDATE collab_principals SET disabled_at = NOW() WHERE id = $1', [downgraderPrincipalId]);
    try {
      await expect(reportIdea(binding, claimId, 'Disabled initiator')).rejects.toMatchObject({ status: 403 });
      await expect(mint(claimId)).rejects.toMatchObject({ status: 403 });
      expect(await ideaCount('Disabled initiator')).toBe(0);
    } finally {
      await getPool().query('UPDATE collab_principals SET disabled_at = NULL WHERE id = $1', [downgraderPrincipalId]);
    }
  });
});
