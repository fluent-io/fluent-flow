
import http from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

export const QUESTION_SERVER = 'ff_questions';
export const QUESTION_TOOL = 'ask';
export const QUESTION_HOLD_MS = 518_400_000;
export const QUESTION_HEARTBEAT_MS = 15_000;

const MAX_BODY_BYTES = 1024 * 1024;

export class QuestionToolError extends Error {
  /** @param {'invalid_arguments'} code @param {string} message */
  constructor(code, message) {
    super(message);
    this.name = 'QuestionToolError';
    this.code = code;
  }
}

const optionSchema = z.object({
  label: z.string().min(1).max(120),
  description: z.string().nullable().default(null),
});

const questionSchema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
    header: z.string().min(1).max(80),
    question: z.string().min(1).max(2000),
    options: z.array(optionSchema).min(1).max(10).nullable().default(null),
    multiSelect: z.boolean().default(false),
    allowOther: z.boolean().default(false),
    secret: z.boolean().default(false),
  })
  .refine((q) => q.options === null || new Set(q.options.map((o) => o.label)).size === q.options.length, { message: 'option labels must be unique' });

const argumentsSchema = z
  .object({ questions: z.array(questionSchema).min(1).max(3) })
  .refine((a) => new Set(a.questions.map((q) => q.id)).size === a.questions.length, { message: 'question ids must be unique' });

const metaSchema = z
  .object({
    callId: z.string().min(1),
    threadId: z.string().min(1),
    itemId: z.string().min(1).optional(),
    'x-codex-turn-metadata': z.object({ turn_id: z.string().optional() }).passthrough().optional(),
  })
  .passthrough();

/**
 * @typedef {{ id: string, header: string, question: string, options: Array<{ label: string, description: string|null }>|null, multiSelect: boolean, allowOther: boolean, secret: boolean }} AskQuestion
 * @typedef {{ requestId: string, nativeRequestId: string, fingerprint: string, generation: number, correlation: { threadId: string, turnId: string|null, callId: string, itemId: string|null }, questions: AskQuestion[], secret: boolean }} QuestionRequest
 */

/**
 * @param {unknown} args
 * @returns {{ questions: AskQuestion[], secret: boolean }}
 */
export function parseAskArguments(args) {
  const parsed = argumentsSchema.safeParse(args);
  if (!parsed.success) throw new QuestionToolError('invalid_arguments', 'ask arguments are invalid');
  const questions = parsed.data.questions.map((q) => ({
    id: q.id,
    header: q.header,
    question: q.question,
    options: q.options,
    multiSelect: q.multiSelect,
    allowOther: q.options === null ? true : q.allowOther,
    secret: q.secret,
  }));
  return { questions, secret: questions.some((q) => q.secret) };
}

const ASK_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    questions: {
      type: 'array',
      minItems: 1,
      maxItems: 3,
      items: {
        type: 'object',
        properties: {
          id: { type: 'string', pattern: '^[a-z][a-z0-9_]{0,63}$', description: 'Stable snake_case id used to map the answer.' },
          header: { type: 'string', minLength: 1, maxLength: 80 },
          question: { type: 'string', minLength: 1, maxLength: 2000 },
          options: {
            type: ['array', 'null'],
            minItems: 1,
            maxItems: 10,
            items: {
              type: 'object',
              properties: { label: { type: 'string', minLength: 1, maxLength: 120 }, description: { type: ['string', 'null'] } },
              required: ['label'],
            },
            description: 'Offered choices, or null for a free-text answer.',
          },
          multiSelect: { type: 'boolean' },
          allowOther: { type: 'boolean', description: 'Allow a free-text answer besides the options.' },
          secret: { type: 'boolean', description: 'The answer is sensitive and must be given on the execution host.' },
        },
        required: ['id', 'header', 'question'],
      },
    },
  },
  required: ['questions'],
};

