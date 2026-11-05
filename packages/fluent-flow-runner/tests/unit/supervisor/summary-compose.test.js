import { describe, it, expect, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createLedger } from '../../../src/supervisor/ledger.js';
import { createSupervisorHandlers, EVENT_BATCH_BYTES } from '../../../src/supervisor/supervisor.js';
import { ContainmentError } from '../../../src/supervisor/containment.js';
import { readProcessIdentity } from '../../../src/supervisor/process-identity.js';
import { MAX_FRAME_BYTES } from '../../../src/supervisor/ipc.js';
import { nativeCursorEpoch } from '../../../src/supervisor/summary.js';
import { profileRevision } from '../../../src/connector/catalog.js';

const roots = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

const RUN = '11111111-1111-4111-8111-111111111111';
const WORK = '22222222-2222-4222-8222-222222222222';
const SUMMARY = '33333333-3333-4333-8333-333333333333';
const work = { id: 'cc-work', name: 'Claude', backend: 'claude-code', executable: '/opt/claude', contextDir: '/ctx', model: 'm-work', policy: { permissionMode: 'manual' }, complete: true, problems: [] };
const summaryProfile = { ...work, id: 'cc-summary', model: 'm-summary' };
const flush = async (n = 20) => { for (let i = 0; i < n; i += 1) await new Promise((r) => setImmediate(r)); };
const EARLIER = 'EARLIER marker';
const LATER = 'LATER marker after the freeze';
const UNIT = '大きな要約🎉 source ';
const GIANT = UNIT.repeat(Math.ceil((MAX_FRAME_BYTES + 100_000) / Buffer.byteLength(UNIT, 'utf8')));

function queue() {
  const items = [];
  let wake = null;
  let ended = false;
  return {
    push(item) { items.push(item); wake?.(); },
    end() { ended = true; wake?.(); },
    async *[Symbol.asyncIterator]() {
      for (;;) {
        if (items.length) { yield items.shift(); continue; }
        if (ended) return;
        await new Promise((r) => (wake = r));
        wake = null;
      }
    },
  };
}

function memoryContainment() {
  const leaves = new Map();
  const scopePath = '/mem/ff-0123456789abcdef';
  const leafPath = ({ generation, sessionId }) => `${scopePath}/w-${generation}-${sessionId}`;
  return {
    state: 'verified',
    scopePath,
    ops: {
      leafPath,
      createWorker({ generation, sessionId }) { const p = leafPath({ generation, sessionId }); leaves.set(p, { populated: false }); return p; },
      async spawn({ cgroupPath }) {
        leaves.get(cgroupPath).populated = true;
        return { child: Object.assign(new EventEmitter(), { pid: 4242 }), identity: await readProcessIdentity(process.pid) };
      },
      leaf({ cgroupPath, generation, sessionId }) {
        if (cgroupPath !== leafPath({ generation, sessionId })) throw new ContainmentError('not_owned_leaf', 'not this leaf');
        if (!leaves.has(cgroupPath)) throw new ContainmentError('leaf_missing', 'gone');
        return cgroupPath;
      },
      async read({ cgroupPath }) { return { populated: leaves.get(cgroupPath).populated }; },
      async kill({ cgroupPath }) { leaves.get(cgroupPath).populated = false; },
    },
  };
}

function backend() {
  const workers = new Map();
  const opened = [];
  return {
    id: 'claude-code',
    workers,
    opened,
    async readiness() { return { state: 'ready' }; },
    async open(opts) {
      opened.push(opts.sessionId);
      await opts.effects.barrier('create_native_session', {});
      const { child, identity } = await opts.spawn({ executable: '/opt/claude', args: [], env: {}, cwd: opts.workspaceDir });
      await opts.effects.bind(`native-${opts.sessionId}`);
      const events = queue();
      const worker = {
        nativeSessionId: `native-${opts.sessionId}`,
        identity: { ...identity, pgid: child.pid, cgroup: '/unit' },
        events,
        sends: [],
        pending: () => [],
        idle: () => true,
        async send({ commandId, text, mode, barrier }) { await barrier({}); worker.sends.push({ commandId, text, mode }); return { receipt: { state: 'replayed', dispatched: true } }; },
        async respond() { return { state: 'failed', errorCode: 'request_unavailable' }; },
        async interrupt({ barrier }) { await barrier({}); return { receipt: null, terminal: null, settled: [], dispatched: false }; },
        async close() { events.end(); },
      };
      workers.set(opts.sessionId, worker);
      return worker;
    },
  };
}

