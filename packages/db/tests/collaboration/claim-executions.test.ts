import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  resetCollabSchema,
  resolveCollabTestDatabaseUrl,
  seedOrgMembership,
  seedUser,
} from '../helpers/collab-db.js';
import { closePool, getPool } from '../../src/pool.js';
import { runMigrations } from '../../src/migrate.js';
import {
  bootstrapCollaborationWorkspace,
  createCollabProject,
  createCollabTask,
  ensureGithubPrincipal,
  getCollabClaimExecution,
  listCollabClaimExecutions,
  submitCollabClaimCommand,
  startCollabChatSession,
  startCollabClaimExecution,
} from '../../src/collaboration/index.js';
import { dismissClaim, insertPendingClaim } from '../../src/queries/claims.js';
import { createClaim as createDashboardClaim } from '../../src/queries/repos.js';
import { getPipelineDetail, listPipelines } from '../../src/queries/pipelines.js';
import { deleteAgentIfNoCollaborationClaims } from '../../src/queries/agents.js';
import { enqueueClaimCommand, leaseClaimCommands } from '../../src/queries/claim-interactions.js';

async function withSingleConnection<T>(operation: () => Promise<T>): Promise<T> {
  await closePool();
  const pool = getPool();
  const options = pool.options;
  const previous = { max: options.max, connectionTimeoutMillis: options.connectionTimeoutMillis };
  options.max = 1;
  options.connectionTimeoutMillis = 150;
  try {
    return await operation();
  } finally {
    Object.assign(options, previous);
    await closePool();
  }
}

process.env.DATABASE_URL = resolveCollabTestDatabaseUrl();
const DATABASE_URL = process.env.DATABASE_URL;

async function rows<T = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> {
  const result = await getPool().query<T>(text, params);
  return result.rows;
}
const dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.resolve(dirname, '../../src/migrations');
const migrationPath = path.join(migrationsDir, '0023_collab_claim_idempotency.sql');
const journalPath = path.join(migrationsDir, 'meta/_journal.json');

