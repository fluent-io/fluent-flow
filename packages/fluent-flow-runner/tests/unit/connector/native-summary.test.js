import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createJournal } from '../../../src/connector/journal.js';
import { createExecutor } from '../../../src/connector/executor.js';
import { createPaseoAdapter } from '../../../src/connector/paseo-adapter.js';
import { profileRevision } from '../../../src/connector/catalog.js';
import { nativeObservation } from '../../../src/connector/native-events.js';
import { nativeCursorEpoch } from '../../../src/supervisor/summary.js';
import { fakePaseoSdk } from './helpers/fake-paseo.js';

const dirs = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const RUN = '11111111-1111-4111-8111-111111111111';
const WORK = '22222222-2222-4222-8222-222222222222';
const SUMMARY = '33333333-3333-4333-8333-333333333333';
const claude = { id: 'cc-main', name: 'Claude', backend: 'claude-code', executable: '/opt/claude', contextDir: '/ctx/cc', model: 'claude-model-a', policy: { permissionMode: 'manual' }, complete: true, problems: [] };
const claudeSummary = { ...claude, id: 'cc-summary', name: 'Claude summary', model: 'claude-summary-model' };
const codex = { id: 'cx-main', name: 'Codex', backend: 'codex', executable: '/opt/codex', contextDir: '/ctx/cx', model: 'codex-model-a', policy: { approvalPolicy: 'on-request', sandbox: 'workspace-write', networkAccess: false }, complete: true, problems: [] };
const summaryRev = profileRevision(claudeSummary, '2.1.317');
const codexRev = profileRevision(codex, '0.162.1');
const config = { serverUrl: 'http://127.0.0.1:4000', repositories: { repo: '/repos/test' }, profiles: [claude, claudeSummary, codex], capacity: { 'claude-code': 1, codex: 1 }, integrations: { paseo: { enabled: true, savedProfileIds: ['p1'], home: null, cliPath: null } }, paseo: { home: null, cliPath: null } };
const SERVER_PROMPT = 'Summarize the supplied task and execution history.';
const paseoLocal = { id: 'p1', name: 'Coder', provider: 'omp', model: 'ai3/x', modeId: 'full', thinkingOptionId: null, featureValues: {} };
const v1Snapshot = { id: 'p1', name: 'Coder', provider: 'omp', model: 'ai3/x', modeId: 'full', thinkingOptionId: null, features: {} };

function fakeSupervisor(script = {}) {
  const requests = [];
  return {
    requests,
    async request(method, params = {}) {
      requests.push({ method, params: structuredClone(params) });
      const answer = script[method];
      if (answer instanceof Error) throw answer;
      if (typeof answer === 'function') return answer(params);
      if (answer) return structuredClone(answer);
      if (method === 'submit') return { state: 'accepted', binding: { workspaceRef: 'ffw_0123456789abcdef', nativeSessionId: `native-${params.sessionId}`, generation: 1 } };
      return { state: 'applied' };
    },
  };
}

async function setup(script) {
  const dir = mkdtempSync(join(tmpdir(), 'ff-native-summary-'));
  dirs.push(dir);
  const journal = createJournal({ dir });
  const paseo = fakePaseoSdk();
  const supervisor = fakeSupervisor(script);
  const executor = createExecutor({ config, adapter: createPaseoAdapter({ paseo, journal }), native: supervisor, journal, catalogProfiles: [v1Snapshot], paseoProfiles: [paseoLocal], log: () => {} });
  await journal.append({ type: 'intent', commandId: 'launch-0', runId: RUN, sessionId: WORK, kind: 'launch', payloadDigest: 'x', recordedAt: '2026-11-05T00:00:00.000Z' });
  await journal.append({ type: 'binding', commandId: 'launch-0', runId: RUN, sessionId: WORK, backend: 'claude-code', nativeSessionId: WORK, workspaceRef: 'ffw_0123456789abcdef', generation: 1, repositoryKey: 'repo', role: 'work' });
  return { journal, paseo, supervisor, executor };
}

const summarize = (payload = {}, id = 'summary-1') => ({ id, runId: RUN, sessionId: SUMMARY, kind: 'summarize', payload: {
  profileId: 'cc-summary', model: 'claude-summary-model', prompt: SERVER_PROMPT, reportingCredential: 'summary-session-credential', sourceSessionId: WORK,
  sourceCursor: { epoch: nativeCursorEpoch('claude-code'), seq: '7' }, execution: { schemaVersion: 2, backend: 'claude-code', profileId: 'cc-summary', profileRevision: summaryRev }, ...payload } });

