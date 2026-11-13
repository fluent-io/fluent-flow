import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getAgentDetail, listAgents, updateAgentChatSlots, isValidChatSlotValue } from '../../src/queries/index.js';
import { closePool, getPool } from '../../src/pool.js';
import { runMigrations } from '../../src/migrate.js';
import type { AgentListItem } from '../../src/schemas/agents.js';
import {
  bootstrapCollaborationWorkspace,
  createCollabProject,
  createCollabTask,
  ensureGithubPrincipal,
} from '../../src/collaboration/index.js';
import {
  resetCollabSchema,
  resolveCollabTestDatabaseUrl,
  seedOrgMembership,
  seedUser,
} from '../helpers/collab-db.js';

process.env.DATABASE_URL = resolveCollabTestDatabaseUrl();
const databaseUrl = process.env.DATABASE_URL;
const orgId = 'chat-slots-org';

async function insertAgent(id: string) {
  await getPool().query(
    `INSERT INTO agents (id, org_id, agent_type, transport, transport_meta)
     VALUES ($1, $2, 'codex', 'long_poll', '{"capacity": 4}')`,
    [id, orgId],
  );
}

async function insertLiveSession(orgId_: string, agentId: string, sessionId: number) {
  await getPool().query(
    `INSERT INTO agent_sessions (org_id, agent_id, session_meta, status, last_seen_at, expires_at)
     VALUES ($1, $2, jsonb_build_object('capacity', 4, 'instance_id', 'inst-1', 'slot_id', $3::int), 'online', NOW(), NOW() + interval '10 minutes')`,
    [orgId_, agentId, sessionId],
  );
}

async function insertClaimedClaim(input: {
  orgId: string;
  agentId: string;
  claimType: string;
  repo: string | null;
  prNumber: number | null;
  taskId?: string | null;
}) {
  const session = await getPool().query<{ id: number }>(
    `SELECT id FROM agent_sessions WHERE org_id = $1 AND agent_id = $2 ORDER BY id DESC LIMIT 1`,
    [input.orgId, input.agentId],
  );
  const claim = await getPool().query<{ id: number }>(
    `INSERT INTO agent_claims
       (org_id, repo, pr_number, attempt, session_id, claim_type, status, payload, claimed_at, expires_at, last_activity_at, task_id, pending_deadline_at)
     VALUES ($1, $2, $3, 1, $4, $5, 'claimed', '{}'::jsonb, now(), now() + interval '15 minutes', now(), $6,
       CASE WHEN $5 = 'chat' THEN now() + interval '120 seconds' ELSE NULL END)
     RETURNING id`,
    [input.orgId, input.repo, input.prNumber, session.rows[0].id, input.claimType, input.taskId ?? null],
  );
  await getPool().query(`UPDATE agent_sessions SET status='busy' WHERE id=$1`,[session.rows[0].id]);
  return claim.rows[0].id;
}

