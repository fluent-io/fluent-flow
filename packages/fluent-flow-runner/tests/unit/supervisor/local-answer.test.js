import { describe, it, expect, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, realpathSync, readdirSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import { createLedger } from '../../../src/supervisor/ledger.js';
import { createSupervisorHandlers } from '../../../src/supervisor/supervisor.js';
import { ContainmentError } from '../../../src/supervisor/containment.js';
import { readProcessIdentity } from '../../../src/supervisor/process-identity.js';
import { createSpoolPrivacy } from '../../../src/supervisor/spool-privacy.js';
import { answerBarrierRef } from '../../../src/supervisor/backend-contract.js';
import { createIpcServer } from '../../../src/supervisor/ipc.js';
import { connectSupervisor } from '../../../src/supervisor/client.js';
import { startQuestionServer } from '../../../src/native/question-mcp.js';
import { profileRevision } from '../../../src/connector/catalog.js';
import { LOCAL_ANSWER_WARNING, LOCAL_TTY_REQUIRED, runLocalAnswer } from '../../../src/supervisor/cli.js';

const here = dirname(fileURLToPath(import.meta.url));
const runnerRoot = resolve(here, '../../..');
const repoRoot = resolve(runnerRoot, '../..');
const roots = [];
const closers = [];
afterEach(async () => {
  for (const c of closers.splice(0)) await c();
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

const RUN = '11111111-1111-4111-8111-111111111111';
const S1 = '22222222-2222-4222-8222-222222222222';
const codex = { id: 'cx-main', name: 'Codex', backend: 'codex', executable: '/opt/codex', contextDir: '/ctx', model: 'm-x', policy: { approvalPolicy: 'on-request', sandbox: 'workspace-write', networkAccess: false }, complete: true, problems: [] };
const REV = profileRevision(codex, '0.162.1');
const TOKEN = 'question-token-0123456789abcdef';
const SECRET = 'tok-SECRET-41f7';
const ORDINARY = { id: 'color', header: 'Color', question: 'Which color?', options: [{ label: 'Red', description: null }, { label: 'Blue', description: null }], allowOther: true };
const SECRET_Q = { id: 'token', header: 'Token', question: 'Paste the token', options: null, allowOther: true, secret: true };
const ffRequestId = (sessionId, backend, generation, nativeRequestId) => createHash('sha256').update(`${sessionId}|${backend}|${generation}|${nativeRequestId}`).digest('hex').slice(0, 32);
const until = async (check, ms = 3000) => {
  const start = Date.now();
  for (;;) {
    const v = await check();
    if (v) return v;
    if (Date.now() - start > ms) return expect.fail('timed out waiting for the expected state');
    await new Promise((r) => setTimeout(r, 10));
  }
};

function gitRepo(base) {
  const repo = join(base, 'repo');
  mkdirSync(repo);
  const git = (...args) => execFileSync('git', ['-C', repo, '-c', 'user.name=T', '-c', 'user.email=t@example.test', ...args], { encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'README.md'), 'base\n');
  git('add', '.');
  git('commit', '-q', '-m', 'base');
  return repo;
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
        const child = Object.assign(new EventEmitter(), { pid: 4242, exitCode: null, signalCode: null });
        return { child, identity: await readProcessIdentity(process.pid) };
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

function questionBackend() {
  const workers = [];
  return {
    id: 'codex',
    workers,
    async readiness() { return { state: 'ready' }; },
    async open(opts) {
      await opts.effects.barrier('create_native_session', {});
      const { child, identity } = await opts.spawn({ executable: opts.profile.executable, args: [], env: {}, cwd: opts.workspaceDir });
      await opts.effects.bind(`thread-${opts.sessionId}`);
      const events = queue();
      const calls = new Map();
      const publicRequests = new Map();
      let seq = 0;
      const server = await startQuestionServer({
        sessionId: opts.sessionId, generation: opts.generation, token: TOKEN,
        async record(entry) {
          if (entry.type === 'answer_barrier') {
            const call = calls.get(entry.responseId);
            if (!call || call.requestId !== entry.requestId) throw new Error('answer barrier without its respond call');
            return call.barrier(answerBarrierRef(entry));
          }
          const { type, requestId, ...rest } = entry;
          events.push({ kind: 'attention', nativeEventId: `question:${requestId}:${type}:${++seq}`, payload: { nativeRequestId: requestId, record: type, ...rest } });
        },
        onPending(req) {
          const publicRequest = { nativeRequestId: req.requestId, kind: 'question', fingerprint: req.fingerprint, secret: req.secret, hostOnly: req.secret, generation: req.generation,
            choices: [{ id: 'decline', label: 'Deny and continue', scope: 'once', behavior: 'deny' }], questions: req.questions, correlation: { ...req.correlation } };
          publicRequests.set(req.requestId, publicRequest);
          events.push({ kind: 'attention', nativeEventId: `question:${req.requestId}:pending`, payload: { ...publicRequest, state: 'pending' } });
        },
        onSettled(req, outcome) {
          publicRequests.delete(req.requestId);
          events.push({ kind: 'attention', nativeEventId: `question:${req.requestId}:settled:${++seq}`, payload: { nativeRequestId: req.requestId, state: outcome?.state ?? 'settled' } });
        },
      });
      const worker = {
        nativeSessionId: `thread-${opts.sessionId}`,
        identity: { ...identity, pgid: child.pid, cgroup: '/unit' },
        events,
        server,
        respondCalls: [],
        emit: (e) => events.push(e),
        pending: () => [...publicRequests.values()],
        idle: () => false,
        async send({ barrier }) { await barrier({}); return { receipt: { state: 'started', dispatched: true } }; },
        async respond({ commandId, nativeRequestId, response, source, barrier }) {
          worker.respondCalls.push({ commandId, source });
          const known = publicRequests.get(nativeRequestId);
          if (known && response?.fingerprint !== undefined && response.fingerprint !== known.fingerprint) return { state: 'failed', errorCode: 'request_unavailable' };
          calls.set(commandId, { barrier, requestId: nativeRequestId });
          if (response?.selections !== undefined) return server.answer(nativeRequestId, { responseId: commandId, source, selections: response.selections });
          if (response?.selectedActionId === 'decline' && response?.behavior === 'deny') return server.decline(nativeRequestId, { responseId: commandId, source });
          return { state: 'failed', errorCode: 'request_unavailable' };
        },
        async interrupt({ barrier }) { await barrier({}); return { receipt: null, terminal: null, settled: [], dispatched: false }; },
        async close() { await server.close(); events.end(); },
      };
      closers.push(() => server.close());
      workers.push(worker);
      return worker;
    },
  };
}

async function ask(url, questions, callId = `call-${randomUUID()}`) {
  const controller = new AbortController();
  const response = await fetch(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'ask', arguments: { questions }, _meta: { callId, threadId: `thread-${S1}`, 'x-codex-turn-metadata': { turn_id: 'turn-1' } } } }),
    signal: controller.signal,
  });
  const result = (async () => {
    const text = await response.text();
    const data = text.split('\n').find((l) => l.startsWith('data: '));
    return data ? JSON.parse(JSON.parse(data.slice(6)).result.content[0].text) : null;
  })();
  result.catch(() => {
  });
  return { callId, result, abort: () => controller.abort() };
}

