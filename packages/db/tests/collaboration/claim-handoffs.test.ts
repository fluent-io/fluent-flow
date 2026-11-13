import { afterAll, beforeAll, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { closePool, getPool } from '../../src/pool.js';
import { runMigrations } from '../../src/migrate.js';
import {
  bootstrapCollaborationWorkspace, createCollabProject, createCollabTask,
  ensureGithubPrincipal, startCollabClaimExecution, submitCollabClaimCommand,
} from '../../src/collaboration/index.js';
import * as collaboration from '../../src/collaboration/index.js';
import { ackClaimCommand, leaseClaimCommands } from '../../src/queries/claim-interactions.js';
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
  const { rows } = await getPool().query(`SELECT c.*,e.root_claim_id FROM agent_claims c JOIN collab_claim_executions e ON e.claim_id=c.id WHERE c.id=$1`, [first.claimId]);
  expect(rows[0]).toMatchObject({
    claim_type: 'spec', status: 'pending', session_id: null, target_agent_id: null,
    root_claim_id: source.claimId,
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
