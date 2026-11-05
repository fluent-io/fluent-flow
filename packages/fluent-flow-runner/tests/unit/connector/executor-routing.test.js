import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createJournal } from '../../../src/connector/journal.js';
import { createExecutor } from '../../../src/connector/executor.js';
import { createPaseoAdapter } from '../../../src/connector/paseo-adapter.js';
import { profileRevision, paseoExecutionProfile, PASEO_HARNESS_VERSION } from '../../../src/connector/catalog.js';
import { SupervisorRequestError } from '../../../src/supervisor/client.js';
import { fakePaseoSdk } from './helpers/fake-paseo.js';

const dirs = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const RUN = '11111111-1111-4111-8111-111111111111';
const SESSION = '22222222-2222-4222-8222-222222222222';
const SESSION2 = '33333333-3333-4333-8333-333333333333';

const paseoLocal = { id: 'p1', name: 'Coder', provider: 'omp', model: 'ai3/x', modeId: 'full', thinkingOptionId: null, featureValues: { plan: true, nested: { a: [1, 2] } } };
const v1Snapshot = { id: 'p1', name: 'Coder', provider: 'omp', model: 'ai3/x', modeId: 'full', thinkingOptionId: null, features: { plan: true, nested: { a: [1, 2] } } };
const claude = { id: 'cc-main', name: 'Claude', backend: 'claude-code', executable: '/opt/claude', contextDir: '/ctx/cc', model: 'claude-model-a', policy: { permissionMode: 'manual' }, summaryProfileId: undefined, complete: true, problems: [] };
const codex = { id: 'cx-main', name: 'Codex', backend: 'codex', executable: '/opt/codex', contextDir: '/ctx/cx', model: 'codex-model-a', policy: { approvalPolicy: 'on-request', sandbox: 'workspace-write', networkAccess: false }, summaryProfileId: undefined, complete: true, problems: [] };
const claudeRev = profileRevision(claude, '2.1.317');
const codexRev = profileRevision(codex, '0.162.1');
const paseoRev = profileRevision(paseoExecutionProfile(paseoLocal), PASEO_HARNESS_VERSION);

function legacyConfig() {
  return { serverUrl: 'http://127.0.0.1:4000', repositories: { repo: '/repos/test' }, profiles: ['p1'] };
}
function loadedConfig({ paseo = true, profiles = [claude, codex] } = {}) {
  return { serverUrl: 'http://127.0.0.1:4000', repositories: { repo: '/repos/test' }, profiles, capacity: { 'claude-code': 1, codex: 1 }, integrations: { paseo: { enabled: paseo, savedProfileIds: paseo ? ['p1'] : [], home: null, cliPath: null } }, paseo: { home: null, cliPath: null } };
}

function fakeSupervisor(script = {}) {
  const requests = [];
  return {
    requests,
    async request(method, params = {}) {
      requests.push({ method, params: structuredClone(params) });
      const answer = script[`${method}:${params.kind ?? ''}`] ?? script[method];
      if (answer instanceof Error) throw answer;
      if (typeof answer === 'function') return answer(params);
      if (answer) return structuredClone(answer);
      if (method === 'submit' && ['launch', 'create_session', 'summarize'].includes(params.kind)) {
        return { state: 'accepted', binding: { workspaceRef: 'ffw_0123456789abcdef', nativeSessionId: params.kind === 'launch' ? 'native-1' : 'native-2', generation: 1 } };
      }
      return { state: 'applied' };
    },
  };
}