const sha256 = (s) => createHash('sha256').update(s).digest('hex');

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function validSelections(questions, selections) {
  if (selections === null || typeof selections !== 'object' || Array.isArray(selections)) return false;
  const ids = questions.map((q) => q.id);
  if (Object.keys(selections).length !== ids.length || !ids.every((id) => Object.hasOwn(selections, id))) return false;
  return questions.every((q) => {
    const s = selections[q.id];
    if (s === null || typeof s !== 'object' || !Array.isArray(s.selected)) return false;
    const other = s.other ?? null;
    if (other !== null && (typeof other !== 'string' || other.length === 0 || !q.allowOther)) return false;
    const offered = new Set((q.options ?? []).map((o) => o.label));
    if (!s.selected.every((l) => typeof l === 'string' && offered.has(l))) return false;
    if (new Set(s.selected).size !== s.selected.length) return false;
    if (!q.multiSelect && s.selected.length > 1) return false;
    return s.selected.length > 0 || other !== null;
  });
}

function bearerMatches(header, token) {
  const expected = createHash('sha256').update(`Bearer ${token}`).digest();
  const actual = createHash('sha256').update(typeof header === 'string' ? header : '').digest();
  return timingSafeEqual(expected, actual);
}

/**
 * @param {{ sessionId: string, generation: number, token: string, record: (entry: object) => Promise<void>, onPending?: (req: QuestionRequest) => void, onSettled?: (req: QuestionRequest, outcome: object) => void, recorded?: Map<string, { state: string, errorCode?: string }>, log?: (entry: object) => void, holdMs?: number, heartbeatMs?: number, admit?: (req: QuestionRequest) => { ok: boolean, reason?: string } }} opts
 */
