import { describe, it, expect, afterEach, vi, onTestFinished } from 'vitest';
import http from 'node:http';
import { createHash } from 'node:crypto';
import {
  startQuestionServer,
  recoverQuestionRecords,
  parseAskArguments,
  QuestionToolError,
  QUESTION_TOOL,
  QUESTION_HOLD_MS,
  QUESTION_HEARTBEAT_MS,
} from '../../../src/native/question-mcp.js';

const TOKEN = 'ff-questions-test-token';
const SESSION = 'sess-1';
const ANSWER_TEXT = 'FF-SECRET-ANSWER-VALUE-91';
const OTHER_TEXT = 'FF-OTHER-FREE-TEXT-37';

const servers = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
});

async function start(extra = {}) {
  const records = [];
  const logs = [];
  const events = [];
  const server = await startQuestionServer({
    sessionId: SESSION,
    generation: 3,
    token: TOKEN,
    record: async (entry) => {
      records.push(entry);
      events.push(`record:${entry.type}`);
    },
    onPending: (req) => events.push(`pending:${req.requestId}`),
    onSettled: (req, outcome) => events.push(`settled:${outcome?.reason ?? outcome?.state ?? 'x'}`),
    log: (entry) => logs.push(entry),
    ...extra,
  });
  servers.push(server);
  return { server, records, logs, events };
}

function post(url, body, { token = TOKEN, headers = {}, raw } = {}) {
  const u = new URL(url);
  const payload = raw ?? JSON.stringify(body);
  const chunks = [];
  let req;
  const done = new Promise((resolve, reject) => {
    req = http.request(
      {
        host: u.hostname,
        port: u.port,
        path: u.pathname,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...headers,
        },
      },
      (res) => {
        res.on('data', (d) => chunks.push(String(d)));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: chunks.join('') }));
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    req.end(payload);
  });
  return { done, chunks, abort: () => req.destroy(), request: () => req };
}

const rpcResult = (text) => {
  const data = text
    .split('\n')
    .filter((l) => l.startsWith('data:'))
    .map((l) => JSON.parse(l.slice(5)));
  return data.length ? data.at(-1) : JSON.parse(text);
};
const toolPayload = (text) => {
  const { result } = rpcResult(text);
  expect(result?.content?.[0]?.type, 'tool result text item').toBe('text');
  return JSON.parse(result.content[0].text);
};

const meta = (callId = 'call_1') => ({ callId, threadId: 'thread-1', itemId: 'fc_1', 'x-codex-turn-metadata': { turn_id: 'turn-1' } });
const ordinary = { id: 'color', header: 'Color', question: 'Which color?', options: [{ label: 'Red', description: null }, { label: 'Blue', description: 'cool' }] };
const secretQ = { id: 'token', header: 'Token', question: 'Paste the token', options: null, secret: true };
const callBody = (args, m = meta(), id = 7) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: QUESTION_TOOL, arguments: args, _meta: m } });