function setup() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'ff-local-answer-')));
  roots.push(base);
  const repo = gitRepo(base);
  const stateDir = join(base, 'state');
  mkdirSync(join(stateDir, 'supervisor'), { recursive: true, mode: 0o700 });
  const dir = join(stateDir, 'supervisor');
  const ledger = createLedger({ dir });
  const logs = [];
  const backend = questionBackend();
  const privacy = createSpoolPrivacy();
  const handlers = createSupervisorHandlers({ ledger, profiles: [codex], backends: { codex: backend }, containment: memoryContainment(), log: (l) => logs.push(l), stateDir, repositories: { repo }, privacy, stopTimeoutMs: 300 });
  handlers.connectorAttached?.({}, { role: 'connector', connectorEpoch: 0 });
  handlers.controlPlaneStatus?.({ online: true }, { role: 'connector', connectorEpoch: 0 });
  return { base, stateDir, dir, ledger, handlers, backend, logs };
}

const launch = { commandId: 'launch-1', digest: 'd-launch-1', runId: RUN, sessionId: S1, backend: 'codex', kind: 'launch', profileId: 'cx-main', profileRevision: REV, repositoryKey: 'repo', branchName: `ff/run-${RUN}`, baseRef: 'main', role: 'work', reporting: { url: 'http://127.0.0.1:9/mcp/collab', credential: 'reporting-credential' } };
const ledgerLines = (dir) => readFileSync(join(dir, 'ledger.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));

async function started(questions) {
  const t = setup();
  expect(await t.handlers.submit(launch)).toMatchObject({ state: 'accepted' });
  const worker = t.backend.workers[0];
  const call = await ask(worker.server.url, questions);
  const listed = await until(async () => (await t.handlers.pendingQuestions()).requests.at(0));
  return { ...t, worker, call, listed };
}

function filesUnder(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...filesUnder(p));
    else if (st.isFile()) out.push(p);
  }
  return out;
}
const digests = (value) => ['sha1', 'sha256', 'md5'].flatMap((alg) => [createHash(alg).update(value).digest('hex'), createHash(alg).update(value).digest('base64')]);