describe('native summaries (Task 8)', () => {
  it('native observations carry the supervisor cursor domain: the backend epoch and the spool sequence', () => {
    const obs = nativeObservation({ seq: 42, sessionId: WORK, runId: RUN, generation: 1, kind: 'timeline', nativeEventId: 'a1', at: '2026-11-05T00:00:00.000Z', payload: { backend: 'claude-code', event: { type: 'assistant_text', text: 'x' } } });
    expect(obs.providerCursor).toEqual({ epoch: nativeCursorEpoch('claude-code'), seq: '42' });
  });

  it('an explicit summary runs on its frozen same-backend profile and hands the supervisor the exact frozen source reference', async () => {
    const t = await setup();
    const bound = await t.executor.execute(summarize());
    expect(bound.state, JSON.stringify(bound)).toBe('accepted');
    const submit = t.supervisor.requests.find((r) => r.method === 'submit');
    expect(submit.params).toMatchObject({ kind: 'summarize', role: 'summary', backend: 'claude-code', profileId: 'cc-summary', profileRevision: summaryRev,
      summarySource: { sessionId: WORK, sourceCursor: { epoch: nativeCursorEpoch('claude-code'), seq: 7 } } });
    expect((await t.executor.complete(summarize())).state).toBe('applied');
    const deliver = t.supervisor.requests.find((r) => r.method === 'deliver');
    expect(deliver.params.text).toBe(SERVER_PROMPT);
    expect(t.supervisor.requests.map((r) => r.method)).toEqual(['submit', 'deliver']);
    expect(t.journal.bindingForSession(RUN, SUMMARY)).toMatchObject({ role: 'summary', model: 'claude-summary-model', sourceCursor: { epoch: nativeCursorEpoch('claude-code'), seq: '7' } });
    expect(t.paseo.state.agentCreateCalls).toEqual([]);
  });

  it.each([
    ['no cursor', { sourceCursor: null }],
    ['a Paseo cursor', { sourceCursor: { epoch: 'paseo-epoch', seq: '7' } }],
    ['another backend\'s cursor domain', { sourceCursor: { epoch: nativeCursorEpoch('codex'), seq: '7' } }],
    ['an unparseable sequence', { sourceCursor: { epoch: nativeCursorEpoch('claude-code'), seq: 'seven' } }],
    ['an unbound source session', { sourceSessionId: '55555555-5555-4555-8555-555555555555' }],
  ])('%s refuses the summary before any worker starts', async (_name, payload) => {
    const t = await setup();
    expect(await t.executor.execute(summarize(payload))).toMatchObject({ state: 'failed', errorCode: 'summary_unavailable' });
    expect(t.supervisor.requests.filter((r) => r.method === 'submit')).toEqual([]);
    expect(t.paseo.state.agentCreateCalls).toEqual([]);
  });

  it('incomplete supervisor history refuses the summary; it never retries on another model or backend', async () => {
    const t = await setup({ submit: { state: 'failed', errorCode: 'summary_unavailable' } });
    expect(await t.executor.execute(summarize())).toMatchObject({ state: 'failed', errorCode: 'summary_unavailable' });
    expect(t.supervisor.requests.map((r) => r.method)).toEqual(['submit']);
    expect(t.paseo.state.agentCreateCalls).toEqual([]);
  });

  it('a summary profile on another backend is refused', async () => {
    const t = await setup();
    const crossed = summarize({ profileId: 'cx-main', model: 'codex-model-a', execution: { schemaVersion: 2, backend: 'codex', profileId: 'cx-main', profileRevision: codexRev } });
    expect(await t.executor.execute(crossed)).toMatchObject({ state: 'failed', errorCode: 'execution_settings_changed' });
    expect(t.supervisor.requests.filter((r) => r.method === 'submit')).toEqual([]);
  });

  it('a summarize command without a frozen native profile (summaries disabled) on a native run starts no worker, Paseo included', async () => {
    const t = await setup();
    const disabled = { id: 'summary-2', runId: RUN, sessionId: SUMMARY, kind: 'summarize', payload: { profileId: 'p1', profileSnapshot: v1Snapshot, model: null, prompt: SERVER_PROMPT, sourceSessionId: WORK } };
    const result = await t.executor.execute(disabled).catch((err) => ({ thrown: err.message }));
    expect(result).toMatchObject({ state: 'failed', errorCode: 'summary_disabled' });
    expect(t.supervisor.requests).toEqual([]);
    expect(t.paseo.state.agentCreateCalls).toEqual([]);
  });
});
