import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePool, getPool } from '../../src/pool.js';
import { runMigrations } from '../../src/migrate.js';
import { ensureGithubPrincipal, bootstrapCollaborationWorkspace, createCollabProject } from '../../src/collaboration/index.js';
import { getProjectSummarySettings, updateProjectSummarySettings } from '../../src/collaboration/summary-settings.js';
import { resetCollabSchema, resolveCollabTestDatabaseUrl, seedOrgMembership, seedUser } from '../helpers/collab-db.js';

process.env.DATABASE_URL = resolveCollabTestDatabaseUrl();
const databaseUrl = process.env.DATABASE_URL;
const orgId = 'native-summary-settings';
const profiles = [{ id: 'summarize', models: ['small', 'large'], default_model: 'small' }];
let actor: { principalId: string; sessionVersion: number };
let outsider: typeof actor;
let workspaceId: string;

async function project(name: string) {
  return createCollabProject({ actor, workspaceId, name });
}

async function advertisedAgent(id: string, purpose: string[], live: boolean, agentOrg = orgId) {
  await getPool().query(`INSERT INTO agents(id,org_id,agent_type,transport,max_chat_slots) VALUES($1,$2,'codex','long_poll',0)`, [id, agentOrg]);
  await getPool().query(`INSERT INTO agent_sessions(org_id,agent_id,session_meta,status,last_seen_at,expires_at)
    VALUES($1,$2,$3,'online',NOW(),CASE WHEN $4 THEN NOW()+interval '10 minutes' ELSE NOW()-interval '1 minute' END)`,
  [agentOrg, id, JSON.stringify({ capacity: 1, supported_claim_types: purpose, profiles }), live]);
}