describe('host-local answers (Task 9)', () => {
  it('no answer bytes and no sha1, sha256 or md5 hex of them exist in any file under stateDir', async () => {
    const t = await started([SECRET_Q]);
    expect(t.listed).toMatchObject({ sessionId: S1, runId: RUN, backend: 'codex', kind: 'question', secret: true, hostOnly: true, generation: 1,
      requestId: ffRequestId(S1, 'codex', 1, t.listed.nativeRequestId), questions: [{ id: 'token', question: 'Paste the token', secret: true }] });
    expect(await t.handlers.submit({ commandId: 'web-1', digest: 'dw', runId: RUN, sessionId: S1, backend: 'codex', kind: 'permission', nativeRequestId: t.listed.nativeRequestId, generation: 1, fingerprint: t.listed.fingerprint, response: { behavior: 'allow', selections: { token: { selected: [], other: 'web-typed' } } } })).toEqual({ state: 'failed', errorCode: 'answer_on_host' });
    expect(t.ledger.classify('web-1')).toBe('undispatched');
    const localCommandId = randomUUID();
    await expect(t.handlers.localAnswer({ localCommandId, requestId: t.listed.requestId, selections: { token: { selected: [], other: SECRET } } })).resolves.toEqual({ state: 'applied' });
    expect(await t.call.result).toEqual({ status: 'answered', answers: { token: { selected: [], other: SECRET } } });
    t.worker.emit({ kind: 'timeline', nativeEventId: 'item:call:completed', payload: { type: 'item_completed', item: { type: 'mcpToolCall', id: t.call.callId, server: 'ff_questions', tool: 'ask', status: 'completed', arguments: { questions: [SECRET_Q] }, result: { content: [{ type: 'text', text: JSON.stringify({ status: 'answered', answers: { token: { selected: [], other: SECRET } } }) }] } } } });
    t.worker.emit({ kind: 'timeline', nativeEventId: 'item:echo', payload: { type: 'agentMessage', text: `The token you gave is ${SECRET}.` } });
    const events = await until(() => {
      const e = ledgerLines(t.dir).filter((r) => r.type === 'event');
      return e.some((r) => r.nativeEventId === 'item:echo') ? e : null;
    });
    expect(events.find((r) => r.nativeEventId === 'item:echo').payload.event.text).toBe('The token you gave is [local answer].');
    expect(events.find((r) => r.nativeEventId === 'item:call:completed').payload.event.item).toMatchObject({ result: null, resultWithheld: 'ff_question_answer' });
    const resolved = events.find((r) => r.nativeEventId === `ff:local:${localCommandId}`);
    expect(resolved.payload.event).toEqual({ nativeRequestId: t.listed.nativeRequestId, state: 'resolved', resolvedBy: 'host' });
    const local = ledgerLines(t.dir).filter((r) => r.commandId === localCommandId);
    expect(local.map((r) => (r.type === 'barrier' ? `barrier:${r.effect}` : r.type))).toEqual(['accept', 'barrier:respond', 'receipt', 'outcome']);
    expect(Object.keys(local[0]).sort()).toEqual(['at', 'backend', 'commandId', 'digest', 'fingerprint', 'generation', 'kind', 'operation', 'requestId', 'runId', 'sessionId', 'type', 'v'].sort());
    expect(local[0]).toMatchObject({ kind: 'local_answer', requestId: t.listed.requestId, fingerprint: t.listed.fingerprint, generation: 1, operation: 'answer', digest: 'local' });
    expect(local[1].ref).toEqual({ nativeRequestId: t.listed.nativeRequestId, responseId: localCommandId, source: 'local', requestKind: 'question', fingerprint: t.listed.fingerprint, operation: 'answer' });
    expect(local[3]).toMatchObject({ state: 'applied' });
    const needles = [SECRET, ...digests(SECRET)];
    for (const file of filesUnder(t.stateDir)) {
      const bytes = readFileSync(file);
      for (const needle of needles) expect(bytes.includes(needle), `${file} contains ${needle === SECRET ? 'the answer' : 'an answer digest'}`).toBe(false);
    }
    expect(JSON.stringify(t.logs)).not.toContain(SECRET);
  });

  it('a locally selected label of an ordinary question is a live answer value: its later echo is spooled as [local answer]', async () => {
    const t = await started([ORDINARY]);
    expect(t.listed).toMatchObject({ secret: false, hostOnly: false });
    const pendingEvent = await until(() => ledgerLines(t.dir).find((r) => r.type === 'event' && r.nativeEventId === `question:${t.listed.nativeRequestId}:pending`));
    expect(pendingEvent.payload.event.questions[0].options.map((o) => o.label)).toEqual(['Red', 'Blue']);
    expect(await t.handlers.localAnswer({ localCommandId: randomUUID(), requestId: t.listed.requestId, selections: { color: { selected: ['Blue'] } } })).toEqual({ state: 'applied' });
    expect(await t.call.result).toEqual({ status: 'answered', answers: { color: { selected: ['Blue'], other: null } } });
    t.worker.emit({ kind: 'timeline', nativeEventId: 'item:label-echo', payload: { type: 'agentMessage', text: 'You picked Blue.' } });
    const echo = await until(() => ledgerLines(t.dir).find((r) => r.type === 'event' && r.nativeEventId === 'item:label-echo'));
    expect(echo.payload.event.text).toBe('You picked [local answer].');
    expect(ledgerLines(t.dir).find((r) => r.nativeEventId === `question:${t.listed.nativeRequestId}:pending`).payload.event.questions[0].options.map((o) => o.label)).toEqual(['Red', 'Blue']);
  });

  it('a repeated localCommandId never redispatches', async () => {
    const t = await started([ORDINARY]);
    const localCommandId = randomUUID();
    const answering = t.handlers.localAnswer({ localCommandId, requestId: t.listed.requestId, selections: { color: { selected: ['Red'] } } });
    await expect(answering).resolves.toEqual({ state: 'applied' });
    const first = await answering;
    expect(await t.call.result).toEqual({ status: 'answered', answers: { color: { selected: ['Red'], other: null } } });
    expect(await t.handlers.localAnswer({ localCommandId, requestId: t.listed.requestId, selections: { color: { selected: ['Blue'] } } })).toEqual(first);
    expect(await t.handlers.localAnswer({ localCommandId, requestId: 'f'.repeat(32), selections: { color: { selected: [], other: 'Green' } } })).toEqual(first);
    expect(t.worker.respondCalls).toEqual([{ commandId: localCommandId, source: 'local' }]);
    expect(ledgerLines(t.dir).filter((r) => r.type === 'barrier' && r.commandId === localCommandId)).toHaveLength(1);
    const late = randomUUID();
    expect(await t.handlers.localAnswer({ localCommandId: late, requestId: t.listed.requestId, selections: { color: { selected: ['Blue'] } } })).toEqual({ state: 'failed', errorCode: 'request_unavailable' });
    expect(await t.handlers.localAnswer({ localCommandId: late, requestId: t.listed.requestId, selections: { color: { selected: ['Blue'] } } })).toEqual({ state: 'failed', errorCode: 'request_unavailable' });
    expect(t.worker.respondCalls).toHaveLength(1);
    const lost = randomUUID();
    t.ledger.acceptLocal({ localCommandId: lost, runId: RUN, sessionId: S1, backend: 'codex', requestId: t.listed.requestId, fingerprint: t.listed.fingerprint, generation: 1, operation: 'answer' });
    const restarted = createSupervisorHandlers({ ledger: createLedger({ dir: t.dir }), profiles: [codex], backends: { codex: questionBackend() }, containment: memoryContainment(), log: () => {}, stateDir: t.stateDir, repositories: {}, privacy: createSpoolPrivacy() });
    expect(await restarted.localAnswer({ localCommandId: lost, requestId: t.listed.requestId, selections: { color: { selected: ['Red'] } } })).toEqual({ state: 'failed', errorCode: 'request_unavailable' });
    expect(await restarted.localAnswer({ localCommandId, requestId: t.listed.requestId, selections: { color: { selected: ['Red'] } } })).toEqual(first);
  });

  it('fix 1 I1: a replayed local answer with a barrier but no outcome stays reconciling, over the real reopened ledger', async () => {
    const t = await started([ORDINARY]);
    const meta = { runId: RUN, sessionId: S1, backend: 'codex', requestId: t.listed.requestId, fingerprint: t.listed.fingerprint, generation: 1, operation: 'answer' };
    const ref = (id) => ({ nativeRequestId: t.listed.nativeRequestId, responseId: id, source: 'local', requestKind: 'question', fingerprint: t.listed.fingerprint, operation: 'answer' });
    const barrierOnly = randomUUID();
    t.ledger.acceptLocal({ localCommandId: barrierOnly, ...meta });
    t.ledger.barrier(barrierOnly, { effect: 'respond', generation: 1, ref: ref(barrierOnly) });
    const receiptOnly = randomUUID();
    t.ledger.acceptLocal({ localCommandId: receiptOnly, ...meta });
    t.ledger.barrier(receiptOnly, { effect: 'respond', generation: 1, ref: ref(receiptOnly) });
    t.ledger.receipt(receiptOnly, { effect: 'respond', evidence: { state: 'dispatched' } });
    const reopened = createLedger({ dir: t.dir });
    const restarted = createSupervisorHandlers({ ledger: reopened, profiles: [codex], backends: { codex: questionBackend() }, containment: memoryContainment(), log: () => {}, stateDir: t.stateDir, repositories: {}, privacy: createSpoolPrivacy() });
    const before = ledgerLines(t.dir).length;
    for (const id of [barrierOnly, receiptOnly]) {
      expect(await restarted.localAnswer({ localCommandId: id, requestId: t.listed.requestId, selections: { color: { selected: ['Blue'], other: 'replacement' } } })).toEqual({ state: 'reconciling', errorCode: 'reconciling' });
      expect(await t.handlers.localAnswer({ localCommandId: id, requestId: t.listed.requestId, selections: { color: { selected: ['Red'] } } })).toEqual({ state: 'reconciling', errorCode: 'reconciling' });
    }
    expect(ledgerLines(t.dir)).toHaveLength(before);
    expect(ledgerLines(t.dir).filter((r) => r.type === 'outcome' && [barrierOnly, receiptOnly].includes(r.commandId))).toEqual([]);
    expect(t.worker.respondCalls).toEqual([]);
    expect((await t.handlers.pendingQuestions()).requests.map((r) => r.requestId)).toEqual([t.listed.requestId]);
  });

  it('fix 1 I2: a later ordinary question offering earlier local values is answerable from the web by option id', async () => {
    const colors = [{ label: 'Blue', description: null }, { label: 'Green', description: null }, { label: 'Red', description: null }];
    const t = await started([{ id: 'colors', header: 'Colors', question: 'Which colors?', options: colors, multiSelect: true }]);
    expect(await t.handlers.localAnswer({ localCommandId: randomUUID(), requestId: t.listed.requestId, selections: { colors: { selected: ['Blue', 'Green'] } } })).toEqual({ state: 'applied' });
    await t.call.result;
    const registeredAt = ledgerLines(t.dir).length;
    const second = await ask(t.worker.server.url, [{ id: 'pick', header: 'Pick', question: 'Pick one', options: colors }]);
    const listed = await until(async () => (await t.handlers.pendingQuestions()).requests.find((r) => r.requestId !== t.listed.requestId));
    const spooled = await until(() => ledgerLines(t.dir).find((r) => r.type === 'event' && r.nativeEventId === `question:${listed.nativeRequestId}:pending`));
    expect(spooled.payload.event.questions[0].options.map((o) => o.label)).toEqual(['[local answer]', '[local answer]', 'Red']);
    const web = (commandId, selections, over = {}) => t.handlers.submit({ commandId, digest: `d-${commandId}`, runId: RUN, sessionId: S1, backend: 'codex', kind: 'permission', nativeRequestId: listed.nativeRequestId, generation: 1, fingerprint: listed.fingerprint, response: { behavior: 'allow', selections }, ...over });
    expect(await web('bad-1', { pick: { optionIds: ['o9'] } })).toEqual({ state: 'failed', errorCode: 'invalid_response' });
    expect(await web('bad-2', { pick: { optionIds: ['o1', 'o1'] } })).toEqual({ state: 'failed', errorCode: 'invalid_response' });
    expect(await web('bad-3', { colors: { optionIds: ['o1'] } })).toEqual({ state: 'failed', errorCode: 'invalid_response' });
    expect(await web('bad-4', { pick: { optionIds: ['o1'], selected: ['Green'] } })).toEqual({ state: 'failed', errorCode: 'invalid_response' });
    expect(await web('bad-5', { pick: { optionIds: ['o1'] } }, { fingerprint: 'f'.repeat(64) })).toEqual({ state: 'failed', errorCode: 'request_unavailable' });
    for (const id of ['bad-1', 'bad-2', 'bad-3', 'bad-4', 'bad-5']) expect(t.ledger.classify(id)).toBe('undispatched');
    expect(await web('web-pick', { pick: { optionIds: ['o1'] } })).toEqual({ state: 'applied' });
    expect(await second.result).toEqual({ status: 'answered', answers: { pick: { selected: ['Green'], other: null } } });
    const later = JSON.stringify(ledgerLines(t.dir).slice(registeredAt));
    expect(later).not.toContain('Blue');
    expect(later).not.toContain('Green');
  });

  it('concurrent web and local answers produce one native response', async () => {
    const t = await started([ORDINARY]);
    const respond = t.worker.respond;
    let active = 0;
    let overlap = 0;
    t.worker.respond = async (args) => {
      active += 1;
      overlap = Math.max(overlap, active);
      await new Promise((r) => setTimeout(r, 30));
      try {
        return await respond(args);
      } finally {
        active -= 1;
      }
    };
    const web = { commandId: 'web-race', digest: 'dr', runId: RUN, sessionId: S1, backend: 'codex', kind: 'permission', nativeRequestId: t.listed.nativeRequestId, generation: 1, fingerprint: t.listed.fingerprint, response: { behavior: 'allow', selections: { color: { selected: ['Blue'] } } } };
    const [w, l] = await Promise.all([t.handlers.submit(web), t.handlers.localAnswer({ localCommandId: randomUUID(), requestId: t.listed.requestId, selections: { color: { selected: ['Red'] } } }).catch((err) => ({ state: 'threw', code: err.code }))]);
    expect([w.state, l.state].sort()).toEqual(['applied', 'failed']);
    expect([w, l].find((x) => x.state === 'failed')).toEqual({ state: 'failed', errorCode: 'request_unavailable' });
    const result = await t.call.result;
    expect(result.status).toBe('answered');
    expect(ledgerLines(t.dir).filter((r) => r.type === 'receipt' && r.effect === 'respond')).toHaveLength(1);
    expect(overlap).toBe(1);
    expect(await t.handlers.submit({ ...web, commandId: 'web-old', generation: 2 })).toEqual({ state: 'failed', errorCode: 'request_unavailable' });
    expect(t.worker.respondCalls.map((c) => c.commandId)).not.toContain('web-old');
  });

  it('refuses fresh local answers after the connector IPC detaches', async () => {
    const t = await started([ORDINARY]);
    const server = createIpcServer({ instanceId: 'local-answer-ipc', stateDir: t.stateDir, handlers: t.handlers, log: (entry) => t.logs.push(entry) });
    await server.listen();
    closers.push(() => server.close());
    const connector = await connectSupervisor({ instanceId: 'local-answer-ipc', stateDir: t.stateDir, role: 'connector' });
    if (t.handlers.controlPlaneStatus) await connector.request('controlPlaneStatus', { online: true });
    const cli = await connectSupervisor({ instanceId: 'local-answer-ipc', stateDir: t.stateDir, role: 'cli' });
    closers.push(() => cli.close());
    await connector.close();
    await until(() => t.logs.some((entry) => entry.msg === 'connector detached with outstanding slot grants'));
    const before = ledgerLines(t.dir).length;
    const result = await cli.request('localAnswer', { localCommandId: randomUUID(), requestId: t.listed.requestId, selections: { color: { selected: ['Red'] } } });
    expect(result).toEqual({ state: 'failed', errorCode: 'request_unavailable' });
    expect(t.worker.respondCalls).toEqual([]);
    expect(ledgerLines(t.dir)).toHaveLength(before);
  });

  it('refuses a queued local answer when connectivity is lost before dispatch', async () => {
    const t = await started([ORDINARY]);
    const respond = t.worker.respond;
    let enteredGate = () => {};
    let releaseGate = () => {};
    const entered = new Promise((resolveEntered) => (enteredGate = resolveEntered));
    const gate = new Promise((resolveGate) => (releaseGate = resolveGate));
    t.worker.respond = async (args) => {
      if (args.commandId === 'web-connectivity-gate') {
        enteredGate();
        await gate;
        return { state: 'failed', errorCode: 'invalid_response' };
      }
      return respond(args);
    };
    const web = t.handlers.submit({ commandId: 'web-connectivity-gate', digest: 'dcg', runId: RUN, sessionId: S1, backend: 'codex', kind: 'permission', nativeRequestId: t.listed.nativeRequestId, generation: 1, fingerprint: t.listed.fingerprint, response: { behavior: 'allow', selections: { color: { selected: ['Blue'] } } } });
    await entered;
    const localCommandId = randomUUID();
    const local = t.handlers.localAnswer({ localCommandId, requestId: t.listed.requestId, selections: { color: { selected: ['Red'] } } });
    await until(() => t.ledger.commandRecord(localCommandId));
    await t.handlers.connectorDetached({}, { role: 'connector', connectorEpoch: 0 });
    releaseGate();
    await expect(web).resolves.toEqual({ state: 'failed', errorCode: 'invalid_response' });
    await expect(local).resolves.toEqual({ state: 'failed', errorCode: 'request_unavailable' });
    expect(t.worker.respondCalls.map((call) => call.commandId)).not.toContain(localCommandId);
    expect(t.ledger.commandRecord(localCommandId)).toMatchObject({ barriers: [], outcome: { state: 'failed', errorCode: 'request_unavailable' } });
  });

  it('web answers keep the question server\'s invalid_response unchanged', async () => {
    const t = await started([ORDINARY]);
    expect(await t.handlers.submit({ commandId: 'web-bad', digest: 'db', runId: RUN, sessionId: S1, backend: 'codex', kind: 'permission', nativeRequestId: t.listed.nativeRequestId, generation: 1, fingerprint: t.listed.fingerprint, response: { behavior: 'allow', selections: { color: { selected: ['Purple'] } } } })).toEqual({ state: 'failed', errorCode: 'invalid_response' });
    expect(await t.handlers.localAnswer({ localCommandId: randomUUID(), requestId: t.listed.requestId, selections: { color: { selected: ['Purple'] } } })).toEqual({ state: 'failed', errorCode: 'invalid_response' });
    t.call.abort();
    await until(async () => (await t.handlers.pendingQuestions()).requests.length === 0);
    expect(ledgerLines(t.dir).filter((r) => r.type === 'barrier' && r.effect === 'respond')).toEqual([]);
  });
});