async function setup() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'ff-summary-compose-')));
  roots.push(base);
  const repo = join(base, 'repo');
  mkdirSync(repo);
  const git = (...args) => execFileSync('git', ['-C', repo, '-c', 'user.name=T', '-c', 'user.email=t@example.test', ...args]);
  git('init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'README.md'), 'base\n');
  git('add', '.');
  git('commit', '-q', '-m', 'base');
  const stateDir = join(base, 'state');
  mkdirSync(join(stateDir, 'supervisor'), { recursive: true, mode: 0o700 });
  const ledger = createLedger({ dir: join(stateDir, 'supervisor') });
  const b = backend();
  const logs = [];
  const handlers = createSupervisorHandlers({ ledger, profiles: [work, summaryProfile], backends: { 'claude-code': b }, containment: memoryContainment(), log: (l) => logs.push(l), stateDir, repositories: { repo }, limits: { 'claude-code': 4, codex: 4 } });
  handlers.connectorAttached({}, { role: 'connector', connectorEpoch: 0 });
  handlers.controlPlaneStatus({ online: true }, { role: 'connector', connectorEpoch: 0 });
  const reporting = { url: 'http://127.0.0.1:9/mcp/collab', credential: 'reporting-credential' };
  const launched = await handlers.submit({ commandId: 'launch-1', digest: 'd1', runId: RUN, sessionId: WORK, backend: 'claude-code', kind: 'launch', profileId: 'cc-work', profileRevision: profileRevision(work, '2.1.317'), repositoryKey: 'repo', branchName: `ff/run-${RUN}`, baseRef: 'main', role: 'work', reporting });
  expect(launched.state).toBe('accepted');
  expect(await handlers.deliver({ commandId: 'launch-1', digest: 'd1', text: 'Do the task.' })).toEqual({ state: 'applied' });
  const worker = b.workers.get(WORK);
  worker.events.push({ kind: 'timeline', nativeEventId: 'a1', payload: { type: 'assistant_text', text: EARLIER } });
  worker.events.push({ kind: 'timeline', nativeEventId: 'a2', payload: { type: 'assistant_text', text: GIANT } });
  worker.events.push({ kind: 'state', nativeEventId: 'r1', payload: { phase: 'result' }, terminal: 'completed' });
  await flush();
  const frozenSeq = ledger.eventsAfter(0).filter((e) => e.sessionId === WORK).at(-1).seq;
  worker.events.push({ kind: 'timeline', nativeEventId: 'a3', payload: { type: 'assistant_text', text: LATER } });
  await flush();
  expect(ledger.eventsAfter(0).some((e) => e.payload.event?.text === LATER)).toBe(true);
  const summarize = (over = {}) => ({ commandId: 'summary-1', digest: 'd2', runId: RUN, sessionId: SUMMARY, backend: 'claude-code', kind: 'summarize', profileId: 'cc-summary', profileRevision: profileRevision(summaryProfile, '2.1.317'), repositoryKey: 'repo', role: 'summary', reporting,
    summarySource: { sessionId: WORK, sourceCursor: { epoch: nativeCursorEpoch('claude-code'), seq: frozenSeq } }, ...over });
  return { handlers, ledger, backend: b, logs, frozenSeq, summarize };
}

describe('supervisor-composed native summary prompts (Task 8 C1)', () => {
  it('a complete frozen source larger than one IPC frame reaches the summary worker whole, in order, correlated and without later text', async () => {
    expect(Buffer.byteLength(GIANT, 'utf8')).toBeGreaterThan(MAX_FRAME_BYTES);
    expect(GIANT.length).toBeGreaterThan(200_000);
    expect(Buffer.byteLength(JSON.stringify({ text: GIANT }), 'utf8')).toBeGreaterThan(EVENT_BATCH_BYTES);
    const t = await setup();
    const bound = await t.handlers.submit(t.summarize());
    expect(bound.state, JSON.stringify(bound)).toBe('accepted');
    expect(await t.handlers.deliver({ commandId: 'summary-1', digest: 'd2', text: 'Summarize the run.' })).toEqual({ state: 'applied' });
    const sends = t.backend.workers.get(SUMMARY).sends;
    expect(sends).toHaveLength(1);
    expect(sends[0].text, 'the prompt carries the frozen history').toContain(EARLIER);
    const [instructions, ...rest] = sends[0].text.split('\n');
    expect(instructions).toBe('Summarize the run.');
    expect(JSON.parse(rest.join('\n'))).toEqual({ history: { sourceSessionId: WORK, sourceCursor: { epoch: nativeCursorEpoch('claude-code'), seq: String(t.frozenSeq) }, assistantText: `${EARLIER}\n\n${GIANT}` } });
    expect(sends[0].text).not.toContain(LATER);
    const rec = t.ledger.commandRecord('summary-1');
    expect(rec.barriers.map((b) => b.effect)).toEqual(['create_native_session', 'prompt']);
    expect(rec.receipts.map((r) => r.effect)).toEqual(['prompt']);
    expect(JSON.stringify(bound)).not.toContain('大きな要約');
  });

  it.each([
    ['a missing source', { summarySource: undefined }],
    ['another backend domain', 'codex-domain'],
    ['a cursor beyond the history', 'beyond'],
    ['an unknown source session', 'unknown-session'],
  ])('%s refuses with summary_unavailable before any summary worker is opened', async (_name, variant) => {
    const t = await setup();
    const source = { sessionId: WORK, sourceCursor: { epoch: nativeCursorEpoch('claude-code'), seq: t.frozenSeq } };
    const over = typeof variant === 'object' ? variant
      : variant === 'codex-domain' ? { summarySource: { ...source, sourceCursor: { epoch: nativeCursorEpoch('codex'), seq: t.frozenSeq } } }
        : variant === 'beyond' ? { summarySource: { ...source, sourceCursor: { ...source.sourceCursor, seq: 10_000 } } }
          : { summarySource: { ...source, sessionId: '55555555-5555-4555-8555-555555555555' } };
    expect(await t.handlers.submit(t.summarize(over))).toEqual({ state: 'failed', errorCode: 'summary_unavailable' });
    expect(t.backend.opened).toEqual([WORK]);
    expect(t.ledger.commandRecord('summary-1').barriers).toEqual([]);
  });
});
