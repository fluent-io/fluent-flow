import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
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
  submitConnectorObservations,
  submitSessionCommand,
  getSessionPendingRequest,
  getSessionPendingRequests,
} from '../../src/collaboration/identity.js';

process.env.DATABASE_URL = resolveCollabTestDatabaseUrl();
const DATABASE_URL = process.env.DATABASE_URL;

const CLAUDE_CAPS = ['timeline', 'permissions', 'questions', 'local_answers', 'steer', 'cancel', 'usage', 'summary', 'artifacts', 'wrapup', 'reporting'];
const CODEX_CAPS = [...CLAUDE_CAPS, 'secret_questions'];
const UNAVAILABLE = { status: 409, code: 'request_unavailable', message: 'This request is no longer available. Refresh the session.' };
const ON_HOST = { status: 409, code: 'answer_on_host', message: 'Answer this request on the execution host.' };

function entry(id: string, backend: 'claude-code' | 'codex') {
  return {
    id, name: `Profile ${id}`, backend, model: `${backend}-model-x`, revision: 'rev-1',
    capabilities: backend === 'claude-code' ? CLAUDE_CAPS : CODEX_CAPS,
    readiness: { state: 'ready' },
    harness: backend === 'claude-code' ? { name: 'claude-code', version: '2.1.317' } : { name: 'codex', version: '0.162.1' },
    policy: backend === 'claude-code' ? { permissionMode: 'manual' } : { approvalPolicy: 'on-request', sandbox: 'workspace-write', networkAccess: false },
    authExpectation: backend === 'claude-code' ? 'claude-subscription' : 'chatgpt-subscription',
    limits: { maxActiveSessions: 1 },
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

const ffRequestId = (sessionId: string, backend: string, generation: number, nativeRequestId: string) =>
  createHash('sha256').update(`${sessionId}|${backend}|${generation}|${nativeRequestId}`).digest('hex').slice(0, 32);
const fp = (n: number | string) => createHash('sha256').update(`fingerprint-${n}`).digest('hex');

async function rejection(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (err) {
    const e = err as { status?: number; code?: string; message?: string };
    return { status: e.status, code: e.code, message: e.message };
  }
  return expect.fail('expected a rejection');
}

describe('plural pending requests and validated answers (real Postgres)', () => {
  let manager: { principalId: string; sessionVersion: number };
  let projectId: string;
  const hosts: Record<string, { token: string; mappingId: string; connector: { connectorSessionId: string; leaseEpoch: number } }> = {};
  let counter = 0;
  let clock = Date.UTC(2026, 10, 5, 10, 0, 0);
  const at = () => new Date((clock += 1000)).toISOString();

  async function addHost(name: string, catalog: Record<string, unknown>, profileIds: string[]) {
    const host = await createExecutionHost({ actor: manager, name });
    const mapping = await createProjectHostMapping({ actor: manager, projectId, hostId: host.id, repositoryKey: `repo/${name}`, profileIds, defaultProfileId: profileIds[0] });
    const connector = await registerConnector({ token: host.token, instanceId: `inst-${name}`, protocolVersion: 1, sdkVersion: '0.12.0', capabilities: {}, catalog: catalog as never });
    hosts[name] = { token: host.token, mappingId: mapping.id, connector };
  }

  async function session(host: string, profileId: string) {
    counter += 1;
    const taskId = (await createCollabTask({ actor: manager, projectId, title: `Pending task ${counter}` })).id;
    const started = await startCollabRun({ actor: manager, taskId, expectedVersion: 1, idempotencyKey: `pending-run-${counter}`, mappingId: hosts[host].mappingId, profileId });
    const sessionId = (await rawQuery(`SELECT id FROM collab_sessions WHERE run_id = $1`, [started.run.id]))[0].id as string;
    return { runId: started.run.id as string, sessionId, host };
  }

  async function observe(s: { runId: string; sessionId: string; host: string }, events: Array<{ eventId?: string; kind: string; payload: Record<string, unknown> }>) {
    const h = hosts[s.host];
    const result = await submitConnectorObservations({
      token: h.token, connectorSessionId: h.connector.connectorSessionId, leaseEpoch: h.connector.leaseEpoch,
      events: events.map((e) => ({ eventId: e.eventId ?? `ev-${randomUUID()}`, runId: s.runId, sessionId: s.sessionId, observedAt: at(), kind: e.kind, payload: e.payload })),
    });
    expect(result.rejectedEventIds).toEqual([]);
  }

  const bind = (s: { runId: string; sessionId: string; host: string }, backend: string, generation: number) =>
    observe(s, [{ kind: 'session_bound', payload: { backend, nativeSessionId: `native-${s.sessionId}`, generation } }]);

  function nativePending(backend: string, generation: number, nativeRequestId: string, request: Record<string, unknown>) {
    return { kind: 'attention', payload: { nativeRequestId, ...request, state: 'pending', attention: 'permission', requestId: nativeRequestId, source: { backend, generation, nativeEventId: `request:${nativeRequestId}`, seq: counter } } };
  }
  function nativeResolved(backend: string, generation: number, nativeRequestId: string) {
    return { kind: 'attention', payload: { nativeRequestId, state: 'resolved', attention: 'permission_resolved', requestId: nativeRequestId, source: { backend, generation, nativeEventId: `request:${nativeRequestId}:resolved`, seq: counter } } };
  }
  const claudeApproval = (n: number) => ({
    kind: 'permission', fingerprint: fp(n), secret: false,
    choices: [
      { id: 'allow_once', label: 'Allow once', scope: 'once', behavior: 'allow' },
      { id: 'allow_session', label: 'Allow for this session', scope: 'session', behavior: 'allow' },
      { id: 'deny', label: 'Deny and continue', scope: 'once', behavior: 'deny' },
    ],
    questions: null,
    tool: { name: 'Bash', displayName: 'Bash', description: `Run command ${n}`, input: { command: `echo ${n}` } },
  });
  const claudeQuestion = (n: number) => ({
    kind: 'question', fingerprint: fp(`q${n}`), secret: false,
    choices: [{ id: 'deny', label: 'Deny and continue', scope: 'once', behavior: 'deny' }],
    questions: [
      { id: 'q0', header: 'Pick', question: 'Which colors?', options: [{ label: 'Red, bright', description: 'warm' }, { label: 'Blue', description: null }], multiSelect: true, allowOther: true, secret: false },
      { id: 'q1', header: 'Pick', question: 'Which size?', options: [{ label: 'Small', description: null }, { label: 'Large', description: null }], multiSelect: false, allowOther: false, secret: false },
    ],
    tool: { name: 'AskUserQuestion', displayName: 'AskUserQuestion', description: null, input: {} },
  });
  const codexSecretQuestion = (n: number) => ({
    kind: 'question', fingerprint: fp(`s${n}`), secret: true, hostOnly: true, generation: 1,
    choices: [{ id: 'decline', label: 'Deny and continue', scope: 'once', behavior: 'deny' }],
    questions: [{ id: 'token', header: 'Token', question: 'Paste the token', options: null, multiSelect: false, allowOther: true, secret: true }],
    correlation: { threadId: 't', turnId: 'u', callId: `call-${n}`, itemId: null },
  });
  const answer = (sessionId: string, command: Record<string, unknown>, key = `answer-${randomUUID()}`) =>
    submitSessionCommand({ actor: manager, sessionId, idempotencyKey: key, command: command as never });
  async function only(sessionId: string) {
    const { requests } = await getSessionPendingRequests(manager, sessionId);
    expect(requests).toHaveLength(1);
    return requests[0];
  }
  const commandsFor = async (sessionId: string) => rawQuery(`SELECT payload FROM collab_connector_commands WHERE session_id = $1 AND kind = 'permission' ORDER BY created_at`, [sessionId]);

  beforeAll(async () => {
    process.env.FF_COLLAB_AUTH_SECRET = 'collab-test-secret-0123456789abcdef0123456789abcdef';
    await resetCollabSchema(DATABASE_URL);
    await runMigrations();
    const legacy = await seedLegacyUser(DATABASE_URL, { githubId: 9901, login: 'pending-owner' });
    await seedLegacyOrgMembership(DATABASE_URL, legacy, 'pending-org', 'admin');
    const principal = await ensureGithubPrincipal({ legacyUserId: legacy, displayName: 'Pending Owner', email: 'pending-owner@example.test' });
    manager = { principalId: principal.id, sessionVersion: principal.sessionVersion };
    const ws = await bootstrapCollaborationWorkspace({ actor: manager, legacyOrgId: 'pending-org', name: 'Pending Client', idempotencyKey: 'pending-ws-01' });
    projectId = (await createCollabProject({ actor: manager, workspaceId: ws.id, name: 'Pending P1' })).id;
    await addHost('native', { formatVersion: 2, capacity: { 'claude-code': 1, codex: 1 }, repositories: [{ key: 'repo/native' }], profiles: [entry('cc-p', 'claude-code'), entry('cx-p', 'codex')] }, ['cc-p', 'cx-p']);
    await addHost('paseo', { repositories: [{ key: 'repo/paseo' }], profiles: [{ id: 'px-legacy', provider: 'claude', model: 'claude-model-x' }] }, ['px-legacy']);
  });

  afterAll(async () => {
    delete process.env.FF_COLLAB_AUTH_SECRET;
    await closePool();
  });

  it('lists every outstanding request oldest first, 50 per page with cursor', async () => {
    const s = await session('native', 'cc-p');
    await bind(s, 'claude-code', 1);
    const ids = Array.from({ length: 55 }, (_, i) => `ctl-${String(i).padStart(2, '0')}`);
    for (let i = 0; i < ids.length; i += 11) await observe(s, ids.slice(i, i + 11).map((id, j) => nativePending('claude-code', 1, id, claudeApproval(i + j))));
    await observe(s, [nativeResolved('claude-code', 1, 'ctl-03')]);
    const first = await getSessionPendingRequests(manager, s.sessionId);
    expect(first.requests).toHaveLength(50);
    expect(first.nextCursor).toEqual(expect.any(String));
    const second = await getSessionPendingRequests(manager, s.sessionId, { cursor: first.nextCursor! });
    expect(second.nextCursor).toBeNull();
    const listed = [...first.requests, ...second.requests];
    const expected = ids.filter((id) => id !== 'ctl-03').map((id) => ffRequestId(s.sessionId, 'claude-code', 1, id));
    expect(listed.map((r) => r.requestId)).toEqual(expected);
    expect(listed[0]).toEqual({
      requestId: ffRequestId(s.sessionId, 'claude-code', 1, 'ctl-00'), kind: 'permission', backend: 'claude-code', generation: 1, fingerprint: fp(0),
      promptText: 'Run command 0',
      choices: [
        { id: 'allow_once', label: 'Allow once', scope: 'once', behavior: 'allow' },
        { id: 'allow_session', label: 'Allow for this session', scope: 'session', behavior: 'allow' },
        { id: 'deny', label: 'Deny and continue', scope: 'once', behavior: 'deny' },
      ],
      questions: null, hostOnly: false, inputSchema: { command: 'echo 0' }, expiresAt: null, observedAt: expect.any(String),
    });
    expect((await getSessionPendingRequests(manager, s.sessionId, { limit: 500 })).requests).toHaveLength(50);
    expect((await getSessionPendingRequests(manager, s.sessionId, { limit: 2 })).requests.map((r) => r.requestId)).toEqual(expected.slice(0, 2));
    expect(await getSessionPendingRequest(manager, s.sessionId)).toEqual({
      requestId: ffRequestId(s.sessionId, 'claude-code', 1, 'ctl-54'), kind: 'permission', promptText: 'Run command 54',
      choices: [{ id: 'allow_once', label: 'Allow once' }, { id: 'allow_session', label: 'Allow for this session' }, { id: 'deny', label: 'Deny and continue' }],
      inputSchema: { command: 'echo 54' }, expiresAt: null,
    });
    expect(await rejection(getSessionPendingRequests(manager, s.sessionId, { cursor: 'not-a-cursor' }))).toMatchObject({ status: 400, code: 'invalid_cursor' });
  });

  it('a stale fingerprint or old generation is request_unavailable', async () => {
    const s = await session('native', 'cc-p');
    await bind(s, 'claude-code', 1);
    await observe(s, [nativePending('claude-code', 1, 'old-gen', claudeApproval(1))]);
    const old = await only(s.sessionId);
    expect(await rejection(answer(s.sessionId, { kind: 'permission', requestId: old.requestId, fingerprint: fp(999), generation: 1, response: { behavior: 'allow', selectedActionId: 'allow_once' } }))).toEqual(UNAVAILABLE);
    expect(await rejection(answer(s.sessionId, { kind: 'permission', requestId: old.requestId, generation: 1, response: { behavior: 'allow', selectedActionId: 'allow_once' } }))).toEqual(UNAVAILABLE);
    expect(await rejection(answer(s.sessionId, { kind: 'permission', requestId: old.requestId, fingerprint: old.fingerprint, generation: 2, response: { behavior: 'allow', selectedActionId: 'allow_once' } }))).toEqual(UNAVAILABLE);
    expect(await rejection(answer(s.sessionId, { kind: 'permission', requestId: 'f'.repeat(32), fingerprint: old.fingerprint, generation: 1, response: { behavior: 'allow', selectedActionId: 'allow_once' } }))).toEqual(UNAVAILABLE);
    await bind(s, 'claude-code', 2);
    await observe(s, [nativePending('claude-code', 2, 'old-gen', claudeApproval(2))]);
    const current = (await getSessionPendingRequests(manager, s.sessionId)).requests;
    expect(current.map((r) => [r.generation, r.requestId])).toEqual([[2, ffRequestId(s.sessionId, 'claude-code', 2, 'old-gen')]]);
    expect(await rejection(answer(s.sessionId, { kind: 'permission', requestId: old.requestId, fingerprint: old.fingerprint, generation: 1, response: { behavior: 'allow', selectedActionId: 'allow_once' } }))).toEqual(UNAVAILABLE);
    expect(await commandsFor(s.sessionId)).toEqual([]);
    const accepted = await answer(s.sessionId, { kind: 'permission', requestId: current[0].requestId, fingerprint: current[0].fingerprint, generation: 2, response: { behavior: 'allow', selectedActionId: 'allow_once' } });
    expect(accepted.created).toBe(true);
    expect((await commandsFor(s.sessionId)).map((c) => c.payload)).toEqual([
      { kind: 'permission', requestId: current[0].requestId, nativeRequestId: 'old-gen', fingerprint: current[0].fingerprint, generation: 2, response: { behavior: 'allow', selectedActionId: 'allow_once' } },
    ]);
  });

  it('a second answer under another idempotency key is request_unavailable', async () => {
    const s = await session('native', 'cc-p');
    await bind(s, 'claude-code', 1);
    await observe(s, [nativePending('claude-code', 1, 'twice', claudeApproval(3))]);
    const r = await only(s.sessionId);
    const body = { kind: 'permission', requestId: r.requestId, fingerprint: r.fingerprint, generation: 1, response: { behavior: 'allow', selectedActionId: 'allow_once' } };
    const first = await answer(s.sessionId, body, 'answer-twice-1');
    expect((await answer(s.sessionId, body, 'answer-twice-1')).commandId).toBe(first.commandId);
    expect(await rejection(answer(s.sessionId, body, 'answer-twice-2'))).toEqual(UNAVAILABLE);
    expect(await rejection(answer(s.sessionId, { ...body, response: { behavior: 'deny', selectedActionId: 'deny' } }, 'answer-twice-3'))).toEqual(UNAVAILABLE);
    await observe(s, [nativePending('claude-code', 1, 'race', claudeApproval(4))]);
    const raceList = (await getSessionPendingRequests(manager, s.sessionId)).requests;
    expect(raceList.map((x) => x.fingerprint)).toContain(fp(4));
    const race = raceList.find((x) => x.fingerprint === fp(4))!;
    const raced = await Promise.allSettled([1, 2, 3].map((n) => answer(s.sessionId, { ...body, requestId: race.requestId, fingerprint: race.fingerprint }, `answer-race-${n}`)));
    expect(raced.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    expect(raced.filter((x) => x.status === 'rejected').map((x) => (x as PromiseRejectedResult).reason.code)).toEqual(['request_unavailable', 'request_unavailable']);
    await rawQuery(`UPDATE collab_connector_commands SET state = 'failed', error_code = 'invalid_response' WHERE id = $1`, [first.commandId]);
    expect((await answer(s.sessionId, body, 'answer-twice-4')).created).toBe(true);
  });

  it('hostOnly allow is answer_on_host and deny is accepted', async () => {
    const s = await session('native', 'cx-p');
    await bind(s, 'codex', 1);
    await observe(s, [nativePending('codex', 1, 'secret-q', codexSecretQuestion(1))]);
    const r = await only(s.sessionId);
    expect(r).toMatchObject({ kind: 'question', backend: 'codex', hostOnly: true, questions: [{ id: 'token', secret: true, options: null, allowOther: true }] });
    expect(await rejection(answer(s.sessionId, { kind: 'permission', requestId: r.requestId, fingerprint: r.fingerprint, generation: 1, response: { behavior: 'allow', selections: { token: { selected: [], other: 'tok-value-1' } } } }))).toEqual(ON_HOST);
    expect(await rejection(answer(s.sessionId, { kind: 'permission', requestId: r.requestId, fingerprint: r.fingerprint, generation: 1, response: { behavior: 'allow', selectedActionId: 'decline' } }))).toEqual(ON_HOST);
    expect(await commandsFor(s.sessionId)).toEqual([]);
    expect(JSON.stringify(await rawQuery(`SELECT * FROM collab_idempotency_records`))).not.toContain(r.requestId);
    const deny = await answer(s.sessionId, { kind: 'permission', requestId: r.requestId, fingerprint: r.fingerprint, generation: 1, response: { behavior: 'deny', selectedActionId: 'decline' } });
    expect(deny.created).toBe(true);
    expect((await commandsFor(s.sessionId)).map((c) => c.payload.response)).toEqual([{ behavior: 'deny', selectedActionId: 'decline' }]);
    const dump = JSON.stringify(await rawQuery(`SELECT payload FROM collab_connector_commands UNION ALL SELECT payload FROM collab_task_events`));
    expect(dump).not.toContain('tok-value-1');
  });

  it('a selectedActionId outside the choices, or a behavior other than the choice\'s, is request_unavailable', async () => {
    const s = await session('native', 'cc-p');
    await bind(s, 'claude-code', 1);
    await observe(s, [nativePending('claude-code', 1, 'choice', claudeApproval(5))]);
    const r = await only(s.sessionId);
    const base = { kind: 'permission', requestId: r.requestId, fingerprint: r.fingerprint, generation: 1 };
    expect(await rejection(answer(s.sessionId, { ...base, response: { behavior: 'allow', selectedActionId: 'always_everything' } }))).toEqual(UNAVAILABLE);
    expect(await rejection(answer(s.sessionId, { ...base, response: { behavior: 'allow', selectedActionId: 'deny' } }))).toEqual(UNAVAILABLE);
    expect(await rejection(answer(s.sessionId, { ...base, response: { behavior: 'deny', selectedActionId: 'allow_once' } }))).toEqual(UNAVAILABLE);
    expect(await rejection(answer(s.sessionId, { ...base, response: { behavior: 'allow' } }))).toEqual(UNAVAILABLE);
    expect(await rejection(answer(s.sessionId, { ...base, behavior: 'deny', response: { behavior: 'allow', selectedActionId: 'allow_once' } }))).toEqual(UNAVAILABLE);
    expect(await commandsFor(s.sessionId)).toEqual([]);
    expect((await answer(s.sessionId, { ...base, behavior: 'deny', response: { behavior: 'deny', selectedActionId: 'deny' } })).created).toBe(true);
  });

  it('choices keep their behavior in the plural DTO', async () => {
    const s = await session('native', 'cx-p');
    await bind(s, 'codex', 1);
    const approval = {
      kind: 'permission', fingerprint: fp('cx'), secret: false, hostOnly: false, questions: null,
      choices: [
        { id: 'accept', label: 'Allow once', scope: 'once', behavior: 'allow' },
        { id: 'network_allow', label: 'Allow this network host', scope: 'session', behavior: 'allow' },
        { id: 'network_deny', label: 'Block this network host', scope: 'session', behavior: 'deny' },
        { id: 'cancel', label: 'Deny and stop this turn', scope: 'once', behavior: 'deny' },
      ],
      detail: { kind: 'command', command: 'curl example.test', reason: 'Fetch the page' },
    };
    await observe(s, [nativePending('codex', 1, 'rpc:7', approval)]);
    const r = await only(s.sessionId);
    expect(r.choices).toEqual(approval.choices);
    expect(r.requestId).toBe(ffRequestId(s.sessionId, 'codex', 1, 'rpc:7'));
    const legacy = await getSessionPendingRequest(manager, s.sessionId);
    expect(legacy?.choices).toEqual(approval.choices.map(({ id, label }) => ({ id, label })));
    expect((await answer(s.sessionId, { kind: 'permission', requestId: r.requestId, fingerprint: r.fingerprint, generation: 1, response: { behavior: 'deny', selectedActionId: 'network_deny' } })).created).toBe(true);
  });

  it('selections outside the offered options are refused', async () => {
    const s = await session('native', 'cc-p');
    await bind(s, 'claude-code', 1);
    await observe(s, [nativePending('claude-code', 1, 'question', claudeQuestion(1))]);
    const r = await only(s.sessionId);
    expect(r).toMatchObject({ kind: 'question', hostOnly: false, questions: [{ id: 'q0', header: 'Pick', question: 'Which colors?' }, { id: 'q1', header: 'Pick', question: 'Which size?' }] });
    const base = { kind: 'permission', requestId: r.requestId, fingerprint: r.fingerprint, generation: 1 };
    const invalid = { status: 400, code: 'invalid_response', message: 'This request does not accept these answers.' };
    expect(r.questions?.map((q) => q.options?.map((o) => [o.id, o.label]))).toEqual([[['o0', 'Red, bright'], ['o1', 'Blue']], [['o0', 'Small'], ['o1', 'Large']]]);
    const bad = [
      { q0: { optionIds: ['o7'] }, q1: { optionIds: ['o0'] } },
      { q0: { optionIds: ['o1'] }, q1: { optionIds: ['o0', 'o1'] } },
      { q0: { optionIds: ['o1', 'o1'] }, q1: { optionIds: ['o0'] } },
      { q0: { optionIds: ['o1'] }, q1: { optionIds: [], other: 'Medium' } },
      { q0: { optionIds: ['o1'] } },
      { q0: { optionIds: ['o1'] }, q1: { optionIds: ['o0'] }, q9: { optionIds: [] } },
      { q0: { optionIds: ['Blue'] }, q1: { optionIds: ['o0'] } },
      { q0: { selected: ['Blue'] }, q1: { selected: ['Small'] } },
      { q0: { optionIds: ['o1'], selected: ['Blue'] }, q1: { optionIds: ['o0'] } },
    ];
    for (const selections of bad) expect(await rejection(answer(s.sessionId, { ...base, response: { behavior: 'allow', selections } }))).toEqual(invalid);
    expect(await rejection(answer(s.sessionId, { ...base, response: { behavior: 'allow', answers: { Pick: 'Blue' } } }))).toEqual(invalid);
    expect(await rejection(answer(s.sessionId, { ...base, response: { behavior: 'allow' } }))).toEqual(invalid);
    expect(await commandsFor(s.sessionId)).toEqual([]);
    const selections = { q0: { optionIds: ['o0', 'o1'], other: 'and teal' }, q1: { optionIds: ['o0'] } };
    expect((await answer(s.sessionId, { ...base, response: { behavior: 'allow', selections } })).created).toBe(true);
    expect((await commandsFor(s.sessionId))[0].payload.response).toEqual({ behavior: 'allow', selections });
  });

  it('fix 1 I2: options that scrub to the same display label stay separately selectable by id', async () => {
    const s = await session('native', 'cc-p');
    await bind(s, 'claude-code', 1);
    await observe(s, [nativePending('claude-code', 1, 'scrubbed', { ...claudeQuestion(2), questions: [
      { id: 'q0', header: 'Pick', question: 'Pick one', options: [{ label: '[local answer]', description: null }, { label: '[local answer]', description: null }, { label: 'Red', description: null }], multiSelect: false, allowOther: true, secret: false },
    ] })]);
    const r = await only(s.sessionId);
    expect(r.hostOnly).toBe(false);
    expect(r.questions?.[0].options).toEqual([{ id: 'o0', label: '[local answer]', description: null }, { id: 'o1', label: '[local answer]', description: null }, { id: 'o2', label: 'Red', description: null }]);
    expect(await rejection(answer(s.sessionId, { kind: 'permission', requestId: r.requestId, fingerprint: r.fingerprint, generation: 1, response: { behavior: 'allow', selections: { q0: { selected: ['[local answer]'] } } } }))).toMatchObject({ code: 'invalid_response' });
    const selections = { q0: { optionIds: ['o1'] } };
    expect((await answer(s.sessionId, { kind: 'permission', requestId: r.requestId, fingerprint: r.fingerprint, generation: 1, response: { behavior: 'allow', selections } })).created).toBe(true);
    const [command] = await commandsFor(s.sessionId);
    expect(command.payload).toEqual({ kind: 'permission', requestId: r.requestId, nativeRequestId: 'scrubbed', fingerprint: r.fingerprint, generation: 1, response: { behavior: 'allow', selections } });
    expect(JSON.stringify(command.payload)).not.toContain('local answer');
  });

  it('Paseo requests keep the answers record', async () => {
    const s = await session('paseo', 'px-legacy');
    await observe(s, [
      { eventId: `paseo-q-${counter}`, kind: 'attention', payload: { attention: 'permission', permissionKind: 'question', requestId: 'paseo-question', promptText: 'Ask', input: { questions: [{ header: 'Next', question: 'What next?', options: [{ label: 'Continue' }] }] } } },
      { eventId: `paseo-t-${counter}`, kind: 'attention', payload: { attention: 'permission', permissionKind: 'tool', requestId: 'paseo-tool', promptText: 'Allow tool', actions: [{ id: 'approve', label: 'Approve' }, { id: 'reject', label: 'Reject' }] } },
    ]);
    const { requests } = await getSessionPendingRequests(manager, s.sessionId);
    expect(requests.map((r) => [r.requestId, r.kind, r.backend, r.generation, r.fingerprint, r.hostOnly, r.questions])).toEqual([
      ['paseo-question', 'question', 'paseo', null, null, false, null],
      ['paseo-tool', 'permission', 'paseo', null, null, false, null],
    ]);
    expect(requests[0].inputSchema).toEqual({ questions: [{ header: 'Next', question: 'What next?', options: [{ label: 'Continue' }] }] });
    expect(requests[1].choices).toEqual([{ id: 'approve', label: 'Approve', scope: null, behavior: null }, { id: 'reject', label: 'Reject', scope: null, behavior: null }]);
    expect(await getSessionPendingRequest(manager, s.sessionId)).toEqual({ requestId: 'paseo-tool', kind: 'permission', promptText: 'Allow tool', choices: [{ id: 'approve', label: 'Approve' }, { id: 'reject', label: 'Reject' }], inputSchema: null, expiresAt: null });
    const answered = await answer(s.sessionId, { kind: 'permission', requestId: 'paseo-question', response: { behavior: 'allow', answers: { Next: 'Continue' } } });
    expect(answered.created).toBe(true);
    expect((await answer(s.sessionId, { kind: 'permission', requestId: 'paseo-tool', response: { behavior: 'deny', selectedActionId: 'reject' } })).created).toBe(true);
    expect((await commandsFor(s.sessionId)).map((c) => c.payload)).toEqual([
      { kind: 'permission', requestId: 'paseo-question', response: { behavior: 'allow', answers: { Next: 'Continue' } } },
      { kind: 'permission', requestId: 'paseo-tool', response: { behavior: 'deny', selectedActionId: 'reject' } },
    ]);
    expect(await rejection(answer(s.sessionId, { kind: 'permission', requestId: 'paseo-question', response: { behavior: 'allow', answers: { Next: 'Again' } } }))).toEqual(UNAVAILABLE);
  });
});
