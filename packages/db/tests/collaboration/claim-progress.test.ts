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
} from '../../src/collaboration/index.js';
import { listTaskClaimProgress, markClaimReadCursor } from '../../src/collaboration/claim-progress.js';
import { appendClaimEvents, upsertClaimRequest } from '../../src/queries/claim-interactions.js';
import { insertPendingClaim } from '../../src/queries/claims.js';

process.env.DATABASE_URL = resolveCollabTestDatabaseUrl();
const DATABASE_URL = process.env.DATABASE_URL;

async function rows<T = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> {
  const result = await getPool().query<T>(text, params);
  return result.rows;
}
const dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.resolve(dirname, '../../src/migrations');
const migrationPath = path.join(migrationsDir, '0032_claim_read_cursors.sql');
const journalPath = path.join(migrationsDir, 'meta/_journal.json');

describe('claim progress and per-principal read cursors', () => {
  let managerActor: { principalId: string; sessionVersion: number };
  let viewerActor: { principalId: string; sessionVersion: number };
  let outsiderActor: { principalId: string; sessionVersion: number };
  let projectId: string;
  let workspaceId: string;
  let taskId: string;
  let chatClaimId: number;
  let specClaimId: number;
  let doneClaimId: number;
  const orgId = 'claim-progress-org';
  const repo = 'acme/claim-progress';

  async function makeActor(input: {
    githubId: number;
    login: string;
    workspaceRole?: string;
  }) {
    const userId = await seedUser(DATABASE_URL, { githubId: input.githubId, login: input.login });
    await seedOrgMembership(DATABASE_URL, userId, orgId, 'member');
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

  async function seedClaim(input: {
    claimType: string;
    status?: string;
    payload?: Record<string, unknown>;
    prNumber?: number | null;
  }): Promise<number> {
    const chat = input.claimType === 'chat';
    const claim = await insertPendingClaim({
      orgId,
      repo: chat ? null : repo,
      prNumber: chat ? null : input.prNumber ?? 7,
      claimType: input.claimType,
      payload: input.payload ?? { source: 'collab' },
      ...(chat ? { taskId } : {}),
      attempt: 1,
    });
    if (!claim) throw new Error(`claim seed failed for ${input.claimType}`);
    await getPool().query(
      `INSERT INTO collab_claim_executions (task_id, project_id, claim_id, root_claim_id, created_by_principal_id)
       VALUES ($1, $2, $3, $3, $4)`,
      [taskId, projectId, claim.id, managerActor.principalId],
    );
    if (input.status && input.status !== 'pending') {
      await getPool().query(
        `UPDATE agent_claims SET status = $2, completed_at = now() WHERE id = $1`,
        [claim.id, input.status],
      );
    }
    return claim.id;
  }

  beforeAll(async () => {
    process.env.FF_COLLAB_AUTH_SECRET = 'claim-progress-test-secret-0123456789abcdef0123456789abcdef';
    await resetCollabSchema(DATABASE_URL);
    await runMigrations();

    const managerUserId = await seedUser(DATABASE_URL, { githubId: 9701, login: 'claim-progress-manager' });
    await seedOrgMembership(DATABASE_URL, managerUserId, orgId, 'admin');
    const manager = await ensureGithubPrincipal({
      userId: managerUserId,
      displayName: 'Claim Progress Manager',
      email: 'claim-progress-manager@example.test',
    });
    managerActor = { principalId: manager.id, sessionVersion: manager.sessionVersion };

    const workspace = await bootstrapCollaborationWorkspace({
      actor: managerActor,
      orgId,
      name: 'Claim Progress Workspace',
      idempotencyKey: 'claim-progress-workspace',
    });
    workspaceId = workspace.id;
    const project = await createCollabProject({ actor: managerActor, workspaceId, name: 'Claim Progress Project' });
    projectId = project.id;
    const task = await createCollabTask({ actor: managerActor, projectId, title: 'Claim progress task' });
    taskId = task.id;

    viewerActor = await makeActor({ githubId: 9702, login: 'claim-progress-viewer', workspaceRole: 'viewer' });

    const outsiderUserId = await seedUser(DATABASE_URL, { githubId: 9703, login: 'claim-progress-outsider' });
    const outsider = await ensureGithubPrincipal({
      userId: outsiderUserId,
      displayName: 'Claim Progress Outsider',
      email: 'claim-progress-outsider@example.test',
    });
    outsiderActor = { principalId: outsider.id, sessionVersion: outsider.sessionVersion };

    await getPool().query(
      `INSERT INTO repos (id, org_id, repo_full_name, provider)
       VALUES ($1, $2, $3, 'github')`,
      [crypto.randomUUID(), orgId, repo],
    );

    chatClaimId = await seedClaim({ claimType: 'chat', payload: { source: 'collab', profile: 'design', model: 'large', instructions: '' } });
    specClaimId = await seedClaim({ claimType: 'spec', prNumber: 11, payload: { source: 'collab' } });
    doneClaimId = await seedClaim({ claimType: 'build', prNumber: 12, payload: { source: 'collab' }, status: 'completed' });

    await appendClaimEvents({
      orgId,
      claimId: chatClaimId,
      events: [
        { seq: 1, kind: 'agent_message', payload: { content: [{ type: 'text', text: 'hello' }] } },
        { seq: 2, kind: 'agent_message', payload: { content: [{ type: 'text', text: 'working' }] } },
      ],
    });
    await upsertClaimRequest({ orgId, claimId: chatClaimId, requestKey: 'req-1', kind: 'permission', payload: { title: 'Allow edit' } });
    await appendClaimEvents({
      orgId,
      claimId: specClaimId,
      events: [
        { seq: 1, kind: 'session_message', payload: { content: [{ type: 'text', text: 'started' }] } },
        { seq: 2, kind: 'agent_message', payload: { content: [{ type: 'text', text: 'spec drafted' }] } },
        { seq: 3, kind: 'agent_message', payload: { content: [{ type: 'text', text: 'spec done' }] } },
      ],
    });
    await appendClaimEvents({
      orgId,
      claimId: doneClaimId,
      events: [{ seq: 1, kind: 'terminal', payload: { output: 'done' } }],
    });
  });

  afterAll(async () => {
    delete process.env.FF_COLLAB_AUTH_SECRET;
    await closePool();
  });

  it('adds the read cursor migration directly after the handoff migration', async () => {
    await expect(fs.access(migrationPath)).resolves.toBeUndefined();
    const journal = JSON.parse(await fs.readFile(journalPath, 'utf8')) as {
      entries: Array<{ idx: number; tag: string }>;
    };
    const previous = journal.entries.find((entry) => entry.tag === '0031_chat_handoff');
    const current = journal.entries.find((entry) => entry.tag === '0032_claim_read_cursors');

    expect(previous).toBeDefined();
    expect(current).toEqual(expect.objectContaining({
      idx: previous!.idx + 1,
      tag: '0032_claim_read_cursors',
    }));
    const table = await rows<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'collab_claim_read_cursors' ORDER BY ordinal_position`,
    );
    expect(table.map((c) => c.column_name)).toEqual(['org_id', 'claim_id', 'principal_id', 'last_seq', 'updated_at']);
  });

  it('reports live claims without capping and marks the truncation flag for terminal history', async () => {
    const progress = await listTaskClaimProgress({ actor: managerActor, taskId });
    const live = progress.claims.filter((c) => ['pending', 'claimed'].includes(c.status));
    expect(live.map((c) => c.claimId).sort()).toEqual([chatClaimId, specClaimId].sort());
    expect(progress.terminalTruncated).toBe(false);

    for (let index = 0; index < 51; index += 1) {
      const claim = await insertPendingClaim({
        orgId,
        repo,
        prNumber: 1000 + index,
        claimType: 'build',
        payload: { source: 'collab' },
        attempt: 1,
      });
      if (!claim) throw new Error(`bulk claim ${index} failed`);
      await getPool().query(
        `INSERT INTO collab_claim_executions (task_id, project_id, claim_id, root_claim_id, created_by_principal_id)
         VALUES ($1, $2, $3, $3, $4)`,
        [taskId, projectId, claim.id, managerActor.principalId],
      );
      await getPool().query(
        `UPDATE agent_claims SET status = 'completed', completed_at = now() WHERE id = $1`,
        [claim.id],
      );
    }

    const truncated = await listTaskClaimProgress({ actor: managerActor, taskId });
    const liveAfter = truncated.claims.filter((c) => ['pending', 'claimed'].includes(c.status));
    expect(liveAfter.map((c) => c.claimId).sort()).toEqual([chatClaimId, specClaimId].sort());
    const terminal = truncated.claims.filter((c) => !['pending', 'claimed'].includes(c.status));
    expect(terminal).toHaveLength(50);
    expect(truncated.terminalTruncated).toBe(true);
    expect(terminal.every((c) => !['pending', 'claimed'].includes(c.status))).toBe(true);
    expect(new Set(terminal.map((c) => c.claimId)).size).toBe(50);
    const allIds = truncated.claims.map((c) => c.claimId);
    expect(new Set(allIds).size).toBe(allIds.length);
    const firstTerminalIndex = truncated.claims.findIndex((c) => !['pending', 'claimed'].includes(c.status));
    expect(truncated.claims.slice(0, firstTerminalIndex).every((c) => ['pending', 'claimed'].includes(c.status))).toBe(true);
  });

  it('returns exactly one entry per claim across a live-to-terminal transition', async () => {
    const transitionTask = await createCollabTask({ actor: managerActor, projectId, title: 'Claim progress transition' });
    const liveChat = await insertPendingClaim({
      orgId,
      repo: null,
      prNumber: null,
      claimType: 'chat',
      payload: { source: 'collab' },
      taskId: transitionTask.id,
      attempt: 1,
    });
    if (!liveChat) throw new Error('transition chat seed failed');
    await getPool().query(
      `INSERT INTO collab_claim_executions (task_id, project_id, claim_id, root_claim_id, created_by_principal_id)
       VALUES ($1, $2, $3, $3, $4)`,
      [transitionTask.id, projectId, liveChat.id, managerActor.principalId],
    );
    const before = await listTaskClaimProgress({ actor: managerActor, taskId: transitionTask.id });
    expect(before.claims.map((c) => c.claimId)).toEqual([liveChat.id]);
    expect(before.claims[0].status).toBe('pending');

    await getPool().query(
      `UPDATE agent_claims SET status = 'completed', completed_at = now() WHERE id = $1`,
      [liveChat.id],
    );
    const after = await listTaskClaimProgress({ actor: managerActor, taskId: transitionTask.id });
    expect(after.claims.map((c) => c.claimId)).toEqual([liveChat.id]);
    expect(after.claims[0].status).toBe('completed');
    const ids = after.claims.map((c) => c.claimId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('computes unread per principal and needs-input across all live claims', async () => {
    const managerView = await listTaskClaimProgress({ actor: managerActor, taskId });
    const managerChat = managerView.claims.find((c) => c.claimId === chatClaimId)!;
    const managerSpec = managerView.claims.find((c) => c.claimId === specClaimId)!;
    expect(managerChat.unread).toBe(true);
    expect(managerSpec.unread).toBe(true);
    expect(managerChat.needsInput).toBe(true);
    expect(managerSpec.needsInput).toBe(false);
    expect(managerChat.readSeq).toBe(0);
    expect(managerChat.lastSeq).toBe(2);

    const viewerView = await listTaskClaimProgress({ actor: viewerActor, taskId });
    const viewerChat = viewerView.claims.find((c) => c.claimId === chatClaimId)!;
    expect(viewerChat.unread).toBe(false);
    expect(viewerChat.readSeq).toBeNull();
    expect(viewerChat.lastSeq).toBeNull();
    expect(viewerChat.needsInput).toBe(true);
  });

  it('advancing one principal cursor clears only that principal unread', async () => {
    const marked = await markClaimReadCursor({ actor: managerActor, claimId: chatClaimId, seq: 2 });
    expect(marked).toEqual({ claimId: chatClaimId, lastSeq: 2 });

    const managerView = await listTaskClaimProgress({ actor: managerActor, taskId });
    expect(managerView.claims.find((c) => c.claimId === chatClaimId)!.unread).toBe(false);
    expect(managerView.claims.find((c) => c.claimId === specClaimId)!.unread).toBe(true);

    const viewerView = await listTaskClaimProgress({ actor: viewerActor, taskId });
    expect(viewerView.claims.find((c) => c.claimId === chatClaimId)!.unread).toBe(false);
    expect(viewerView.claims.find((c) => c.claimId === chatClaimId)!.lastSeq).toBeNull();
  });

  it('keeps concurrent marks monotonic and rejects regressions', async () => {
    const claimId = specClaimId;
    const [low, high] = await Promise.all([
      markClaimReadCursor({ actor: managerActor, claimId, seq: 1 }),
      markClaimReadCursor({ actor: managerActor, claimId, seq: 3 }),
    ]);
    expect(high.lastSeq).toBe(3);
    expect([low.lastSeq, high.lastSeq]).toContain(3);

    const regressed = await markClaimReadCursor({ actor: managerActor, claimId, seq: 2 });
    expect(regressed.lastSeq).toBe(3);
    const older = await markClaimReadCursor({ actor: managerActor, claimId, seq: 1 });
    expect(older.lastSeq).toBe(3);
  });

  it('rejects future and foreign seq values in the same authorized claim', async () => {
    await expect(markClaimReadCursor({ actor: managerActor, claimId: chatClaimId, seq: 3 }))
      .rejects.toMatchObject({ code: 'invalid_read_seq', status: 422 });
    await expect(markClaimReadCursor({ actor: managerActor, claimId: chatClaimId, seq: 999999 }))
      .rejects.toMatchObject({ code: 'invalid_read_seq', status: 422 });
    await expect(markClaimReadCursor({ actor: managerActor, claimId: doneClaimId, seq: 2 }))
      .rejects.toMatchObject({ code: 'invalid_read_seq', status: 422 });
    await expect(markClaimReadCursor({ actor: managerActor, claimId: chatClaimId, seq: 0 }))
      .resolves.toEqual({ claimId: chatClaimId, lastSeq: 0 });
  });

  it('requires internal.read for the cursor and hides profile fields from task.read readers', async () => {
    await expect(markClaimReadCursor({ actor: viewerActor, claimId: chatClaimId, seq: 1 }))
      .rejects.toMatchObject({ status: 403, code: 'forbidden' });
    await expect(markClaimReadCursor({ actor: outsiderActor, claimId: chatClaimId, seq: 1 }))
      .rejects.toMatchObject({ status: 404, code: 'not_found' });
    await expect(markClaimReadCursor({ actor: managerActor, claimId: 999999999, seq: 1 }))
      .rejects.toMatchObject({ code: 'not_found', status: 404 });

    const viewerView = await listTaskClaimProgress({ actor: viewerActor, taskId });
    const viewerChat = viewerView.claims.find((c) => c.claimId === chatClaimId)!;
    expect(viewerChat.profile).toBeNull();
    expect(viewerChat.model).toBeNull();
    expect(viewerChat.targetAgentId).toBeNull();
    expect(viewerChat.lastSeq).toBeNull();
    expect(viewerChat.readSeq).toBeNull();
    expect(viewerChat.unread).toBe(false);
    expect(viewerChat.needsInput).toBe(true);
    expect(Object.keys(viewerChat).sort()).toEqual([
      'attempt', 'claimId', 'claimType', 'completedAt', 'createdAt', 'endReason', 'lastSeq',
      'model', 'needsInput', 'profile', 'readSeq', 'status', 'targetAgentId', 'unread',
    ].sort());
    expect(JSON.stringify(viewerChat)).not.toContain('hello');
    expect(JSON.stringify(viewerChat)).not.toContain('working');

    const managerView = await listTaskClaimProgress({ actor: managerActor, taskId });
    const managerChat = managerView.claims.find((c) => c.claimId === chatClaimId)!;
    expect(managerChat.profile).toBe('design');
    expect(managerChat.model).toBe('large');
  });

  it('stops returning task progress after membership revocation', async () => {
    const membership = await rows<{ workspace_id: string; principal_id: string }>(
      `SELECT m.workspace_id, m.principal_id FROM collab_memberships m
       JOIN collab_principals p ON p.id = m.principal_id
       JOIN collab_roles r ON r.id = m.role_id
       WHERE p.user_id = (SELECT id FROM users WHERE github_id = 9702) AND r.name = 'viewer'`,
    );
    expect(membership).toHaveLength(1);
    await getPool().query(
      `DELETE FROM collab_memberships WHERE workspace_id = $1 AND principal_id = $2`,
      [membership[0].workspace_id, membership[0].principal_id],
    );
    await expect(listTaskClaimProgress({ actor: viewerActor, taskId })).rejects.toMatchObject({ status: 404, code: 'not_found' });
    await expect(markClaimReadCursor({ actor: viewerActor, claimId: chatClaimId, seq: 1 }))
      .rejects.toMatchObject({ status: 404, code: 'not_found' });
    const managerView = await listTaskClaimProgress({ actor: managerActor, taskId });
    expect(managerView.claims.find((c) => c.claimId === chatClaimId)).toBeDefined();
  });
});
