import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePool, getPool } from '../../src/pool.js';
import { runMigrations } from '../../src/migrate.js';
import { readChatAgents, validateChatSelection, type ChatAgent } from '../../src/collaboration/chat-settings.js';
import { ensureGithubPrincipal, bootstrapCollaborationWorkspace, createCollabProject, updateProjectChatSettings } from '../../src/collaboration/index.js';
import {
  resetCollabSchema,
  resolveCollabTestDatabaseUrl,
  seedOrgMembership,
  seedUser,
} from '../helpers/collab-db.js';

process.env.DATABASE_URL = resolveCollabTestDatabaseUrl();
const databaseUrl = process.env.DATABASE_URL;
const orgId = 'chat-eligibility-org';

async function insertAgent(id: string, maxChatSlots: number | null) {
  await getPool().query(
    `INSERT INTO agents (id, org_id, agent_type, transport, transport_meta)
     VALUES ($1, $2, 'codex', 'long_poll', '{"capacity": 8}'::jsonb)`,
    [id, orgId],
  );
  if (maxChatSlots !== null) {
    await getPool().query(`UPDATE agents SET max_chat_slots = $2 WHERE org_id = $1 AND id = $3`, [orgId, maxChatSlots, id]);
  }
}

async function insertSession(orgId_: string, agentId: string, meta: Record<string, unknown>, live: boolean) {
  await getPool().query(
    `INSERT INTO agent_sessions (org_id, agent_id, session_meta, status, last_seen_at, expires_at)
     VALUES ($1, $2, $3::jsonb, 'online',
       CASE WHEN $4 THEN NOW() ELSE NOW() - interval '30 minutes' END,
       CASE WHEN $4 THEN NOW() + interval '10 minutes' ELSE NOW() - interval '1 minute' END)`,
    [orgId_, agentId, JSON.stringify(meta), live],
  );
}

function pick(agents: ChatAgent[], id: string): ChatAgent {
  const found = agents.find((agent) => agent.id === id);
  if (!found) throw new Error(`agent ${id} missing`);
  return found;
}

