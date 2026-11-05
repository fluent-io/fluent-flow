import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { resolveCollabTestDatabaseUrl, resetCollabSchema, seedLegacyUser, seedLegacyOrgMembership } from '../helpers/collab-db.js';
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
  registerConnector,
  pollConnectorCommands,
  ackConnectorCommand,
  submitConnectorObservations,
  getSessionTimeline,
  submitSessionCommand,
  listProjectHostMappings,
  getExecutionHostCatalog,
} from '../../src/collaboration/identity.js';

process.env.DATABASE_URL = resolveCollabTestDatabaseUrl();
const DATABASE_URL = process.env.DATABASE_URL;

const CLAUDE_CAPS = ['timeline', 'permissions', 'questions', 'local_answers', 'steer', 'cancel', 'usage', 'summary', 'artifacts', 'wrapup', 'reporting'];
const PASEO_CAPS = ['timeline', 'permissions', 'cancel', 'artifacts', 'wrapup'];

function entry(id: string, backend: 'claude-code' | 'paseo') {
  return {
    id, name: id, backend, model: backend === 'paseo' ? 'ai3/x' : 'claude-model-a', revision: `rev-${id}`,
    capabilities: backend === 'paseo' ? PASEO_CAPS : CLAUDE_CAPS, readiness: { state: 'ready' },
    harness: backend === 'paseo' ? { name: 'paseo', version: '0.12.0' } : { name: 'claude-code', version: '2.1.317' },
    policy: backend === 'paseo' ? { modeId: 'full' } : { permissionMode: 'manual' },
    authExpectation: backend === 'paseo' ? 'paseo' : 'claude-subscription',
    limits: backend === 'paseo' ? null : { maxActiveSessions: 1 },
  };
}

async function rawQuery(text: string, params?: unknown[]) {
  const client = new pg.Client({ connectionString: DATABASE_URL });
  try {
    await client.connect();
    return (await client.query(text, params)).rows;
  } finally {
    await client.end();
  }
}