async function waitFor(pred, label, ms = 2000) {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error(`timed out: ${label}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

const allText = (h) => JSON.stringify([h.records, h.logs]);
const digests = (s) => ['sha1', 'sha256', 'md5'].map((a) => createHash(a).update(s).digest('hex'));

describe('question MCP server', () => {
  it('keeps the hold below the Codex 7-day tool timeout', () => {
    expect(QUESTION_HOLD_MS).toBe(518_400_000);
    expect(QUESTION_HOLD_MS).toBeLessThan(604_800_000);
    expect(QUESTION_HEARTBEAT_MS).toBe(15_000);
  });

  it('401 without or with a wrong bearer, 403 with Origin, 404 on another path', async () => {
    const { server } = await start();
    const init = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } };
    expect((await post(server.url, init, { token: null }).done).status).toBe(401);
    expect((await post(server.url, init, { token: 'wrong' }).done).status).toBe(401);
    expect((await post(server.url, init, { headers: { origin: 'http://evil' } }).done).status).toBe(403);
    expect((await post(server.url.replace(SESSION, 'other'), init).done).status).toBe(404);
    expect((await post(server.url, init).done).status).toBe(200);
    expect(new URL(server.url).hostname).toBe('127.0.0.1');
    expect(new URL(server.url).pathname).toBe(`/mcp/${SESSION}`);
  });

  it('rejects a body over 1 MiB with 413', async () => {
    const { server } = await start();
    const r = await post(server.url, null, { raw: `{"x":"${'a'.repeat(1024 * 1024 + 10)}"}` }).done.catch((e) => ({ status: e.code }));
    expect(r.status).toBe(413);
  });

  it('tools/list returns only ask, without annotations', async () => {
    const { server } = await start();
    const r = await post(server.url, { jsonrpc: '2.0', id: 2, method: 'tools/list' }).done;
    const tools = rpcResult(r.text).result?.tools;
    expect(tools?.map((t) => t.name)).toEqual(['ask']);
    expect(tools[0]).not.toHaveProperty('annotations');
    expect(tools[0].inputSchema.type).toBe('object');
    const unknown = await post(server.url, { jsonrpc: '2.0', id: 3, method: 'resources/list' }).done;
    expect(rpcResult(unknown.text).error?.code).toBe(-32601);
  });

  it('invalid arguments or a missing _meta.callId return -32602 and record nothing', async () => {
    const h = await start();
    const bad = [
      callBody({ questions: [] }),
      callBody({ questions: [ordinary, ordinary] }),
      callBody({ questions: [{ ...ordinary, id: 'Bad-Id' }] }),
      callBody({ questions: [{ ...ordinary, options: [{ label: 'A', description: null }, { label: 'A', description: null }] }] }),
      callBody({ questions: [ordinary] }, { threadId: 'thread-1' }),
      callBody({ questions: [ordinary] }, { callId: 'c' }),
    ];
    for (const body of bad) {
      const r = await post(h.server.url, body).done;
      expect(rpcResult(r.text).error?.code, JSON.stringify(body.params.arguments)).toBe(-32602);
    }
    expect(h.records).toEqual([]);
    expect(h.server.pending()).toEqual([]);
    expect(() => parseAskArguments({ questions: [{ ...ordinary, header: '' }] })).toThrow(QuestionToolError);
    expect(parseAskArguments({ questions: [{ ...secretQ }] })).toEqual({
      questions: [{ ...secretQ, multiSelect: false, allowOther: true, secret: true }],
      secret: true,
    });
  });

  it('one call creates one request with a stable requestId and fingerprint', async () => {
    const h = await start();
    const call = post(h.server.url, callBody({ questions: [ordinary] }));
    await waitFor(() => h.server.pending().length === 1, 'pending');
    const [req] = h.server.pending();
    const expectedId = createHash('sha256').update(`${SESSION}|codex|3|call_1`).digest('hex').slice(0, 32);
    const sortKeys = (v) => (Array.isArray(v) ? v.map(sortKeys) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])])) : v);
    const canonical = JSON.stringify(sortKeys({ threadId: 'thread-1', callId: 'call_1', arguments: { questions: [ordinary] } }));
    expect(req.requestId).toBe(expectedId);
    expect(req.nativeRequestId).toBe('call_1');
    expect(req.fingerprint).toBe(createHash('sha256').update(canonical).digest('hex'));
    expect(req.generation).toBe(3);
    expect(req.correlation).toEqual({ threadId: 'thread-1', turnId: 'turn-1', callId: 'call_1', itemId: 'fc_1' });
    expect(req.secret).toBe(false);
    await h.server.decline(req.requestId, { responseId: 'r-x', source: 'web' });
    await call.done;
  });

  it('question_pending is recorded before onPending and answer_barrier before the first response byte', async () => {
    let dataSeenAtBarrier = null;
    const chunksRef = { chunks: [] };
    const h = await start({
      heartbeatMs: 20,
      record: async (entry) => {
        h.records.push(entry);
        h.events.push(`record:${entry.type}`);
        if (entry.type === 'answer_barrier') dataSeenAtBarrier = chunksRef.chunks.join('').includes('data:');
      },
    });
    const call = post(h.server.url, callBody({ questions: [ordinary] }));
    chunksRef.chunks = call.chunks;
    await waitFor(() => h.server.pending().length === 1, 'pending');
    await waitFor(() => call.chunks.join('').includes(':'), 'heartbeat');
    const [req] = h.server.pending();
    await h.server.answer(req.requestId, { responseId: 'r1', source: 'web', selections: { color: { selected: ['Red'], other: null } } });
    await call.done;
    expect(h.events.indexOf('record:question_pending')).toBeLessThan(h.events.indexOf(`pending:${req.requestId}`));
    expect(dataSeenAtBarrier).toBe(false);
    expect(h.records.map((r) => r.type)).toEqual(['question_pending', 'answer_barrier', 'answer_written']);
    expect(h.records[1]).toMatchObject({ responseId: 'r1', requestId: req.requestId, fingerprint: req.fingerprint, generation: 3, source: 'web', operation: 'answer' });
  });

  it('a web answer to an ordinary request dispatches the exact selections', async () => {
    const h = await start();
    const multi = { id: 'size', header: 'Size', question: 'Sizes?', multiSelect: true, allowOther: true, options: [{ label: 'S', description: null }, { label: 'L', description: null }] };
    const call = post(h.server.url, callBody({ questions: [ordinary, multi] }));
    await waitFor(() => h.server.pending().length === 1, 'pending');
    const [req] = h.server.pending();
    const selections = { color: { selected: ['Blue'], other: null }, size: { selected: ['S', 'L'], other: OTHER_TEXT } };
    expect(await h.server.answer(req.requestId, { responseId: 'r1', source: 'web', selections })).toEqual({ state: 'dispatched' });
    const r = await call.done;
    expect(r.headers['content-type']).toMatch(/text\/event-stream/);
    expect(toolPayload(r.text)).toEqual({ status: 'answered', answers: selections });
    expect(h.server.pending()).toEqual([]);
  });

  it('a web answer to a secret request is answer_on_host and writes nothing, while a local answer dispatches', async () => {
    const h = await start();
    const call = post(h.server.url, callBody({ questions: [ordinary, secretQ] }));
    await waitFor(() => h.server.pending().length === 1, 'pending');
    const [req] = h.server.pending();
    expect(req.secret).toBe(true);
    const selections = { color: { selected: ['Red'], other: null }, token: { selected: [], other: ANSWER_TEXT } };
    expect(await h.server.answer(req.requestId, { responseId: 'w1', source: 'web', selections })).toEqual({ state: 'failed', errorCode: 'answer_on_host' });
    expect(call.chunks.join('')).not.toContain('data:');
    expect(await h.server.answer(req.requestId, { responseId: 'l1', source: 'local', selections })).toEqual({ state: 'dispatched' });
    expect(toolPayload((await call.done).text).answers.token.other).toBe(ANSWER_TEXT);
  });

  it('a decline is accepted from either source and carries no answers', async () => {
    const h = await start();
    const call = post(h.server.url, callBody({ questions: [secretQ] }));
    await waitFor(() => h.server.pending().length === 1, 'pending');
    const [req] = h.server.pending();
    expect(await h.server.decline(req.requestId, { responseId: 'd1', source: 'web' })).toEqual({ state: 'dispatched' });
    expect(toolPayload((await call.done).text)).toEqual({ status: 'declined' });
  });

  it('a repeated responseId returns its recorded state and writes nothing, even with other selections', async () => {
    const recorded = new Map([['old-1', { state: 'reconciling' }]]);
    const h = await start({ recorded });
    const call = post(h.server.url, callBody({ questions: [ordinary] }));
    await waitFor(() => h.server.pending().length === 1, 'pending');
    const [req] = h.server.pending();
    expect(await h.server.answer(req.requestId, { responseId: 'old-1', source: 'web', selections: { color: { selected: ['Red'], other: null } } })).toEqual({ state: 'reconciling' });
    expect(h.server.pending()).toHaveLength(1);
    expect(await h.server.answer(req.requestId, { responseId: 'r1', source: 'web', selections: { color: { selected: ['Red'], other: null } } })).toEqual({ state: 'dispatched' });
    const before = h.records.length;
    expect(await h.server.answer(req.requestId, { responseId: 'r1', source: 'web', selections: { color: { selected: ['Blue'], other: null } } })).toEqual({ state: 'dispatched' });
    expect(h.records.length).toBe(before);
    expect(toolPayload((await call.done).text).answers.color.selected).toEqual(['Red']);
  });

  it('two concurrent answers give one dispatched and one request_unavailable', async () => {
    const h = await start();
    const call = post(h.server.url, callBody({ questions: [ordinary] }));
    await waitFor(() => h.server.pending().length === 1, 'pending');
    const [req] = h.server.pending();
    const sel = { color: { selected: ['Red'], other: null } };
    const results = await Promise.all([
      h.server.answer(req.requestId, { responseId: 'a', source: 'web', selections: sel }),
      h.server.answer(req.requestId, { responseId: 'b', source: 'web', selections: sel }),
    ]);
    expect(results.map((r) => r.state).sort()).toEqual(['dispatched', 'failed']);
    expect(results.find((r) => r.state === 'failed')).toEqual({ state: 'failed', errorCode: 'request_unavailable' });
    await call.done;
    expect(h.records.filter((r) => r.type === 'answer_barrier')).toHaveLength(1);
  });

  it('selections outside the offered labels are invalid_response', async () => {
    const h = await start();
    const call = post(h.server.url, callBody({ questions: [ordinary] }));
    await waitFor(() => h.server.pending().length === 1, 'pending');
    const [req] = h.server.pending();
    const bad = [
      { color: { selected: ['Green'], other: null } },
      { color: { selected: ['Red', 'Blue'], other: null } },
      { color: { selected: ['Red', 'Red'], other: null } },
      { color: { selected: [], other: OTHER_TEXT } },
      { color: { selected: [], other: null } },
      {},
    ];
    for (const [i, selections] of bad.entries()) {
      expect(await h.server.answer(req.requestId, { responseId: `bad-${i}`, source: 'web', selections }), JSON.stringify(selections)).toEqual({ state: 'failed', errorCode: 'invalid_response' });
    }
    expect(call.chunks.join('')).not.toContain('data:');
    expect(h.server.pending()).toHaveLength(1);
    await h.server.decline(req.requestId, { responseId: 'd', source: 'web' });
    await call.done;
  });

  it('a client abort records native_aborted and a later answer is request_unavailable', async () => {
    const h = await start();
    const call = post(h.server.url, callBody({ questions: [ordinary] }));
    call.done.catch(() => {
    });
    await waitFor(() => h.server.pending().length === 1, 'pending');
    const [req] = h.server.pending();
    call.abort();
    await waitFor(() => h.records.some((r) => r.type === 'question_withdrawn'), 'withdrawn');
    expect(h.records.at(-1)).toEqual({ type: 'question_withdrawn', requestId: req.requestId, reason: 'native_aborted' });
    expect(h.events).toContain('settled:native_aborted');
    expect(await h.server.answer(req.requestId, { responseId: 'late', source: 'web', selections: { color: { selected: ['Red'], other: null } } })).toEqual({ state: 'failed', errorCode: 'request_unavailable' });
    expect(h.records.some((r) => r.type === 'answer_barrier')).toBe(false);
  });

  it('the hold ceiling and close write withdrawn with no answers', async () => {
    const h = await start({ holdMs: 80, heartbeatMs: 20 });
    const expired = post(h.server.url, callBody({ questions: [ordinary] }, meta('call_e')));
    const r = await expired.done;
    expect(toolPayload(r.text)).toEqual({ status: 'withdrawn' });
    expect(h.records.at(-1)).toMatchObject({ type: 'question_withdrawn', reason: 'expired' });

    const h2 = await start();
    const held = post(h2.server.url, callBody({ questions: [ordinary] }, meta('call_s')));
    await waitFor(() => h2.server.pending().length === 1, 'pending');
    await h2.server.close();
    expect(toolPayload((await held.done).text)).toEqual({ status: 'withdrawn' });
    expect(h2.records.at(-1)).toMatchObject({ type: 'question_withdrawn', reason: 'shutdown' });
  });

  it('a failed write after the barrier is reconciling and never retried', async () => {
    let call;
    const h = await start({
      record: async (entry) => {
        h.records.push(entry);
        if (entry.type === 'answer_barrier') {
          call.request().socket.destroy();
          await new Promise((r) => setTimeout(r, 30));
        }
      },
    });
    call = post(h.server.url, callBody({ questions: [ordinary] }));
    call.done.catch(() => {
    });
    await waitFor(() => h.server.pending().length === 1, 'pending');
    const [req] = h.server.pending();
    const sel = { color: { selected: ['Red'], other: null } };
    expect(await h.server.answer(req.requestId, { responseId: 'r1', source: 'web', selections: sel })).toEqual({ state: 'reconciling' });
    expect(h.records.map((r) => r.type)).toEqual(['question_pending', 'answer_barrier', 'answer_unknown']);
    expect(await h.server.answer(req.requestId, { responseId: 'r1', source: 'web', selections: sel })).toEqual({ state: 'reconciling' });
    expect(await h.server.answer(req.requestId, { responseId: 'r2', source: 'web', selections: sel })).toEqual({ state: 'failed', errorCode: 'request_unavailable' });
    expect(h.records.filter((r) => r.type === 'answer_barrier')).toHaveLength(1);
  });

  it('withdrawTurn on the matching terminal turn records turn_interrupted and refuses a late answer', async () => {
    const h = await start();
    const call = post(h.server.url, callBody({ questions: [ordinary, secretQ] }));
    await waitFor(() => h.server.pending().length === 1, 'pending');
    const [req] = h.server.pending();
    await h.server.withdrawTurn({ threadId: 'thread-1', turnId: 'turn-1', generation: 3 });
    expect(h.server.pending()).toEqual([]);
    expect(h.records.at(-1)).toEqual({ type: 'question_withdrawn', requestId: req.requestId, reason: 'turn_interrupted' });
    expect(h.events).toContain('settled:turn_interrupted');
    expect(toolPayload((await call.done).text)).toEqual({ status: 'withdrawn' });
    const late = await h.server.answer(req.requestId, { responseId: 'late', source: 'local', selections: { color: { selected: ['Red'], other: null }, token: { selected: [], other: ANSWER_TEXT } } });
    expect(late).toEqual({ state: 'failed', errorCode: 'request_unavailable' });
    expect(h.records.some((r) => r.type === 'answer_barrier')).toBe(false);
    expect(JSON.stringify(h.records).includes(ANSWER_TEXT)).toBe(false);
  });

  it('withdrawTurn for another thread, turn or generation keeps the request pending', async () => {
    const h = await start();
    const call = post(h.server.url, callBody({ questions: [ordinary] }));
    await waitFor(() => h.server.pending().length === 1, 'pending');
    const before = h.records.length;
    await h.server.withdrawTurn({ threadId: 'thread-2', turnId: 'turn-1', generation: 3 });
    await h.server.withdrawTurn({ threadId: 'thread-1', turnId: 'turn-9', generation: 3 });
    await h.server.withdrawTurn({ threadId: 'thread-1', turnId: 'turn-1', generation: 2 });
    expect(h.server.pending()).toHaveLength(1);
    expect(h.records.length).toBe(before);
    expect(call.chunks.join('')).not.toContain('data:');
    const [req] = h.server.pending();
    expect(await h.server.answer(req.requestId, { responseId: 'ok', source: 'web', selections: { color: { selected: ['Red'], other: null } } })).toEqual({ state: 'dispatched' });
    await call.done;
  });

  function heldBarrierServer(extra = {}) {
    let release;
    const gate = new Promise((r) => (release = r));
    let entered = false;
    const records = [];
    const opts = {
      record: async (entry) => {
        records.push(entry);
        if (entry.type === 'answer_barrier') {
          entered = true;
          await gate;
        }
      },
      ...extra,
    };
    return { opts, records, release: () => release(), entered: () => entered };
  }

  it('withdrawTurn during a held answer barrier returns at once and the released answer is never written', async () => {
    const held = heldBarrierServer();
    const h = await start(held.opts);
    const call = post(h.server.url, callBody({ questions: [ordinary] }));
    await waitFor(() => h.server.pending().length === 1, 'pending');
    const [req] = h.server.pending();
    const answering = h.server.answer(req.requestId, { responseId: 'held', source: 'local', selections: { color: { selected: ['Red'], other: null } } });
    await waitFor(() => held.entered(), 'barrier entered');
    let withdrew = false;
    const withdrawal = h.server.withdrawTurn({ threadId: 'thread-1', turnId: 'turn-1', generation: 3 }).then(() => (withdrew = true));
    await waitFor(() => withdrew, 'withdrawTurn returned while the answer barrier is held', 500);
    held.release();
    expect(await answering).toEqual({ state: 'failed', errorCode: 'request_unavailable' });
    await withdrawal;
    expect(toolPayload((await call.done).text)).toEqual({ status: 'withdrawn' });
    const types = held.records.map((r) => (r.type === 'question_withdrawn' ? `${r.type}:${r.reason}` : r.type));
    expect(types).toEqual(['question_pending', 'answer_barrier', 'question_withdrawn:turn_interrupted', 'answer_refused']);
    expect(held.records.at(-1)).toEqual({ type: 'answer_refused', responseId: 'held', requestId: req.requestId, errorCode: 'request_unavailable' });
    expect(await h.server.answer(req.requestId, { responseId: 'held', source: 'local', selections: { color: { selected: ['Red'], other: null } } })).toEqual({ state: 'failed', errorCode: 'request_unavailable' });
    expect(recoverQuestionRecords(held.records).responses.get('held')).toEqual({ state: 'failed', errorCode: 'request_unavailable' });
  });

  it('a withdrawal during a held answer barrier for another turn does not stop the answer', async () => {
    const held = heldBarrierServer();
    const h = await start(held.opts);
    const call = post(h.server.url, callBody({ questions: [ordinary] }));
    await waitFor(() => h.server.pending().length === 1, 'pending');
    const [req] = h.server.pending();
    const answering = h.server.answer(req.requestId, { responseId: 'held', source: 'local', selections: { color: { selected: ['Red'], other: null } } });
    await waitFor(() => held.entered(), 'barrier entered');
    await h.server.withdrawTurn({ threadId: 'thread-1', turnId: 'turn-9', generation: 3 });
    held.release();
    expect(await answering).toEqual({ state: 'dispatched' });
    expect(toolPayload((await call.done).text)).toMatchObject({ status: 'answered' });
  });

  function rejectingBarrierServer({ failWithdrawal = false } = {}) {
    let reject;
    const gate = new Promise((_, r) => (reject = r));
    gate.catch(() => {
    });
    let entered = false;
    const records = [];
    const settled = [];
    const opts = {
      heartbeatMs: 10,
      onSettled: (_req, outcome) => settled.push(outcome),
      record: async (entry) => {
        if (failWithdrawal && entry.type === 'question_withdrawn') throw new Error('withdrawal store down');
        records.push(entry);
        if (entry.type === 'answer_barrier') {
          entered = true;
          await gate;
        }
      },
    };
    return { opts, records, settled, reject: (err) => reject(err), entered: () => entered };
  }

  for (const failWithdrawal of [false, true]) {
    it(`an answer barrier that rejects after a turn withdrawal settles the request and keeps the original error${failWithdrawal ? ' (withdrawal record fails too)' : ''}`, async () => {
      const keepaliveWrites = [];
      const write = http.ServerResponse.prototype.write;
      const spy = vi.spyOn(http.ServerResponse.prototype, 'write').mockImplementation(function (chunk, ...rest) {
        if (chunk === ': keepalive\n\n') keepaliveWrites.push(Date.now());
        return write.call(this, chunk, ...rest);
      });
      onTestFinished(() => spy.mockRestore());
      const held = rejectingBarrierServer({ failWithdrawal });
      const h = await start(held.opts);
      const call = post(h.server.url, callBody({ questions: [ordinary] }));
      call.done.catch(() => {
      });
      await waitFor(() => h.server.pending().length === 1, 'pending');
      const [req] = h.server.pending();
      const answering = h.server.answer(req.requestId, { responseId: 'held', source: 'local', selections: { color: { selected: ['Red'], other: null } } });
      answering.catch(() => {
      });
      await waitFor(() => held.entered(), 'barrier entered');
      await waitFor(() => keepaliveWrites.length > 0, 'server heartbeat while held');
      await h.server.withdrawTurn({ threadId: 'thread-1', turnId: 'turn-1', generation: 3 });
      held.reject(new Error('barrier storage failed'));
      await expect(answering).rejects.toThrow('barrier storage failed');
      expect(h.server.pending()).toEqual([]);
      expect(held.settled).toEqual([{ state: failWithdrawal ? 'reconciling' : 'withdrawn', reason: 'turn_interrupted' }]);
      const body = call.chunks.join('');
      expect(body).not.toContain('answered');
      if (!failWithdrawal) expect(toolPayload((await call.done).text)).toEqual({ status: 'withdrawn' });
      const serverBeats = () => keepaliveWrites.length;
      const beats = serverBeats();
      await new Promise((r) => setTimeout(r, 60));
      expect(serverBeats(), 'heartbeats stopped').toBe(beats);
      expect(held.records.map((r) => r.type)).toEqual(failWithdrawal ? ['question_pending', 'answer_barrier'] : ['question_pending', 'answer_barrier', 'question_withdrawn']);
      if (failWithdrawal) expect(h.logs.some((l) => l.code === 'record_failed')).toBe(true);
      expect(await h.server.answer(req.requestId, { responseId: 'held', source: 'local', selections: { color: { selected: ['Red'], other: null } } })).toEqual({ state: 'reconciling' });
      expect(await h.server.answer(req.requestId, { responseId: 'next', source: 'local', selections: { color: { selected: ['Red'], other: null } } })).toEqual({ state: 'failed', errorCode: 'request_unavailable' });
    });
  }

  it('an answer barrier that rejects with no withdrawal leaves the request genuinely pending and answerable', async () => {
    let fail = true;
    const h = await start({
      record: async (entry) => {
        if (entry.type === 'answer_barrier' && fail) {
          fail = false;
          throw new Error('barrier storage failed');
        }
        h.records.push(entry);
      },
    });
    const call = post(h.server.url, callBody({ questions: [ordinary] }));
    await waitFor(() => h.server.pending().length === 1, 'pending');
    const [req] = h.server.pending();
    await expect(h.server.answer(req.requestId, { responseId: 'first', source: 'web', selections: { color: { selected: ['Red'], other: null } } })).rejects.toThrow('barrier storage failed');
    expect(h.server.pending()).toHaveLength(1);
    expect(await h.server.answer(req.requestId, { responseId: 'second', source: 'web', selections: { color: { selected: ['Red'], other: null } } })).toEqual({ state: 'dispatched' });
    await call.done;
  });

  it('an admit check refuses a question before anything is recorded or published', async () => {
    const seen = [];
    const h = await start({ admit: (req) => (seen.push(req.correlation), req.correlation.turnId === 'turn-1' ? { ok: true } : { ok: false, reason: 'turn_not_owned' }) });
    const refusedCall = post(h.server.url, callBody({ questions: [ordinary] }, { ...meta('call_x'), 'x-codex-turn-metadata': { turn_id: 'turn-other' } }, 21));
    refusedCall.done.catch(() => {
    });
    const refused = await Promise.race([refusedCall.done, new Promise((r) => setTimeout(() => r(null), 500))]);
    expect(refused, 'the refused call is answered at once').not.toBeNull();
    expect(rpcResult(refused.text).error).toEqual({ code: -32603, message: 'Question not admitted' });
    expect(h.records).toEqual([]);
    expect(h.server.pending()).toEqual([]);
    expect(h.events.some((e) => e.startsWith('pending:'))).toBe(false);
    expect(h.logs.some((l) => l.code === 'question_not_admitted' && l.reason === 'turn_not_owned')).toBe(true);
    const call = post(h.server.url, callBody({ questions: [ordinary] }));
    await waitFor(() => h.server.pending().length === 1, 'admitted pending');
    expect(seen.map((c) => c.turnId)).toEqual(['turn-other', 'turn-1']);
    const [req] = h.server.pending();
    expect(await h.server.answer(req.requestId, { responseId: 'ok', source: 'web', selections: { color: { selected: ['Red'], other: null } } })).toEqual({ state: 'dispatched' });
    await call.done;
  });

  it('a withdrawal record failure stops heartbeats, makes the request unavailable and propagates', async () => {
    const settledWith = [];
    const h = await start({
      heartbeatMs: 10,
      onSettled: (_req, outcome) => settledWith.push(outcome),
      record: async (entry) => {
        if (entry.type === 'question_withdrawn') throw new Error('store down');
        h.records.push(entry);
      },
    });
    const call = post(h.server.url, callBody({ questions: [ordinary] }));
    call.done.catch(() => {
    });
    await waitFor(() => h.server.pending().length === 1, 'pending');
    const [req] = h.server.pending();
    await expect(h.server.withdraw(req.requestId, 'shutdown')).rejects.toThrow('store down');
    const heartbeatsAtFailure = (call.chunks.join('').match(/:/g) ?? []).length;
    await new Promise((r) => setTimeout(r, 80));
    expect((call.chunks.join('').match(/:/g) ?? []).length, 'heartbeats after failure').toBe(heartbeatsAtFailure);
    expect(h.server.pending()).toEqual([]);
    expect(settledWith).toEqual([{ state: 'reconciling', reason: 'shutdown' }]);
    expect(call.chunks.join('')).not.toContain('data:');
    expect(await h.server.answer(req.requestId, { responseId: 'late', source: 'web', selections: { color: { selected: ['Red'], other: null } } })).toEqual({ state: 'failed', errorCode: 'request_unavailable' });
    expect(h.records.some((r) => r.type === 'answer_barrier')).toBe(false);
    call.abort();
  });

  it('a native abort whose withdrawal record fails notifies reconciling and stays unavailable', async () => {
    const settledWith = [];
    const h = await start({
      onSettled: (_req, outcome) => settledWith.push(outcome),
      record: async (entry) => {
        if (entry.type === 'question_withdrawn') throw new Error('store down');
        h.records.push(entry);
      },
    });
    const call = post(h.server.url, callBody({ questions: [ordinary] }));
    call.done.catch(() => {
    });
    await waitFor(() => h.server.pending().length === 1, 'pending');
    const [req] = h.server.pending();
    call.abort();
    await waitFor(() => settledWith.length === 1, 'settled');
    expect(settledWith).toEqual([{ state: 'reconciling', reason: 'native_aborted' }]);
    expect(h.logs.some((l) => l.code === 'record_failed')).toBe(true);
    expect(await h.server.answer(req.requestId, { responseId: 'late', source: 'web', selections: { color: { selected: ['Red'], other: null } } })).toEqual({ state: 'failed', errorCode: 'request_unavailable' });
  });

  it('close always shuts the listener and sockets even when the withdrawal record fails', async () => {
    const h = await start({
      record: async (entry) => {
        if (entry.type === 'question_withdrawn') throw new Error('store down');
        h.records.push(entry);
      },
    });
    servers.splice(servers.indexOf(h.server), 1);
    const call = post(h.server.url, callBody({ questions: [ordinary] }));
    const ended = call.done.then(
      () => 'ended',
      () => 'reset',
    );
    await waitFor(() => h.server.pending().length === 1, 'pending');
    await expect(h.server.close()).rejects.toThrow('store down');
    expect(await Promise.race([ended, new Promise((r) => setTimeout(() => r('still open'), 500))])).not.toBe('still open');
    const port = new URL(h.server.url).port;
    const refused = await new Promise((resolve) => {
      const r = http.request({ host: '127.0.0.1', port, path: '/', method: 'POST' }, () => resolve('accepted'));
      r.on('error', (e) => resolve(e.code));
      r.end();
    });
    expect(refused).toBe('ECONNREFUSED');
  });

  it('a receipt record failure after the write settles reconciling, propagates and never replays', async () => {
    const settledWith = [];
    const h = await start({
      onSettled: (_req, outcome) => settledWith.push(outcome),
      record: async (entry) => {
        if (entry.type === 'answer_written') throw new Error('store down');
        h.records.push(entry);
      },
    });
    const call = post(h.server.url, callBody({ questions: [ordinary] }));
    await waitFor(() => h.server.pending().length === 1, 'pending');
    const [req] = h.server.pending();
    const sel = { color: { selected: ['Red'], other: null } };
    await expect(h.server.answer(req.requestId, { responseId: 'r1', source: 'web', selections: sel })).rejects.toThrow('store down');
    await call.done;
    expect(settledWith).toEqual([{ state: 'reconciling' }]);
    expect(h.server.pending()).toEqual([]);
    expect(await h.server.answer(req.requestId, { responseId: 'r1', source: 'web', selections: sel })).toEqual({ state: 'reconciling' });
    expect(h.records.filter((r) => r.type === 'answer_barrier')).toHaveLength(1);
  });

  const throwingSettled = () => {
    throw new Error('callback boom');
  };
  const settleFailures = (h) => h.logs.filter((l) => l.code === 'settle_callback_failed');

  it('a throwing onSettled cannot hide a withdrawal record failure or skip its protected log', async () => {
    const h = await start({
      onSettled: throwingSettled,
      record: async (entry) => {
        if (entry.type === 'question_withdrawn') throw new Error('store down');
        h.records.push(entry);
      },
    });
    const call = post(h.server.url, callBody({ questions: [ordinary] }));
    call.done.catch(() => {
    });
    await waitFor(() => h.server.pending().length === 1, 'pending');
    const [req] = h.server.pending();
    await expect(h.server.withdraw(req.requestId, 'shutdown')).rejects.toThrow('store down');
    expect(h.logs.some((l) => l.code === 'record_failed' && l.requestId === req.requestId)).toBe(true);
    expect(settleFailures(h)).toHaveLength(1);
    expect(h.server.pending()).toEqual([]);
    expect(await h.server.answer(req.requestId, { responseId: 'late', source: 'web', selections: { color: { selected: ['Red'], other: null } } })).toEqual({ state: 'failed', errorCode: 'request_unavailable' });
    call.abort();
  });

  it('a throwing onSettled cannot hide a receipt record failure, and the response still never replays', async () => {
    const h = await start({
      onSettled: throwingSettled,
      record: async (entry) => {
        if (entry.type === 'answer_written') throw new Error('store down');
        h.records.push(entry);
      },
    });
    const call = post(h.server.url, callBody({ questions: [ordinary] }));
    await waitFor(() => h.server.pending().length === 1, 'pending');
    const [req] = h.server.pending();
    const sel = { color: { selected: ['Red'], other: null } };
    await expect(h.server.answer(req.requestId, { responseId: 'r1', source: 'web', selections: sel })).rejects.toThrow('store down');
    await call.done;
    expect(h.logs.some((l) => l.code === 'record_failed' && l.responseId === 'r1')).toBe(true);
    expect(settleFailures(h)).toHaveLength(1);
    expect(await h.server.answer(req.requestId, { responseId: 'r1', source: 'web', selections: sel })).toEqual({ state: 'reconciling' });
    expect(h.records.filter((r) => r.type === 'answer_barrier')).toHaveLength(1);
  });

  it('a throwing onSettled on a native abort is logged and never an unhandled rejection', async () => {
    const unhandled = [];
    const onUnhandled = (reason) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      for (const failRecord of [true, false]) {
        const h = await start({
          onSettled: throwingSettled,
          record: async (entry) => {
            if (failRecord && entry.type === 'question_withdrawn') throw new Error('store down');
            h.records.push(entry);
          },
        });
        const call = post(h.server.url, callBody({ questions: [ordinary] }));
        call.done.catch(() => {
        });
        await waitFor(() => h.server.pending().length === 1, 'pending');
        call.abort();
        await waitFor(() => settleFailures(h).length === 1, `settle callback failure logged (record ${failRecord ? 'fails' : 'ok'})`);
        expect(h.logs.some((l) => l.code === 'record_failed'), 'record failure log').toBe(failRecord);
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('a throwing onSettled after a dispatched answer keeps the dispatched outcome', async () => {
    const h = await start({ onSettled: throwingSettled });
    const call = post(h.server.url, callBody({ questions: [ordinary] }));
    await waitFor(() => h.server.pending().length === 1, 'pending');
    const [req] = h.server.pending();
    expect(await h.server.answer(req.requestId, { responseId: 'r1', source: 'web', selections: { color: { selected: ['Red'], other: null } } })).toEqual({ state: 'dispatched' });
    await call.done;
    expect(settleFailures(h)).toHaveLength(1);
  });

  it('one responseId used concurrently on two pending requests dispatches once and leaves the other pending', async () => {
    const h = await start();
    const first = post(h.server.url, callBody({ questions: [ordinary] }, meta('call_a'), 11));
    const second = post(h.server.url, callBody({ questions: [ordinary] }, meta('call_b'), 12));
    await waitFor(() => h.server.pending().length === 2, 'two pending');
    const [a, b] = h.server.pending();
    const sel = { color: { selected: ['Red'], other: null } };
    const results = await Promise.all([
      h.server.answer(a.requestId, { responseId: 'shared', source: 'web', selections: sel }),
      h.server.answer(b.requestId, { responseId: 'shared', source: 'web', selections: sel }),
    ]);
    expect(results).toEqual([{ state: 'dispatched' }, { state: 'dispatched' }]);
    expect(h.records.filter((r) => r.type === 'answer_barrier')).toHaveLength(1);
    expect(h.server.pending().map((r) => r.requestId)).toEqual([b.requestId]);
    await h.server.decline(b.requestId, { responseId: 'other', source: 'web' });
    await Promise.all([first.done, second.done]);
  });

  it('recoverQuestionRecords maps written, barrier-only, refused and unsettled entries', () => {
    const entries = [
      { type: 'question_pending', requestId: 'q1' },
      { type: 'answer_barrier', requestId: 'q1', responseId: 'r1' },
      { type: 'answer_written', requestId: 'q1', responseId: 'r1' },
      { type: 'question_pending', requestId: 'q2' },
      { type: 'answer_barrier', requestId: 'q2', responseId: 'r2' },
      { type: 'question_pending', requestId: 'q3' },
      { type: 'answer_refused', requestId: 'q3', responseId: 'r3', errorCode: 'answer_on_host' },
      { type: 'question_pending', requestId: 'q4' },
      { type: 'question_withdrawn', requestId: 'q4', reason: 'native_aborted' },
    ];
    const { responses, expired } = recoverQuestionRecords(entries);
    expect(Object.fromEntries(responses)).toEqual({
      r1: { state: 'dispatched' },
      r2: { state: 'reconciling' },
      r3: { state: 'failed', errorCode: 'answer_on_host' },
    });
    expect(expired).toEqual(['q3']);
  });

  it('no record, log line or error contains the answer text, the other text, or a sha1, sha256 or md5 hex of either', async () => {
    const h = await start();
    const call = post(h.server.url, callBody({ questions: [ordinary, secretQ] }));
    await waitFor(() => h.server.pending().length === 1, 'pending');
    const [req] = h.server.pending();
    const secretSel = { color: { selected: ['Red'], other: null }, token: { selected: [], other: ANSWER_TEXT } };
    const errors = [];
    errors.push(await h.server.answer(req.requestId, { responseId: 'w', source: 'web', selections: secretSel }));
    errors.push(await h.server.answer(req.requestId, { responseId: 'x', source: 'local', selections: { ...secretSel, color: { selected: ['Red'], other: OTHER_TEXT } } }));
    errors.push(await h.server.answer(req.requestId, { responseId: 'l', source: 'local', selections: secretSel }));
    await call.done;
    const haystack = allText(h) + JSON.stringify(errors);
    for (const needle of [ANSWER_TEXT, OTHER_TEXT, ...digests(ANSWER_TEXT), ...digests(OTHER_TEXT)]) {
      expect(haystack.includes(needle), needle.slice(0, 12)).toBe(false);
    }
    expect(h.records.length).toBeGreaterThan(2);
  });
});