describe('readChatAgents effective chat eligibility (real Postgres)', () => {
  let actor: { principalId: string; sessionVersion: number };
  let projectId: string;
  beforeAll(async () => {
    await resetCollabSchema(databaseUrl);
    await runMigrations();
    const userId = await seedUser(databaseUrl, { githubId: 9501, login: 'chat-eligibility-admin' });
    await seedOrgMembership(databaseUrl, userId, orgId, 'admin');
    const principal=await ensureGithubPrincipal({userId,displayName:'Eligibility admin',email:'eligibility@example.test'});
    actor={principalId:principal.id,sessionVersion:principal.sessionVersion};
    const workspace=await bootstrapCollaborationWorkspace({actor,orgId,name:'Eligibility',idempotencyKey:'eligibility-workspace'});
    projectId=(await createCollabProject({actor,workspaceId:workspace.id,name:'Eligibility project'})).id;

    await insertAgent('cap-two-default', null);
    await insertSession(orgId, 'cap-two-default', {
      capacity: 2,
      supported_claim_types: ['chat', 'spec'],
      profiles: [{ id: 'design', models: ['large'], default_model: 'large' }],
    }, true);

    await insertAgent('cap-one-default', null);
    await insertSession(orgId, 'cap-one-default', {
      capacity: 1,
      supported_claim_types: ['chat', 'spec'],
      profiles: [{ id: 'design', models: ['large'], default_model: 'large' }],
    }, true);

    await insertAgent('configured-zero', 0);
    await insertSession(orgId, 'configured-zero', {
      capacity: 8,
      supported_claim_types: ['chat'],
      profiles: [{ id: 'design', models: ['large'], default_model: 'large' }],
    }, true);

    await insertAgent('offline-with-catalog', null);
    await insertSession(orgId, 'offline-with-catalog', {
      capacity: 4,
      supported_claim_types: ['chat'],
      profiles: [{ id: 'design', models: ['large'], default_model: 'large' }],
    }, false);

    await insertAgent('live-no-chat', null);
    await insertSession(orgId, 'live-no-chat', {
      capacity: 4,
      supported_claim_types: ['spec'],
      profiles: [{ id: 'build', models: ['large'] }],
    }, true);

    await insertAgent('unknown-capacity', null);
    await insertSession(orgId, 'unknown-capacity', {
      supported_claim_types: ['chat'],
      profiles: [{ id: 'design', models: ['large'], default_model: 'large' }],
    }, true);
    await insertAgent('configured-fifteen',15);
    await insertSession(orgId,'configured-fifteen',{capacity:2,supported_claim_types:['chat'],profiles:[{id:'design',models:[]}]},true);
  });

  afterAll(closePool);

  it('keeps the capacity-2 default runner eligible with one effective chat slot', async () => {
    const agent = pick(await readChatAgents(orgId), 'cap-two-default');
    expect(agent).toMatchObject({ available: true, online: true, chatDisabled: false, effectiveChatSlots: 1, maxChatSlots: null });
    expect(agent.profiles.map((p) => p.id)).toEqual(['design']);
  });

  it('disables chats for capacity-1 agents even with an advertised catalog', async () => {
    const agent = pick(await readChatAgents(orgId), 'cap-one-default');
    expect(agent).toMatchObject({ online: true, chatDisabled: true, effectiveChatSlots: 0, available: false });
    expect(agent.profiles).toEqual([]);
    expect(() => validateChatSelection([agent], 'cap-one-default', { profileId: 'design', model: 'large', instructions: '' }))
      .toThrow(expect.objectContaining({ status: 422, code: 'profile_unavailable' }));
  });

  it('rejects a configured-zero agent even when using runner defaults', async () => {
    const agent = pick(await readChatAgents(orgId), 'configured-zero');
    expect(agent).toMatchObject({ online: true, chatDisabled: true, effectiveChatSlots: 0, available: false });
    expect(() => validateChatSelection([agent], 'configured-zero', { profileId: null, model: null, instructions: '' }))
      .toThrow(expect.objectContaining({ status: 422, code: 'profile_unavailable' }));
  });

  it('marks offline agents unavailable without generically disabling their saved drafts', async () => {
    const agent = pick(await readChatAgents(orgId), 'offline-with-catalog');
    expect(agent).toMatchObject({ online: false, available: false, chatDisabled: false, effectiveChatSlots: null, maxChatSlots: null });
    expect(agent.profiles.map((p) => p.id)).toEqual(['design']);
    const saved=await updateProjectChatSettings({actor,projectId,expectedVersion:1,executionMode:'chat',
      defaultAgentId:agent.id,defaults:{profileId:'design',model:'large',instructions:'Keep this offline target'}});
    expect(saved).toMatchObject({defaultAgentId:agent.id,defaults:{profileId:'design',model:'large',instructions:'Keep this offline target'}});
  });

  it('never advertises chats for live agents without chat support', async () => {
    const agent = pick(await readChatAgents(orgId), 'live-no-chat');
    expect(agent).toMatchObject({ online: true, available: false, chatDisabled: false });
    expect(agent.profiles).toEqual([]);
    expect(() => validateChatSelection([agent], 'live-no-chat', { profileId: 'build', model: 'large', instructions: '' }))
      .toThrow(expect.objectContaining({ status: 422, code: 'profile_unavailable' }));
  });

  it('reports unknown effective capacity honestly when live slots omit capacity', async () => {
    const agent = pick(await readChatAgents(orgId), 'unknown-capacity');
    expect(agent).toMatchObject({ online: true, chatDisabled: false, effectiveChatSlots: null, available: false });
    expect(agent.profiles.map((p) => p.id)).toEqual(['design']);
  });

  it('does not let a newer offline advertisement hide the live catalog', async () => {
    await insertSession(orgId,'cap-two-default',{capacity:4,supported_claim_types:['chat'],profiles:[{id:'stale',models:[]}]},false);
    await getPool().query(`UPDATE agent_sessions SET last_seen_at=now() WHERE org_id=$1 AND agent_id=$2 AND expires_at<now()`,[orgId,'cap-two-default']);
    expect(pick(await readChatAgents(orgId),'cap-two-default')).toMatchObject({available:true,effectiveChatSlots:1,profiles:[{id:'design'}]});
  });

  it('keeps an explicitly disabled agent disabled while it is offline', async () => {
    await getPool().query(`UPDATE agent_sessions SET status='offline' WHERE org_id=$1 AND agent_id=$2`,[orgId,'configured-zero']);
    try {
      const agent=pick(await readChatAgents(orgId),'configured-zero');
      expect(agent).toMatchObject({online:false,chatDisabled:true,effectiveChatSlots:0,available:false});
      expect(()=>validateChatSelection([agent],agent.id,{profileId:null,model:null,instructions:''}))
        .toThrow(expect.objectContaining({status:422,code:'profile_unavailable'}));
    } finally {
      await getPool().query(`UPDATE agent_sessions SET status='online' WHERE org_id=$1 AND agent_id=$2`,[orgId,'configured-zero']);
    }
  });

  it('caps configured chat slots at capacity minus one', async () => {
    expect(pick(await readChatAgents(orgId),'configured-fifteen')).toMatchObject({maxChatSlots:15,effectiveChatSlots:1,available:true});
  });
});
