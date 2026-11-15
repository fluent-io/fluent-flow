import { afterAll, beforeAll, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { closePool, getPool } from '../../src/pool.js';
import { runMigrations } from '../../src/migrate.js';
import {
  bootstrapCollaborationWorkspace, createCollabProject, createCollabTask,
  ensureGithubPrincipal, startCollabClaimExecution, submitCollabClaimCommand,
} from '../../src/collaboration/index.js';
import * as collaboration from '../../src/collaboration/index.js';
import { ackClaimCommand, appendClaimEvents, leaseClaimCommands } from '../../src/queries/claim-interactions.js';
import { resetCollabSchema, resolveCollabTestDatabaseUrl, seedOrgMembership, seedUser } from '../helpers/collab-db.js';

process.env.DATABASE_URL = resolveCollabTestDatabaseUrl();
const databaseUrl = process.env.DATABASE_URL;
const orgId = 'handoff-org';
const repo = 'acme/handoff';
let actor: { principalId: string; sessionVersion: number };
let projectId: string;

beforeAll(async () => {
  await resetCollabSchema(databaseUrl);
  await runMigrations();
  const userId = await seedUser(databaseUrl, { githubId: 9981, login: 'handoff-manager' });
  await seedOrgMembership(databaseUrl, userId, orgId, 'admin');
  const principal = await ensureGithubPrincipal({ userId, displayName: 'Manager', email: 'handoff@example.test' });
  actor = { principalId: principal.id, sessionVersion: principal.sessionVersion };
  const workspace = await bootstrapCollaborationWorkspace({ actor, orgId, name: 'Handoff', idempotencyKey: 'handoff-workspace' });
  const project = await createCollabProject({ actor, workspaceId: workspace.id, name: 'Handoff' });
  projectId = project.id;
  await getPool().query(`INSERT INTO repos(id,org_id,repo_full_name,provider) VALUES ($1,$2,$3,'github')`, [randomUUID(), orgId, repo]);
});
afterAll(() => closePool());

async function chat(repository: string | null = repo) {
  const task = await createCollabTask({ actor, projectId, title: 'Designed feature', description: 'Original task' });
  const started = await startCollabClaimExecution({ actor, taskId: task.id, expectedVersion: task.version,
    idempotencyKey: randomUUID(), repo: repository, claimType: 'chat' });
  await getPool().query(`UPDATE agent_claims SET status='claimed',expires_at=now()+interval '15 minutes' WHERE id=$1`, [started.claim.id]);
  return { task, claimId: started.claim.id };
}

it('queues an explicit handoff only for repository chats without creating unattended claims', async () => {
  const source = await chat();
  const request = { actor, claimId: source.claimId, idempotencyKey: randomUUID(), kind: 'handoff' as const, payload: {} };
  const queued = await submitCollabClaimCommand(request);
  const replay = await submitCollabClaimCommand(request);
  expect(replay).toMatchObject({ commandId: queued.commandId, created: false });
  const commands = await leaseClaimCommands({ orgId, claimId: source.claimId, limit: 25 });
  expect(commands.map(command => command.kind)).toEqual(['handoff']);
  const unattended = await getPool().query(`SELECT c.id FROM agent_claims c JOIN collab_claim_executions e ON e.claim_id=c.id WHERE e.task_id=$1 AND c.claim_type<>'chat'`, [source.task.id]);
  expect(unattended.rows).toEqual([]);
  const repoNull = await chat(null);
  await expect(submitCollabClaimCommand({ ...request, claimId: repoNull.claimId, idempotencyKey: randomUUID() }))
    .rejects.toMatchObject({ status: 409, code: 'handoff_unavailable' });
});

const digest = {
  goal: 'Build the accepted feature',
  decisions: ['Use the existing API'],
  acceptanceCriteria: ['An authorized user can complete the workflow'],
  openQuestions: [],
  filesTouched: ['design.md'],
};

async function preparedHandoff(design = digest) {
  const source = await chat();
  const queued = await submitCollabClaimCommand({ actor, claimId: source.claimId,
    idempotencyKey: randomUUID(), kind: 'handoff', payload: {} });
  await leaseClaimCommands({ orgId, claimId: source.claimId, limit: 25 });
  await ackClaimCommand({ orgId, claimId: source.claimId, commandId: queued.commandId!,
    status: 'acked', result: { digest: design, branch: `ff/task-${source.task.id}`, headSha: 'a'.repeat(40) } });
  return { ...source, commandId: queued.commandId! };
}

it('atomically starts one ordinary spec claim with reviewed digest, pinned artifacts and chat lineage', async () => {
  const source = await preparedHandoff();
  const input = { actor, claimId: source.claimId, commandId: source.commandId,
    expectedVersion: source.task.version, idempotencyKey: randomUUID() };
  const [first, replay] = await Promise.all([
    collaboration.startCollabClaimHandoff(input), collaboration.startCollabClaimHandoff(input),
  ]);
  expect(first.claimId).toBe(replay.claimId);
  expect([first.created, replay.created].sort()).toEqual([false, true]);
  const { rows } = await getPool().query(`SELECT c.*,e.root_claim_id,e.parent_claim_id,e.created_by_principal_id,e.created_by_session_version FROM agent_claims c JOIN collab_claim_executions e ON e.claim_id=c.id WHERE c.id=$1`, [first.claimId]);
  expect(rows[0]).toMatchObject({
    claim_type: 'spec', status: 'pending', session_id: null, target_agent_id: null,
    root_claim_id: source.claimId, parent_claim_id: source.claimId,
    created_by_principal_id: actor.principalId, created_by_session_version: actor.sessionVersion,
    payload: { handed_off_from: source.claimId, handoff_command_id: source.commandId,
      branch: `ff/task-${source.task.id}`, handoff_base_sha: 'a'.repeat(40), handoff_digest: digest },
  });
  expect(rows[0].payload.message).toContain('An authorized user can complete the workflow');
  const task = await getPool().query(`SELECT description,status,version FROM collab_tasks WHERE id=$1`, [source.task.id]);
  expect(task.rows[0].description).toContain('Original task');
  expect(task.rows[0].description).toContain('An authorized user can complete the workflow');
  expect(task.rows[0]).toMatchObject({ status: 'backlog', version: 2 });
  const chatState = await getPool().query(`SELECT status FROM agent_claims WHERE id=$1`, [source.claimId]);
  expect(chatState.rows[0].status).toBe('claimed');
});

it('does not spend tokens on stale or revoked handoff confirmation', async () => {
  const source = await preparedHandoff();
  const input = { actor, claimId: source.claimId, commandId: source.commandId, expectedVersion: 99, idempotencyKey: randomUUID() };
  await expect(collaboration.startCollabClaimHandoff(input)).rejects.toMatchObject({ status: 409, code: 'version_conflict' });
  await expect(collaboration.startCollabClaimHandoff({ ...input, expectedVersion: 1,
    actor: { ...actor, sessionVersion: actor.sessionVersion + 1 } })).rejects.toMatchObject({ status: 401 });
  const work = await getPool().query(`SELECT c.id FROM agent_claims c JOIN collab_claim_executions e ON e.claim_id=c.id WHERE e.task_id=$1 AND c.claim_type<>'chat'`, [source.task.id]);
  expect(work.rows).toEqual([]);
});

it('creates a destination task only on explicit confirmation and keeps the source task unchanged', async () => {
  const source = await preparedHandoff();
  const result = await collaboration.startCollabClaimHandoff({ actor, claimId: source.claimId, commandId: source.commandId,
    expectedVersion: source.task.version, idempotencyKey: randomUUID(), destinationTitle: 'Separate build task' });
  expect(result.taskId).not.toBe(source.task.id);
  const destination = await getPool().query(`SELECT title,description,project_id FROM collab_tasks WHERE id=$1`, [result.taskId]);
  expect(destination.rows[0]).toMatchObject({ title: 'Separate build task', project_id: projectId });
  expect(destination.rows[0].description).toContain('Build the accepted feature');
  const original = await getPool().query(`SELECT description,version FROM collab_tasks WHERE id=$1`, [source.task.id]);
  expect(original.rows[0]).toEqual({ description: 'Original task', version: 1 });
  const work = (await getPool().query(`SELECT claim.payload,execution.root_claim_id,execution.parent_claim_id
    FROM agent_claims claim JOIN collab_claim_executions execution ON execution.claim_id=claim.id WHERE claim.id=$1`, [result.claimId])).rows[0];
  expect(work).toMatchObject({ root_claim_id: result.claimId, parent_claim_id: null, payload: {
    branch: `ff/task-${result.taskId}`, handed_off_from: source.claimId, handoff_base_sha: 'a'.repeat(40),
  } });
});

it('gives a different authorized handoff initiator a genuine independent execution root', async () => {
  const source = await preparedHandoff();
  const userId = await seedUser(databaseUrl, { githubId: 9982, login: 'handoff-builder' });
  await seedOrgMembership(databaseUrl, userId, orgId, 'member');
  const principal = await ensureGithubPrincipal({ userId, displayName: 'Builder', email: 'builder@example.test' });
  const builder = { principalId: principal.id, sessionVersion: principal.sessionVersion };
  const workspaceId = (await getPool().query('SELECT workspace_id FROM collab_projects WHERE id=$1', [projectId])).rows[0].workspace_id;
  const role = await collaboration.createWorkspaceRole({ actor, workspaceId, name: 'Handoff operator',
    capabilities: ['task.read','internal.read','run.start','run.steer'] });
  await collaboration.addCollabMember({ actor, workspaceId, principalId: builder.principalId, roleId: role.id });
  const result = await collaboration.startCollabClaimHandoff({ actor: builder, claimId: source.claimId, commandId: source.commandId,
    expectedVersion: source.task.version, idempotencyKey: randomUUID() });
  const work = (await getPool().query(`SELECT claim.payload,execution.root_claim_id,execution.parent_claim_id,
    execution.created_by_principal_id,execution.created_by_session_version FROM agent_claims claim
    JOIN collab_claim_executions execution ON execution.claim_id=claim.id WHERE claim.id=$1`, [result.claimId])).rows[0];
  expect(work).toMatchObject({ root_claim_id: result.claimId, parent_claim_id: null,
    created_by_principal_id: builder.principalId, created_by_session_version: builder.sessionVersion,
    payload: { handed_off_from: source.claimId, branch: `ff/task-${source.task.id}`, handoff_base_sha: 'a'.repeat(40) } });
  expect((await getPool().query('SELECT created_by_principal_id,created_by_session_version FROM collab_claim_executions WHERE claim_id=$1', [source.claimId])).rows)
    .toEqual([{ created_by_principal_id: actor.principalId, created_by_session_version: actor.sessionVersion }]);
});

it('rejects machine-local paths in a digest before publishing it into task content', async () => {
  const source = await preparedHandoff({ ...digest, filesTouched: ['/home/operator/private/design.md'] });
  await expect(collaboration.startCollabClaimHandoff({ actor, claimId: source.claimId, commandId: source.commandId,
    expectedVersion: 1, idempotencyKey: randomUUID() })).rejects.toMatchObject({ status: 409, code: 'handoff_not_ready' });
  expect((await getPool().query('SELECT description FROM collab_tasks WHERE id=$1', [source.task.id])).rows[0].description).toBe('Original task');
});

it('shows unknown cleanup honestly and accepts retained-work metadata only from the owning agent session', async () => {
  const source = await chat();
  await getPool().query(`INSERT INTO agents(org_id,id,agent_type,transport,repos) VALUES ($1,'workspace-runner','test','long_poll','{}')`, [orgId]);
  const slot = (await getPool().query(`INSERT INTO agent_sessions(org_id,agent_id,status,expires_at) VALUES ($1,'workspace-runner','online',now()+interval '1 hour') RETURNING id`, [orgId])).rows[0].id;
  await getPool().query(`UPDATE agent_claims SET session_id=$2,status='cancelled',end_reason='user' WHERE id=$1`, [source.claimId,slot]);
  const unknown = await collaboration.listCollabRetainedWork({ actor, taskId: source.task.id });
  expect(unknown.items[0]).toMatchObject({ claimId: source.claimId, retained: null });
  const report = { orgId, agentId: 'different-agent', sessionId: slot, claimId: source.claimId, retained: true, reason: 'dirty' };
  expect(await collaboration.recordClaimWorkspace(report)).toBeNull();
  expect(await collaboration.recordClaimWorkspace({ ...report, agentId: 'workspace-runner' })).toMatchObject({ retained: true, reason: 'dirty' });
  const visible = await collaboration.listCollabRetainedWork({ actor, taskId: source.task.id });
  expect(visible.items[0]).toEqual({ claimId: source.claimId, agentId: 'workspace-runner', repo,
    retained: true, reason: 'dirty', reportedAt: expect.any(String) });
  await expect(collaboration.listCollabRetainedWork({ actor: { ...actor, sessionVersion: actor.sessionVersion + 1 },
    taskId: source.task.id })).rejects.toMatchObject({ status: 401 });
});

it('does not invent workspace cleanup uncertainty for a chat that never reached an agent', async () => {
  const source = await chat();
  await getPool().query(`UPDATE agent_claims SET status='cancelled',end_reason='no_capacity' WHERE id=$1`, [source.claimId]);
  expect((await collaboration.listCollabRetainedWork({ actor, taskId: source.task.id })).items).toEqual([]);
});

it('preserves an accepted session event while a build handoff waits for the same task', async () => {
  const source = await preparedHandoff();
  const client = await getPool().connect();
  let pending: Promise<{ result?: { claimId: number; taskId: string; created: boolean }; error?: unknown }> | undefined;
  try {
    await client.query('BEGIN');
    await client.query('SELECT id FROM collab_tasks WHERE id=$1 FOR UPDATE', [source.task.id]);
    const pid = (await client.query('SELECT pg_backend_pid() AS id')).rows[0].id;
    pending = collaboration.startCollabClaimHandoff({ actor, claimId: source.claimId, commandId: source.commandId,
      expectedVersion: source.task.version, idempotencyKey: randomUUID() }).then(result => ({ result }), error => ({ error }));
    const deadline = Date.now() + 3000;
    let blocked = false;
    while (Date.now() < deadline) {
      const state = await getPool().query('SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND $1::integer=ANY(pg_blocking_pids(pid))) AS blocked', [pid]);
      if (state.rows[0].blocked) { blocked = true; break; }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    expect(blocked).toBe(true);
    await client.query('SELECT id FROM agent_claims WHERE id=$1 FOR UPDATE', [source.claimId]);
    await appendClaimEvents({ orgId, claimId: source.claimId,
      events: [{ seq: 1, kind: 'notice', payload: { text: 'Final design event accepted before handoff.' } }] }, client);
    await client.query('COMMIT');
    const settled = await pending;
    if (settled.error) throw settled.error;
    expect(settled.result).toMatchObject({ taskId: source.task.id, created: true });
    expect((await getPool().query('SELECT seq,payload FROM agent_claim_events WHERE claim_id=$1', [source.claimId])).rows)
      .toEqual([{ seq: 1, payload: { text: 'Final design event accepted before handoff.' } }]);
    expect((await getPool().query('SELECT payload FROM agent_claims WHERE id=$1', [settled.result!.claimId])).rows[0].payload.handoff_digest).toEqual(digest);
  } finally {
    await client.query('ROLLBACK');
    client.release();
    if (pending) await pending;
  }
});

it('waits for the destination board before taking its source task lock', async () => {
  const source = await preparedHandoff();
  const client = await getPool().connect();
  let pending: Promise<{ result?: { claimId: number; taskId: string; created: boolean }; error?: unknown }> | undefined;
  try {
    await client.query('BEGIN');
    await client.query('SELECT id FROM collab_projects WHERE id=$1 FOR UPDATE', [projectId]);
    const pid = (await client.query('SELECT pg_backend_pid() AS id')).rows[0].id;
    pending = collaboration.startCollabClaimHandoff({ actor, claimId: source.claimId, commandId: source.commandId,
      expectedVersion: source.task.version, idempotencyKey: randomUUID(), destinationTitle: 'Concurrent destination' })
      .then(result => ({ result }), error => ({ error }));
    const deadline = Date.now() + 3000;
    let blocked = false;
    while (Date.now() < deadline) {
      const state = await getPool().query('SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND $1::integer=ANY(pg_blocking_pids(pid))) AS blocked', [pid]);
      if (state.rows[0].blocked) { blocked = true; break; }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    expect(blocked).toBe(true);
    expect((await client.query('SELECT id FROM collab_tasks WHERE id=$1 FOR UPDATE NOWAIT', [source.task.id])).rows)
      .toEqual([{ id: source.task.id }]);
    await client.query('COMMIT');
    const settled = await pending;
    if (settled.error) throw settled.error;
    const destination = (await getPool().query('SELECT title,project_id FROM collab_tasks WHERE id=$1', [settled.result!.taskId])).rows;
    expect(destination).toEqual([{ title: 'Concurrent destination', project_id: projectId }]);
  } finally {
    await client.query('ROLLBACK');
    client.release();
    if (pending) await pending;
  }
});

it('starts from the current initiator snapshot after the chat creator session is replaced', async () => {
  const source = await preparedHandoff();
  const originalVersion = actor.sessionVersion;
  const current = (await getPool().query(`UPDATE collab_principals SET session_version=session_version+1
    WHERE id=$1 RETURNING session_version`, [actor.principalId])).rows[0];
  actor = { principalId: actor.principalId, sessionVersion: current.session_version };
  const result = await collaboration.startCollabClaimHandoff({ actor, claimId: source.claimId, commandId: source.commandId,
    expectedVersion: source.task.version, idempotencyKey: randomUUID() });
  expect((await getPool().query(`SELECT root_claim_id,parent_claim_id,created_by_session_version
    FROM collab_claim_executions WHERE claim_id=$1`, [result.claimId])).rows)
    .toEqual([{ root_claim_id: result.claimId, parent_claim_id: null, created_by_session_version: actor.sessionVersion }]);
  expect((await getPool().query('SELECT created_by_session_version FROM collab_claim_executions WHERE claim_id=$1', [source.claimId])).rows)
    .toEqual([{ created_by_session_version: originalVersion }]);
});
