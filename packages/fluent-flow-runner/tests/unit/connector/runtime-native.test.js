import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, chmodSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConnectorRuntime, attachOrLaunchSupervisor } from '../../../src/connector/runtime.js';
import { loadConnectorConfig } from '../../../src/connector/config.js';
import { profileRevision, paseoExecutionProfile, PASEO_HARNESS_VERSION } from '../../../src/connector/catalog.js';
import { fakePaseoSdk } from './helpers/fake-paseo.js';
import { SupervisorUnavailable, OwnerLockHeld } from '../../../src/supervisor/owner-lock.js';
import { nativeCursorEpoch } from '../../../src/supervisor/summary.js';

const RUN = '11111111-1111-4111-8111-111111111111';
const S1 = '22222222-2222-4222-8222-222222222222';
const dirs = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function standaloneConfig() {
  const dir = mkdtempSync(join(tmpdir(), 'ff-runtime-native-'));
  dirs.push(dir);
  mkdirSync(join(dir, 'repo'));
  mkdirSync(join(dir, 'ctx'), { mode: 0o700 });
  chmodSync(join(dir, 'ctx'), 0o700);
  writeFileSync(join(dir, 'tool'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  writeFileSync(join(dir, 'token'), 'ffh_runtime_native\n', { mode: 0o600 });
  const file = join(dir, 'connector.json');
  writeFileSync(file, JSON.stringify({ serverUrl: 'http://127.0.0.1:9', tokenFile: join(dir, 'token'), instanceId: 'native-rt', repositories: { repo: join(dir, 'repo') },
    profiles: [{ id: 'cc-main', name: 'Claude', backend: 'claude-code', executable: join(dir, 'tool'), contextDir: join(dir, 'ctx'), model: 'claude-model-a', policy: { permissionMode: 'manual' } }] }));
  return { dir, file, config: loadConnectorConfig({ file }) };
}

function fakeSupervisor(events = []) {
  const requests = [];
  let delivered = 0;
  return {
    requests,
    events,
    async request(method, params = {}) {
      requests.push({ method, params });
      if (method === 'status') return { containment: { state: 'verified' }, admissionStopped: false, workers: [], profiles: [{ id: 'cc-main', backend: 'claude-code', readiness: { state: 'ready' } }] };
      if (method === 'hello') return { deliveredSeq: delivered, admissionStopped: false };
      if (method === 'events') return { events: events.filter((e) => e.seq > params.afterSeq) };
      if (method === 'ackEvents') { delivered = params.uptoSeq; return { deliveredSeq: delivered }; }
      if (method === 'workspace') return { workspaceDir: null };
      if (method === 'submit') return { state: 'accepted', binding: { workspaceRef: 'ffw_0123456789abcdef', nativeSessionId: S1, generation: 1 } };
      if (method === 'deliver') return { state: 'applied' };
      if (method === 'controlPlaneStatus') return { recorded: true };
      throw new Error(`unexpected ${method}`);
    },
    async close() {},
  };
}

function fakeClient() {
  const registrations = [];
  const observed = [];
  return {
    registrations,
    observed,
    register: async (body) => { registrations.push(body); return { connectorSessionId: 'fence', leaseEpoch: 1, heartbeatIntervalMs: 50 }; },
    heartbeat: async () => ({ leaseEpoch: 1 }),
    poll: async () => { await new Promise((r) => setTimeout(r, 5)); return { commands: [] }; },
    observe: async (body) => { observed.push(...body.events); return { acceptedEventIds: body.events.map((e) => e.eventId) }; },
    ack: async (_id, body) => ({ state: body.state }),
  };
}

describe('connector runtime with standalone backends (Task 7)', () => {
  it('attaches to a running supervisor, and launches one only when none answers', async () => {
    const calls = [];
    const client = { request: async () => ({}) };
    const connect = async () => { calls.push('connect'); return client; };
    const launch = async () => { calls.push('launch'); return { pid: 1 }; };
    expect(await attachOrLaunchSupervisor({ stateDir: '/s', instanceId: 'i', configFile: '/c', connect, launch })).toBe(client);
    expect(calls).toEqual(['connect']);

    calls.length = 0;
    let first = true;
    const connectAfterLaunch = async () => {
      calls.push('connect');
      if (first) { first = false; throw new SupervisorUnavailable('connect_failed'); }
      return client;
    };
    expect(await attachOrLaunchSupervisor({ stateDir: '/s', instanceId: 'i', configFile: '/c', connect: connectAfterLaunch, launch })).toBe(client);
    expect(calls).toEqual(['connect', 'launch', 'connect']);

    calls.length = 0;
    first = true;
    const raced = async () => { calls.push('launch'); throw new OwnerLockHeld(); };
    expect(await attachOrLaunchSupervisor({ stateDir: '/s', instanceId: 'i', configFile: '/c', connect: connectAfterLaunch, launch: raced })).toBe(client);
    expect(calls).toEqual(['connect', 'launch', 'connect']);

    await expect(attachOrLaunchSupervisor({ stateDir: '/s', instanceId: 'i', configFile: '/c', connect: async () => { throw new Error('boom'); }, launch })).rejects.toThrow('boom');
  });

  it('a standalone-only config composes without Paseo: v2 catalog, native launch through the supervisor', async () => {
    const { dir, config } = standaloneConfig();
    const supervisor = fakeSupervisor();
    const client = fakeClient();
    const runtime = await createConnectorRuntime({ config, journalDir: join(dir, 'state'), supervisor, client, log: () => {} });
    try {
      expect(runtime.catalog.formatVersion).toBe(2);
      expect(runtime.catalog.profiles.map((p) => [p.id, p.backend, p.readiness.state])).toEqual([['cc-main', 'claude-code', 'ready']]);
      const rev = profileRevision(config.profiles[0], '2.1.317');
      const command = { id: 'launch-1', runId: RUN, sessionId: S1, kind: 'launch', payload: { repositoryKey: 'repo', profileId: 'cc-main', model: 'claude-model-a', prompt: 'go', reportingCredential: 'cred', workspace: { branchName: 'ff/x', baseRef: 'main' }, execution: { schemaVersion: 2, backend: 'claude-code', profileId: 'cc-main', profileRevision: rev } } };
      expect(await runtime.executor.execute(command)).toMatchObject({ state: 'accepted', stage: 'bound' });
      expect(supervisor.requests.find((r) => r.method === 'submit').params).toMatchObject({ backend: 'claude-code', profileRevision: rev, reporting: { url: 'http://127.0.0.1:9/mcp/collab', credential: 'cred' } });
      expect(await runtime.executor.execute({ id: 'legacy', runId: RUN, sessionId: 'other', kind: 'launch', payload: { repositoryKey: 'repo', profileId: 'p1' } })).toEqual({ state: 'failed', errorCode: 'integration_disabled' });
    } finally {
      await runtime.close();
    }
  });

  it('an intentional close stops this instance\'s workers through its supervisor; a plain close stops nothing', async () => {
    for (const [answer, expected] of [[{ state: 'stopped' }, 'stopped'], [{ state: 'uncertain' }, 'uncertain'], [new Error('lost'), 'uncertain']]) {
      const { dir, config } = standaloneConfig();
      const supervisor = fakeSupervisor();
      const base = supervisor.request;
      supervisor.request = async (method, params) => {
        if (method === 'stop') {
          supervisor.requests.push({ method, params });
          if (answer instanceof Error) throw answer;
          return answer;
        }
        return base(method, params);
      };
      const runtime = await createConnectorRuntime({ config, journalDir: join(dir, 'state'), supervisor, client: fakeClient(), log: () => {} });
      expect(await runtime.close({ intentional: true })).toEqual({ stop: expected });
      expect(supervisor.requests.filter((r) => r.method === 'stop')).toEqual([{ method: 'stop', params: { scope: 'all', timeoutMs: 30_000 } }]);
    }
    const { dir, config } = standaloneConfig();
    const supervisor = fakeSupervisor();
    const runtime = await createConnectorRuntime({ config, journalDir: join(dir, 'state'), supervisor, client: fakeClient(), log: () => {} });
    expect(await runtime.close()).toEqual({ stop: null });
    expect(supervisor.requests.some((r) => r.method === 'stop')).toBe(false);
  });

  it('with Paseo enabled on a v2 host, legacy and v2 Paseo launches still pin to the local saved profile', async () => {
    const { dir, file } = standaloneConfig();
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    writeFileSync(file, JSON.stringify({ ...raw, integrations: { paseo: { profiles: ['p1'] } } }));
    const config = loadConnectorConfig({ file, enableIntegrations: ['paseo'] });
    const saved = { id: 'p1', name: 'Coder', provider: 'omp', model: 'ai3/x', modeId: 'full', thinkingOptionId: null, featureValues: { plan: true } };
    const paseo = fakePaseoSdk();
    paseo.config = { get: async () => ({ config: { agentProfiles: [saved] } }) };
    paseo.close = async () => {};
    const runtime = await createConnectorRuntime({ config, journalDir: join(dir, 'state'), paseo, supervisor: fakeSupervisor(), stopAgent: async () => {}, client: fakeClient(), log: () => {} });
    try {
      expect(runtime.catalog.profiles.map((p) => [p.id, p.backend])).toEqual([['cc-main', 'claude-code'], ['p1', 'paseo']]);
      const legacySnapshot = { id: 'p1', name: 'Coder', provider: 'omp', model: 'ai3/x', modeId: 'full', thinkingOptionId: null, features: { plan: true } };
      const legacy = { id: 'legacy-1', runId: RUN, sessionId: S1, kind: 'launch', payload: { repositoryKey: 'repo', profileId: 'p1', profileSnapshot: legacySnapshot, prompt: 'go', workspace: { branchName: 'ff/a', baseRef: 'main' } } };
      expect((await runtime.executor.execute(legacy)).state).toBe('accepted');
      const rev = profileRevision(paseoExecutionProfile(saved), PASEO_HARNESS_VERSION);
      const v2 = { id: 'v2-1', runId: '44444444-4444-4444-8444-444444444444', sessionId: '55555555-5555-4555-8555-555555555555', kind: 'launch', payload: { repositoryKey: 'repo', profileId: 'p1', profileSnapshot: runtime.catalog.profiles[1], model: 'ai3/x', prompt: 'go', workspace: { branchName: 'ff/b', baseRef: 'main' }, execution: { schemaVersion: 2, backend: 'paseo', profileId: 'p1', profileRevision: rev } } };
      expect((await runtime.executor.execute(v2)).state).toBe('accepted');
      expect(paseo.state.agentCreateCalls).toHaveLength(2);
    } finally {
      await runtime.close();
    }
  });

  it('a native summary session publishes its assistant output as a summary after its turn completes', async () => {
    const { dir, config } = standaloneConfig();
    const SUMMARY = '33333333-3333-4333-8333-333333333333';
    const supervisor = fakeSupervisor([
      { seq: 1, sessionId: SUMMARY, runId: RUN, generation: 1, kind: 'timeline', nativeEventId: 'a1', at: '2026-11-05T00:00:00.000Z', payload: { backend: 'claude-code', event: { type: 'assistant_text', text: 'Tests passed.' } } },
      { seq: 2, sessionId: SUMMARY, runId: RUN, generation: 1, kind: 'timeline', nativeEventId: 'a2', at: '2026-11-05T00:00:00.500Z', payload: { backend: 'claude-code', event: { type: 'assistant_text', text: 'Work remains for review.' } } },
      { seq: 3, sessionId: SUMMARY, runId: RUN, generation: 1, kind: 'state', nativeEventId: 'r1', at: '2026-11-05T00:00:01.000Z', payload: { backend: 'claude-code', event: { phase: 'result' }, terminal: 'completed' } },
    ]);
    const client = fakeClient();
    const runtime = await createConnectorRuntime({ config, journalDir: join(dir, 'state'), supervisor, client, log: () => {}, intervals: { heartbeatIntervalMs: 50 } });
    const rev = profileRevision(config.profiles[0], '2.1.317');
    const summarize = { id: 'summary-1', runId: RUN, sessionId: SUMMARY, kind: 'summarize', payload: { profileId: 'cc-main', prompt: 'Summarize.', reportingCredential: 'summary-session-reporting-credential', sourceSessionId: S1, sourceCursor: { epoch: nativeCursorEpoch('claude-code'), seq: '7' }, execution: { schemaVersion: 2, backend: 'claude-code', profileId: 'cc-main', profileRevision: rev } } };
    await runtime.journal.append({ type: 'intent', commandId: 'launch-0', runId: RUN, sessionId: S1, kind: 'launch', payloadDigest: 'x', recordedAt: '2026-11-05T00:00:00.000Z' });
    await runtime.journal.append({ type: 'binding', commandId: 'launch-0', runId: RUN, sessionId: S1, backend: 'claude-code', nativeSessionId: S1, workspaceRef: 'ffw_0123456789abcdef', generation: 1, repositoryKey: 'repo', role: 'work' });
    expect((await runtime.executor.execute(summarize)).state).toBe('accepted');
    const started = runtime.start();
    try {
      const summary = await (async () => {
        for (let i = 0; i < 300; i += 1) {
          const found = client.observed.find((o) => o.kind === 'summary');
          if (found) return found;
          await new Promise((r) => setTimeout(r, 10));
        }
        return null;
      })();
      expect(summary).toMatchObject({ runId: RUN, sessionId: SUMMARY, payload: { body: 'Tests passed.\n\nWork remains for review.', model: 'claude-model-a', sourceCursor: { epoch: nativeCursorEpoch('claude-code'), seq: '7' } } });
    } finally {
      await runtime.close();
      await started;
    }
  });

  it('spooled native events are durably journaled before the supervisor acknowledgement, then sent to the server', async () => {
    const { dir, config } = standaloneConfig();
    const supervisor = fakeSupervisor([
      { seq: 1, sessionId: S1, runId: RUN, generation: 1, kind: 'timeline', nativeEventId: 'm1', at: '2026-11-05T00:00:00.000Z', payload: { backend: 'claude-code', event: { type: 'assistant_text', text: `working in ${join(dir, 'repo')}` } } },
      { seq: 2, sessionId: S1, runId: RUN, generation: 1, kind: 'state', nativeEventId: 'r1', at: '2026-11-05T00:00:01.000Z', payload: { backend: 'claude-code', event: { phase: 'result' }, terminal: 'completed' } },
    ]);
    const client = fakeClient();
    const journalDir = join(dir, 'state');
    const runtime = await createConnectorRuntime({ config, journalDir, supervisor, client, log: () => {}, intervals: { heartbeatIntervalMs: 50 } });
    const started = runtime.start();
    try {
      for (let i = 0; i < 200 && client.observed.length < 2; i += 1) await new Promise((r) => setTimeout(r, 10));
      expect(client.observed.map((o) => [o.eventId, o.kind])).toEqual([[`claude-code:${S1}:1:m1`, 'timeline'], [`claude-code:${S1}:1:r1`, 'state']]);
      expect(client.observed[1].payload.state).toBe('idle');
      expect(client.observed[0].payload.text).toBe('working in [source]');
      expect(readFileSync(join(journalDir, 'journal.jsonl'), 'utf8')).not.toContain(join(dir, 'repo'));
      const ackIndex = supervisor.requests.findIndex((r) => r.method === 'ackEvents');
      expect(ackIndex).toBeGreaterThan(-1);
      expect(supervisor.requests[ackIndex].params).toEqual({ uptoSeq: 2 });
    } finally {
      await runtime.close();
      await started;
    }
  });
});