describe('native summary configuration authority', () => {
  beforeAll(async () => {
    await resetCollabSchema(databaseUrl);
    await runMigrations();
    const userId = await seedUser(databaseUrl, { githubId: 9751, login: 'summary-settings-admin' });
    await seedOrgMembership(databaseUrl, userId, orgId, 'admin');
    await seedOrgMembership(databaseUrl, userId, 'foreign-summary-settings', 'admin');
    const principal = await ensureGithubPrincipal({ userId, displayName: 'Summary admin', email: 'summary-admin@example.test' });
    actor = { principalId: principal.id, sessionVersion: principal.sessionVersion };
    workspaceId = (await bootstrapCollaborationWorkspace({ actor, orgId, name: 'Summary settings', idempotencyKey: 'native-summary-settings-workspace' })).id;
    const otherUser = await seedUser(databaseUrl, { githubId: 9752, login: 'summary-settings-outsider' });
    const otherPrincipal = await ensureGithubPrincipal({ userId: otherUser, displayName: 'Other reader', email: 'summary-outsider@example.test' });
    outsider = { principalId: otherPrincipal.id, sessionVersion: otherPrincipal.sessionVersion };
    await advertisedAgent('summary-capacity-one', ['summary'], true);
    await advertisedAgent('summary-offline', ['summary'], false);
    await advertisedAgent('chat-only', ['chat'], true);
    await advertisedAgent('summary-foreign', ['summary'], true, 'foreign-summary-settings');
  });

  afterAll(closePool);

  it('offers ordinary summary capacity when chat slots are disabled', async () => {
    const target = await project('Summary capacity');
    const settings = await getProjectSummarySettings({ actor, projectId: target.id });
    expect(settings.agents.find(agent => agent.id === 'summary-capacity-one')).toMatchObject({ available: true, online: true, profiles });
    expect(settings.agents.find(agent => agent.id === 'chat-only')).toMatchObject({ available: false, profiles: [] });
    expect(settings.agents.some(agent => agent.id === 'summary-foreign')).toBe(false);
  });

  it('saves explicit summary identity without rewriting chat or legacy configuration', async () => {
    const target = await project('Separate summary configuration');
    const legacy = { summary: { enabled: true, profileId: 'legacy-summary-profile', model: 'legacy-model' }, instructions: 'Preserve historical instructions' };
    await getPool().query('UPDATE collab_projects SET execution_defaults=$2 WHERE id=$1', [target.id, JSON.stringify(legacy)]);
    const before = (await getPool().query('SELECT execution_mode,default_agent_id,chat_execution_defaults FROM collab_projects WHERE id=$1', [target.id])).rows[0];
    const current = await getProjectSummarySettings({ actor, projectId: target.id });
    const defaults = { enabled: true, agentId: 'summary-capacity-one', profileId: 'summarize', model: 'large' };
    const saved = await updateProjectSummarySettings({ actor, projectId: target.id, expectedVersion: current.version, defaults });
    expect(saved.defaults).toEqual(defaults);
    const persisted = (await getPool().query('SELECT execution_mode,default_agent_id,chat_execution_defaults,execution_defaults,summary_execution_defaults,version FROM collab_projects WHERE id=$1', [target.id])).rows[0];
    expect(persisted).toMatchObject({ ...before, execution_defaults: legacy, summary_execution_defaults: defaults, version: current.version + 1 });
  });

  it('preserves an explicit offline selection rather than silently replacing it', async () => {
    const target = await project('Offline summary draft');
    const current = await getProjectSummarySettings({ actor, projectId: target.id });
    const defaults = { enabled: true, agentId: 'summary-offline', profileId: 'summarize', model: null };
    const saved = await updateProjectSummarySettings({ actor, projectId: target.id, expectedVersion: current.version, defaults });
    expect(saved.defaults).toEqual(defaults);
    expect(saved.agents.find(agent => agent.id === 'summary-offline')).toMatchObject({ available: false, online: false, profiles });
  });

  it.each([
    { enabled: true, agentId: 'chat-only', profileId: 'summarize', model: 'small' },
    { enabled: true, agentId: 'summary-foreign', profileId: 'summarize', model: 'small' },
    { enabled: true, agentId: 'summary-capacity-one', profileId: 'summarize', model: 'unadvertised' },
    { enabled: true, agentId: 'summary-capacity-one', profileId: null, model: null },
  ])('rejects unavailable purpose, scope or model without saving $agentId/$model', async defaults => {
    const target = await project(`Rejected ${defaults.agentId}/${defaults.model}`);
    const before = await getProjectSummarySettings({ actor, projectId: target.id });
    await expect(updateProjectSummarySettings({ actor, projectId: target.id, expectedVersion: before.version, defaults })).rejects.toMatchObject({ status: 422 });
    const after = await getProjectSummarySettings({ actor, projectId: target.id });
    expect(after.defaults).toEqual(before.defaults);
    expect(after.version).toBe(before.version);
  });

  it('rejects a stale save without overwriting the newer selection', async () => {
    const target = await project('Concurrent summary settings');
    const current = await getProjectSummarySettings({ actor, projectId: target.id });
    const defaults = { enabled: true, agentId: 'summary-capacity-one', profileId: 'summarize', model: 'large' };
    await updateProjectSummarySettings({ actor, projectId: target.id, expectedVersion: current.version, defaults });
    await expect(updateProjectSummarySettings({ actor, projectId: target.id, expectedVersion: current.version, defaults: { ...defaults, model: 'small' } })).rejects.toMatchObject({ status: 409 });
    expect((await getProjectSummarySettings({ actor, projectId: target.id })).defaults).toEqual(defaults);
  });

  it('does not disclose or mutate project defaults to another principal', async () => {
    const target = await project('Private summary settings');
    const before = await getProjectSummarySettings({ actor, projectId: target.id });
    await expect(getProjectSummarySettings({ actor: outsider, projectId: target.id })).rejects.toMatchObject({ status: 404 });
    await expect(updateProjectSummarySettings({ actor: outsider, projectId: target.id, expectedVersion: before.version, defaults: { enabled: true, agentId: 'summary-capacity-one', profileId: 'summarize', model: 'small' } })).rejects.toMatchObject({ status: 404 });
    expect((await getProjectSummarySettings({ actor, projectId: target.id })).defaults).toEqual(before.defaults);
  });
});
