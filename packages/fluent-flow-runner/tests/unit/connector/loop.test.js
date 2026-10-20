import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { createConnectorClient, ConnectorApiError } from '../../../src/connector/connector-client.js';
import { createJournal } from '../../../src/connector/journal.js';
import { createExecutor } from '../../../src/connector/executor.js';
import { createPaseoAdapter } from '../../../src/connector/paseo-adapter.js';
import { createConnectorLoop } from '../../../src/connector/loop.js';

/** Minimal scripted control plane on a real loopback socket. */
function fakeControlPlane(state) {
  state.deliveredIds = new Set();
  state.redeliver = new Set();
  state.acks = [];
  const waits = [];
  let server;
  let url;
  function waitersCheck() {
    for (let i = waits.length - 1; i >= 0; i--) {
      if (waits[i].predicate(state)) {
        waits[i].resolve();
        waits.splice(i, 1);
      }
    }
  }
  async function start() {
    if (server) return url;
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        try {
        const parsed = body ? JSON.parse(body) : {};
        const key = `POST ${req.url}`;
        const override = state.responses[key];
        const reply = (status, payload) => {
          // Connection: close keeps every request on a fresh socket so
          // ephemeral-port reuse across tests can never hit a stale pooled
          // keep-alive socket from a previous (closed) plane.
          res.writeHead(status, { 'Content-Type': 'application/json', Connection: 'close' });
          res.end(JSON.stringify(payload));
          waitersCheck();
        };
        if (override) return override({ req, body: parsed, reply, state });
        if (req.url === '/api/connector/v1/register') {
          if (state.rejectSecondRegistration && state.registrationActive) {
            return reply(409, { error: { code: 'connector_active', message: 'another connector instance is active', requestId: 'r' } });
          }
          state.registrationActive = true;
          state.registrations.push(parsed);
          return reply(200, { data: { hostId: 'host-1', connectorSessionId: `cs-${state.registrations.length}`, leaseEpoch: state.registrations.length, heartbeatIntervalMs: 15000, staleAfterMs: 45000, offlineAfterMs: 120000 } });
        }
        if (req.url === '/api/connector/v1/heartbeat') {
          state.heartbeats.push(parsed);
          return reply(200, { data: { ok: true, status: 'online', leaseEpoch: parsed.leaseEpoch } });
        }
        if (req.url === '/api/connector/v1/poll') {
          state.pollRequests += 1;
          const pending = state.commands.filter((c) => !state.deliveredIds.has(c.id) || state.redeliver.has(c.id));
          const cmd = pending[0];
          if (cmd) state.deliveredIds.add(cmd.id);
          return reply(200, { data: { commands: cmd ? [cmd] : [] } });
        }
        if (req.url?.startsWith('/api/connector/v1/commands/') && req.url.endsWith('/ack')) {
          state.acks.push({ id: req.url.split('/')[5], ...parsed });
          return reply(200, { data: { ok: true, state: parsed.state } });
        }
        if (req.url === '/api/connector/v1/observations') {
          state.observationBatches.push(parsed);
          const accepted = (parsed.events ?? []).map((e) => e.eventId);
          return reply(200, { data: { acceptedEventIds: accepted, highWatermarks: {} } });
        }
        reply(404, { error: { code: 'not_found', message: 'no route', requestId: 'x' } });
        } catch (err) {
          console.error('PLANE-HANDLER-ERR', err.message);
          if (!res.headersSent) {
            res.writeHead(500, { 'Content-Type': 'application/json', Connection: 'close' });
            res.end(JSON.stringify({ error: { code: 'fake_plane_error', message: err.message, requestId: 'x' } }));
          }
        }
      });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${server.address().port}`;
    return url;
  }
  function waitFor(predicate, timeoutMs = 5000) {
    if (predicate(state)) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const entry = { predicate, resolve };
      waits.push(entry);
      setTimeout(() => reject(new Error('waitFor timeout')), timeoutMs).unref?.();
    });
  }
  // close(): final teardown of the one shared server.
  function close() {
    return new Promise((resolve) => server.close(resolve));
  }
  // reset(): fresh state per test on the SAME listening server (one origin).
  function reset() {
    state.registrationActive = false;
    state.rejectSecondRegistration = false;
    state.registrations = [];
    state.deliveredIds = new Set();
    state.redeliver = new Set();
    state.responses = {};
    state.heartbeats = [];
    state.acks = [];
    state.observationBatches = [];
    state.pollRequests = 0;
    state.commands = [];
    state.processedBatches = 0;
  }
  return { start, reset, close, state, waitFor, url: () => url };
}

function fakePaseoState() {
  const state = { workspaces: new Map(), agents: new Map(), sends: [], agentCreates: [], workspaceCreates: [], timelineByAgent: new Map() };
  function handleFor(record) {
    return {
      id: record.id,
      workspaceId: record.workspaceId,
      refresh: async () => ({ agent: { ...record }, project: null }),
      send: async (text, opts) => {
        state.sends.push({ agentId: record.id, text, messageId: opts?.messageId ?? null, activeTurnBehavior: opts?.activeTurnBehavior ?? null });
        const timeline = state.timelineByAgent.get(record.id) ?? { items: [] };
        state.timelineByAgent.set(record.id, timeline);
        timeline.items.push({ type: 'user_message', text, messageId: opts?.messageId ?? `auto-${state.sends.length}` });
      },
      respondToPermission: async (args) => {
        if (!state.pendingPermissions?.has(args.requestId)) throw new Error('This request is no longer active.');
        state.permissionResponses.push(args);
      },
      timeline: {
        refetch: async () => {
          const items = state.timelineByAgent.get(record.id)?.items ?? [];
          return {
            requestId: 'r', agentId: record.id, agent: null, direction: 'tail', projection: 'canonical',
            epoch: 'e1', reset: false, staleCursor: false, gap: false,
            window: { minSeq: 0, maxSeq: items.length, nextSeq: items.length + 1 },
            startCursor: { epoch: 'e1', seq: 1 }, endCursor: { epoch: 'e1', seq: items.length },
            hasOlder: false, hasNewer: false,
            entries: items.map((item, i) => ({ provider: 'omp', item, timestamp: 't', seqStart: i + 1, seqEnd: i + 1, sourceSeqRanges: [], collapsed: [] })),
            error: null,
          };
        },
      },
    };
  }
  const paseo = {
    state,
    workspaces: {
      create: async (opts) => {
        state.workspaceCreates.push(opts);
        const existing = state.workspaces.get(opts.idempotencyKey);
        if (existing) return existing;
        const handle = {
          id: opts.workspaceId ?? `ws-${state.workspaces.size + 1}`,
          agents: {
            create: async (agentOpts) => {
              state.agentCreates.push(agentOpts);
              const existingAgent = state.agents.get(agentOpts.idempotencyKey);
              if (existingAgent) return handleFor(existingAgent);
              const record = { id: agentOpts.agentId ?? `ag-${state.agents.size + 1}`, workspaceId: opts.workspaceId, status: 'idle' };
              state.agents.set(agentOpts.idempotencyKey, record);
              state.timelineByAgent.set(record.id, { items: [] });
              return handleFor(record);
            },
          },
          refresh: async () => handle,
        };
        state.workspaces.set(opts.idempotencyKey, handle);
        return handle;
      },
      ref: (id) => {
        const handle = [...state.workspaces.values()].find((h) => h.id === id);
        if (!handle) throw new Error(`workspace ${id} not found`);
        return handle;
      },
    },
    agents: {
      ref: (id) => {
        for (const record of state.agents.values()) if (record.id === id) return handleFor(record);
        throw new Error(`agent ${id} not found`);
      },
    },
  };
  state.permissionResponses = [];
  state.pendingPermissions = new Set();
  return paseo;
}

const connectorConfig = {
  serverUrl: 'http://127.0.0.1:0',
  instanceId: 'pc-test',
  token: 'ffh_test',
  repositories: { 'test-repo': '/repos/test' },
  profiles: ['p1'],
};

const launchCommand = {
  id: 'cmd-1',
  runId: 'run-1',
  sessionId: 'sess-1',
  kind: 'launch',
  createdAt: '2026-10-19T00:00:00Z',
  leaseEpoch: 1,
  payload: {
    repositoryKey: 'test-repo',
    profileId: 'p1',
    profileSnapshot: { id: 'p1', name: 'Coder', provider: 'omp', model: 'ai3/x', modeId: null, thinkingOptionId: null, features: {} },
    model: null,
    instructions: '',
    prompt: 'Do the bounded task.',
    workspace: { mode: 'worktree', branchName: 'ff/run-1/sess-1', baseRef: 'main' },
    labels: { 'fluent-flow.run': 'run-1', 'fluent-flow.session': 'sess-1' },
  },
};

describe('connector loop over real loopback HTTP', () => {
  let plane;
  let dir;
  let activeLoops;

  beforeAll(async () => {
    // ONE long-lived plane for the whole file: a single origin means undici's
    // connection pool can never hold stale sockets to a *reused* ephemeral
    // port from a previous (closed) plane.
    plane = fakeControlPlane({});
    await plane.start();
  });

  afterAll(async () => {
    await plane.close();
  });

  beforeEach(() => {
    plane.reset();
    dir = mkdtempSync(join(tmpdir(), 'ff-loop-'));
    activeLoops = [];
  });

  afterEach(async () => {
    // Stop loops even when an assertion failed mid-test, so runaway pollers
    // cannot mask the real failure with socket noise.
    for (const loop of activeLoops) {
      try { loop.stop(); } catch {}
    }
    await new Promise((r) => setTimeout(r, 20));
    rmSync(dir, { recursive: true, force: true });
  });

  function buildLoop(url, journal, paseo, extra = {}) {
    const client = createConnectorClient({ serverUrl: url, token: 'ffh_test' });
    const adapter = createPaseoAdapter({ paseo, journal });
    const executor = createExecutor({
      config: connectorConfig,
      adapter,
      journal,
      catalogProfiles: extra.catalogProfiles ?? [
        { id: 'p1', name: 'Coder', provider: 'omp', model: 'ai3/x', modeId: null, thinkingOptionId: null, features: {} },
      ],
      capabilities: extra.capabilities ?? {},
    });
    return createConnectorLoop({
      client,
      executor,
      journal,
      catalog: { repositories: [{ key: 'test-repo' }], profiles: [{ id: 'p1', name: 'Coder', provider: 'omp', model: 'ai3/x' }] },
      instanceId: 'pc-test',
      sdkVersion: '0.12.0',
      daemonVersion: '0.12.0',
      capabilities: { cancel: 'cli-stop' },
      intervals: { pollWaitMs: 0, heartbeatIntervalMs: 15_000, baseBackoffMs: 100, maxBackoffMs: 500 },
      log: (o, m) => console.error('LOOP', m ?? '', JSON.stringify(o).slice(0, 200)),
      ...extra,
    });
    activeLoops.push(loop);
    return loop;
  }

  it('registers, executes one launch command once, acks applied and posts bound observations', async () => {
    const url = await plane.start();
    plane.state.commands = [structuredClone(launchCommand)];
    const journal = createJournal({ dir });
    const paseo = fakePaseoState();
    const loop = buildLoop(url, journal, paseo);

    const runner = loop.start();
    await plane.waitFor((s) => s.acks.some((a) => a.id === 'cmd-1' && a.state === 'applied'));
    await plane.waitFor((s) => s.observationBatches.length > 0);
    loop.stop();
    await runner;

    expect(paseo.state.workspaceCreates).toHaveLength(1);
    expect(paseo.state.sends).toHaveLength(1);
    expect(paseo.state.sends[0].messageId).toBe('cmd-1');
    // Staged launch: bind acked `accepted` (IDs persisted) BEFORE the prompt,
    // then `applied` after delivery.
    const acks = plane.state.acks.filter((a) => a.id === 'cmd-1');
    expect(acks.map((a) => a.state)).toEqual(['accepted', 'applied']);
    expect(acks[0].result).toMatchObject({ workspaceId: expect.any(String), paseoAgentId: expect.any(String) });
    expect(acks[0].connectorSessionId).toBeTruthy();
    const batch = plane.state.observationBatches.flat();
    const kinds = (plane.state.observationBatches[0]?.events ?? []).map((e) => e.kind);
    expect(kinds).toContain('workspace_bound');
    expect(kinds).toContain('session_bound');
    // Heartbeats went out with the session and lease.
    expect(plane.state.heartbeats.length).toBeGreaterThanOrEqual(1);
    expect(plane.state.heartbeats[0].connectorSessionId).toBeTruthy();
    void batch;
  });

  it('a second connector instance for the same host cannot register while the first is active', async () => {
    const url = await plane.start();
    plane.state.rejectSecondRegistration = true;
    plane.state.registrationActive = true;
    const journal = createJournal({ dir });
    const paseo = fakePaseoState();
    const loop2 = buildLoop(url, journal, paseo);
    await expect(loop2.register()).rejects.toMatchObject({ status: 409, code: 'connector_active' });
    expect(paseo.state.workspaceCreates).toHaveLength(0);
  });

  it('superseded lease triggers re-register on the same journal; same command redelivers without duplicate work', async () => {
    const url = await plane.start();
    // First registration gets stolen: every poll/heartbeat returns 409 once,
    // then the override clears so the loop re-registers with epoch 2.
    let fenceErrors = 0;
    plane.state.responses['POST /api/connector/v1/poll'] = function ({ reply, state }) {
      if (fenceErrors === 0) {
        fenceErrors += 1;
        return reply(409, { error: { code: 'stale_lease', message: 'fence superseded', requestId: 'r' } });
      }
      delete state.responses['POST /api/connector/v1/poll'];
      state.pollRequests += 1;
      const pending = state.commands.filter((c) => !state.deliveredIds.has(c.id) || state.redeliver.has(c.id));
      const cmd = pending[0];
      if (cmd) state.deliveredIds.add(cmd.id);
      return reply(200, { commands: cmd ? [cmd] : [] });
    };
    // After re-registration (epoch 2), the SAME command id is redelivered.
    plane.state.redeliver = new Set(['cmd-1']);
    plane.state.commands = [structuredClone(launchCommand)];
    const journal = createJournal({ dir });
    const paseo = fakePaseoState();
    const loop = buildLoop(url, journal, paseo);
    const runner = loop.start();
    await plane.waitFor((s) => s.acks.filter((a) => a.id === 'cmd-1').length >= 2);
    loop.stop();
    await runner;

    // Both deliveries ran the SAME command id through the idempotent adapter:
    // one workspace, one agent, one prompt.
    expect(paseo.state.workspaceCreates).toHaveLength(1);
    expect(paseo.state.agentCreates).toHaveLength(1);
    expect(paseo.state.sends).toHaveLength(1);
    expect(plane.state.registrations.length).toBeGreaterThanOrEqual(2);
    const epochs = plane.state.registrations.map((_, i) => i + 1);
    expect(epochs).toEqual([1, 2]);
  });

  it('revoked token (401) stops the loop fatally without executing anything', async () => {
    const url = await plane.start();
    plane.state.responses['POST /api/connector/v1/register'] = ({ reply }) =>
      reply(401, { error: { code: 'unauthorized', message: 'host token revoked', requestId: 'r' } });
    const journal = createJournal({ dir });
    const paseo = fakePaseoState();
    let fatal = null;
    const loop = buildLoop(url, journal, paseo, { onFatal: (err) => (fatal = err) });
    await loop.start();
    expect(fatal).toBeInstanceOf(ConnectorApiError);
    expect(fatal.status).toBe(401);
    expect(paseo.state.workspaceCreates).toHaveLength(0);
  });

  it('unconfirmed observations are re-queued from the journal after restart and deduped server-side', async () => {
    const url = await plane.start();
    const journal = createJournal({ dir });
    const paseo = fakePaseoState();
    // Pre-crash state: launch journaled + observations recorded, ack already
    // applied, but the process died before the observation batch was accepted.
    await journal.append({ type: 'intent', commandId: 'cmd-1', runId: 'run-1', sessionId: 'sess-1', kind: 'launch', payloadDigest: 'd', recordedAt: 't' });
    await journal.append({ type: 'binding', commandId: 'cmd-1', runId: 'run-1', sessionId: 'sess-1', workspaceId: 'ffws-run-1', paseoAgentId: 'ag-1', providerSessionId: null });
    await journal.append({ type: 'acked', commandId: 'cmd-1', state: 'applied', at: 't' });
    await journal.append({ type: 'observation', eventId: 'session_bound:cmd-1', commandId: 'cmd-1', runId: 'run-1', sessionId: 'sess-1', kind: 'session_bound', payload: { paseoAgentId: 'ag-1' }, at: 't' });

    const loop = buildLoop(url, journal, paseo);
    const runner = loop.start();
    await plane.waitFor((s) => s.observationBatches.length > 0);
    // Wait for the connector to CONSUME the ack and checkpoint the journal —
    // server-side batches alone do not prove persistence.
    for (let i = 0; i < 100 && journal.pendingObservationIds().length > 0; i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    loop.stop();
    await runner;

    const events = plane.state.observationBatches[0]?.events ?? [];
    expect(events.map((e) => e.eventId)).toEqual(['session_bound:cmd-1']);
    expect(events[0].payload).toEqual({ paseoAgentId: 'ag-1' });
    // No duplicate launch happened during recovery.
    expect(paseo.state.workspaceCreates).toHaveLength(0);
    // Server acceptance is checkpointed: a restart does NOT resubmit the
    // accepted history (journal-level regression for the ACK path).
    expect(journal.pendingObservationIds()).toEqual([]);
    const journalRestart = createJournal({ dir });
    expect(journalRestart.pendingObservationIds()).toEqual([]);
    expect(journalRestart.observationById('session_bound:cmd-1')).toBeTruthy();
  });

  it('a lost observations HTTP ack leaves the event pending across restart', async () => {
    const url = await plane.start();
    plane.state.responses['POST /api/connector/v1/observations'] = ({ req, state: planeState }) => {
      // Server processes the batch but the connector never sees the response:
      // destroy the socket deterministically (no late reply scheduling).
      planeState.processedBatches = (planeState.processedBatches ?? 0) + 1;
      req.socket.destroy();
    };
    const journal = createJournal({ dir });
    const paseo = fakePaseoState();
    await journal.append({ type: 'observation', eventId: 'ev-lost', commandId: null, runId: 'run-1', sessionId: 's', kind: 'state', payload: { x: 1 }, at: 't' });
    const loop = buildLoop(url, journal, paseo);
    const runner = loop.start();
    await plane.waitFor((s) => (s.processedBatches ?? 0) >= 1);
    loop.stop(); // socket destroyed: the connector never learned acceptance
    await runner.catch(() => {});
    const journal2 = createJournal({ dir });
    expect(journal2.pendingObservationIds()).toEqual(['ev-lost']);
    // Replay on the same journal: now accepted → checkpointed.
    plane.state.responses = {};
    const loop2 = buildLoop(await plane.start(), journal2, fakePaseoState());
    const runner2 = loop2.start();
    for (let i = 0; i < 100 && journal2.pendingObservationIds().length > 0; i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    loop2.stop();
    await runner2.catch(() => {});
    expect(journal2.pendingObservationIds()).toEqual([]);
  });

  it('bind ack recorded ambiguous (revoked after poll): zero sends, durable hold, no applied', async () => {
    const url = await plane.start();
    plane.state.commands = [structuredClone(launchCommand)];
    // Server records the bind but re-checks authorization at ack time and
    // truthfully reports the final state as ambiguous.
    plane.state.responses['POST /api/connector/v1/commands/cmd-1/ack'] = ({ body, reply, state }) => {
      const recorded = body.state === 'accepted' ? 'ambiguous' : body.state;
      state.acks.push({ id: 'cmd-1', ...body, state: recorded });
      const prior = state.acks.filter((a) => a.id === 'cmd-1').length;
      return reply(200, { data: { ok: true, state: recorded, result: prior === 0 ? { workspaceId: 'ffws-run-1', paseoAgentId: 'ag-x' } : undefined } });
    };
    const journal = createJournal({ dir });
    const paseo = fakePaseoState();
    const loop = buildLoop(url, journal, paseo);
    const runner = loop.start();
    await plane.waitFor((s) => s.acks.some((a) => a.id === 'cmd-1' && a.state === 'ambiguous'));
    await new Promise((r) => setTimeout(r, 150));
    loop.stop();
    await runner.catch(() => {});
    expect(paseo.state.sends).toHaveLength(0); // NO grant: no prompt
    expect(plane.state.acks.some((a) => a.id === 'cmd-1' && a.state === 'applied')).toBe(false);
    // Durable hold: binding journaled; redelivery resumes at bind stage.
    expect(journal.byCommand('cmd-1').binding).toBeTruthy();
    const bare = createConnectorClient({ serverUrl: url, token: 'ffh_test' });
    void bare;
  }, 10_000);

  it('rejects an out-of-allowlist repository key with a failed ack and never touches Paseo', async () => {
    const url = await plane.start();
    plane.state.commands = [structuredClone({ ...launchCommand, id: 'cmd-2', payload: { ...launchCommand.payload, repositoryKey: 'NOT-ALLOWED' } })];
    const journal = createJournal({ dir });
    const paseo = fakePaseoState();
    const loop = buildLoop(url, journal, paseo);
    const runner = loop.start();
    await plane.waitFor((s) => s.acks.some((a) => a.id === 'cmd-2'));
    loop.stop();
    await runner;
    const ack = plane.state.acks.find((a) => a.id === 'cmd-2');
    expect(ack.state).toBe('failed');
    expect(ack.errorCode).toBe('repository_not_allowed');
    expect(paseo.state.workspaceCreates).toHaveLength(0);
  });
});
