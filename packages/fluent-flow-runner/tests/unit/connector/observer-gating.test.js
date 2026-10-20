import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { createConnectorClient } from '../../../src/connector/connector-client.js';
import { createJournal } from '../../../src/connector/journal.js';
import { createExecutor } from '../../../src/connector/executor.js';
import { createPaseoAdapter } from '../../../src/connector/paseo-adapter.js';
import { createConnectorLoop } from '../../../src/connector/loop.js';
import { createObserver } from '../../../src/connector/observer.js';
import { fakePaseoSdk } from './helpers/fake-paseo.js';

/**
 * Slice: the initial (billable) prompt may only be delivered AFTER the live
 * timeline subscription for the bound agent is READY and the initial backfill
 * has been queued to the control plane. A fast turn must never outrun the
 * observer: otherwise the run's whole execution history is invisible.
 */

const catalogProfile = { id: 'p1', name: 'Coder', provider: 'omp', model: 'ai3/x', modeId: null, thinkingOptionId: null, features: {} };
const config = { instanceId: 'pc-obs', repositories: { 'test-repo': '/repos/test' }, profiles: ['p1'] };

function fakeControlPlane() {
  const state = { acks: [], commands: [], deliveredIds: new Set(), redeliver: new Set(), observationBatches: [] };
  let server;
  let url;
  const waits = [];
  function waitersCheck() {
    for (let i = waits.length - 1; i >= 0; i--) {
      if (waits[i].predicate(state)) {
        waits[i].resolve();
        waits.splice(i, 1);
      }
    }
  }
  async function start() {
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        try {
          const parsed = body ? JSON.parse(body) : {};
          const reply = (payload) => {
            res.writeHead(200, { 'Content-Type': 'application/json', Connection: 'close' });
            res.end(JSON.stringify(payload));
            waitersCheck();
          };
          if (req.url === '/api/connector/v1/register') return reply({ data: { hostId: 'h', connectorSessionId: 'cs-1', leaseEpoch: 1, heartbeatIntervalMs: 15000, staleAfterMs: 45000, offlineAfterMs: 120000 } });
          if (req.url === '/api/connector/v1/heartbeat') return reply({ data: { ok: true, status: 'online', leaseEpoch: parsed.leaseEpoch } });
          if (req.url === '/api/connector/v1/poll') {
            const cmd = state.commands.find((c) => !state.deliveredIds.has(c.id) || state.redeliver.has(c.id));
            if (cmd) state.deliveredIds.add(cmd.id);
            return reply({ data: { commands: cmd ? [cmd] : [] } });
          }
          if (req.url?.includes('/ack')) {
            state.acks.push({ id: req.url.split('/')[5], ...parsed });
            return reply({ data: { state: parsed.state } });
          }
          if (req.url === '/api/connector/v1/observations') {
            state.observationBatches.push(parsed);
            return reply({ data: { acceptedEventIds: (parsed.events ?? []).map((e) => e.eventId), highWatermarks: {} } });
          }
          res.writeHead(404); res.end('{}');
        } catch {
          res.writeHead(500); res.end('{}');
        }
      });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    url = `http://127.0.0.1:${server.address().port}`;
    return url;
  }
  function waitFor(predicate, timeoutMs = 5000) {
    if (predicate(state)) return Promise.resolve();
    return new Promise((resolve, reject) => {
      waits.push({ predicate, resolve });
      setTimeout(() => reject(new Error('waitFor timeout')), timeoutMs).unref?.();
    });
  }
  function stop() {
    return new Promise((r) => server.close(r));
  }
  return { start, stop, state, waitFor, url: () => url };
}

function shaPrefix(payload) {
  void payload;
  // eventId = sha256({agentId, epoch, seq, event}) sliced to 32; recompute the
  // prefix from the payload fields the adapter uses.
  return createHash('sha256').update(JSON.stringify({ agentId: payload.agentId, epoch: payload.epoch, seq: payload.seq !== undefined ? String(payload.seq) : null, event: payload.event })).digest('hex').slice(0, 32);
}

const launchCommand = {
  id: 'cmd-1',
  runId: 'run-1',
  sessionId: 'sess-1',
  kind: 'launch',
  payload: {
    repositoryKey: 'test-repo',
    profileId: 'p1',
    profileSnapshot: catalogProfile,
    model: null,
    prompt: 'Do the bounded task.',
    workspace: { mode: 'worktree', branchName: 'ff/run-1/s-1', baseRef: 'main' },
  },
};

let plane;
let dir;
let activeLoops;

beforeEach(() => {
  plane = fakeControlPlane();
  dir = mkdtempSync(join(tmpdir(), 'ff-obs-'));
  activeLoops = [];
});

