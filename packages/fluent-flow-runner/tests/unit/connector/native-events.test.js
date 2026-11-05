import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLedger } from '../../../src/supervisor/ledger.js';
import { createIpcServer, MAX_FRAME_BYTES } from '../../../src/supervisor/ipc.js';
import { connectSupervisor, fetchEvents } from '../../../src/supervisor/client.js';
import { createSupervisorHandlers } from '../../../src/supervisor/supervisor.js';
import { createJournal } from '../../../src/connector/journal.js';
import { createNativeEventPump, nativeObservation } from '../../../src/connector/native-events.js';

const RUN = '11111111-1111-4111-8111-111111111111';
const S1 = '22222222-2222-4222-8222-222222222222';
const roots = [];
const closers = [];
afterEach(async () => {
  for (const c of closers.splice(0).reverse()) await c();
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function largeText(bytes) {
  const unit = '日本語のテキスト🎉 mixed ASCII ';
  return unit.repeat(Math.ceil(bytes / Buffer.byteLength(unit, 'utf8')));
}

async function startSupervisorIpc() {
  const root = mkdtempSync(join(tmpdir(), 'ff-native-events-'));
  roots.push(root);
  const stateDir = join(root, 'state');
  mkdirSync(join(stateDir, 'supervisor'), { recursive: true, mode: 0o700 });
  const ledger = createLedger({ dir: join(stateDir, 'supervisor') });
  const handlers = createSupervisorHandlers({ ledger, profiles: [], backends: {}, containment: { state: 'unavailable', reason: 'test' }, log: () => {} });
  const server = createIpcServer({ instanceId: 'inst-ev', stateDir, handlers });
  await server.listen();
  closers.push(() => server.close());
  const journalDir = join(root, 'journal');
  mkdirSync(journalDir, { mode: 0o700 });
  return { root, stateDir, ledger, journalDir };
}

async function client(stateDir) {
  const c = await connectSupervisor({ instanceId: 'inst-ev', stateDir, role: 'connector' });
  closers.push(() => c.close());
  return c;
}

const spooled = (ledger, nativeEventId, kind, event, extra = {}) => ledger.appendEvent({ sessionId: S1, runId: RUN, generation: 1, kind, nativeEventId, payload: { backend: 'codex', event, ...extra } });

function journaled(journalDir) {
  return readFileSync(join(journalDir, 'journal.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.type === 'observation');
}

function remembering(journal) {
  return async (observations) => {
    for (const o of observations) if (!journal.observationById(o.eventId)) await journal.append({ type: 'observation', ...o, at: o.observedAt });
  };
}

describe('lossless native event transport (Task 7)', () => {
  it('a single >1 MiB multi-byte event and the next event cross the real ledger, IPC and connector journal exactly', async () => {
    const { stateDir, ledger, journalDir } = await startSupervisorIpc();
    const big = largeText(MAX_FRAME_BYTES + 200_000);
    expect(Buffer.byteLength(big, 'utf8')).toBeGreaterThan(MAX_FRAME_BYTES);
    spooled(ledger, 'item:big:completed', 'timeline', { phase: 'completed', item: { type: 'agentMessage', id: 'big', text: big } });
    spooled(ledger, 'item:after:completed', 'timeline', { phase: 'completed', item: { type: 'agentMessage', id: 'after', text: 'after the big one' } });
    const journal = createJournal({ dir: journalDir });
    const pump = createNativeEventPump({ supervisor: await client(stateDir), remember: remembering(journal), log: () => {} });
    expect(await pump.drainOnce()).toBe(2);
    const records = journaled(journalDir);
    expect(records.map((r) => r.eventId)).toEqual([`codex:${S1}:1:item:big:completed`, `codex:${S1}:1:item:after:completed`]);
    expect(records[0].payload.item.text).toBe(big);
    expect(records[0].payload.source).toEqual({ backend: 'codex', generation: 1, nativeEventId: 'item:big:completed', seq: 1 });
    expect(records[1].payload.item.text).toBe('after the big one');
    expect(ledger.deliveredSeq).toBe(2);
  });

  it('a crash or disconnect before complete delivery never advances the ack; resumption reconstructs once', async () => {
    const { stateDir, ledger, journalDir } = await startSupervisorIpc();
    const big = largeText(MAX_FRAME_BYTES * 2);
    spooled(ledger, 'small-1', 'timeline', { type: 'assistant_text', text: 'first' });
    spooled(ledger, 'big', 'timeline', { type: 'assistant_text', text: big });
    spooled(ledger, 'small-2', 'timeline', { type: 'assistant_text', text: 'last' });
    const real = await client(stateDir);
    let chunks = 0;
    const flaky = { request: async (method, params) => {
      if (method === 'eventChunk' && ++chunks === 2) throw Object.assign(new Error('closed'), { name: 'SupervisorRequestError', code: 'connection_closed' });
      return real.request(method, params);
    } };
    const journal = createJournal({ dir: journalDir });
    const first = createNativeEventPump({ supervisor: flaky, remember: remembering(journal), log: () => {} });
    await expect(first.drainOnce()).rejects.toMatchObject({ code: 'connection_closed' });
    expect(ledger.deliveredSeq).toBe(1);
    expect(journaled(journalDir).map((r) => r.payload.text)).toEqual(['first']);
    await real.close();
    const restarted = createJournal({ dir: journalDir });
    const reconnected = await client(stateDir);
    const second = createNativeEventPump({ supervisor: reconnected, remember: remembering(restarted), log: () => {} });
    expect(await second.drainOnce()).toBe(2);
    expect(journaled(journalDir).map((r) => r.payload.text)).toEqual(['first', big, 'last']);
    expect(ledger.deliveredSeq).toBe(3);
    await reconnected.close();
    const third = createNativeEventPump({ supervisor: await client(stateDir), remember: remembering(restarted), log: () => {} });
    expect(await third.drainOnce()).toBe(0);
    expect(journaled(journalDir)).toHaveLength(3);
  });

  it('an acknowledgement lost after the durable hand-off redelivers, and the journal records each event once', async () => {
    const { stateDir, ledger, journalDir } = await startSupervisorIpc();
    const big = largeText(MAX_FRAME_BYTES + 10);
    spooled(ledger, 'big', 'timeline', { type: 'assistant_text', text: big });
    const real = await client(stateDir);
    const ackLost = { request: async (method, params) => {
      if (method === 'ackEvents') throw Object.assign(new Error('closed'), { name: 'SupervisorRequestError', code: 'connection_closed' });
      return real.request(method, params);
    } };
    const journal = createJournal({ dir: journalDir });
    await expect(createNativeEventPump({ supervisor: ackLost, remember: remembering(journal), log: () => {} }).drainOnce()).rejects.toMatchObject({ code: 'connection_closed' });
    expect(ledger.deliveredSeq).toBe(0);
    expect(journaled(journalDir)).toHaveLength(1);
    await real.close();
    const again = createNativeEventPump({ supervisor: await client(stateDir), remember: remembering(createJournal({ dir: journalDir })), log: () => {} });
    expect(await again.drainOnce()).toBe(1);
    expect(ledger.deliveredSeq).toBe(1);
    const records = journaled(journalDir);
    expect(records).toHaveLength(1);
    expect(records[0].payload.text).toBe(big);
  });

  it('a batch whose aggregate exceeds 1 MiB is delivered completely and in order', async () => {
    const { stateDir, ledger, journalDir } = await startSupervisorIpc();
    const texts = Array.from({ length: 6 }, (_, i) => `${i}:${largeText(300_000)}`);
    texts.forEach((text, i) => spooled(ledger, `m-${i}`, 'timeline', { type: 'assistant_text', text }));
    const journal = createJournal({ dir: journalDir });
    const pump = createNativeEventPump({ supervisor: await client(stateDir), remember: remembering(journal), log: () => {} });
    expect(await pump.drainOnce()).toBe(6);
    expect(journaled(journalDir).map((r) => r.payload.text)).toEqual(texts);
  });

  it('fetchEvents reassembles a chunked event and rejects an incomplete one', async () => {
    const { stateDir, ledger } = await startSupervisorIpc();
    const big = largeText(MAX_FRAME_BYTES + 1);
    spooled(ledger, 'big', 'timeline', { text: big });
    const c = await client(stateDir);
    const [event] = await fetchEvents(c, { afterSeq: 0, limit: 10 });
    expect(event.payload.event.text).toBe(big);
    expect(event.chunked).toBeUndefined();
    for (const corrupt of [(r) => ({ ...r, data: '' }), (r) => ({ ...r, total: r.total + 1 })]) {
      const broken = { request: async (method, params) => {
        const result = await c.request(method, params);
        return method === 'eventChunk' ? corrupt(result) : result;
      } };
      await expect(fetchEvents(broken, { afterSeq: 0, limit: 10 })).rejects.toThrow(/incomplete/);
    }
  });
});

describe('native event mapping onto existing observation kinds (Task 7)', () => {
  const ev = (kind, nativeEventId, event, extra = {}, backend = 'codex') => ({ seq: 7, sessionId: S1, runId: RUN, generation: 2, kind, nativeEventId, at: '2026-11-05T00:00:00.000Z', payload: { backend, event, ...extra } });

  it('event ids are <backend>:<sessionId>:<generation>:<nativeEventId> and stay within the server bound', () => {
    expect(nativeObservation(ev('timeline', 'item:x:started', { phase: 'started' })).eventId).toBe(`codex:${S1}:2:item:x:started`);
    const long = nativeObservation(ev('timeline', 'x'.repeat(400), {}));
    expect(long.eventId.length).toBeLessThanOrEqual(180);
    expect(long.eventId.startsWith(`codex:${S1}:2:`)).toBe(true);
    expect(nativeObservation(ev('timeline', 'x'.repeat(400), {})).eventId).toBe(long.eventId);
    expect(long.payload.source.nativeEventId).toBe('x'.repeat(400));
  });

  it('turn completion becomes an idle session; FF confirms Cancel; a native interruption projects nothing; failure keeps its code', () => {
    expect(nativeObservation(ev('state', 'turn:t:completed', { state: 'completed', turnId: 't' }, { terminal: 'completed' })).payload).toMatchObject({ state: 'idle', nativeState: 'completed' });
    const plain = nativeObservation(ev('state', 'turn:t:completed', { state: 'interrupted', turnId: 't' }, { terminal: 'interrupted' })).payload;
    expect(plain.state).toBeUndefined();
    expect(plain).toMatchObject({ nativeState: 'interrupted', turnId: 't' });
    expect(nativeObservation(ev('state', 'ff:cancel:cancel-1', { state: 'cancelled', cancelCommandId: 'cancel-1', generation: 2, nativeTerminal: 'interrupted', dispatched: true, settled: [] })).payload).toMatchObject({ state: 'cancelled', cancelCommandId: 'cancel-1', nativeTerminal: 'interrupted' });
    expect(nativeObservation(ev('state', 'r', { phase: 'result', errorCode: 'profile_unavailable' }, { terminal: 'failed' }, 'claude-code')).payload).toMatchObject({ state: 'failed', errorCode: 'profile_unavailable' });
    expect(nativeObservation(ev('state', 'r', { phase: 'result' }, { terminal: 'account_limited' }, 'claude-code')).payload).toMatchObject({ state: 'failed', errorCode: 'account_limited' });
    expect(nativeObservation(ev('state', 'session:profile_violation:1', { state: 'profile_violation', errorCode: 'profile_unavailable', actualModel: 'a', fromModel: 'b' })).payload).toMatchObject({ state: 'reconciling', errorCode: 'profile_unavailable', violation: { actualModel: 'a', fromModel: 'b' } });
    expect(nativeObservation(ev('state', 'ff:owned_stop:2', { state: 'failed', errorCode: 'profile_unavailable', stop: 'quiesced' })).payload).toMatchObject({ state: 'failed', errorCode: 'profile_unavailable' });
    expect(nativeObservation(ev('state', 'turn:t:started', { state: 'running' })).payload.state).toBe('running');
    expect(nativeObservation(ev('state', 'c', { phase: 'init', model: 'm' }, {}, 'claude-code')).payload.state).toBeUndefined();
    expect(nativeObservation(ev('state', 'm', { state: 'model_rerouted', toModel: 'm' })).payload.state).toBeUndefined();
  });

  it('a native terminal under an unproven owned stop stays reconciling with its native evidence (fix round 1, R3)', () => {
    for (const ownedStop of ['pending', 'uncertain']) {
      const out = nativeObservation(ev('state', 'turn:t:completed', { state: 'failed', nativeState: 'completed', errorCode: 'profile_unavailable', turnId: 't' }, { terminal: 'failed', ownedStop }));
      expect(out.payload, ownedStop).toMatchObject({ state: 'reconciling', nativeState: 'completed', errorCode: 'profile_unavailable', ownedStop, nativeTerminal: 'failed', turnId: 't' });
    }
    expect(nativeObservation(ev('state', 'turn:t:completed', { state: 'failed', nativeState: 'completed', errorCode: 'profile_unavailable' }, { terminal: 'failed' })).payload.state).toBe('failed');
  });

  it('usage keeps unknown values null and per-turn attribution; plans become workpad plans', () => {
    const usage = nativeObservation(ev('usage', 'usage:t1', { turnId: 't1', model: null, modelAttribution: 'mixed', modelsReported: ['a', 'b'], tokens: { input: 5, cachedInput: 0, cacheWriteInput: 0, output: 4, reasoningOutput: 0, total: 9 }, threadTotals: { input: 5 }, cost: null }));
    expect(usage.kind).toBe('usage');
    expect(usage.payload).toMatchObject({ sampleKey: `codex:${S1}:2:t1`, tokensIn: 5, tokensOut: 4, costUsd: null, model: null, modelAttribution: 'mixed', modelsReported: ['a', 'b'], threadTotals: { input: 5 } });
    const unknown = nativeObservation(ev('usage', 'usage:t2', { turnId: 't2', model: null, modelAttribution: 'unknown', tokens: null, threadTotals: null, cost: null }));
    expect(unknown.payload).toMatchObject({ tokensIn: null, tokensOut: null, reason: 'usage_unavailable' });
    const claudeUsage = nativeObservation(ev('usage', 'u:usage', { samples: [{ model: 'm', inputTokens: 3, outputTokens: 2, cost: { amount: 0.01, currency: 'USD', estimate: true } }] }, {}, 'claude-code'));
    expect(claudeUsage.payload).toMatchObject({ sampleKey: `claude-code:${S1}:2:u:usage`, tokensIn: 3, tokensOut: 2, costUsd: 0.01 });
    const plan = nativeObservation(ev('plan', 'plan:t:1', { turnId: 't', plan: [{ step: 'Read', status: 'completed' }, { step: 'Write', status: 'inProgress' }, { step: 'Test', status: 'pending' }] }));
    expect(plan.kind).toBe('state');
    expect(plan.payload.plan).toEqual({ items: [{ text: 'Read', status: 'completed' }, { text: 'Write', status: 'in_progress' }, { text: 'Test', status: 'pending' }] });
  });

  it('native requests become attention; their resolution resolves them', () => {
    const pending = nativeObservation(ev('attention', 'request:rpc:1', { nativeRequestId: 'rpc:1', kind: 'permission', state: 'pending', choices: [] }));
    expect(pending.payload).toMatchObject({ attention: 'permission', requestId: 'rpc:1', kind: 'permission' });
    expect(nativeObservation(ev('attention', 'request:rpc:1:resolved', { nativeRequestId: 'rpc:1', state: 'resolved' })).payload).toMatchObject({ attention: 'permission_resolved', requestId: 'rpc:1' });
    expect(nativeObservation(ev('attention', 'question:q:answer_barrier:1', { nativeRequestId: 'q', record: 'answer_barrier' })).payload.attention).toBe('native_record');
  });
});

describe('supervisor binding events (Task 11 C5)', () => {
  it('a spooled binding becomes the existing session_bound observation with its exact native id and generation', () => {
    const observation = nativeObservation({ seq: 7, sessionId: 's1', runId: 'r1', generation: 2, kind: 'binding', nativeEventId: 'ff:binding:2', at: '2026-11-05T00:00:00.000Z', payload: { backend: 'codex', event: { nativeSessionId: 'thread-1', generation: 2 } } });
    expect(observation).toMatchObject({ runId: 'r1', sessionId: 's1', kind: 'session_bound', payload: { backend: 'codex', nativeSessionId: 'thread-1', generation: 2, source: { backend: 'codex', generation: 2, nativeEventId: 'ff:binding:2', seq: 7 } } });
  });
});