export async function startQuestionServer({
  sessionId,
  generation,
  token,
  record,
  onPending,
  onSettled,
  recorded = new Map(),
  log = () => {},
  holdMs = QUESTION_HOLD_MS,
  heartbeatMs = QUESTION_HEARTBEAT_MS,
  admit = () => ({ ok: true }),
}) {
  if (typeof token !== 'string' || token.length === 0) throw new Error('question server token is required');
  const path = `/mcp/${encodeURIComponent(sessionId)}`;
  /** @type {Map<string, { request: QuestionRequest, res: http.ServerResponse, rpcId: unknown, state: 'reserved'|'pending'|'answering'|'settled', chain: Promise<unknown>, invalidated: string|null, writeAttempted: boolean, timer?: NodeJS.Timeout, heartbeat?: NodeJS.Timeout }>} */
  const requests = new Map();
  /** @type {Map<string, { state: string, errorCode?: string }>} */
  const responses = new Map();
  /** @type {Map<string, Promise<{ state: string, errorCode?: string }>>} */
  const reservations = new Map();

  const json = (res, status, body) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(body === undefined ? undefined : JSON.stringify(body));
  };
  const rpcError = (res, id, code, message) => json(res, 200, { jsonrpc: '2.0', id: id ?? null, error: { code, message } });

  function stopTimers(entry) {
    clearTimeout(entry.timer);
    clearInterval(entry.heartbeat);
  }

  function writeResult(entry, payload) {
    stopTimers(entry);
    const { res } = entry;
    if (res.destroyed || res.writableEnded || !res.socket || res.socket.destroyed) return Promise.resolve(false);
    const message = { jsonrpc: '2.0', id: entry.rpcId, result: { content: [{ type: 'text', text: JSON.stringify(payload) }], isError: false } };
    return new Promise((resolve) => {
      let finished = false;
      res.once('finish', () => {
        finished = true;
        resolve(true);
      });
      res.once('close', () => {
        if (!finished) resolve(false);
      });
      res.end(`event: message\ndata: ${JSON.stringify(message)}\n\n`);
    });
  }

  function settle(entry, outcome) {
    entry.state = 'settled';
    stopTimers(entry);
    try {
      onSettled?.(entry.request, outcome);
    } catch (err) {
      log({ msg: 'question settle callback failed', requestId: entry.request.requestId, code: 'settle_callback_failed', error: err instanceof Error ? err.name : 'error' });
    }
  }

  async function withdrawEntry(entry, reason) {
    if (entry.state !== 'pending') return;
    entry.state = 'answering';
    stopTimers(entry);
    try {
      await record({ type: 'question_withdrawn', requestId: entry.request.requestId, reason });
    } catch (err) {
      log({ msg: 'question withdrawal record failed', requestId: entry.request.requestId, reason, code: 'record_failed' });
      settle(entry, { state: 'reconciling', reason });
      throw err;
    }
    await writeResult(entry, { status: 'withdrawn' });
    settle(entry, { state: 'withdrawn', reason });
    log({ msg: 'question withdrawn', requestId: entry.request.requestId, reason });
  }

  function invalidate(entry, reason) {
    if (entry.state === 'settled' || entry.writeAttempted) return 'done';
    if (!entry.invalidated) entry.invalidated = reason;
    return entry.state === 'answering' ? 'held' : 'pending';
  }

  function nativeAborted(entry) {
    if (entry.state !== 'pending') return;
    entry.state = 'answering';
    stopTimers(entry);
    record({ type: 'question_withdrawn', requestId: entry.request.requestId, reason: 'native_aborted' })
      .then(() => {
        settle(entry, { state: 'withdrawn', reason: 'native_aborted' });
        log({ msg: 'question withdrawn', requestId: entry.request.requestId, reason: 'native_aborted' });
      })
      .catch((err) => {
        log({ msg: 'question withdrawal record failed', requestId: entry.request.requestId, code: 'record_failed', error: err instanceof Error ? err.name : 'error' });
        settle(entry, { state: 'reconciling', reason: 'native_aborted' });
      });
  }

  async function handleAsk(req, res, msg) {
    let parsed;
    let meta;
    try {
      parsed = parseAskArguments(msg.params?.arguments);
      const m = metaSchema.safeParse(msg.params?._meta);
      if (!m.success) throw new QuestionToolError('invalid_arguments', 'ask call metadata is invalid');
      meta = m.data;
    } catch (err) {
      if (!(err instanceof QuestionToolError)) throw err;
      log({ msg: 'ask call rejected', code: err.code });
      return rpcError(res, msg.id, -32602, 'Invalid ask arguments');
    }
    const nativeRequestId = meta.callId;
    const requestId = sha256(`${sessionId}|codex|${generation}|${nativeRequestId}`).slice(0, 32);
    if (requests.has(requestId)) {
      log({ msg: 'ask call repeated', requestId, code: 'duplicate_call' });
      return rpcError(res, msg.id, -32602, 'Duplicate ask call');
    }
    const correlation = { threadId: meta.threadId, turnId: meta['x-codex-turn-metadata']?.turn_id ?? null, callId: meta.callId, itemId: meta.itemId ?? null };
    const verdict = admit({ requestId, nativeRequestId, fingerprint: '', generation, correlation: { ...correlation }, questions: parsed.questions, secret: parsed.secret });
    if (!verdict?.ok) {
      log({ msg: 'question not admitted', requestId, code: 'question_not_admitted', reason: verdict?.reason ?? 'refused' });
      return rpcError(res, msg.id, -32603, 'Question not admitted');
    }
    /** @type {QuestionRequest} */
    const request = {
      requestId,
      nativeRequestId,
      fingerprint: sha256(canonical({ threadId: meta.threadId, callId: meta.callId, arguments: msg.params.arguments })),
      generation,
      correlation,
      questions: parsed.questions,
      secret: parsed.secret,
    };
    const entry = { request, res, rpcId: msg.id, state: /** @type {'reserved'|'pending'|'answering'|'settled'} */ ('reserved'), chain: Promise.resolve(), invalidated: /** @type {string|null} */ (null), writeAttempted: false };
    requests.set(requestId, entry);
    res.on('close', () => nativeAborted(entry));
    try {
      await record({ type: 'question_pending', requestId, fingerprint: request.fingerprint, generation, secret: request.secret, correlation: request.correlation });
    } catch (err) {
      requests.delete(requestId);
      log({ msg: 'question record failed', requestId, code: 'record_failed' });
      rpcError(res, msg.id, -32603, 'Question could not be recorded');
      throw err;
    }
    entry.state = 'pending';
    if (res.destroyed) return nativeAborted(entry);
    if (entry.invalidated) {
      entry.chain = entry.chain.then(() => withdrawEntry(entry, /** @type {string} */ (entry.invalidated)));
      entry.chain.catch(() => log({ msg: 'question withdrawal failed', requestId, code: 'record_failed' }));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    res.flushHeaders();
    entry.heartbeat = setInterval(() => res.write(': keepalive\n\n'), heartbeatMs);
    entry.timer = setTimeout(() => {
      entry.chain = entry.chain.then(() => withdrawEntry(entry, 'expired'));
      entry.chain.catch(() => log({ msg: 'question expiry failed', requestId, code: 'record_failed' }));
    }, holdMs);
    log({ msg: 'question pending', requestId });
    onPending?.(request);
  }

  async function handle(req, res) {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname !== path) {
      req.resume();
      return json(res, 404);
    }
    if (req.headers.origin !== undefined) {
      req.resume();
      return json(res, 403);
    }
    if (!bearerMatches(req.headers.authorization, token)) {
      req.resume();
      return json(res, 401);
    }
    if (req.method !== 'POST') {
      req.resume();
      return json(res, 405);
    }
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size <= MAX_BODY_BYTES) chunks.push(chunk);
    }
    if (size > MAX_BODY_BYTES) return json(res, 413);
    let msg;
    try {
      msg = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      return rpcError(res, null, -32700, 'Parse error');
    }
    if (msg?.id === undefined || msg?.id === null) return json(res, 202);
    switch (msg.method) {
      case 'initialize':
        return json(res, 200, {
          jsonrpc: '2.0',
          id: msg.id,
          result: {
            protocolVersion: typeof msg.params?.protocolVersion === 'string' ? msg.params.protocolVersion : '2025-06-18',
            capabilities: { tools: {} },
            serverInfo: { name: QUESTION_SERVER, version: '1.0.0' },
          },
        });
      case 'ping':
        return json(res, 200, { jsonrpc: '2.0', id: msg.id, result: {} });
      case 'tools/list':
        return json(res, 200, {
          jsonrpc: '2.0',
          id: msg.id,
          result: {
            tools: [
              {
                name: QUESTION_TOOL,
                description: 'Ask the person running this task up to three short questions and wait for their answer.',
                inputSchema: ASK_INPUT_SCHEMA,
              },
            ],
          },
        });
      case 'tools/call':
        if (msg.params?.name !== QUESTION_TOOL) return rpcError(res, msg.id, -32602, 'Unknown tool');
        return handleAsk(req, res, msg);
      default:
        return rpcError(res, msg.id, -32601, 'Method not found');
    }
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      log({ msg: 'question server request failed', code: 'internal_error', error: err instanceof Error ? err.name : 'error' });
      if (!res.headersSent) json(res, 500);
      else res.destroy();
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
  const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());

  async function refuse(responseId, requestId, errorCode) {
    await record({ type: 'answer_refused', responseId, requestId, errorCode });
    const outcome = { state: 'failed', errorCode };
    responses.set(responseId, outcome);
    log({ msg: 'answer refused', requestId, responseId, code: errorCode });
    return { ...outcome };
  }

  function respond(requestId, operation, { responseId, source, selections }) {
    const seen = () => responses.get(responseId) ?? recorded.get(responseId);
    if (seen()) return Promise.resolve({ ...seen() });
    const inFlight = reservations.get(responseId);
    if (inFlight) return inFlight.then((outcome) => ({ ...outcome }));
    const entry = requests.get(requestId);
    const run = async () => {
      if (seen()) return { ...seen() };
      if (!entry || entry.state !== 'pending' || entry.invalidated) return refuse(responseId, requestId, 'request_unavailable');
      if (operation === 'answer') {
        if (entry.request.secret && source !== 'local') return refuse(responseId, requestId, 'answer_on_host');
        if (!validSelections(entry.request.questions, selections)) return refuse(responseId, requestId, 'invalid_response');
      }
      entry.state = 'answering';
      try {
        await record({ type: 'answer_barrier', responseId, requestId, fingerprint: entry.request.fingerprint, generation, source, operation });
      } catch (err) {
        if (entry.invalidated) {
          responses.set(responseId, { state: 'reconciling' });
          entry.state = 'pending';
          try {
            await withdrawEntry(entry, entry.invalidated);
          } catch (secondary) {
            log({ msg: 'question withdrawal after a failed answer barrier failed', requestId, responseId, code: 'withdrawal_after_barrier_failed', error: secondary instanceof Error ? secondary.name : 'error' });
          }
          throw err;
        }
        entry.state = 'pending';
        throw err;
      }
      if (entry.invalidated) {
        const reason = entry.invalidated;
        entry.state = 'pending';
        try {
          await withdrawEntry(entry, reason);
        } catch (err) {
          responses.set(responseId, { state: 'reconciling' });
          throw err;
        }
        return refuse(responseId, requestId, 'request_unavailable');
      }
      entry.writeAttempted = true;
      responses.set(responseId, { state: 'reconciling' });
      const answers = operation === 'answer' ? Object.fromEntries(entry.request.questions.map((q) => [q.id, { selected: [...selections[q.id].selected], other: selections[q.id].other ?? null }])) : null;
      const written = await writeResult(entry, answers ? { status: 'answered', answers } : { status: 'declined' });
      try {
        await record({ type: written ? 'answer_written' : 'answer_unknown', responseId, requestId });
      } catch (err) {
        const uncertain = { state: 'reconciling' };
        responses.set(responseId, uncertain);
        log({ msg: 'answer receipt record failed', requestId, responseId, code: 'record_failed' });
        settle(entry, uncertain);
        throw err;
      }
      const outcome = written ? { state: 'dispatched' } : { state: 'reconciling' };
      responses.set(responseId, outcome);
      settle(entry, outcome);
      log({ msg: written ? 'answer dispatched' : 'answer write unknown', requestId, responseId });
      return { ...outcome };
    };
    const next = entry ? entry.chain.then(run, run) : run();
    if (entry) {
      entry.chain = next.catch(() => {
      });
    }
    reservations.set(responseId, next);
    const release = () => reservations.delete(responseId);
    next.then(release, release);
    return next;
  }

  return {
    url: `http://127.0.0.1:${port}${path}`,
    pending: () => [...requests.values()].filter((e) => e.state === 'pending').map((e) => e.request),
    answer: (requestId, opts) => respond(requestId, 'answer', opts),
    decline: (requestId, opts) => respond(requestId, 'decline', opts),
    withdraw(requestId, reason) {
      const entry = requests.get(requestId);
      if (!entry) return Promise.resolve();
      if (invalidate(entry, reason) === 'held') return Promise.resolve();
      const next = entry.chain.then(() => withdrawEntry(entry, reason));
      entry.chain = next.catch(() => {
      });
      return next;
    },
    /**
     * @param {{ threadId: string, turnId: string, generation: number, reason?: string }} turn
     */
    async withdrawTurn({ threadId, turnId, generation: turnGeneration, reason = 'turn_interrupted' }) {
      if (turnGeneration !== generation || typeof threadId !== 'string' || typeof turnId !== 'string') return;
      const matching = [...requests.values()].filter((e) => e.request.correlation.threadId === threadId && e.request.correlation.turnId === turnId);
      await Promise.all(
        matching.map((entry) => {
          if (invalidate(entry, reason) !== 'pending') return undefined;
          const next = entry.chain.then(() => withdrawEntry(entry, reason));
          entry.chain = next.catch(() => {
          });
          return next;
        }),
      );
    },
    async close() {
      const withdrawals = await Promise.allSettled(
        [...requests.values()].map((entry) => {
          if (invalidate(entry, 'shutdown') === 'held') return undefined;
          const next = entry.chain.then(() => withdrawEntry(entry, 'shutdown'));
          entry.chain = next.catch(() => {
          });
          return next;
        }),
      );
      server.closeAllConnections();
      await new Promise((resolve) => server.close(() => resolve(undefined)));
      const failed = withdrawals.find((w) => w.status === 'rejected');
      if (failed) throw /** @type {PromiseRejectedResult} */ (failed).reason;
    },
  };
}

/**
 * @param {Array<{ type: string, requestId?: string, responseId?: string, errorCode?: string }>} entries
 */
export function recoverQuestionRecords(entries) {
  /** @type {Map<string, { state: string, errorCode?: string }>} */
  const responses = new Map();
  const pending = [];
  const settled = new Set();
  for (const e of entries) {
    switch (e.type) {
      case 'question_pending':
        pending.push(e.requestId);
        break;
      case 'answer_barrier':
        settled.add(e.requestId);
        if (!responses.has(e.responseId)) responses.set(e.responseId, { state: 'reconciling' });
        break;
      case 'answer_written':
        responses.set(e.responseId, { state: 'dispatched' });
        break;
      case 'answer_unknown':
        responses.set(e.responseId, { state: 'reconciling' });
        break;
      case 'answer_refused':
        responses.set(e.responseId, { state: 'failed', errorCode: e.errorCode });
        break;
      case 'question_withdrawn':
        settled.add(e.requestId);
        break;
      default:
        throw new Error(`unknown question record type: ${e.type}`);
    }
  }
  return { responses, expired: pending.filter((id) => !settled.has(id)) };
}