describe('agent chat slot administration (real Postgres)', () => {
  let managerActor: { principalId: string; sessionVersion: number };
  let taskOneId: string;
  let taskTwoId: string;

  beforeAll(async () => {
    process.env.FF_COLLAB_AUTH_SECRET = 'chat-slots-test-secret-0123456789abcdef0123456789abcdef';
    await resetCollabSchema(databaseUrl);
    await runMigrations();
    const userId = await seedUser(databaseUrl, { githubId: 9601, login: 'chat-slots-admin' });
    await seedOrgMembership(databaseUrl, userId, orgId, 'admin');
    const principal = await ensureGithubPrincipal({
      userId,
      displayName: 'Chat Slots Admin',
      email: 'chat-slots-admin@example.test',
    });
    managerActor = { principalId: principal.id, sessionVersion: principal.sessionVersion };

    const workspace = await bootstrapCollaborationWorkspace({
      actor: managerActor,
      orgId,
      name: 'Chat Slots Workspace',
      idempotencyKey: 'chat-slots-workspace',
    });
    const project = await createCollabProject({ actor: managerActor, workspaceId: workspace.id, name: 'Chat Slots Project' });
    taskOneId = (await createCollabTask({ actor: managerActor, projectId: project.id, title: 'Chat slots task one' })).id;
    taskTwoId = (await createCollabTask({ actor: managerActor, projectId: project.id, title: 'Chat slots task two' })).id;

    await insertAgent('slots-agent');
    await insertLiveSession(orgId, 'slots-agent', 1);
    await insertClaimedClaim({ orgId, agentId: 'slots-agent', claimType: 'chat', repo: null, prNumber: null, taskId: taskOneId });
    await insertLiveSession(orgId, 'slots-agent', 2);
    await insertClaimedClaim({ orgId, agentId: 'slots-agent', claimType: 'chat', repo: null, prNumber: null, taskId: taskTwoId });
    await insertLiveSession(orgId, 'slots-agent', 3);
    await insertClaimedClaim({ orgId, agentId: 'slots-agent', claimType: 'spec', repo: 'acme/widgets', prNumber: 5 });

    await insertAgent('empty-agent');
  });

  afterAll(async () => {
    delete process.env.FF_COLLAB_AUTH_SECRET;
    await closePool();
  });

  function pick(agents: AgentListItem[], id: string): AgentListItem {
    const found = agents.find((agent) => agent.org_id === orgId && agent.id === id);
    if (!found) throw new Error(`agent ${id} missing`);
    return found;
  }

  it('reports authoritative claimed chat and work counts and the configured chat slots', async () => {
    const agents = await listAgents([orgId]);
    const busy = pick(agents, 'slots-agent');
    expect(busy.busy_chat).toBe(2);
    expect(busy.busy_work).toBe(1);
    expect(busy.max_chat_slots).toBeNull();

    const empty = pick(agents, 'empty-agent');
    expect(empty.busy_chat).toBe(0);
    expect(empty.busy_work).toBe(0);

    const detail = await getAgentDetail([orgId], 'slots-agent');
    expect(detail).toMatchObject({ busy_chat: 2, busy_work: 1, max_chat_slots: null });
  });

  it('does not expose or mutate an agent outside the allowed organization', async () => {
    expect(await listAgents(['unrelated-org'])).toEqual([]);
    expect(await getAgentDetail(['unrelated-org'], 'slots-agent')).toBeNull();
    expect(await getAgentDetail([orgId], 'missing-agent')).toBeNull();
    expect(await updateAgentChatSlots('unrelated-org', 'slots-agent', 15)).toBeNull();
    expect(await getAgentDetail([orgId], 'slots-agent')).toMatchObject({ max_chat_slots: null });
    expect(await getAgentDetail([], 'slots-agent', true)).toMatchObject({ org_id: orgId, busy_chat: 2, busy_work: 1 });
  });

  it('uses live capacity until sessions expire, then falls back to configured capacity and offline status', async () => {
    const {rows:original}=await getPool().query('SELECT id,session_meta,expires_at,status FROM agent_sessions WHERE org_id=$1 AND agent_id=$2',[orgId,'slots-agent']);
    try {
      await getPool().query(`UPDATE agent_sessions SET session_meta=jsonb_set(session_meta,'{capacity}','6') WHERE org_id=$1 AND agent_id=$2`,[orgId,'slots-agent']);
      expect(await getAgentDetail([orgId],'slots-agent')).toMatchObject({capacity:6,active_slots:3,status:'busy'});
      await getPool().query(`UPDATE agent_sessions SET expires_at=now()-interval '1 second' WHERE org_id=$1 AND agent_id=$2`,[orgId,'slots-agent']);
      expect(await getAgentDetail([orgId],'slots-agent')).toMatchObject({capacity:4,active_slots:0,status:'offline'});
    } finally {
      for(const row of original)await getPool().query('UPDATE agent_sessions SET session_meta=$2,expires_at=$3,status=$4 WHERE id=$1',[row.id,row.session_meta,row.expires_at,row.status]);
    }
  });

  it('persists max_chat_slots updates through the org-scoped mutation', async () => {
    const updated = await updateAgentChatSlots(orgId, 'slots-agent', 5);
    expect(updated).toMatchObject({ id: 'slots-agent', max_chat_slots: 5, busy_chat: 2, busy_work: 1 });

    const cleared = await updateAgentChatSlots(orgId, 'slots-agent', null);
    expect(cleared).toMatchObject({ max_chat_slots: null });

    const zero = await updateAgentChatSlots(orgId, 'empty-agent', 0);
    expect(zero).toMatchObject({ id: 'empty-agent', max_chat_slots: 0 });

    const boundary = await updateAgentChatSlots(orgId, 'empty-agent', 15);
    expect(boundary).toMatchObject({ max_chat_slots: 15 });

    await expect(updateAgentChatSlots(orgId, 'missing-agent', 3)).resolves.toBeNull();
  });

  it('validates chat slot bounds before writing', async () => {
    expect(isValidChatSlotValue(0)).toBe(true);
    expect(isValidChatSlotValue(15)).toBe(true);
    expect(isValidChatSlotValue(null)).toBe(true);
    expect(isValidChatSlotValue(16)).toBe(false);
    expect(isValidChatSlotValue(-1)).toBe(false);
    expect(isValidChatSlotValue(1.5)).toBe(false);
    expect(isValidChatSlotValue('3')).toBe(false);
    for (const invalid of [16, -1, 1.5, '3']) {
      await expect(updateAgentChatSlots(orgId, 'slots-agent', invalid as unknown as number)).rejects.toThrow();
    }
  });

  it('shrinking chat capacity never ends live chat sessions', async () => {
    await updateAgentChatSlots(orgId, 'slots-agent', 0);
    const claims = await getPool().query<{ claim_type: string; status: string }>(
      `SELECT claim_type, status FROM agent_claims
       WHERE org_id = $1 AND session_id IN (
         SELECT id FROM agent_sessions WHERE org_id = $1 AND agent_id = 'slots-agent'
       ) AND status = 'claimed'`,
      [orgId],
    );
    expect(claims.rows.filter((c) => c.claim_type === 'chat')).toHaveLength(2);
    expect(claims.rows.filter((c) => c.claim_type === 'spec')).toHaveLength(1);
    const detail = await getAgentDetail([orgId], 'slots-agent');
    expect(detail).toMatchObject({ max_chat_slots: 0, busy_chat: 2 });
  });
});