describe('native binding observations (Task 7, real Postgres)', () => {
  let manager;
  let projectId: string;
  let host: { id: string; token: string; mappingId: string };
  let connector: Awaited<ReturnType<typeof registerConnector>>;
  let taskCounter = 0;
  const fence = () => ({ token: host.token, connectorSessionId: connector.connectorSessionId, leaseEpoch: connector.leaseEpoch });

  async function startRun(profileId: string) {
    taskCounter += 1;
    const task = await createCollabTask({ actor: manager, projectId, title: `Binding task ${taskCounter}` });
    const started = await startCollabRun({ actor: manager, taskId: task.id, expectedVersion: 1, idempotencyKey: `binding-${taskCounter}-key`, mappingId: host.mappingId, profileId });
    const polled = await pollConnectorCommands({ ...fence(), waitMs: 0, limit: 10, availableSlots: { 'claude-code': 64, codex: 64 } });
    const launch = polled.commands.find((c) => c.runId === started.run.id);
    return { taskId: task.id, runId: started.run.id, sessionId: launch.sessionId as string, commandId: launch.id as string };
  }

  const observe = (events: Array<Record<string, unknown>>) => submitConnectorObservations({ ...fence(), events: events.map((e) => ({ observedAt: new Date().toISOString(), ...e })) as never });

  beforeAll(async () => {
    process.env.FF_COLLAB_AUTH_SECRET = 'collab-test-secret-0123456789abcdef0123456789abcdef';
    await resetCollabSchema(DATABASE_URL);
    await runMigrations();
    const legacy = await seedLegacyUser(DATABASE_URL, { githubId: 9801, login: 'binding-owner' });
    await seedLegacyOrgMembership(DATABASE_URL, legacy, 'binding-org', 'admin');
    const principal = await ensureGithubPrincipal({ legacyUserId: legacy, displayName: 'Binding Owner', email: 'binding-owner@example.test' });
    manager = { principalId: principal.id, sessionVersion: principal.sessionVersion };
    const ws = await bootstrapCollaborationWorkspace({ actor: manager, legacyOrgId: 'binding-org', name: 'Binding Client', idempotencyKey: 'binding-ws-01' });
    projectId = (await createCollabProject({ actor: manager, workspaceId: ws.id, name: 'Binding P1' })).id;
    const created = await createExecutionHost({ actor: manager, name: 'binding-host' });
    const mapping = await createProjectHostMapping({ actor: manager, projectId, hostId: created.id, repositoryKey: 'repo/binding', profileIds: ['cc-main', 'px-main'], defaultProfileId: 'cc-main' });
    host = { id: created.id, token: created.token, mappingId: mapping.id };
    connector = await registerConnector({
      token: host.token, instanceId: 'inst-binding', protocolVersion: 1, sdkVersion: '0.12.0', capabilities: {},
      catalog: { formatVersion: 2, capacity: { 'claude-code': 2, codex: 1 }, repositories: [{ key: 'repo/binding' }], profiles: [entry('cc-main', 'claude-code'), entry('px-main', 'paseo')] } as never,
    });
  });

  afterAll(async () => {
    await closePool();
  });

  it('v2 capacity accepts limit-only integers and canonical objects and stores the canonical shape', async () => {
    const stored = await rawQuery('SELECT catalog FROM collab_hosts WHERE id = $1', [host.id]);
    expect(stored[0].catalog.capacity).toEqual({ 'claude-code': { limit: 2, available: null, observedAt: null }, codex: { limit: 1, available: null, observedAt: null } });
    const at = '2026-11-05T00:00:00.000Z';
    const register = (capacity: unknown) => registerConnector({ token: host.token, instanceId: 'inst-binding', protocolVersion: 1, sdkVersion: '0.12.0', capabilities: {}, catalog: { formatVersion: 2, capacity, repositories: [{ key: 'repo/binding' }], profiles: [entry('cc-main', 'claude-code'), entry('px-main', 'paseo')] } as never });
    await register({ 'claude-code': { limit: 2, available: 1, observedAt: at }, codex: { limit: 1, available: 0, observedAt: at } });
    expect((await rawQuery('SELECT catalog FROM collab_hosts WHERE id = $1', [host.id]))[0].catalog.capacity).toEqual({ 'claude-code': { limit: 2, available: 1, observedAt: at }, codex: { limit: 1, available: 0, observedAt: at } });
    for (const bad of [
      { 'claude-code': { limit: 0, available: null, observedAt: null }, codex: 1 },
      { 'claude-code': { limit: 1, available: 2, observedAt: at }, codex: 1 },
      { 'claude-code': { limit: 1, available: 1, observedAt: null }, codex: 1 },
      { 'claude-code': { limit: 1, available: -1, observedAt: at }, codex: 1 },
      { 'claude-code': 1 },
    ]) {
      await expect(register(bad), JSON.stringify(bad)).rejects.toMatchObject({ name: 'ZodError' });
    }
    connector = await register({ 'claude-code': 2, codex: 1 });
  });

  it('native session_bound writes collab_session_execution and leaves paseo_agent_id null', async () => {
    const run = await startRun('cc-main');
    const result = await observe([
      { eventId: `workspace_bound:${run.commandId}`, commandId: run.commandId, runId: run.runId, sessionId: run.sessionId, kind: 'workspace_bound', payload: { workspaceRef: 'ffw_0123456789abcdef', backend: 'claude-code' } },
      { eventId: `session_bound:${run.commandId}`, commandId: run.commandId, runId: run.runId, sessionId: run.sessionId, kind: 'session_bound', payload: { backend: 'claude-code', nativeSessionId: run.sessionId, generation: 1 } },
    ]);
    expect(result.acceptedEventIds).toHaveLength(2);
    const session = (await rawQuery('SELECT native_session_id, binding_generation, backend FROM collab_session_execution WHERE session_id = $1', [run.sessionId]))[0];
    expect(session).toEqual({ native_session_id: run.sessionId, binding_generation: 1, backend: 'claude-code' });
    expect((await rawQuery('SELECT workspace_ref FROM collab_run_execution WHERE run_id = $1', [run.runId]))[0].workspace_ref).toBe('ffw_0123456789abcdef');
    expect((await rawQuery('SELECT paseo_agent_id, provider_session_id FROM collab_sessions WHERE id = $1', [run.sessionId]))[0]).toEqual({ paseo_agent_id: null, provider_session_id: null });
    expect((await rawQuery('SELECT state, workspace_id FROM collab_runs WHERE id = $1', [run.runId]))[0]).toEqual({ state: 'launching', workspace_id: 'ffw_0123456789abcdef' });
    await observe([
      { eventId: `session_bound:other:${run.commandId}`, runId: run.runId, sessionId: run.sessionId, kind: 'session_bound', payload: { backend: 'codex', nativeSessionId: 'foreign-thread', generation: 5 } },
      { eventId: `session_bound:gen2:${run.commandId}`, runId: run.runId, sessionId: run.sessionId, kind: 'session_bound', payload: { backend: 'claude-code', nativeSessionId: 'second-generation', generation: 2 } },
      { eventId: `session_bound:gen1:${run.commandId}`, runId: run.runId, sessionId: run.sessionId, kind: 'session_bound', payload: { backend: 'claude-code', nativeSessionId: 'stale-generation', generation: 1 } },
      { eventId: `session_bound:smuggle:${run.commandId}`, runId: run.runId, sessionId: run.sessionId, kind: 'session_bound', payload: { backend: 'claude-code', nativeSessionId: 'second-generation', generation: 2, paseoAgentId: 'smuggled' } },
    ]);
    expect((await rawQuery('SELECT native_session_id, binding_generation FROM collab_session_execution WHERE session_id = $1', [run.sessionId]))[0]).toEqual({ native_session_id: 'second-generation', binding_generation: 2 });
    expect((await rawQuery('SELECT paseo_agent_id FROM collab_sessions WHERE id = $1', [run.sessionId]))[0].paseo_agent_id).toBeNull();
  });

  it('v2 paseo session_bound still sets paseo_agent_id through the existing path', async () => {
    const run = await startRun('px-main');
    await observe([
      { eventId: `workspace_bound:${run.commandId}`, commandId: run.commandId, runId: run.runId, sessionId: run.sessionId, kind: 'workspace_bound', payload: { workspaceId: 'wks_paseo00000000' } },
      { eventId: `session_bound:${run.commandId}`, commandId: run.commandId, runId: run.runId, sessionId: run.sessionId, kind: 'session_bound', payload: { paseoAgentId: 'agent-paseo-1', workspaceId: 'wks_paseo00000000' } },
    ]);
    expect((await rawQuery('SELECT paseo_agent_id FROM collab_sessions WHERE id = $1', [run.sessionId]))[0].paseo_agent_id).toBe('agent-paseo-1');
    expect((await rawQuery('SELECT native_session_id, binding_generation, backend FROM collab_session_execution WHERE session_id = $1', [run.sessionId]))[0]).toEqual({ native_session_id: null, binding_generation: 0, backend: 'paseo' });
    expect((await rawQuery('SELECT workspace_id FROM collab_runs WHERE id = $1', [run.runId]))[0].workspace_id).toBe('wks_paseo00000000');
    expect((await rawQuery('SELECT workspace_ref FROM collab_run_execution WHERE run_id = $1', [run.runId]))[0].workspace_ref).toBeNull();
  });

  it('native turn completion makes the session idle and never changes task status', async () => {
    const run = await startRun('cc-main');
    await ackConnectorCommand({ ...fence(), commandId: run.commandId, state: 'accepted' } as never);
    await observe([{ eventId: `prompt_dispatched:${run.commandId}`, commandId: run.commandId, runId: run.runId, sessionId: run.sessionId, kind: 'state', payload: { state: 'running' } }]);
    const statusWhileRunning = (await rawQuery('SELECT status FROM collab_tasks WHERE id = $1', [run.taskId]))[0].status;
    await observe([{ eventId: `claude-code:${run.sessionId}:1:result-1`, runId: run.runId, sessionId: run.sessionId, kind: 'state', payload: { state: 'idle', nativeState: 'completed', phase: 'result', source: { backend: 'claude-code', generation: 1, nativeEventId: 'result-1', seq: 9 } } }]);
    expect((await rawQuery('SELECT state FROM collab_sessions WHERE id = $1', [run.sessionId]))[0].state).toBe('idle');
    expect((await rawQuery('SELECT status FROM collab_tasks WHERE id = $1', [run.taskId]))[0].status).toBe(statusWhileRunning);
  });

  const B64 = 300 * 1024;
  function fragmentsOf(run: { runId: string; sessionId: string }, eventId: string, kind: string, payload: Record<string, unknown>) {
    const bytes = Buffer.from(JSON.stringify(payload), 'utf8');
    const count = Math.ceil(bytes.length / B64);
    return Array.from({ length: count }, (_, index) => ({ eventId: `${eventId}#f${index}/${count}`, runId: run.runId, sessionId: run.sessionId, kind, observedAt: '2026-11-05T02:00:00.000Z', payload: { fragmentOf: eventId, index, count, encoding: 'base64', data: bytes.subarray(index * B64, (index + 1) * B64).toString('base64') } }));
  }
  async function historyPages(sessionId: string, limit: number) {
    const entries: Array<{ eventId: string; payload: Record<string, unknown> }> = [];
    let cursor: string | undefined;
    for (let pages = 0; pages < 500; pages += 1) {
      const page = await getSessionTimeline({ actor: manager, sessionId, limit, cursor } as never);
      entries.push(...(page.entries as never[]));
      if (!page.nextCursor) return entries;
      cursor = page.nextCursor;
    }
    throw new Error('history did not end');
  }
  const big = (label: string) => `${label} 大きな出力🎉 `.repeat(40_000);

  it('a reassembled native state is projected before the following event of the same request, fresh and retried', async () => {
    for (const variant of ['same-request', 'missing-then-retried']) {
      const run = await startRun('cc-main');
      const id = `claude-code:${run.sessionId}:1:big-state-${variant}`;
      const frags = fragmentsOf(run, id, 'state', { state: 'running', note: big(variant), source: { backend: 'claude-code', generation: 1, nativeEventId: `big-state-${variant}`, seq: 1 } });
      expect(frags.length).toBeGreaterThan(2);
      const following = { eventId: `claude-code:${run.sessionId}:1:after-${variant}`, runId: run.runId, sessionId: run.sessionId, kind: 'state', observedAt: '2026-11-05T02:00:01.000Z', payload: { state: 'reconciling', source: { backend: 'claude-code', generation: 1, nativeEventId: `after-${variant}`, seq: 2 } } };
      if (variant === 'same-request') {
        for (const f of frags.slice(0, -1)) await observe([f]);
      } else {
        for (const f of frags.filter((_, i) => i !== 1 && i !== frags.length - 1)) await observe([f]);
      }
      const finalRequest = variant === 'same-request' ? [frags.at(-1), following] : [frags[1], frags.at(-1), following];
      const result = await observe(finalRequest as never);
      expect(result.acceptedEventIds, variant).toEqual(finalRequest.map((e) => e!.eventId));
      expect((await rawQuery('SELECT state FROM collab_sessions WHERE id = $1', [run.sessionId]))[0].state, variant).toBe('reconciling');
      const rows = await rawQuery(`SELECT event_id FROM collab_connector_observations WHERE session_id = $1 AND NOT (payload ? 'fragmentOf') ORDER BY created_at, id`, [run.sessionId]);
      expect(rows.map((r) => r.event_id).filter((e) => e.startsWith('claude-code:')), variant).toEqual([id, following.eventId]);
    }
  });

  it('native history pages of size 1 return a fragmented event and the following events in native order, exactly once', async () => {
    const run = await startRun('cc-main');
    const bigId = `claude-code:${run.sessionId}:1:big-text`;
    const bigPayload = { type: 'assistant_text', text: big('history'), source: { backend: 'claude-code', generation: 1, nativeEventId: 'big-text', seq: 1 } };
    const frags = fragmentsOf(run, bigId, 'timeline', bigPayload);
    for (const f of frags.slice(0, -1)) await observe([f]);
    const following = Array.from({ length: 20 }, (_, i) => ({ eventId: `claude-code:${run.sessionId}:1:n-${i}`, runId: run.runId, sessionId: run.sessionId, kind: 'timeline', observedAt: '2026-11-05T02:00:02.000Z', payload: { type: 'assistant_text', text: `following ${i}`, source: { backend: 'claude-code', generation: 1, nativeEventId: `n-${i}`, seq: i + 2 } } }));
    await observe([frags.at(-1), ...following] as never);
    for (const limit of [1, 3]) {
      const entries = await historyPages(run.sessionId, limit);
      expect(entries.map((e) => e.eventId), `limit ${limit}`).toEqual([bigId, ...following.map((f) => f.eventId)]);
      expect(entries[0].payload, `limit ${limit}`).toEqual(bigPayload);
      expect(entries.slice(1).map((e) => (e.payload as { source: { seq: number } }).source.seq), `limit ${limit}`).toEqual(following.map((_, i) => i + 2));
      expect(entries.slice(1).map((e) => (e.payload as { text: string }).text), `limit ${limit}`).toEqual(following.map((_, i) => `following ${i}`));
    }
  });

  it('events appended after a future-dated or tied predecessor page back after it, in append order, with pages of one', async () => {
    const run = await startRun('cc-main');
    const prior = [
      { id: '00000000-0000-4000-8000-0000000000a1', eventId: `claude-code:${run.sessionId}:1:prior-a`, at: "now() + interval '1 hour'" },
      { id: '00000000-0000-4000-8000-0000000000a2', eventId: `claude-code:${run.sessionId}:1:prior-b`, at: "now() + interval '1 hour'" },
      { id: '00000000-0000-4000-8000-0000000000a3', eventId: `claude-code:${run.sessionId}:1:prior-c`, at: "now() + interval '1 hour 1 second'" },
    ];
    for (const row of prior) {
      await rawQuery(`INSERT INTO collab_connector_observations (id, event_id, host_id, run_id, session_id, kind, payload, observed_at, created_at)
        VALUES ($1, $2, $3, $4, $5, 'timeline', $6, now(), ${row.at})`, [row.id, row.eventId, host.id, run.runId, run.sessionId, JSON.stringify({ type: 'assistant_text', text: row.eventId })]);
    }
    const later = Array.from({ length: 5 }, (_, i) => ({ eventId: `claude-code:${run.sessionId}:1:later-${i}`, runId: run.runId, sessionId: run.sessionId, kind: 'timeline', observedAt: '2026-11-05T03:00:00.000Z', payload: { type: 'assistant_text', text: `later ${i}`, source: { backend: 'claude-code', generation: 1, nativeEventId: `later-${i}`, seq: i + 10 } } }));
    await observe(later.slice(0, 3));
    await observe(later.slice(3));
    const pages = await historyPages(run.sessionId, 1);
    expect(pages.map((e) => e.eventId)).toEqual([...prior.map((p) => p.eventId), ...later.map((l) => l.eventId)]);
    const observed = await rawQuery('SELECT observed_at FROM collab_connector_observations WHERE event_id = $1', [later[0].eventId]);
    expect(new Date(observed[0].observed_at).toISOString()).toBe('2026-11-05T03:00:00.000Z');
  });

  it('a native terminal under an uncertain owned stop leaves session and run reconciling; only the quiesced stop makes them failed', async () => {
    const violation = (run: { runId: string; sessionId: string }) => ({ eventId: `codex:${run.sessionId}:1:session:profile_violation:1`, runId: run.runId, sessionId: run.sessionId, kind: 'state', payload: { state: 'reconciling', errorCode: 'profile_unavailable', violation: { selectedModel: 'm-a', actualModel: 'm-a', fromModel: 'm-b' }, source: { backend: 'codex', generation: 1, nativeEventId: 'session:profile_violation:1', seq: 1 } } });
    const terminal = (run: { runId: string; sessionId: string }, ownedStop: string | null, seq: number) => ({ eventId: `codex:${run.sessionId}:1:turn:t:completed:${seq}`, runId: run.runId, sessionId: run.sessionId, kind: 'state', payload: ownedStop
      ? { state: 'reconciling', nativeState: 'completed', errorCode: 'profile_unavailable', nativeTerminal: 'failed', ownedStop, source: { backend: 'codex', generation: 1, nativeEventId: 'turn:t:completed', seq } }
      : { state: 'failed', nativeState: 'completed', errorCode: 'profile_unavailable', source: { backend: 'codex', generation: 1, nativeEventId: 'turn:t:completed', seq } } });
    const states = async (run: { runId: string; sessionId: string }) => ({ session: (await rawQuery('SELECT state FROM collab_sessions WHERE id = $1', [run.sessionId]))[0].state, run: (await rawQuery('SELECT state FROM collab_runs WHERE id = $1', [run.runId]))[0].state });
    const uncertain = await startRun('cc-main');
    await observe([violation(uncertain)]);
    await observe([terminal(uncertain, 'uncertain', 2)]);
    expect(await states(uncertain)).toEqual({ session: 'reconciling', run: 'reconciling' });
    const pending = await startRun('cc-main');
    await observe([violation(pending), terminal(pending, 'pending', 2)]);
    expect(await states(pending)).toEqual({ session: 'reconciling', run: 'reconciling' });
    await observe([{ eventId: `codex:${pending.sessionId}:1:ff:owned_stop:1`, runId: pending.runId, sessionId: pending.sessionId, kind: 'state', payload: { state: 'failed', errorCode: 'profile_unavailable', reason: 'model_rerouted', stop: 'quiesced', source: { backend: 'codex', generation: 1, nativeEventId: 'ff:owned_stop:1', seq: 3 } } }]);
    expect(await states(pending)).toEqual({ session: 'failed', run: 'failed' });
  });

  it('Task 12 seam: mapping reads and the host catalog expose only the safe backend, readiness, policy and capacity projection', async () => {
    await rawQuery(`UPDATE collab_hosts SET catalog = jsonb_set(jsonb_set(catalog, '{pollAuthority}', to_jsonb('2030-01-01T00:00:00.000Z'::text)), '{capacity,claude-code}', '{"limit":2,"available":1,"observedAt":"2026-11-05T00:00:00.000Z"}'::jsonb) WHERE id = $1`, [host.id]);
    const [mapping] = await listProjectHostMappings(manager, projectId);
    expect(mapping.profiles).toEqual([
      { id: 'cc-main', name: 'cc-main', provider: null, model: 'claude-model-a', modeId: null, thinkingOptionId: null, backend: 'claude-code', readiness: { state: 'ready' }, policy: { permissionMode: 'manual' } },
      { id: 'px-main', name: 'px-main', provider: null, model: 'ai3/x', modeId: 'full', thinkingOptionId: null, backend: 'paseo', readiness: { state: 'ready' }, policy: { modeId: 'full' } },
    ]);
    expect(mapping.capacity).toEqual({ 'claude-code': { limit: 2, available: 1, observedAt: '2026-11-05T00:00:00.000Z' } });
    const catalog = await getExecutionHostCatalog({ actor: manager, hostId: host.id });
    const storedCodex = (await rawQuery('SELECT catalog FROM collab_hosts WHERE id = $1', [host.id]))[0].catalog.capacity.codex;
    expect(catalog).toEqual({ hostId: host.id, repositories: [{ key: 'repo/binding' }], profiles: mapping.profiles, capacity: { 'claude-code': { limit: 2, available: 1, observedAt: '2026-11-05T00:00:00.000Z' }, codex: storedCodex } });
    const serialized = JSON.stringify([mapping, catalog]);
    for (const secret of ['pollAuthority', '2030-01-01', 'authExpectation', 'harness', 'revision', 'capabilities', 'limits']) expect(serialized).not.toContain(secret);
    const stranger = await rawQuery(`INSERT INTO collab_principals (display_name, email) VALUES ('Host Stranger', 'host-stranger@example.test') RETURNING id, session_version`);
    await expect(getExecutionHostCatalog({ actor: { principalId: stranger[0].id, sessionVersion: stranger[0].session_version }, hostId: host.id })).rejects.toMatchObject({ status: 404 });
    await expect(getExecutionHostCatalog({ actor: manager, hostId: '00000000-0000-4000-8000-000000000000' })).rejects.toMatchObject({ status: 404 });
    const legacy = await createExecutionHost({ actor: manager, name: 'legacy-host' });
    await registerConnector({ token: legacy.token, instanceId: 'inst-legacy', protocolVersion: 1, sdkVersion: '0.12.0', capabilities: {}, catalog: { repositories: [{ key: 'repo/legacy' }], profiles: [{ id: 'px-old', name: 'Old', provider: 'ai3', model: 'm', modeId: 'full' }] } as never });
    const old = await getExecutionHostCatalog({ actor: manager, hostId: legacy.id });
    expect(old).toEqual({ hostId: legacy.id, repositories: [{ key: 'repo/legacy' }], profiles: [{ id: 'px-old', name: 'Old', provider: 'ai3', model: 'm', modeId: 'full', thinkingOptionId: null, backend: 'paseo', readiness: null, policy: null }], capacity: null });
  });

  it('Task 11: an authorized operator Cancel reaches a reconciling native run; its closure projects cancelled and frees a new Start', async () => {
    const reconcilingRun = async (profileId: string) => {
      const run = await startRun(profileId);
      await observe([{ eventId: `${profileId}:${run.sessionId}:1:ff:recovery:1`, runId: run.runId, sessionId: run.sessionId, kind: 'state', payload: { state: 'reconciling', errorCode: 'reconciling', source: { backend: 'claude-code', generation: 1, nativeEventId: 'ff:recovery:1', seq: 1 } } }]);
      expect((await rawQuery('SELECT state FROM collab_runs WHERE id = $1', [run.runId]))[0].state).toBe('reconciling');
      return run;
    };
    const run = await reconcilingRun('cc-main');
    const taskBefore = (await rawQuery('SELECT status, version FROM collab_tasks WHERE id = $1', [run.taskId]))[0];
    const ws = (await rawQuery('SELECT workspace_id FROM collab_projects WHERE id = $1', [projectId]))[0].workspace_id;
    const role = await rawQuery(`SELECT id FROM collab_roles WHERE workspace_id = $1 AND name = 'collaborator'`, [ws]);
    const reader = await rawQuery(`INSERT INTO collab_principals (display_name, email) VALUES ('Closure Reader', 'closure-reader@example.test') RETURNING id, session_version`);
    await rawQuery('INSERT INTO collab_memberships (workspace_id, project_id, principal_id, role_id) VALUES ($1, $2, $3, $4)', [ws, projectId, reader[0].id, role[0].id]);
    await expect(submitSessionCommand({ actor: { principalId: reader[0].id, sessionVersion: reader[0].session_version }, sessionId: run.sessionId, idempotencyKey: 'closure-reader', command: { kind: 'cancel' } })).rejects.toMatchObject({ status: 403 });
    expect(await rawQuery(`SELECT id FROM collab_connector_commands WHERE session_id = $1 AND kind = 'cancel'`, [run.sessionId])).toEqual([]);
    const cancel = await submitSessionCommand({ actor: manager, sessionId: run.sessionId, idempotencyKey: 'closure-operator', command: { kind: 'cancel' } });
    expect(cancel.created).toBe(true);
    expect((await rawQuery('SELECT kind, state FROM collab_connector_commands WHERE id = $1', [cancel.commandId]))[0]).toEqual({ kind: 'cancel', state: 'pending' });
    expect((await rawQuery('SELECT state FROM collab_runs WHERE id = $1', [run.runId]))[0].state).toBe('reconciling');
    expect(await submitSessionCommand({ actor: manager, sessionId: run.sessionId, idempotencyKey: 'closure-operator', command: { kind: 'cancel' } })).toEqual({ commandId: cancel.commandId, created: false });
    await observe([{ eventId: `claude-code:${run.sessionId}:1:ff:closure:${cancel.commandId}`, runId: run.runId, sessionId: run.sessionId, kind: 'state', payload: { state: 'cancelled', cancelCommandId: cancel.commandId, closure: 'operator', generation: 1, source: { backend: 'claude-code', generation: 1, nativeEventId: `ff:closure:${cancel.commandId}`, seq: 2 } } }]);
    expect((await rawQuery('SELECT state FROM collab_sessions WHERE id = $1', [run.sessionId]))[0].state).toBe('cancelled');
    expect((await rawQuery('SELECT state FROM collab_runs WHERE id = $1', [run.runId]))[0].state).toBe('cancelled');
    const taskAfter = (await rawQuery('SELECT status, version FROM collab_tasks WHERE id = $1', [run.taskId]))[0];
    expect(taskAfter.status).toBe(taskBefore.status);
    const again = await startCollabRun({ actor: manager, taskId: run.taskId, expectedVersion: taskAfter.version, idempotencyKey: 'closure-fresh-start', mappingId: host.mappingId, profileId: 'cc-main' });
    expect(again.run.id).not.toBe(run.runId);
    const paseo = await reconcilingRun('px-main');
    await expect(submitSessionCommand({ actor: manager, sessionId: paseo.sessionId, idempotencyKey: 'closure-paseo', command: { kind: 'cancel' } })).rejects.toMatchObject({ status: 409, code: 'run_not_active' });
  });

  it('Task 11 C5: an authorized explicit prompt continues a reconciling native session; others are refused and Paseo is unchanged', async () => {
    const reconcilingRun = async (profileId: string) => {
      const run = await startRun(profileId);
      await ackConnectorCommand({ ...fence(), commandId: run.commandId, state: 'accepted' } as never);
      await observe([{ eventId: `${profileId}:${run.sessionId}:1:ff:worker_lost:1`, runId: run.runId, sessionId: run.sessionId, kind: 'state', payload: { state: 'reconciling', errorCode: 'reconciling', reason: 'worker_lost', source: { backend: 'claude-code', generation: 1, nativeEventId: 'ff:worker_lost:1', seq: 1 } } }]);
      expect((await rawQuery('SELECT state FROM collab_runs WHERE id = $1', [run.runId]))[0].state).toBe('reconciling');
      return run;
    };
    const run = await reconcilingRun('cc-main');
    const ws = (await rawQuery('SELECT workspace_id FROM collab_projects WHERE id = $1', [projectId]))[0].workspace_id;
    const role = await rawQuery(`SELECT id FROM collab_roles WHERE workspace_id = $1 AND name = 'collaborator'`, [ws]);
    const reader = await rawQuery(`INSERT INTO collab_principals (display_name, email) VALUES ('Continuation Reader', 'continuation-reader@example.test') RETURNING id, session_version`);
    await rawQuery('INSERT INTO collab_memberships (workspace_id, project_id, principal_id, role_id) VALUES ($1, $2, $3, $4)', [ws, projectId, reader[0].id, role[0].id]);
    const prompt = { kind: 'prompt' as const, text: 'Continue from where you stopped.', behavior: 'steer' as const };
    await expect(submitSessionCommand({ actor: { principalId: reader[0].id, sessionVersion: reader[0].session_version }, sessionId: run.sessionId, idempotencyKey: 'continue-reader', command: prompt })).rejects.toMatchObject({ status: 403 });
    expect(await rawQuery(`SELECT id FROM collab_connector_commands WHERE session_id = $1 AND kind = 'prompt'`, [run.sessionId])).toEqual([]);
    const taskBefore = (await rawQuery('SELECT status FROM collab_tasks WHERE id = $1', [run.taskId]))[0].status;
    const continued = await submitSessionCommand({ actor: manager, sessionId: run.sessionId, idempotencyKey: 'continue-owner', command: prompt });
    expect(continued.created).toBe(true);
    const stored = (await rawQuery('SELECT kind, state, payload FROM collab_connector_commands WHERE id = $1', [continued.commandId]))[0];
    expect(stored).toMatchObject({ kind: 'prompt', state: 'pending', payload: { text: 'Continue from where you stopped.', execution: { backend: 'claude-code', profileId: 'cc-main' } } });
    expect((await rawQuery('SELECT state FROM collab_sessions WHERE id = $1', [run.sessionId]))[0].state).toBe('queued');
    expect((await rawQuery('SELECT state FROM collab_runs WHERE id = $1', [run.runId]))[0].state).toBe('queued');
    expect((await rawQuery('SELECT status FROM collab_tasks WHERE id = $1', [run.taskId]))[0].status).toBe(taskBefore);
    expect(await submitSessionCommand({ actor: manager, sessionId: run.sessionId, idempotencyKey: 'continue-owner', command: prompt })).toEqual({ commandId: continued.commandId, created: false });
    const paseo = await reconcilingRun('px-main');
    await expect(submitSessionCommand({ actor: manager, sessionId: paseo.sessionId, idempotencyKey: 'continue-paseo', command: prompt })).rejects.toMatchObject({ status: 409 });
    expect(await rawQuery(`SELECT id FROM collab_connector_commands WHERE session_id = $1 AND kind = 'prompt'`, [paseo.sessionId])).toEqual([]);
  });

  it('Task 11 C5: the trusted worker_lost spool projects reconciling over an idle session and admits the continuation; cancelled, failed, foreign-backend, stale-generation and unshaped spools stay retained-only', async () => {
    const cursor = (backend: string, seq: number) => ({ epoch: `ff-native-v1:${backend}`, seq: String(seq) });
    const bind = async (session: { runId: string; sessionId: string; commandId: string }, generation = 1) => {
      await observe([{ eventId: `session_bound:${session.commandId}`, commandId: session.commandId, runId: session.runId, sessionId: session.sessionId, kind: 'session_bound', payload: { backend: 'claude-code', nativeSessionId: session.sessionId, generation } }]);
    };
    const lostEvent = (session: { runId: string; sessionId: string }, generation: number, seq: number, backend = 'claude-code') => ({ eventId: `${backend}:${session.sessionId}:${generation}:ff:worker_lost:${generation}`, runId: session.runId, sessionId: session.sessionId, kind: 'state', providerCursor: cursor(backend, seq), payload: { state: 'reconciling', errorCode: 'reconciling', reason: 'worker_lost', stop: 'quiesced', source: { backend, generation, nativeEventId: `ff:worker_lost:${generation}`, seq } } });
    const idleTurn = (session: { runId: string; sessionId: string }) => ({ eventId: `claude-code:${session.sessionId}:1:turn:first:completed`, runId: session.runId, sessionId: session.sessionId, kind: 'state', providerCursor: cursor('claude-code', 1), payload: { state: 'idle', source: { backend: 'claude-code', generation: 1, nativeEventId: 'turn:first:completed', seq: 1 } } });
    const sessionState = async (session: { sessionId: string }) => (await rawQuery('SELECT state FROM collab_sessions WHERE id = $1', [session.sessionId]))[0].state;
    const runState = async (session: { runId: string }) => (await rawQuery('SELECT state FROM collab_runs WHERE id = $1', [session.runId]))[0].state;

    const lost = await startRun('cc-main');
    await bind(lost);
    await observe([idleTurn(lost)]);
    expect(await sessionState(lost)).toBe('idle');
    await observe([lostEvent(lost, 1, 2)]);
    expect(await sessionState(lost)).toBe('reconciling');
    expect(await runState(lost)).toBe('reconciling');
    const continued = await submitSessionCommand({ actor: manager, sessionId: lost.sessionId, idempotencyKey: 'lost-continue-owner', command: { kind: 'prompt', text: 'Continue with this new explicit instruction.', behavior: 'steer' } });
    expect(continued.created).toBe(true);
    expect((await rawQuery('SELECT state FROM collab_connector_commands WHERE id = $1', [continued.commandId]))[0].state).toBe('pending');
    expect(await sessionState(lost)).toBe('queued');

    const foreign = await startRun('cc-main');
    await bind(foreign);
    await observe([idleTurn(foreign), lostEvent(foreign, 1, 2, 'codex')]);
    expect(await sessionState(foreign)).toBe('idle');

    const stale = await startRun('cc-main');
    await bind(stale);
    await observe([idleTurn(stale), lostEvent(stale, 2, 2)]);
    expect(await sessionState(stale)).toBe('idle');

    const unshaped = await startRun('cc-main');
    await bind(unshaped);
    await observe([idleTurn(unshaped), { eventId: `claude-code:${unshaped.sessionId}:1:ff:worker_lost:1`, runId: unshaped.runId, sessionId: unshaped.sessionId, kind: 'state', providerCursor: cursor('claude-code', 2), payload: { state: 'reconciling', reason: 'worker_lost', source: { backend: 'claude-code', generation: 1, nativeEventId: 'totally-unrelated', seq: 2 } } }]);
    expect(await sessionState(unshaped)).toBe('idle');

    const failed = await startRun('cc-main');
    await bind(failed);
    await observe([{ eventId: `claude-code:${failed.sessionId}:1:turn:first:failed`, runId: failed.runId, sessionId: failed.sessionId, kind: 'state', providerCursor: cursor('claude-code', 1), payload: { state: 'failed', errorCode: 'profile_unavailable', source: { backend: 'claude-code', generation: 1, nativeEventId: 'turn:first:failed', seq: 1 } } }, lostEvent(failed, 1, 2)]);
    expect(await sessionState(failed)).toBe('failed');

    const closed = await startRun('cc-main');
    await bind(closed);
    await observe([lostEvent(closed, 1, 1)]);
    const cancel = await submitSessionCommand({ actor: manager, sessionId: closed.sessionId, idempotencyKey: 'lost-cancel-owner', command: { kind: 'cancel' } });
    expect(cancel.created).toBe(true);
    await observe([{ eventId: `claude-code:${closed.sessionId}:1:ff:closure:${cancel.commandId}`, runId: closed.runId, sessionId: closed.sessionId, kind: 'state', payload: { state: 'cancelled', cancelCommandId: cancel.commandId, closure: 'operator', generation: 1, source: { backend: 'claude-code', generation: 1, nativeEventId: `ff:closure:${cancel.commandId}`, seq: 2 } } }]);
    expect(await sessionState(closed)).toBe('cancelled');
    expect(await runState(closed)).toBe('cancelled');
    await observe([lostEvent(closed, 1, 3)]);
    expect(await sessionState(closed)).toBe('cancelled');
    expect(await runState(closed)).toBe('cancelled');
  });

  it('a fragmented native observation is reassembled exactly and session history shows it once, never its fragments', async () => {
    const run = await startRun('cc-main');
    const eventId = `claude-code:${run.sessionId}:1:msg-big`;
    const payload = { type: 'assistant_text', text: '界🎉 large native output '.repeat(60_000), source: { backend: 'claude-code', generation: 1, nativeEventId: 'msg-big', seq: 3 } };
    const bytes = Buffer.from(JSON.stringify(payload), 'utf8');
    expect(bytes.length).toBeGreaterThan(1024 * 1024);
    const size = 300 * 1024;
    const count = Math.ceil(bytes.length / size);
    const fragments = Array.from({ length: count }, (_, index) => ({ eventId: `${eventId}#f${index}/${count}`, runId: run.runId, sessionId: run.sessionId, kind: 'timeline', observedAt: '2026-11-05T01:00:00.000Z', payload: { fragmentOf: eventId, index, count, encoding: 'base64', data: bytes.subarray(index * size, (index + 1) * size).toString('base64') } }));
    const order = [...fragments.keys()].reverse();
    for (const i of order.slice(0, -1)) expect((await observe([fragments[i]])).acceptedEventIds).toEqual([fragments[i].eventId]);
    expect(await rawQuery('SELECT 1 FROM collab_connector_observations WHERE event_id = $1', [eventId])).toHaveLength(0);
    expect((await observe([fragments[order.at(-1)]])).acceptedEventIds).toEqual([fragments[order.at(-1)].eventId]);
    expect((await observe([fragments[0]])).acceptedEventIds).toEqual([fragments[0].eventId]);
    const rows = await rawQuery('SELECT kind, payload, observed_at FROM collab_connector_observations WHERE event_id = $1', [eventId]);
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe('timeline');
    expect(rows[0].payload).toEqual(payload);
    const history = await getSessionTimeline({ actor: manager, sessionId: run.sessionId, limit: 100 } as never);
    expect(history.entries.map((e) => e.eventId)).toEqual([eventId]);
    expect(history.entries[0].payload).toEqual(payload);
    const forged = { ...fragments[0], eventId: `${eventId}-x#f0/${count}` };
    expect((await observe([forged])).rejectedEventIds).toEqual([forged.eventId]);
  });
});