describe('task-linked claim executions', () => {
  let managerActor: { principalId: string; sessionVersion: number };
  let collaboratorActor: { principalId: string; sessionVersion: number };
  let outsiderActor: { principalId: string; sessionVersion: number };
  let projectId: string;
  let workspaceId: string;
  let taskId: string;
  let repoId: string;
  const orgId = 'claim-exec-org';
  const repo = 'acme/claim-executions';

  async function makeActor(input: {
    githubId: number;
    login: string;
    role?: 'admin' | 'member';
    workspaceRole?: string;
  }) {
    const userId = await seedUser(DATABASE_URL, {
      githubId: input.githubId,
      login: input.login,
    });
    await seedOrgMembership(DATABASE_URL, userId, orgId, input.role ?? 'member');
    const principal = await ensureGithubPrincipal({
      userId,
      displayName: input.login,
      email: `${input.login}@example.test`,
    });
    if (input.workspaceRole) {
      const role = await rows<{ id: string }>(
        `SELECT id FROM collab_roles WHERE workspace_id = $1 AND name = $2`,
        [workspaceId, input.workspaceRole],
      );
      await getPool().query(
        `INSERT INTO collab_memberships (workspace_id, principal_id, role_id)
         VALUES ($1, $2, $3)`,
        [workspaceId, principal.id, role[0].id],
      );
    }
    return { principalId: principal.id, sessionVersion: principal.sessionVersion };
  }

  function startInput(overrides: Record<string, unknown> = {}) {
    return {
      actor: managerActor,
      taskId,
      expectedVersion: 1,
      idempotencyKey: `claim-${crypto.randomUUID()}`,
      repo,
      prNumber: 42,
      branch: 'feature/task-linked-claims',
      claimType: 'spec' as const,
      instructions: 'Implement the accepted task.',
      ...overrides,
    };
  }

  beforeAll(async () => {
    process.env.FF_COLLAB_AUTH_SECRET = 'claim-exec-test-secret-0123456789abcdef0123456789abcdef';
    await resetCollabSchema(DATABASE_URL);
    await runMigrations();

    const managerUserId = await seedUser(DATABASE_URL, {
      githubId: 9801,
      login: 'claim-exec-manager',
    });
    await seedOrgMembership(DATABASE_URL, managerUserId, orgId, 'admin');
    const manager = await ensureGithubPrincipal({
      userId: managerUserId,
      displayName: 'Claim Exec Manager',
      email: 'claim-exec-manager@example.test',
    });
    managerActor = { principalId: manager.id, sessionVersion: manager.sessionVersion };

    const workspace = await bootstrapCollaborationWorkspace({
      actor: managerActor,
      orgId,
      name: 'Claim Execution Workspace',
      idempotencyKey: 'claim-exec-workspace',
    });
    workspaceId = workspace.id;
    const project = await createCollabProject({
      actor: managerActor,
      workspaceId,
      name: 'Claim Execution Project',
    });
    projectId = project.id;
    const task = await createCollabTask({
      actor: managerActor,
      projectId,
      title: 'Claim execution task',
    });
    taskId = task.id;

    collaboratorActor = await makeActor({
      githubId: 9802,
      login: 'claim-exec-collaborator',
      workspaceRole: 'collaborator',
    });

    const outsiderUserId = await seedUser(DATABASE_URL, {
      githubId: 9803,
      login: 'claim-exec-outsider',
    });
    const outsider = await ensureGithubPrincipal({
      userId: outsiderUserId,
      displayName: 'Claim Exec Outsider',
      email: 'claim-exec-outsider@example.test',
    });
    outsiderActor = { principalId: outsider.id, sessionVersion: outsider.sessionVersion };

    repoId = crypto.randomUUID();
    await getPool().query(
      `INSERT INTO repos (id, org_id, repo_full_name, provider)
       VALUES ($1, $2, $3, 'github')`,
      [repoId, orgId, repo],
    );
  });

  afterAll(async () => {
    delete process.env.FF_COLLAB_AUTH_SECRET;
    await closePool();
  });

  it('adds the claim resource migration after the shipped ACP migration', async () => {
    await expect(fs.access(migrationPath)).resolves.toBeUndefined();
    const journal = JSON.parse(await fs.readFile(journalPath, 'utf8')) as {
      entries: Array<{ idx: number; tag: string }>;
    };
    const previous = journal.entries.find((entry) => entry.tag === '0022_agent_claim_acp');
    const current = journal.entries.find((entry) => entry.tag === '0023_collab_claim_idempotency');

    expect(previous).toBeDefined();
    expect(current).toEqual(expect.objectContaining({
      idx: previous!.idx + 1,
      tag: '0023_collab_claim_idempotency',
    }));
  });

  it('migrates idempotency records to exactly one UUID or integer resource', async () => {
    const columns = await rows<{
      column_name: string;
      data_type: string;
      is_nullable: 'YES' | 'NO';

    }>(
      `SELECT column_name, data_type, is_nullable
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'collab_idempotency_records'
         AND column_name IN ('resource_id', 'claim_id')
       ORDER BY column_name`,
    );
    expect(columns).toEqual([
      { column_name: 'claim_id', data_type: 'integer', is_nullable: 'YES' },
      { column_name: 'resource_id', data_type: 'uuid', is_nullable: 'YES' },
    ]);

    const created = await insertPendingClaim({
      orgId,
      repo,
      prNumber: 801,
      attempt: 1,
      claimType: 'spec',
      payload: { fixture: 'idempotency-resource' },
    });
    expect(created).not.toBeNull();

    await expect(getPool().query(
      `INSERT INTO collab_idempotency_records
         (principal_id, scope_key, idempotency_key, request_hash, claim_id)
       VALUES ($1, 'claim-schema', 'claim-only-key', 'hash-1', $2)`,
      [managerActor.principalId, created!.id],
    )).resolves.toMatchObject({ rowCount: 1 });
    await expect(getPool().query(
      `INSERT INTO collab_idempotency_records
         (principal_id, scope_key, idempotency_key, request_hash, resource_id)
       VALUES ($1, 'claim-schema', 'resource-only-key', 'hash-2', $2)`,
      [managerActor.principalId, taskId],
    )).resolves.toMatchObject({ rowCount: 1 });
    await expect(getPool().query(
      `INSERT INTO collab_idempotency_records
         (principal_id, scope_key, idempotency_key, request_hash)
       VALUES ($1, 'claim-schema', 'missing-resource-key', 'hash-3')`,
      [managerActor.principalId],
    )).rejects.toThrow();
    await expect(getPool().query(
      `INSERT INTO collab_idempotency_records
         (principal_id, scope_key, idempotency_key, request_hash, resource_id, claim_id)
       VALUES ($1, 'claim-schema', 'double-resource-key', 'hash-4', $2, $3)`,
      [managerActor.principalId, taskId, created!.id],
    )).rejects.toThrow();

    const foreignKeys = await rows<{ foreign_table_name: string }>(
      `SELECT ccu.table_name AS foreign_table_name
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON kcu.constraint_name = tc.constraint_name
        AND kcu.constraint_schema = tc.constraint_schema
       JOIN information_schema.constraint_column_usage ccu
         ON ccu.constraint_name = tc.constraint_name
        AND ccu.constraint_schema = tc.constraint_schema
       WHERE tc.table_schema = 'public'
         AND tc.table_name = 'collab_idempotency_records'
         AND tc.constraint_type = 'FOREIGN KEY'
         AND kcu.column_name = 'claim_id'`,
    );
    expect(foreignKeys).toEqual([{ foreign_table_name: 'agent_claims' }]);

    await getPool().query(`DELETE FROM agent_claims WHERE id = $1`, [created!.id]);
    const cascaded = await rows(
      `SELECT idempotency_key FROM collab_idempotency_records
       WHERE principal_id = $1
         AND scope_key = 'claim-schema'
         AND idempotency_key = 'claim-only-key'`,
      [managerActor.principalId],
    );
    expect(cascaded).toEqual([]);
  });

  it('creates a repo-less task chat exactly once without changing the task', async () => {
    const input = { ...startInput(), claimType: 'chat' as const, repo: null, prNumber: null, branch: null };
    const first = await startCollabClaimExecution(input);
    const replay = await startCollabClaimExecution(input);
    expect(replay).toMatchObject({ created: false, claim: { id: first.claim.id } });
    expect(first.claim).toMatchObject({ taskId, claimType: 'chat', repo: null, attempt: 1, status: 'pending' });
    expect(await rows('SELECT task_id, target_agent_id, last_activity_at IS NOT NULL AS activity FROM agent_claims WHERE id = $1', [first.claim.id]))
      .toEqual([{ task_id: taskId, target_agent_id: null, activity: true }]);
    expect(await rows('SELECT status, version FROM collab_tasks WHERE id = $1', [taskId]))
      .toEqual([{ status: 'backlog', version: 1 }]);
    await expect(startCollabClaimExecution({ ...input, idempotencyKey: crypto.randomUUID() }))
      .rejects.toMatchObject({ status: 409, code: 'chat_already_open' });
    await getPool().query("UPDATE agent_claims SET status = 'cancelled' WHERE id = $1", [first.claim.id]);
  });

  it('keeps turn cancellation nonterminal and ends a pending chat idempotently', async () => {
    const task = await createCollabTask({ actor: managerActor, projectId, title: 'Chat command semantics' });
    const started = await startCollabClaimExecution({ actor: managerActor, taskId: task.id, expectedVersion: 1, idempotencyKey: crypto.randomUUID(), repo: null, claimType: 'chat' });
    const command = { actor: managerActor, claimId: started.claim.id, idempotencyKey: crypto.randomUUID(), payload: {} };
    await expect(submitCollabClaimCommand({ ...command, kind: 'cancel' }))
      .rejects.toMatchObject({ status: 409, code: 'claim_not_active' });
    const ended = await submitCollabClaimCommand({ ...command, kind: 'end_session' });
    expect(ended).toMatchObject({ kind: 'end_session', status: 'cancelled', created: true });
    expect(await submitCollabClaimCommand({ ...command, kind: 'end_session' })).toMatchObject({ created: false });
    expect(await rows('SELECT status, end_reason FROM agent_claims WHERE id=$1', [started.claim.id]))
      .toEqual([{ status: 'cancelled', end_reason: 'user' }]);
  });

  it('delivers chat commands with the pool fully occupied by the owner transaction', async () => {
    const started = await startCollabChatSession({ actor: managerActor, projectId, title: 'Saturated delivery', idempotencyKey: crypto.randomUUID() });
    const queued = await enqueueClaimCommand({ orgId, claimId: started.claim.id, kind: 'prompt', payload: { text: 'continue' }, idempotencyKey: crypto.randomUUID(), originator: managerActor });
    await withSingleConnection(async () => {
      const client = await getPool().connect();
      try {
        await client.query('BEGIN');
        await client.query('SELECT id FROM agent_claims WHERE id=$1 FOR UPDATE', [started.claim.id]);
        const delivered = await leaseClaimCommands({ orgId, claimId: started.claim.id, limit: 10 }, client);
        expect(delivered.map(command => command.id)).toEqual([queued.command.id]);
        await client.query('COMMIT');
      } finally {
        await client.query('ROLLBACK');
        client.release();
      }
    });
  });

  it('revalidates current chat authority through the held transaction under saturation', async () => {
    const started = await startCollabChatSession({ actor: managerActor, projectId, title: 'Revoked delivery', idempotencyKey: crypto.randomUUID() });
    const queued = await enqueueClaimCommand({ orgId, claimId: started.claim.id, kind: 'prompt', payload: { text: 'continue' }, idempotencyKey: crypto.randomUUID(), originator: managerActor });
    await withSingleConnection(async () => {
      const client = await getPool().connect();
      try {
        await client.query('BEGIN');
        await client.query('UPDATE collab_principals SET session_version=session_version+1 WHERE id=$1', [managerActor.principalId]);
        expect(await leaseClaimCommands({ orgId, claimId: started.claim.id, limit: 10 }, client)).toEqual([]);
        expect((await client.query('SELECT status,result FROM agent_claim_commands WHERE id=$1', [queued.command.id])).rows)
          .toEqual([{ status: 'failed', result: { reason: 'authorization_changed' } }]);
      } finally {
        await client.query('ROLLBACK');
        client.release();
      }
    });
  });

  it('propagates chat authorization database failures and leaves the command pending after rollback', async () => {
    const started = await startCollabChatSession({ actor: managerActor, projectId, title: 'Authorization database failure', idempotencyKey: crypto.randomUUID() });
    const queued = await enqueueClaimCommand({ orgId, claimId: started.claim.id, kind: 'prompt', payload: { text: 'continue' }, idempotencyKey: crypto.randomUUID(), originator: managerActor });
    await withSingleConnection(async () => {
      const client = await getPool().connect();
      try {
        await client.query('BEGIN');
        await client.query('ALTER TABLE collab_principals RENAME TO unavailable_principals');
        await expect(leaseClaimCommands({ orgId, claimId: started.claim.id, limit: 10 }, client)).rejects.toMatchObject({ code: '42P01' });
      } finally {
        await client.query('ROLLBACK');
        client.release();
      }
    });
    expect(await rows('SELECT status FROM agent_claim_commands WHERE id=$1', [queued.command.id])).toEqual([{ status: 'pending' }]);
  });

  it('creates and replays a repository-linked New session with only one pool connection', async () => {
    await withSingleConnection(async () => {
      const input = { actor: managerActor, projectId, title: 'Single connection New session', repo, idempotencyKey: crypto.randomUUID() };
      const [first, concurrent] = await Promise.all([
        startCollabChatSession(input),
        startCollabChatSession({ ...input, idempotencyKey: crypto.randomUUID() }),
      ]);
      expect(first.claim).toMatchObject({ repo, claimType: 'chat' });
      expect(concurrent.taskId).not.toBe(first.taskId);
      expect(await startCollabChatSession(input)).toMatchObject({ taskId: first.taskId, created: false });
    });
  });

  it('creates an assigned task inside a saturated caller transaction', async () => {
    await withSingleConnection(async () => {
      const client = await getPool().connect();
      try {
        await client.query('BEGIN');
        const task = await createCollabTask({ actor: managerActor, projectId, title: 'Assigned task', assigneeId: managerActor.principalId }, client);
        expect(task.assigneeId).toBe(managerActor.principalId);
      } finally {
        await client.query('ROLLBACK');
        client.release();
      }
    });
  });

  it.each(['pending', 'cancelled'] as const)('protects sessionless targeted chat %s history from agent deletion', async (status) => {
    const agentId = `target-only-${status}`;
    await getPool().query(`INSERT INTO agents(org_id,id,agent_type,transport) VALUES ($1,$2,'test','long_poll')`, [orgId, agentId]);
    const started = await startCollabChatSession({ actor: managerActor, projectId, title: `Target ${status}`, targetAgentId: agentId, idempotencyKey: crypto.randomUUID() });
    if (status === 'cancelled') await submitCollabClaimCommand({ actor: managerActor, claimId: started.claim.id, kind: 'end_session', payload: {}, idempotencyKey: crypto.randomUUID() });
    await expect(deleteAgentIfNoCollaborationClaims(orgId, agentId)).resolves.toBe('protected');
    expect(await rows('SELECT status,session_id,target_agent_id FROM agent_claims WHERE id=$1', [started.claim.id]))
      .toEqual([{ status, session_id: null, target_agent_id: agentId }]);
    expect(await rows('SELECT claim_id FROM collab_claim_executions WHERE claim_id=$1', [started.claim.id])).toHaveLength(1);
    expect(await rows('SELECT id FROM agents WHERE org_id=$1 AND id=$2', [orgId, agentId])).toHaveLength(1);
  });

  it('returns protected when a concurrent target reference commits before deletion obtains its agent lock', async () => {
    const agentId = 'target-concurrent-insert';
    await getPool().query(`INSERT INTO agents(org_id,id,agent_type,transport) VALUES ($1,$2,'test','long_poll')`, [orgId, agentId]);
    const task = await createCollabTask({ actor: managerActor, projectId, title: 'Concurrent target' });
    const client = await getPool().connect();
    let deletion: Promise<string> | undefined;
    try {
      await client.query('BEGIN');
      const claim = await insertPendingClaim({ orgId, taskId: task.id, repo: null, prNumber: null, claimType: 'chat', targetAgentId: agentId, payload: {} }, client);
      deletion = deleteAgentIfNoCollaborationClaims(orgId, agentId);
      await expect.poll(async () => (await rows<{ waiting: boolean }>(`SELECT EXISTS (
        SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock'
          AND query LIKE 'SELECT id FROM agents WHERE org_id%'
      ) AS waiting`))[0].waiting).toBe(true);
      await client.query('COMMIT');
      await expect(deletion).resolves.toBe('protected');
      expect(await rows('SELECT id FROM agent_claims WHERE id=$1', [claim!.id])).toHaveLength(1);
    } finally {
      await client.query('ROLLBACK');
      client.release();
      if (deletion) await Promise.allSettled([deletion]);
    }
  });

  it('atomically creates a minimal Backlog task and chat with project-scoped retry identity', async () => {
    const input = { actor: managerActor, projectId, title: 'New chat first', idempotencyKey: crypto.randomUUID() };
    const [first, replay] = await Promise.all([startCollabChatSession(input), startCollabChatSession(input)]);
    expect(first.taskId).toBe(replay.taskId);
    expect(first.claim.id).toBe(replay.claim.id);
    expect([first.created, replay.created].sort()).toEqual([false, true]);
    expect(await rows('SELECT title,status,version FROM collab_tasks WHERE id=$1', [first.taskId]))
      .toEqual([{ title: input.title, status: 'backlog', version: 1 }]);
    await expect(startCollabChatSession({ ...input, title: 'Different intent' })).rejects.toMatchObject({ code: 'idempotency_conflict' });
    const count = (await rows<{ count: string }>('SELECT count(*) FROM collab_tasks WHERE project_id=$1', [projectId]))[0].count;
    await expect(startCollabChatSession({ ...input, idempotencyKey: crypto.randomUUID(), targetAgentId: 'missing-agent' })).rejects.toMatchObject({ status: 404 });
    expect((await rows<{ count: string }>('SELECT count(*) FROM collab_tasks WHERE project_id=$1', [projectId]))[0].count).toBe(count);
  });

  it('enforces chat identity and task-local uniqueness below the service boundary', async () => {
    const a = await createCollabTask({ actor: managerActor, projectId, title: 'Chat identity A' });
    const b = await createCollabTask({ actor: managerActor, projectId, title: 'Chat identity B' });
    const input = { orgId, repo, prNumber: null, claimType: 'chat', payload: {} };
    const [one, two] = await Promise.all([insertPendingClaim({ ...input, taskId: a.id }), insertPendingClaim({ ...input, taskId: b.id })]);
    expect([one?.attempt, two?.attempt]).toEqual([1, 1]);
    expect(await insertPendingClaim({ ...input, taskId: a.id })).toBeNull();
    await expect(insertPendingClaim({ ...input, taskId: crypto.randomUUID() })).rejects.toThrow();
    await expect(insertPendingClaim({ ...input, taskId: a.id, orgId: 'foreign-claim-org' })).rejects.toThrow();
    await expect(getPool().query(`INSERT INTO agent_claims(org_id,repo,attempt,claim_type,task_id,pending_deadline_at)
      VALUES ($1,NULL,1,NULL,$2,now())`, [orgId,a.id])).rejects.toThrow();
    await expect(getPool().query(`INSERT INTO collab_claim_executions(task_id,project_id,claim_id,root_claim_id,created_by_principal_id)
      VALUES ($1,$2,$3,$3,$4)`, [b.id,projectId,one!.id,managerActor.principalId])).rejects.toThrow();
    await getPool().query("UPDATE agent_claims SET status='cancelled' WHERE id=$1", [one!.id]);
    expect(await insertPendingClaim({ ...input, taskId: a.id })).toMatchObject({ attempt: 2 });
  });

  it('snapshots project routing and timeouts while replay remains attached to its original target', async () => {
    await getPool().query(`INSERT INTO agents(org_id,id,agent_type,transport) VALUES ($1,'chat-default','test','long_poll')`,[orgId]);
    await getPool().query(`UPDATE collab_projects SET default_agent_id='chat-default',chat_pending_ttl_seconds=45,chat_idle_timeout_seconds=60 WHERE id=$1`,[projectId]);
    try {
      const task=await createCollabTask({actor:managerActor,projectId,title:'Default chat routing'});
      const input={actor:managerActor,taskId:task.id,expectedVersion:1,idempotencyKey:crypto.randomUUID(),repo:null,claimType:'chat' as const};
      const created=await startCollabClaimExecution(input);
      expect(await rows(`SELECT target_agent_id,idle_timeout_seconds,round(extract(epoch FROM pending_deadline_at-created_at))::integer AS ttl FROM agent_claims WHERE id=$1`,[created.claim.id]))
        .toEqual([{target_agent_id:'chat-default',idle_timeout_seconds:60,ttl:45}]);
      await getPool().query(`UPDATE collab_projects SET default_agent_id='unavailable-agent' WHERE id=$1`,[projectId]);
      expect((await startCollabClaimExecution(input)).claim.id).toBe(created.claim.id);
      await expect(startCollabClaimExecution({...input,idempotencyKey:crypto.randomUUID(),taskId:taskId})).rejects.toMatchObject({status:404});
    } finally {
      await getPool().query(`UPDATE collab_projects SET default_agent_id=NULL,chat_pending_ttl_seconds=120,chat_idle_timeout_seconds=900 WHERE id=$1`,[projectId]);
    }
  });

  it('gates only new attended creation behind the project rollout mode', async () => {
    const task=await createCollabTask({actor:managerActor,projectId,title:'Attended rollout gate'});
    await getPool().query("UPDATE collab_projects SET execution_mode='connector' WHERE id=$1",[projectId]);
    try {
      await expect(startCollabClaimExecution({actor:managerActor,taskId:task.id,expectedVersion:1,idempotencyKey:crypto.randomUUID(),repo:null,claimType:'chat'}))
        .rejects.toMatchObject({status:409,code:'chat_unavailable'});
      expect((await startCollabClaimExecution(startInput({taskId:task.id,idempotencyKey:crypto.randomUUID(),prNumber:990}))).created).toBe(true);
    } finally {
      await getPool().query("UPDATE collab_projects SET execution_mode='chat' WHERE id=$1",[projectId]);
    }
  });

  it('rejects stale authentication before looking up a task', async () => {
    await expect(startCollabClaimExecution(startInput({
      actor: { ...managerActor, sessionVersion: managerActor.sessionVersion + 1 },
    }))).rejects.toMatchObject({ status: 401, code: 'unauthenticated' });
  });

  it('does not reveal a task to an actor outside its workspace', async () => {
    await expect(startCollabClaimExecution(startInput({ actor: outsiderActor })))
      .rejects.toMatchObject({ status: 404, code: 'not_found' });
  });

  it('requires run.start even when the actor can read and edit the task', async () => {
    await expect(startCollabClaimExecution(startInput({ actor: collaboratorActor })))
      .rejects.toMatchObject({ status: 403, code: 'forbidden' });
  });

  it('returns the current task version for a stale start', async () => {
    await expect(startCollabClaimExecution(startInput({ expectedVersion: 99 })))
      .rejects.toMatchObject({
        status: 409,
        code: 'version_conflict',
        details: { currentVersion: 1 },
      });
  });

  it('rejects a repository owned by another legacy organization', async () => {
    await getPool().query(`INSERT INTO orgs (id, name) VALUES ('foreign-claim-org', 'Foreign Claim Org')`);
    await getPool().query(
      `INSERT INTO repos (id, org_id, repo_full_name, provider)
       VALUES ($1, 'foreign-claim-org', 'foreign/private-repo', 'github')`,
      [crypto.randomUUID()],
    );

    await expect(startCollabClaimExecution(startInput({
      repo: 'foreign/private-repo',
      idempotencyKey: 'foreign-repo-key',
    }))).rejects.toMatchObject({ status: 404, code: 'not_found' });
  });

  it('rejects execution when the task workspace has no legacy organization', async () => {
    await getPool().query(
      `UPDATE collab_workspaces SET org_id = NULL WHERE id = $1`,
      [workspaceId],
    );
    try {
      await expect(startCollabClaimExecution(startInput({
        idempotencyKey: 'missing-legacy-org-key',
      }))).rejects.toMatchObject({ status: 404, code: 'not_found' });
    } finally {
      await getPool().query(
        `UPDATE collab_workspaces SET org_id = $2 WHERE id = $1`,
        [workspaceId, orgId],
      );
    }
  });

  it('starts without a project host mapping and returns an exact replay', async () => {
    const mappings = await rows(
      `SELECT id FROM collab_project_host_mappings WHERE project_id = $1`,
      [projectId],
    );
    expect(mappings).toEqual([]);

    const input = startInput({ idempotencyKey: 'no-host-mapping-replay-key' });
    const first = await startCollabClaimExecution(input);
    const replay = await startCollabClaimExecution(input);

    expect(first.created).toBe(true);
    expect(replay.created).toBe(false);
    expect(replay.claim.id).toBe(first.claim.id);
    expect(first.claim).toMatchObject({
      taskId,
      rootClaimId: first.claim.id,
      repo,
      prNumber: 42,
      attempt: 1,
      claimType: 'spec',
      status: 'pending',
    });

    const record = await rows<{ resource_id: string | null; claim_id: number | null }>(
      `SELECT resource_id, claim_id
       FROM collab_idempotency_records
       WHERE principal_id = $1
         AND scope_key = $2
         AND idempotency_key = $3`,
      [managerActor.principalId, `claim-exec:${taskId}`, 'no-host-mapping-replay-key'],
    );
    expect(record).toEqual([{ resource_id: null, claim_id: first.claim.id }]);
  });

  it('rejects a reused key when any canonical request field changes', async () => {
    const input = startInput({ idempotencyKey: 'canonical-conflict-key' });
    await startCollabClaimExecution(input);

    await expect(startCollabClaimExecution({
      ...input,
      branch: 'feature/different-branch',
    })).rejects.toMatchObject({ status: 409, code: 'idempotency_conflict' });
  });

  it('allocates distinct contiguous attempts across concurrent and repeated starts', async () => {
    const concurrentTask = await createCollabTask({
      actor: managerActor,
      projectId,
      title: 'Concurrent claims',
    });
    const concurrent = await Promise.all(
      Array.from({ length: 6 }, (_, index) => startCollabClaimExecution(startInput({
        taskId: concurrentTask.id,
        idempotencyKey: `concurrent-claim-${index}`,
        prNumber: 902,
      }))),
    );
    const repeated = [];
    for (let index = 0; index < 3; index += 1) {
      repeated.push(await startCollabClaimExecution(startInput({
        taskId: concurrentTask.id,
        idempotencyKey: `repeated-claim-${index}`,
        prNumber: 902,
      })));
    }

    expect([...concurrent, ...repeated].map((result) => result.claim.attempt).sort((a, b) => a - b))
      .toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it('preserves explicit-attempt conflict semantics in the shared allocator', async () => {
    const input = {
      orgId,
      repo,
      prNumber: 903,
      attempt: 4,
      claimType: 'build',
      payload: { fixture: 'explicit-conflict' },
    };
    const first = await insertPendingClaim(input);
    const conflict = await insertPendingClaim(input);

    expect(first).toMatchObject({ attempt: 4, status: 'pending' });
    expect(conflict).toBeNull();
  });

  it.each([
    ['a PR', 904],
    ['no PR', null],
  ])('allocates a per-type sequence for %s', async (_label, prNumber) => {
    await insertPendingClaim({
      orgId,
      repo,
      prNumber,
      attempt: 8,
      claimType: 'spec',
      payload: { fixture: 'other-type' },
    });
    const first = await insertPendingClaim({
      orgId,
      repo,
      prNumber,
      claimType: 'build',
      payload: { fixture: 'allocated-first' },
    });
    const second = await insertPendingClaim({
      orgId,
      repo,
      prNumber,
      claimType: 'build',
      payload: { fixture: 'allocated-second' },
    });

    expect([first?.attempt, second?.attempt]).toEqual([1, 2]);
  });

  it('serializes concurrent allocation for the same null-PR key', async () => {
    const created = await Promise.all(
      Array.from({ length: 8 }, (_, index) => insertPendingClaim({
        orgId,
        repo,
        prNumber: null,
        claimType: 'review_fix',
        payload: { index },
      })),
    );
    expect(created.map((claim) => claim?.attempt).sort((a, b) => Number(a) - Number(b)))
      .toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('uses the shared per-key allocator from the dashboard claim creator', async () => {
    await insertPendingClaim({
      orgId,
      repo,
      prNumber: 905,
      attempt: 7,
      claimType: 'spec',
      payload: { fixture: 'dashboard-other-type' },
    });

    const dashboard = await createDashboardClaim({
      repoId,
      claimType: 'build',
      description: 'Create from dashboard',
      prNumber: 905,
    });
    const stored = await rows<{ attempt: number }>(
      `SELECT attempt FROM agent_claims
       WHERE id = $1`,
      [dashboard!.id],
    );
    expect(stored).toEqual([{ attempt: 1 }]);
  });

  it('rolls back the claim and idempotency record when execution linking fails', async () => {
    const rollbackTask = await createCollabTask({
      actor: managerActor,
      projectId,
      title: 'Atomic claim link',
    });
    await getPool().query(
      `CREATE FUNCTION fail_claim_execution_link() RETURNS trigger
       LANGUAGE plpgsql AS $$
       BEGIN
         RAISE EXCEPTION 'injected claim execution link failure';
       END;
       $$`,
    );
    await getPool().query(
      `CREATE TRIGGER fail_claim_execution_link
       BEFORE INSERT ON collab_claim_executions
       FOR EACH ROW EXECUTE FUNCTION fail_claim_execution_link()`,
    );
    try {
      await expect(startCollabClaimExecution(startInput({
        taskId: rollbackTask.id,
        prNumber: 906,
        idempotencyKey: 'atomic-link-rollback-key',
      }))).rejects.toThrow();
    } finally {
      await getPool().query(`DROP TRIGGER fail_claim_execution_link ON collab_claim_executions`);
      await getPool().query(`DROP FUNCTION fail_claim_execution_link()`);
    }

    const claims = await rows(
      `SELECT id FROM agent_claims
       WHERE org_id = $1 AND repo = $2 AND pr_number = 906`,
      [orgId, repo],
    );
    const records = await rows(
      `SELECT idempotency_key FROM collab_idempotency_records
       WHERE principal_id = $1 AND idempotency_key = 'atomic-link-rollback-key'`,
      [managerActor.principalId],
    );
    expect(claims).toEqual([]);
    expect(records).toEqual([]);
  });

  it('paginates by creation identity without duplicates or omissions', async () => {
    const paginationTask = await createCollabTask({
      actor: managerActor,
      projectId,
      title: 'Claim pagination',
    });
    const created = [];
    for (let index = 0; index < 5; index += 1) {
      created.push(await startCollabClaimExecution(startInput({
        taskId: paginationTask.id,
        prNumber: 907,
        idempotencyKey: `pagination-claim-${index}`,
      })));
    }

    const first = await listCollabClaimExecutions({ actor: managerActor, taskId: paginationTask.id, limit: 2 });
    const second = await listCollabClaimExecutions({
      actor: managerActor,
      taskId: paginationTask.id,
      limit: 2,
      cursor: first.nextCursor!,
    });
    const third = await listCollabClaimExecutions({
      actor: managerActor,
      taskId: paginationTask.id,
      limit: 2,
      cursor: second.nextCursor!,
    });

    expect(first.nextCursor).toEqual(expect.any(String));
    expect(second.nextCursor).toEqual(expect.any(String));
    expect(third.nextCursor).toBeNull();
    expect([...first.claims, ...second.claims, ...third.claims].map((claim) => claim.id))
      .toEqual(created.map((result) => result.claim.id));
  });

  it('uses current capabilities for safe badges and full detail', async () => {
    const projectionTask = await createCollabTask({
      actor: managerActor,
      projectId,
      title: 'Claim projections',
    });
    const started = await startCollabClaimExecution(startInput({
      taskId: projectionTask.id,
      prNumber: 908,
      idempotencyKey: 'projection-claim-key',
      instructions: 'Private execution instructions',
    }));

    const safeList = await listCollabClaimExecutions({ actor: collaboratorActor, taskId: projectionTask.id });
    const safeDetail = await getCollabClaimExecution({ actor: collaboratorActor, claimId: started.claim.id });
    const fullDetail = await getCollabClaimExecution({ actor: managerActor, claimId: started.claim.id });

    expect(safeList.claims).toEqual([
      expect.objectContaining({
        id: started.claim.id,
        taskId: projectionTask.id,
        claimType: 'spec',
        attempt: 1,
        status: 'pending',
        rootClaimId: started.claim.id,
      }),
    ]);
    for (const value of [safeList.claims[0], safeDetail]) {
      expect(value).not.toHaveProperty('payload');
      expect(value).not.toHaveProperty('sessionId');
      expect(value).not.toHaveProperty('headSha');
      expect(value).not.toHaveProperty('repo');
      expect(JSON.stringify(value)).not.toContain('Private execution instructions');
    }
    expect(fullDetail).toMatchObject({
      id: started.claim.id,
      repo,
      prNumber: 908,
      sessionId: null,
      payload: expect.objectContaining({ instructions: 'Private execution instructions' }),
    });
  });

  it('isolates task lists and omits claims without an execution link', async () => {
    const firstTask = await createCollabTask({ actor: managerActor, projectId, title: 'First isolated task' });
    const secondTask = await createCollabTask({ actor: managerActor, projectId, title: 'Second isolated task' });
    const first = await startCollabClaimExecution(startInput({
      taskId: firstTask.id,
      prNumber: 909,
      idempotencyKey: 'isolated-first-key',
    }));
    const second = await startCollabClaimExecution(startInput({
      taskId: secondTask.id,
      prNumber: 910,
      idempotencyKey: 'isolated-second-key',
    }));
    const unlinked = await insertPendingClaim({
      orgId,
      repo,
      prNumber: 911,
      claimType: 'spec',
      payload: { fixture: 'unlinked' },
    });

    const firstList = await listCollabClaimExecutions({ actor: managerActor, taskId: firstTask.id });
    const secondList = await listCollabClaimExecutions({ actor: managerActor, taskId: secondTask.id });

    expect(firstList.claims.map((claim) => claim.id)).toEqual([first.claim.id]);
    expect(secondList.claims.map((claim) => claim.id)).toEqual([second.claim.id]);
    expect([...firstList.claims, ...secondList.claims].map((claim) => claim.id))
      .not.toContain(unlinked!.id);
    await expect(getCollabClaimExecution({ actor: collaboratorActor, claimId: unlinked!.id }))
      .rejects.toMatchObject({ status: 404, code: 'not_found' });
  });

  it('keeps collaboration-linked claims out of legacy pipeline reads and dismissals', async () => {
    const isolatedTask = await createCollabTask({ actor: managerActor, projectId, title: 'Legacy boundary task' });
    const started = await startCollabClaimExecution(startInput({
      taskId: isolatedTask.id,
      prNumber: 912,
      idempotencyKey: 'legacy-boundary-key',
    }));

    await expect(getPipelineDetail([orgId], repo, 912, 'all')).resolves.toEqual([]);
    const pipelines = await listPipelines([orgId], 'all');
    expect(pipelines.map((pipeline) => pipeline.pr_number)).not.toContain(912);
    await expect(dismissClaim(started.claim.id, [orgId])).resolves.toBe(false);
    const stored = await rows<{ status: string }>('SELECT status FROM agent_claims WHERE id = $1', [started.claim.id]);
    expect(stored).toEqual([{ status: 'pending' }]);
  });

  it('preserves an agent whose session owns collaboration execution history', async () => {
    const isolatedTask = await createCollabTask({ actor: managerActor, projectId, title: 'Agent deletion boundary task' });
    const started = await startCollabClaimExecution(startInput({
      taskId: isolatedTask.id,
      prNumber: 913,
      idempotencyKey: 'agent-deletion-boundary-key',
    }));
    await getPool().query(
      `INSERT INTO agents (id, org_id, agent_type, transport)
       VALUES ('collab-history-runner', $1, 'claude-code', 'long_poll')`,
      [orgId],
    );
    const session = await getPool().query<{ id: number }>(
      `INSERT INTO agent_sessions (org_id, agent_id, status, expires_at)
       VALUES ($1, 'collab-history-runner', 'busy', NOW() + INTERVAL '1 hour')
       RETURNING id`,
      [orgId],
    );
    await getPool().query(
      `UPDATE agent_claims SET session_id = $2 WHERE id = $1`,
      [started.claim.id, session.rows[0].id],
    );

    await expect(deleteAgentIfNoCollaborationClaims(orgId, 'collab-history-runner')).resolves.toBe('protected');
    const agents = await rows<{ id: string }>(
      `SELECT id FROM agents WHERE org_id = $1 AND id = 'collab-history-runner'`,
      [orgId],
    );
    const links = await rows<{ claim_id: number }>(
      `SELECT claim_id FROM collab_claim_executions WHERE claim_id = $1`,
      [started.claim.id],
    );
    expect(agents).toEqual([{ id: 'collab-history-runner' }]);
    expect(links).toEqual([{ claim_id: started.claim.id }]);
  });
  it('configures only project-scoped advertised agent profiles, versions writes, and delivers validated defaults', async () => {
    const {getProjectChatSettings, updateProjectChatSettings} = await import('../../src/collaboration/chat-settings.js');
    await rows(`INSERT INTO agents(org_id,id,agent_type,transport) VALUES ($1,'catalog-agent','test','long_poll')`,[orgId]);
    await rows(`INSERT INTO agent_sessions(org_id,agent_id,status,last_seen_at,expires_at,session_meta) VALUES ($1,'catalog-agent','online',NOW(),NOW()+interval '5 minutes',$2)`,[orgId,JSON.stringify({capacity:2,supported_claim_types:['chat'],profiles:[{id:'design',models:['small','large'],default_model:'small'}]})]);
    const project=await createCollabProject({actor:managerActor,workspaceId,name:'Configured chat'});
    const initial=await getProjectChatSettings({actor:managerActor,projectId:project.id});
    expect(initial.agents.find(a=>a.id==='catalog-agent')?.profiles).toEqual([{id:'design',models:['small','large'],default_model:'small'}]);
    const input={actor:managerActor,projectId:project.id,expectedVersion:initial.version,executionMode:'chat' as const,defaultAgentId:'catalog-agent',defaults:{profileId:'design',model:'large',instructions:'Use the project conventions.'}};
    const saved=await withSingleConnection(()=>updateProjectChatSettings(input));
    expect(saved.version).toBe(initial.version+1);
    await expect(updateProjectChatSettings(input)).rejects.toMatchObject({code:'version_conflict'});
    await expect(updateProjectChatSettings({...input,expectedVersion:saved.version,defaults:{...input.defaults,model:'not-advertised'}})).rejects.toMatchObject({code:'profile_unavailable'});
    await expect(getProjectChatSettings({actor:outsiderActor,projectId:project.id})).rejects.toMatchObject({status:404});
    await expect(getProjectChatSettings({actor:collaboratorActor,projectId:project.id})).rejects.toMatchObject({status:403});
    const started=await startCollabChatSession({actor:managerActor,projectId:project.id,title:'Use saved defaults',idempotencyKey:crypto.randomUUID()});
    expect('payload' in started.claim && started.claim.payload).toMatchObject({profile:'design',model:'large',instructions:'Use the project conventions.'});
    const persisted=await rows<{target_agent_id:string}>(`SELECT target_agent_id FROM agent_claims WHERE id=$1`,[started.claim.id]);
    expect(persisted[0].target_agent_id).toBe('catalog-agent');
    const {getCollabTask}=await import('../../src/collaboration/tasks.js');
    const {task:taskProjection}=await getCollabTask(managerActor,started.taskId);
    expect(taskProjection.claimActivity).toEqual({claimId:started.claim.id,claimType:'chat',status:'pending',endReason:null,needsInput:false});
    expect(JSON.stringify(taskProjection.claimActivity)).not.toContain('instructions');
    await rows(`UPDATE agent_claims SET status='claimed',session_id=(SELECT id FROM agent_sessions WHERE org_id=$1 AND agent_id='catalog-agent' ORDER BY id DESC LIMIT 1),expires_at=NOW()+interval '5 minutes' WHERE id=$2`,[orgId,started.claim.id]);
    await rows(`INSERT INTO agent_claim_requests(org_id,claim_id,request_key,kind,payload) VALUES($1,$2,'safe-projection-request','permission',$3)`,[orgId,started.claim.id,JSON.stringify({title:'Private tool path and request text'})]);
    const {task:needsInput}=await getCollabTask(managerActor,started.taskId);expect(needsInput.claimActivity?.needsInput).toBe(true);
    expect(JSON.stringify(needsInput.claimActivity)).not.toContain('Private tool path');

    const {getCollabClaimCommand,listCollabClaimPrompts}=await import('../../src/collaboration/claim-executions.js');
    const command=await enqueueClaimCommand({orgId,claimId:started.claim.id,kind:'prompt',payload:{text:'Private draft'},idempotencyKey:crypto.randomUUID()});
    const receipt=await getCollabClaimCommand({actor:managerActor,claimId:started.claim.id,commandId:command.command.id});
    expect(receipt).toEqual({commandId:command.command.id,kind:'prompt',status:'pending'});
    const prompts=await listCollabClaimPrompts({actor:managerActor,claimId:started.claim.id});
    expect(prompts.prompts).toEqual([expect.objectContaining({commandId:command.command.id,text:'Private draft',status:'pending'})]);
    await expect(listCollabClaimPrompts({actor:collaboratorActor,claimId:started.claim.id})).rejects.toMatchObject({status:403});
    await expect(getCollabClaimCommand({actor:collaboratorActor,claimId:started.claim.id,commandId:command.command.id})).rejects.toMatchObject({status:403});

    const reread=await getProjectChatSettings({actor:managerActor,projectId:project.id});expect(reread.defaults).toEqual(input.defaults);
  });

});
