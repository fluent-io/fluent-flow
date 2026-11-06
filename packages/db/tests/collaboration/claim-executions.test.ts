import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  resetCollabSchema,
  resolveCollabTestDatabaseUrl,
  seedLegacyOrgMembership,
  seedLegacyUser,
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
  startCollabClaimExecution,
} from '../../src/collaboration/index.js';
import { insertPendingClaim } from '../../src/queries/claims.js';
import { createClaim as createDashboardClaim } from '../../src/queries/repos.js';

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
    const userId = await seedLegacyUser(DATABASE_URL, {
      githubId: input.githubId,
      login: input.login,
    });
    await seedLegacyOrgMembership(DATABASE_URL, userId, orgId, input.role ?? 'member');
    const principal = await ensureGithubPrincipal({
      legacyUserId: userId,
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

    const managerUserId = await seedLegacyUser(DATABASE_URL, {
      githubId: 9801,
      login: 'claim-exec-manager',
    });
    await seedLegacyOrgMembership(DATABASE_URL, managerUserId, orgId, 'admin');
    const manager = await ensureGithubPrincipal({
      legacyUserId: managerUserId,
      displayName: 'Claim Exec Manager',
      email: 'claim-exec-manager@example.test',
    });
    managerActor = { principalId: manager.id, sessionVersion: manager.sessionVersion };

    const workspace = await bootstrapCollaborationWorkspace({
      actor: managerActor,
      legacyOrgId: orgId,
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

    const outsiderUserId = await seedLegacyUser(DATABASE_URL, {
      githubId: 9803,
      login: 'claim-exec-outsider',
    });
    const outsider = await ensureGithubPrincipal({
      legacyUserId: outsiderUserId,
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
      `UPDATE collab_workspaces SET legacy_org_id = NULL WHERE id = $1`,
      [workspaceId],
    );
    try {
      await expect(startCollabClaimExecution(startInput({
        idempotencyKey: 'missing-legacy-org-key',
      }))).rejects.toMatchObject({ status: 404, code: 'not_found' });
    } finally {
      await getPool().query(
        `UPDATE collab_workspaces SET legacy_org_id = $2 WHERE id = $1`,
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
});