afterEach(async () => {
  for (const loop of activeLoops) {
    try { loop.stop(); } catch {}
  }
  await new Promise((r) => setTimeout(r, 20));
  await plane.stop();
  rmSync(dir, { recursive: true, force: true });
});

describe('observer gating: prompt waits for ready subscription + backfill', () => {
  it('withholds the prompt while the subscription is not ready, backfills on open, then delivers once', async () => {
    const url = await plane.start();
    plane.state.commands = [structuredClone(launchCommand)];
    const journal = createJournal({ dir });
    const paseo = fakePaseoSdk();
    // Subscription ready gate: CLOSED until the test opens it.
    let openGate;
    const gate = new Promise((resolve) => (openGate = resolve));
    paseo.state.subscribeGates = new Map([[/* any agent */ '*', gate]]);

    const adapter = createPaseoAdapter({ paseo, journal });
    const executor = createExecutor({ config, adapter, journal, catalogProfiles: [catalogProfile] });
    const observer = createObserver({ paseo, journal, adapter, onObservations: (obs) => loop.enqueueObservations(obs) });
    const loop = createConnectorLoop({
      client: createConnectorClient({ serverUrl: url, token: 'ffh_test' }),
      executor,
      journal,
      catalog: { repositories: [{ key: 'test-repo' }], profiles: [catalogProfile] },
      instanceId: 'pc-obs',
      sdkVersion: '0.12.0',
      daemonVersion: '0.12.0',
      onBeforeDeliver: (binding) => observer.ensureReady(binding),
      intervals: { pollWaitMs: 0, heartbeatIntervalMs: 15_000, baseBackoffMs: 50, maxBackoffMs: 200 },
    });
    activeLoops.push(loop);
    const runner = loop.start();

    // Bind completes; the deliver stage is now gated behind the closed subscription.
    await plane.waitFor((s) => s.acks.some((a) => a.id === 'cmd-1' && a.state === 'accepted'));
    await new Promise((r) => setTimeout(r, 150));
    expect(paseo.state.sends).toHaveLength(0); // gate closed: NO billable prompt
    expect(paseo.state.timelineByAgent.size).toBe(1);

    // Timeline history the backfill must recover once the gate opens.
    const agentId = [...paseo.state.timelineByAgent.keys()][0];
    paseo.state.timelineByAgent.get(agentId).items.push({ type: 'user_message', text: 'seed', messageId: 'pre-existing' });

    openGate();
    await plane.waitFor((s) => s.acks.some((a) => a.id === 'cmd-1' && a.state === 'applied'));
    await plane.waitFor((s) => s.observationBatches.length > 0);
    loop.stop();
    await runner;

    expect(paseo.state.sends).toHaveLength(1);
    expect(paseo.state.sends[0].messageId).toBe('cmd-1');
    // The backfilled seed event reached the control plane queue before stop.
    const observed = plane.state.observationBatches.flatMap((b) => b.events.map((e) => e.eventId));
    expect(observed.some((id) => id.length > 0)).toBe(true);
    expect(observer.isAttached(agentId)).toBe(true);
  }, 10_000);

  it('dedupes live timeline events by eventId across replay at the loop queue', async () => {
    const url = await plane.start();
    const journal = createJournal({ dir });
    const paseo = fakePaseoSdk();
    const adapter = createPaseoAdapter({ paseo, journal });
    const executor = createExecutor({ config, adapter, journal, catalogProfiles: [catalogProfile] });
    const observer = createObserver({ paseo, journal, adapter, onObservations: (obs) => loop.enqueueObservations(obs) });
    const loop = createConnectorLoop({
      client: createConnectorClient({ serverUrl: url, token: 'ffh_test' }),
      executor,
      journal,
      catalog: { repositories: [{ key: 'test-repo' }], profiles: [catalogProfile] },
      instanceId: 'pc-obs',
      sdkVersion: '0.12.0',
      daemonVersion: '0.12.0',
      intervals: { pollWaitMs: 0, heartbeatIntervalMs: 15_000, baseBackoffMs: 50, maxBackoffMs: 200 },
    });
    activeLoops.push(loop);
    const runner = loop.start();
    await new Promise((r) => setTimeout(r, 50));
    // Bind through the real executor so the subscription attaches.
    await executor.execute(structuredClone(launchCommand));
    await observer.sync();
    const agentId = journal.byCommand('cmd-1').binding.paseoAgentId;

    const payload = {
      agentId,
      event: { type: 'turn_started', provider: 'omp', turnId: 't1' },
      timestamp: '2026-10-19T00:00:00Z',
      seq: 1,
      epoch: 'e1',
    };
    // Same live payload delivered repeatedly: the loop queue keys by eventId.
    for (let i = 0; i < 3; i++) {
      paseo.state.deliverLive(agentId, payload);
    }
    await plane.waitFor((s) => s.observationBatches.some((batch) => batch.events.some((event) => event.eventId === shaPrefix(payload))));
    const observed = plane.state.observationBatches.flatMap((batch) => batch.events).filter((event) => event.eventId === shaPrefix(payload));
    expect(observed).toHaveLength(1);
    expect(journal.cursor('sess-1')).toEqual({ epoch: 'e1', seq: '1' });
    loop.stop();
    await runner.catch(() => {});
  });

  it('holds a rejected subscription without failing the command and retries the same binding', async () => {
    const url = await plane.start();
    plane.state.commands = [structuredClone(launchCommand)];
    const journal = createJournal({ dir });
    const paseo = fakePaseoSdk();
    // Subscription ready gate: REJECTED immediately. Attach .catch to consume rejection early,
    // preventing Vitest unhandled rejection warning while preserving the rejection for ensureReady.
    const rejectedReady = Promise.reject(new Error('subscription unavailable'));
    rejectedReady.catch(() => {}); // Consume rejection to prevent unhandled rejection warning
    paseo.state.subscribeGates = new Map([[/* any agent */ '*', rejectedReady]]);

    const adapter = createPaseoAdapter({ paseo, journal });
    const executor = createExecutor({ config, adapter, journal, catalogProfiles: [catalogProfile] });
    const observer = createObserver({ paseo, journal, adapter, onObservations: (obs) => loop.enqueueObservations(obs) });
    const loop = createConnectorLoop({
      client: createConnectorClient({ serverUrl: url, token: 'ffh_test' }),
      executor,
      journal,
      catalog: { repositories: [{ key: 'test-repo' }], profiles: [catalogProfile] },
      instanceId: 'pc-obs-rejected',
      sdkVersion: '0.12.0',
      daemonVersion: '0.12.0',
      onBeforeDeliver: (binding) => observer.ensureReady(binding),
      intervals: { pollWaitMs: 0, heartbeatIntervalMs: 15_000, baseBackoffMs: 50, maxBackoffMs: 200 },
    });
    activeLoops.push(loop);
    const runner = loop.start();

    // Bind completes; but onBeforeDeliver calls ensureReady which should fail, not send prompt.
    await plane.waitFor((s) => s.acks.some((a) => a.id === 'cmd-1' && a.state === 'accepted'));
    await new Promise((r) => setTimeout(r, 150));
    expect(paseo.state.sends).toHaveLength(0); // subscription ready failed: NO billable prompt
    expect(plane.state.acks.some((a) => a.id === 'cmd-1' && a.state === 'applied')).toBe(false); // NO applied grant
    expect(plane.state.acks.some((a) => a.id === 'cmd-1' && a.state === 'failed')).toBe(false);
    const boundAgent = journal.byCommand('cmd-1').binding.paseoAgentId;
    paseo.state.subscribeGates.clear();
    plane.state.redeliver.add('cmd-1');
    await plane.waitFor((s) => s.acks.some((a) => a.id === 'cmd-1' && a.state === 'applied'));
    loop.stop();
    await runner;
    expect(paseo.state.sends).toHaveLength(1);
    expect(paseo.state.sends[0].agentId).toBe(boundAgent);
    expect(paseo.state.agents.size).toBe(1);
  }, 10_000);

  it.each(['attach', 'refetch'])('holds %s failures and only marks backfill ready after recovery', async (failure) => {
    await plane.start();
    const journal = createJournal({ dir });
    const paseo = fakePaseoSdk();
    const adapter = createPaseoAdapter({ paseo, journal });
    const executor = createExecutor({ config, adapter, journal, catalogProfiles: [catalogProfile] });
    await executor.execute(structuredClone(launchCommand));
    const binding = journal.byCommand('cmd-1').binding;
    const originalRef = paseo.agents.ref;
    let broken = true;
    paseo.agents.ref = (id) => {
      if (failure === 'attach' && broken) throw new Error('disconnected');
      return originalRef(id);
    };
    paseo.state.customRefetch = (_id, _opts, page) => {
      if (failure === 'refetch' && broken) throw new Error('disconnected');
      return page;
    };
    const observer = createObserver({ paseo, journal, adapter, onObservations: () => {} });
    await expect(observer.ensureReady(binding)).rejects.toMatchObject({ code: 'observer_not_ready' });
    broken = false;
    await expect(observer.ensureReady(binding)).resolves.toBeUndefined();
    expect(paseo.state.sends).toHaveLength(0);
    await observer.close();
  });

  it('persists cursor invalidation on a native epoch reset and recovers from a fresh window', async () => {
    await plane.start();
    const journal = createJournal({ dir });
    const paseo = fakePaseoSdk();
    const adapter = createPaseoAdapter({ paseo, journal });
    const executor = createExecutor({ config, adapter, journal, catalogProfiles: [catalogProfile] });
    await executor.execute(structuredClone(launchCommand));
    const binding = journal.byCommand('cmd-1').binding;
    await journal.append({ type: 'cursor', sessionId: binding.sessionId, epoch: 'old', seq: '99' });
    const cursors = [];
    const observations = [];
    paseo.state.customRefetch = (_id, options, page) => {
      cursors.push(options.cursor);
      return options.cursor?.epoch === 'old' ? { ...page, reset: true } : page;
    };
    const observer = createObserver({ paseo, journal, adapter, onObservations: (events) => observations.push(...events) });
    await expect(observer.sync()).rejects.toMatchObject({ code: 'observer_not_ready' });
    await expect(observer.sync()).resolves.toBe(1);
    expect(cursors).toEqual([{ epoch: 'old', seq: 99 }, undefined]);
    expect(observations.some((event) => event.payload.item?.level === 'warning')).toBe(true);
    await observer.close();
  });

  it('backfills retained older history before the first prompt instead of assuming the tail is complete', async () => {
    await plane.start();
    const journal = createJournal({ dir });
    const paseo = fakePaseoSdk();
    const adapter = createPaseoAdapter({ paseo, journal });
    const executor = createExecutor({ config, adapter, journal, catalogProfiles: [catalogProfile] });
    await executor.execute(structuredClone(launchCommand));
    const observed = [];
    paseo.state.customRefetch = (_id, options, page) => ({ ...page, hasOlder: options.direction === 'tail', startCursor: { epoch: 'e1', seq: options.direction === 'tail' ? 2 : 1 }, endCursor: { epoch: 'e1', seq: options.direction === 'tail' ? 2 : 1 }, entries: [{ item: { type: 'assistant_message', text: options.direction === 'tail' ? 'newer' : 'older' }, seqEnd: options.direction === 'tail' ? 2 : 1, timestamp: '2026-10-19T00:00:00Z' }] });
    const observer = createObserver({ paseo, journal, adapter, onObservations: (events) => observed.push(...events) });
    await observer.sync();
    expect(observed.filter((event) => event.kind === 'timeline').map((event) => event.payload.item.text)).toEqual(['older', 'newer']);
    expect(journal.cursor('sess-1')).toEqual({ epoch: 'e1', seq: '2' });
    await observer.close();
  });

  it('captures native idle snapshot lastUsage on startup/reconnect with stable replay identity and raw zero/null values', async () => {
    await plane.start();
    const journal = createJournal({ dir });
    const paseo = fakePaseoSdk();
    const adapter = createPaseoAdapter({ paseo, journal });
    const executor = createExecutor({ config, adapter, journal, catalogProfiles: [catalogProfile] });
    await executor.execute(structuredClone(launchCommand));
    const binding = journal.byCommand('cmd-1').binding;
    const agent = paseo.state.agentsById.get(binding.paseoAgentId);
    agent.status = 'idle';
    agent.lastUsage = { inputTokens: 132, cachedInputTokens: 580784, outputTokens: 4681, totalCostUsd: 0.1666354, contextWindowMaxTokens: 200000, contextWindowUsedTokens: 42518 };
    const observed = [];
    const options = { paseo, journal, adapter, onObservations: (events) => observed.push(...events) };
    let observer = createObserver(options);
    await observer.sync();
    const sample = observed.find((event) => event.kind === 'usage');
    expect(sample).toMatchObject({ runId: 'run-1', sessionId: 'sess-1', payload: { sampleKey: 'native-session-snapshot', source: 'native_snapshot', scope: 'session', cumulative: true, tokensIn: 132, tokensOut: 4681, costUsd: 0.1666354, cachedInputTokens: 580784, contextWindowMaxTokens: 200000, contextWindowUsedTokens: 42518, reason: null } });
    await observer.sync();
    await observer.close();
    observer = createObserver(options);
    await observer.sync();
    expect(observed.filter((event) => event.kind === 'usage')).toHaveLength(1);
    agent.lastUsage = { inputTokens: 0, outputTokens: 0, totalCostUsd: 0 };
    await observer.sync();
    expect(observed.filter((event) => event.kind === 'usage').at(-1).payload).toMatchObject({ sampleKey: sample.payload.sampleKey, tokensIn: 0, tokensOut: 0, costUsd: 0, cachedInputTokens: null, contextWindowMaxTokens: null, contextWindowUsedTokens: null, reason: null });
    agent.lastUsage = undefined;
    await observer.sync();
    expect(observed.filter((event) => event.kind === 'usage').at(-1).payload).toMatchObject({ tokensIn: null, tokensOut: null, costUsd: null, reason: 'Provider usage unavailable.' });
    await observer.close();
  });
});