function fakeTty() {
  const timeline = [];
  const input = new PassThrough();
  Object.assign(input, { isTTY: true, isRaw: false, setRawMode(v) { this.isRaw = v; timeline.push(['raw', v]); return this; } });
  const output = new PassThrough();
  Object.assign(output, { isTTY: true });
  const origWrite = output.write.bind(output);
  output.write = (chunk, ...rest) => { timeline.push(['out', String(chunk)]); return origWrite(chunk, ...rest); };
  output.resume();
  const type = (text) => input.write(text);
  return { input, output, timeline, type, written: () => timeline.filter(([k]) => k === 'out').map(([, v]) => v).join('') };
}

function cliConfig() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'ff-local-cli-')));
  roots.push(base);
  const file = join(base, 'connector.json');
  writeFileSync(file, JSON.stringify({ serverUrl: 'http://127.0.0.1:9', tokenFile: join(base, 'missing-token'), instanceId: 'cli-inst', repositories: {} }), { mode: 0o600 });
  return { base, file };
}

describe('runner answer --local (Task 9)', () => {
  const request = { requestId: 'a'.repeat(32), sessionId: S1, runId: RUN, backend: 'codex', nativeRequestId: 'native-1', kind: 'question', secret: true, hostOnly: true, generation: 1, fingerprint: 'b'.repeat(64),
    questions: [{ id: 'token', header: 'Token', question: 'Paste the token', options: null, multiSelect: false, allowOther: true, secret: true }] };

  it('non-TTY input is refused', async () => {
    const { file } = cliConfig();
    const output = new PassThrough();
    let text = '';
    output.on('data', (c) => (text += c));
    let connected = false;
    const code = await runLocalAnswer({ configFile: file, input: Object.assign(new PassThrough(), { isTTY: false }), output, connect: async () => { connected = true; } });
    expect(code).toBe(1);
    expect(text).toBe(`${LOCAL_TTY_REQUIRED}\n`);
    expect(connected).toBe(false);
  });

  it('the warning prints before input', async () => {
    const { base, file } = cliConfig();
    const tty = fakeTty();
    const calls = [];
    const connect = async (opts) => {
      calls.push(['connect', opts]);
      return {
        async request(method, params) {
          calls.push([method, params]);
          if (method === 'pendingQuestions') return { requests: [request] };
          if (method === 'localAnswer') return { state: 'applied' };
          throw new Error(`unexpected ${method}`);
        },
        async close() { calls.push(['close']); },
      };
    };
    const done = runLocalAnswer({ configFile: file, requestId: request.requestId, input: tty.input, output: tty.output, connect, randomId: () => 'c0ffee00-0000-4000-8000-000000000001' });
    await until(() => tty.timeline.some(([k, v]) => k === 'raw' && v === true));
    const warningAt = tty.timeline.findIndex(([k, v]) => k === 'out' && v.includes(LOCAL_ANSWER_WARNING));
    const firstRaw = tty.timeline.findIndex(([k, v]) => k === 'raw' && v === true);
    expect(warningAt).toBeGreaterThanOrEqual(0);
    expect(warningAt).toBeLessThan(firstRaw);
    tty.type(`${SECRET}\r`);
    expect(await done).toBe(0);
    expect(tty.written()).not.toContain(SECRET);
    expect(tty.written()).toContain('*'.repeat(SECRET.length));
    expect(tty.written()).toContain('Paste the token');
    expect(calls[0]).toEqual(['connect', { instanceId: 'cli-inst', stateDir: join(base, 'connector-cli-inst'), role: 'cli' }]);
    expect(calls.find(([m]) => m === 'localAnswer')).toEqual(['localAnswer', { localCommandId: 'c0ffee00-0000-4000-8000-000000000001', requestId: request.requestId, selections: { token: { selected: [], other: SECRET } } }]);
    expect(tty.timeline.filter(([k]) => k === 'raw').at(-1)).toEqual(['raw', false]);
  });

  it('options are chosen by number and an unknown request is refused without input', async () => {
    const { file } = cliConfig();
    const tty = fakeTty();
    const sent = [];
    const ordinary = { ...request, secret: false, hostOnly: false, questions: [{ id: 'color', header: 'Color', question: 'Which color?', options: [{ label: 'Red', description: null }, { label: 'Blue', description: 'cool' }], multiSelect: true, allowOther: true, secret: false }] };
    const connect = async () => ({
      async request(method, params) {
        if (method === 'pendingQuestions') return { requests: [ordinary] };
        sent.push(params);
        return { state: 'applied' };
      },
      async close() {},
    });
    const done = runLocalAnswer({ configFile: file, input: tty.input, output: tty.output, connect });
    await until(() => tty.timeline.filter(([k, v]) => k === 'raw' && v === true).length === 1);
    tty.type('1,2\r');
    await until(() => tty.timeline.filter(([k, v]) => k === 'raw' && v === true).length === 2);
    tty.type('teal\r');
    expect(await done).toBe(0);
    expect(sent).toEqual([{ localCommandId: expect.stringMatching(/^[0-9a-f-]{36}$/), requestId: ordinary.requestId, selections: { color: { selected: ['Red', 'Blue'], other: 'teal' } } }]);
    const missing = fakeTty();
    expect(await runLocalAnswer({ configFile: file, requestId: 'c'.repeat(32), input: missing.input, output: missing.output, connect })).toBe(1);
    expect(missing.written()).toContain('This request is no longer available. Refresh the session.');
    expect(missing.timeline.some(([k]) => k === 'raw')).toBe(false);
  });

  it('both entry points route answer --local to the local answer path without starting anything', () => {
    const { base, file } = cliConfig();
    const connector = spawnSync(process.execPath, [join(runnerRoot, 'bin/fluent-flow-connector.js'), 'answer', '--local', '--config', file], { input: '', encoding: 'utf8', timeout: 20_000 });
    expect(connector.status).toBe(1);
    expect(connector.stderr).toBe(`${LOCAL_TTY_REQUIRED}\n`);
    expect(connector.stdout).toBe('');
    expect(existsSync(join(base, 'connector-cli-inst'))).toBe(false);
    const dev = spawnSync(process.execPath, [join(repoRoot, 'scripts/dev-runner.mjs'), 'answer', '--local', '--request', 'a'.repeat(32)], { input: '', encoding: 'utf8', timeout: 20_000, cwd: base });
    expect(dev.status).toBe(1);
    expect(dev.stderr).toBe(`${LOCAL_TTY_REQUIRED}\n`);
    expect(dev.stdout).toBe('');
    const usage = spawnSync(process.execPath, [join(runnerRoot, 'bin/fluent-flow-connector.js'), 'answer'], { input: '', encoding: 'utf8', timeout: 20_000 });
    expect(usage.status).toBe(1);
    expect(usage.stderr).toContain('Usage: fluent-flow-connector');
  });
});