function setup({ config, native = null, withAdapter = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ff-routing-'));
  dirs.push(dir);
  const journal = createJournal({ dir });
  const paseo = fakePaseoSdk();
  const adapter = withAdapter ? createPaseoAdapter({ paseo, journal }) : null;
  const executor = createExecutor({ config, adapter, native, journal, catalogProfiles: [v1Snapshot], paseoProfiles: [paseoLocal], log: () => {} });
  return { dir, journal, paseo, executor };
}

function records(dir) {
  return readFileSync(join(dir, 'journal.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).map((r) => {
    const { at, recordedAt, payloadDigest, ...rest } = r;
    return rest;
  });
}

const launch = (payload, id = 'launch-1') => ({ id, runId: RUN, sessionId: SESSION, kind: 'launch', payload: { repositoryKey: 'repo', profileId: 'p1', profileSnapshot: v1Snapshot, model: null, prompt: 'Do the bounded task.', workspace: { mode: 'worktree', branchName: `ff/run-${RUN}`, baseRef: 'main' }, ...payload } });
const nativeLaunch = (backend, profile, rev, extra = {}) => launch({ profileId: profile.id, profileSnapshot: { id: profile.id, backend, model: profile.model, revision: rev }, model: profile.model, reportingCredential: 'session-reporting-credential', execution: { schemaVersion: 2, backend, profileId: profile.id, profileRevision: rev }, ...extra });

describe('executor routing (Task 7)', () => {
  let supervisor;
  beforeEach(() => {
    supervisor = fakeSupervisor();
  });

  it('v1 commands produce the same journal records as before', async () => {
    const before = setup({ config: legacyConfig() });
    const after = setup({ config: legacyConfig(), native: supervisor });
    for (const { executor } of [before, after]) {
      const bound = await executor.execute(launch({}));
      expect(bound).toMatchObject({ stage: 'bound', state: 'accepted' });
      expect((await executor.complete(launch({}))).state).toBe('applied');
    }
    expect(records(after.dir)).toEqual(records(before.dir));
    expect(after.paseo.state.agentCreateCalls).toEqual(before.paseo.state.agentCreateCalls);
    expect(supervisor.requests).toEqual([]);
  });

  it('v2 paseo commands write the same journal records as v1 and leave the envelope to the adapter', async () => {
    const v1 = setup({ config: loadedConfig() });
    const v2 = setup({ config: loadedConfig(), native: supervisor });
    await v1.executor.execute(launch({}));
    await v1.executor.complete(launch({}));
    const v2Launch = launch({ profileSnapshot: { id: 'p1', backend: 'paseo', model: 'ai3/x', revision: paseoRev, policy: { modeId: 'full' } }, model: 'ai3/x', execution: { schemaVersion: 2, backend: 'paseo', profileId: 'p1', profileRevision: paseoRev } });
    expect((await v2.executor.execute(v2Launch)).state).toBe('accepted');
    expect((await v2.executor.complete(v2Launch)).state).toBe('applied');
    expect(records(v2.dir)).toEqual(records(v1.dir));
    const created = v2.paseo.state.agentCreateCalls[0];
    expect(created).toEqual(v1.paseo.state.agentCreateCalls[0]);
    expect(JSON.stringify(created)).not.toContain('execution');
    expect(JSON.stringify(created)).toContain('"nested"');
    expect(supervisor.requests).toEqual([]);
    expect(v2.journal.bindingForRun(RUN)).toMatchObject({ paseoAgentId: expect.any(String) });
  });

  it('v2 native commands reach the supervisor by frozen backend', async () => {
    const { executor, journal } = setup({ config: loadedConfig({ paseo: false }), native: supervisor, withAdapter: false });
    const command = nativeLaunch('claude-code', claude, claudeRev);
    const bound = await executor.execute(command);
    expect(bound).toMatchObject({ stage: 'bound', state: 'accepted', result: { workspaceRef: 'ffw_0123456789abcdef', nativeSessionId: 'native-1' } });
    expect(supervisor.requests[0]).toEqual({ method: 'submit', params: expect.objectContaining({ commandId: 'launch-1', runId: RUN, sessionId: SESSION, backend: 'claude-code', kind: 'launch', profileId: 'cc-main', profileRevision: claudeRev, repositoryKey: 'repo', branchName: `ff/run-${RUN}`, baseRef: 'main', reporting: { url: 'http://127.0.0.1:4000/mcp/collab', credential: 'session-reporting-credential' } }) });
    expect(supervisor.requests[0].params.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(bound.observations.map((o) => [o.kind, o.payload])).toEqual([
      ['workspace_bound', { workspaceRef: 'ffw_0123456789abcdef', backend: 'claude-code' }],
      ['session_bound', { backend: 'claude-code', nativeSessionId: 'native-1', generation: 1 }],
    ]);
    const binding = journal.bindingForSession(RUN, SESSION);
    expect(binding).toMatchObject({ backend: 'claude-code', nativeSessionId: 'native-1', workspaceRef: 'ffw_0123456789abcdef', generation: 1 });
    expect(binding.paseoAgentId).toBeUndefined();
    const delivered = await executor.complete(command);
    expect(delivered.state).toBe('applied');
    expect(supervisor.requests[1]).toEqual({ method: 'deliver', params: { commandId: 'launch-1', digest: supervisor.requests[0].params.digest, text: 'Do the bounded task.' } });
    const prompt = { id: 'prompt-1', runId: RUN, sessionId: SESSION, kind: 'prompt', payload: { text: 'more', behavior: 'steer', execution: { schemaVersion: 2, backend: 'claude-code', profileId: 'cc-main', profileRevision: claudeRev } } };
    expect((await executor.execute(prompt)).state).toBe('applied');
    expect(supervisor.requests[2]).toEqual({ method: 'submit', params: expect.objectContaining({ commandId: 'prompt-1', backend: 'claude-code', kind: 'prompt', profileId: 'cc-main', profileRevision: claudeRev, text: 'more', behavior: 'steer' }) });
    const cx = setup({ config: loadedConfig({ paseo: false }), native: supervisor, withAdapter: false });
    await cx.executor.execute({ ...nativeLaunch('codex', codex, codexRev), id: 'launch-cx', runId: '44444444-4444-4444-8444-444444444444' });
    expect(supervisor.requests.at(-1).params).toMatchObject({ commandId: 'launch-cx', backend: 'codex', profileId: 'cx-main', profileRevision: codexRev });
  });

  it('revision drift fails execution_settings_changed with no supervisor call', async () => {
    const drifted = { ...claude, policy: { permissionMode: 'plan' } };
    const { executor } = setup({ config: loadedConfig({ paseo: false, profiles: [drifted] }), native: supervisor, withAdapter: false });
    expect(await executor.execute(nativeLaunch('claude-code', claude, claudeRev))).toEqual({ state: 'failed', errorCode: 'execution_settings_changed' });
    const withdrawn = setup({ config: loadedConfig({ paseo: false, profiles: [codex] }), native: supervisor, withAdapter: false });
    expect(await withdrawn.executor.execute(nativeLaunch('claude-code', claude, claudeRev))).toEqual({ state: 'failed', errorCode: 'execution_settings_changed' });
    const moved = setup({ config: loadedConfig({ paseo: false, profiles: [{ ...codex, id: 'cc-main' }] }), native: supervisor, withAdapter: false });
    expect(await moved.executor.execute(nativeLaunch('claude-code', claude, claudeRev))).toEqual({ state: 'failed', errorCode: 'execution_settings_changed' });
    const paseoDrift = setup({ config: loadedConfig(), native: supervisor });
    const stale = launch({ execution: { schemaVersion: 2, backend: 'paseo', profileId: 'p1', profileRevision: 'ffffffffffffffff' } });
    expect(await paseoDrift.executor.execute(stale)).toEqual({ state: 'failed', errorCode: 'execution_settings_changed' });
    expect(paseoDrift.paseo.state.createCalls).toEqual([]);
    expect(supervisor.requests).toEqual([]);
  });

  it('a v2 Paseo follow-up prompt requires the exact local revision; stale or withdrawn sends nothing', async () => {
    const config = loadedConfig();
    const t = setup({ config, native: supervisor });
    const v2Launch = launch({ profileSnapshot: { id: 'p1', backend: 'paseo', model: 'ai3/x', revision: paseoRev }, model: 'ai3/x', execution: { schemaVersion: 2, backend: 'paseo', profileId: 'p1', profileRevision: paseoRev } });
    expect((await t.executor.execute(v2Launch)).state).toBe('accepted');
    const sendsAfterLaunch = t.paseo.state.sends.length;
    const prompt = (id, execution) => ({ id, runId: RUN, sessionId: SESSION, kind: 'prompt', payload: { text: 'more', behavior: 'steer', ...(execution ? { execution } : {}) } });
    expect(await t.executor.execute(prompt('p-stale', { schemaVersion: 2, backend: 'paseo', profileId: 'p1', profileRevision: 'ffffffffffffffff' }))).toEqual({ state: 'failed', errorCode: 'execution_settings_changed' });
    expect(await t.executor.execute(prompt('p-gone', { schemaVersion: 2, backend: 'paseo', profileId: 'withdrawn-profile', profileRevision: paseoRev }))).toEqual({ state: 'failed', errorCode: 'profile_not_allowed' });
    expect(t.paseo.state.sends).toHaveLength(sendsAfterLaunch);
    expect((await t.executor.execute(prompt('p-ok', { schemaVersion: 2, backend: 'paseo', profileId: 'p1', profileRevision: paseoRev }))).state).toBe('applied');
    expect(t.paseo.state.sends).toHaveLength(sendsAfterLaunch + 1);
    expect((await t.executor.execute(prompt('p-v1'))).state).toBe('applied');
    expect(t.paseo.state.sends).toHaveLength(sendsAfterLaunch + 2);
    const withdrawn = setup({ config: loadedConfig(), native: supervisor });
    await withdrawn.executor.execute(v2Launch);
    const sends = withdrawn.paseo.state.sends.length;
    const noLocal = createExecutor({ config: loadedConfig(), adapter: createPaseoAdapter({ paseo: withdrawn.paseo, journal: withdrawn.journal }), native: supervisor, journal: withdrawn.journal, catalogProfiles: [v1Snapshot], paseoProfiles: [], log: () => {} });
    expect(await noLocal.execute(prompt('p-after', { schemaVersion: 2, backend: 'paseo', profileId: 'p1', profileRevision: paseoRev }))).toEqual({ state: 'failed', errorCode: 'execution_settings_changed' });
    expect(withdrawn.paseo.state.sends).toHaveLength(sends);
    expect(supervisor.requests).toEqual([]);
  });

  it('a legacy command with Paseo disabled fails integration_disabled', async () => {
    const { executor, journal } = setup({ config: loadedConfig({ paseo: false }), native: supervisor, withAdapter: false });
    expect(await executor.execute(launch({}))).toEqual({ state: 'failed', errorCode: 'integration_disabled' });
    expect(await executor.execute(launch({ execution: { schemaVersion: 2, backend: 'paseo', profileId: 'p1', profileRevision: paseoRev } }, 'launch-2'))).toEqual({ state: 'failed', errorCode: 'integration_disabled' });
    expect(await executor.execute({ id: 'cancel-1', runId: RUN, sessionId: SESSION, kind: 'cancel', payload: {} })).toEqual({ state: 'failed', errorCode: 'integration_disabled' });
    expect(supervisor.requests).toEqual([]);
    expect(journal.bindingForRun(RUN)).toBeNull();
  });

  it('an unknown execution schema fails profile_unavailable', async () => {
    const { executor } = setup({ config: loadedConfig(), native: supervisor });
    for (const [i, execution] of [{ schemaVersion: 3, backend: 'claude-code', profileId: 'cc-main', profileRevision: claudeRev }, { schemaVersion: 2, backend: 'gemini', profileId: 'cc-main', profileRevision: claudeRev }, { schemaVersion: 2 }, 'v2', null].entries()) {
      expect(await executor.execute(launch({ execution }, `launch-${i}`)), JSON.stringify(execution)).toEqual({ state: 'failed', errorCode: 'profile_unavailable' });
    }
    expect(supervisor.requests).toEqual([]);
  });

  it('a native command with no supervisor composed fails profile_unavailable', async () => {
    const { executor } = setup({ config: loadedConfig({ paseo: false }), native: null, withAdapter: false });
    expect(await executor.execute(nativeLaunch('codex', codex, codexRev))).toEqual({ state: 'failed', errorCode: 'profile_unavailable' });
  });

  it('a supervisor reconciling outcome or a lost reply acks ambiguous', async () => {
    const reconciling = fakeSupervisor({ 'submit:launch': { state: 'reconciling' } });
    const one = setup({ config: loadedConfig({ paseo: false }), native: reconciling, withAdapter: false });
    expect(await one.executor.execute(nativeLaunch('claude-code', claude, claudeRev))).toMatchObject({ state: 'ambiguous' });
    expect(one.journal.bindingForRun(RUN)).toBeNull();
    const lost = fakeSupervisor({ 'submit:launch': new SupervisorRequestError('submit', 'connection_closed') });
    const two = setup({ config: loadedConfig({ paseo: false }), native: lost, withAdapter: false });
    expect(await two.executor.execute(nativeLaunch('claude-code', claude, claudeRev))).toEqual({ state: 'ambiguous', errorCode: 'supervisor_unavailable' });
    const failed = fakeSupervisor({ 'submit:launch': { state: 'failed', errorCode: 'sign_in_required' } });
    const three = setup({ config: loadedConfig({ paseo: false }), native: failed, withAdapter: false });
    expect(await three.executor.execute(nativeLaunch('claude-code', claude, claudeRev))).toEqual({ state: 'failed', errorCode: 'sign_in_required' });
  });

  it('a Task 9 native answer sends the native request id, generation and fingerprint and resolves the FF request id', async () => {
    const { executor } = setup({ config: loadedConfig({ paseo: false }), native: supervisor, withAdapter: false });
    await executor.execute(nativeLaunch('codex', codex, codexRev));
    await executor.complete(nativeLaunch('codex', codex, codexRev));
    const selections = { color: { selected: ['Red'], other: 'and teal' } };
    const answer = { id: 'perm-9', runId: RUN, sessionId: SESSION, kind: 'permission', payload: { kind: 'permission', requestId: 'a'.repeat(32), nativeRequestId: 'q-native-1', fingerprint: 'b'.repeat(64), generation: 1, response: { behavior: 'allow', selections } } };
    const result = await executor.execute(answer);
    expect(result.state).toBe('applied');
    expect(supervisor.requests.at(-1).params).toMatchObject({ commandId: 'perm-9', kind: 'permission', nativeRequestId: 'q-native-1', generation: 1, fingerprint: 'b'.repeat(64), response: { behavior: 'allow', selections } });
    expect(result.result).toEqual({ requestId: 'a'.repeat(32) });
    expect(result.observations.map((o) => o.payload)).toEqual([expect.objectContaining({ attention: 'permission_resolved', requestId: 'a'.repeat(32) })]);
  });

  it('controls on an owned native session reach its recorded worker after the profile is withdrawn or drifts', async () => {
    const config = loadedConfig({ paseo: false });
    const { executor } = setup({ config, native: supervisor, withAdapter: false });
    await executor.execute(nativeLaunch('codex', codex, codexRev));
    await executor.complete(nativeLaunch('codex', codex, codexRev));
    config.profiles = [];
    const permission = { id: 'perm-1', runId: RUN, sessionId: SESSION, kind: 'permission', payload: { requestId: 'rpc:7', response: { behavior: 'allow', selectedActionId: 'accept' } } };
    expect((await executor.execute(permission)).state).toBe('applied');
    expect(supervisor.requests.at(-1)).toEqual({ method: 'submit', params: expect.objectContaining({ commandId: 'perm-1', backend: 'codex', kind: 'permission', nativeRequestId: 'rpc:7', response: { behavior: 'allow', selectedActionId: 'accept' } }) });
    expect(supervisor.requests.at(-1).params.profileRevision).toBeUndefined();
    const cancel = { id: 'cancel-1', runId: RUN, sessionId: SESSION, kind: 'cancel', payload: {} };
    const cancelled = await executor.execute(cancel);
    expect(cancelled.state).toBe('applied');
    expect(cancelled.observations.map((o) => o.payload.state)).toEqual(['cancel_requested']);
    expect(supervisor.requests.at(-1)).toEqual({ method: 'submit', params: expect.objectContaining({ commandId: 'cancel-1', backend: 'codex', kind: 'cancel' }) });
    const count = supervisor.requests.length;
    const prompt = { id: 'prompt-9', runId: RUN, sessionId: SESSION, kind: 'prompt', payload: { text: 'more', execution: { schemaVersion: 2, backend: 'codex', profileId: 'cx-main', profileRevision: codexRev } } };
    expect(await executor.execute(prompt)).toEqual({ state: 'failed', errorCode: 'execution_settings_changed' });
    expect(supervisor.requests).toHaveLength(count);
    config.profiles = [codex, claude];
    const crossed = { id: 'prompt-10', runId: RUN, sessionId: SESSION, kind: 'prompt', payload: { text: 'x', execution: { schemaVersion: 2, backend: 'claude-code', profileId: 'cc-main', profileRevision: claudeRev } } };
    expect(await executor.execute(crossed)).toEqual({ state: 'failed', errorCode: 'execution_settings_changed' });
    expect(supervisor.requests).toHaveLength(count);
  });

  it('additional native sessions open in the run worktree on the frozen backend', async () => {
    const { executor } = setup({ config: loadedConfig({ paseo: false }), native: supervisor, withAdapter: false });
    await executor.execute(nativeLaunch('claude-code', claude, claudeRev));
    const create = { id: 'create-2', runId: RUN, sessionId: SESSION2, kind: 'create_session', payload: { profileId: 'cc-main', profileSnapshot: { id: 'cc-main' }, model: 'claude-model-a', prompt: 'second', reportingCredential: 'second-credential', execution: { schemaVersion: 2, backend: 'claude-code', profileId: 'cc-main', profileRevision: claudeRev } } };
    const bound = await executor.execute(create);
    expect(bound).toMatchObject({ stage: 'bound', state: 'accepted', result: { nativeSessionId: 'native-2' } });
    expect(supervisor.requests.at(-1).params).toMatchObject({ kind: 'create_session', sessionId: SESSION2, backend: 'claude-code', repositoryKey: 'repo' });
    expect(bound.observations.map((o) => o.kind)).toEqual(['session_bound']);
  });
});

describe('capacity deferral and claimed cancel (Task 10)', () => {
  it('a launch the host had no slot for is deferred unacknowledged, carries the server slot grant, and its claimed cancel reaches the supervisor', async () => {
    const supervisor = fakeSupervisor({ 'submit:launch': { state: 'deferred' }, 'submit:cancel': { state: 'applied', dispatched: false } });
    const { executor } = setup({ config: loadedConfig({ paseo: false }), native: supervisor, withAdapter: false });
    const command = { ...nativeLaunch('codex', codex, codexRev), slotGranted: true };
    expect(await executor.execute(command)).toEqual({ state: 'deferred' });
    expect(supervisor.requests[0].params).toMatchObject({ kind: 'launch', backend: 'codex', slotGranted: true });
    const cancel = { id: 'cancel-1', runId: RUN, sessionId: SESSION, kind: 'cancel', payload: { kind: 'cancel' }, nativeBackend: 'codex' };
    const cancelled = await executor.execute(cancel);
    expect(supervisor.requests[1]).toEqual({ method: 'submit', params: expect.objectContaining({ commandId: 'cancel-1', runId: RUN, sessionId: SESSION, backend: 'codex', kind: 'cancel' }) });
    expect(cancelled).toMatchObject({ state: 'applied', result: { cancelRequested: true, dispatched: false } });
    expect(cancelled.observations.map((o) => [o.kind, o.payload])).toEqual([['state', { state: 'cancelled', dispatched: false, cancelCommandId: 'cancel-1' }]]);
  });

  it('Task 11: an operator closure reported by the supervisor is observed as cancelled, bound or not', async () => {
    const unbound = fakeSupervisor({ 'submit:cancel': { state: 'applied', closure: 'operator' } });
    const first = setup({ config: loadedConfig({ paseo: false }), native: unbound, withAdapter: false });
    const cancel = { id: 'cancel-1', runId: RUN, sessionId: SESSION, kind: 'cancel', payload: { kind: 'cancel' }, nativeBackend: 'codex' };
    const closedUnbound = await first.executor.execute(cancel);
    expect(closedUnbound).toMatchObject({ state: 'applied', result: { cancelRequested: true, closure: 'operator' } });
    expect(closedUnbound.observations.map((o) => [o.kind, o.payload])).toEqual([['state', { state: 'cancelled', closure: 'operator', cancelCommandId: 'cancel-1' }]]);
    const bound = fakeSupervisor({ 'submit:cancel': { state: 'applied', closure: 'operator' } });
    const second = setup({ config: loadedConfig({ paseo: false }), native: bound, withAdapter: false });
    await second.executor.execute(nativeLaunch('codex', codex, codexRev));
    const closedBound = await second.executor.execute({ id: 'cancel-2', runId: RUN, sessionId: SESSION, kind: 'cancel', payload: {} });
    expect(closedBound.observations.map((o) => [o.kind, o.payload])).toEqual([['state', { state: 'cancelled', closure: 'operator', cancelCommandId: 'cancel-2' }]]);
  });

  it('a Cancel for a native run with no binding goes to the supervisor by its frozen backend, with or without Paseo', async () => {
    for (const withAdapter of [false, true]) {
      const supervisor = fakeSupervisor({ 'submit:cancel': { state: 'applied', dispatched: false } });
      const { executor, paseo } = setup({ config: loadedConfig({ paseo: withAdapter }), native: supervisor, withAdapter });
      const cancel = { id: 'cancel-1', runId: RUN, sessionId: SESSION, kind: 'cancel', payload: { kind: 'cancel' }, nativeBackend: 'codex' };
      const result = await executor.execute(cancel);
      expect(supervisor.requests).toEqual([{ method: 'submit', params: expect.objectContaining({ commandId: 'cancel-1', runId: RUN, sessionId: SESSION, backend: 'codex', kind: 'cancel' }) }]);
      expect(result).toMatchObject({ state: 'applied', result: { cancelRequested: true, dispatched: false } });
      expect(result.observations.map((o) => o.payload)).toEqual([{ state: 'cancelled', dispatched: false, cancelCommandId: 'cancel-1' }]);
      if (withAdapter) expect(JSON.stringify(paseo.calls ?? [])).not.toContain('cancel');
    }
  });

  it('a redelivered native launch passes slotHeld to the supervisor', async () => {
    const supervisor = fakeSupervisor();
    const { executor } = setup({ config: loadedConfig({ paseo: false }), native: supervisor, withAdapter: false });
    await executor.execute({ ...nativeLaunch('codex', codex, codexRev), slotHeld: true });
    expect(supervisor.requests[0].params).toMatchObject({ kind: 'launch', slotHeld: true });
    expect(supervisor.requests[0].params.slotGranted).toBeUndefined();
  });
});
