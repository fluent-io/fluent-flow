
import http from 'node:http';
import { createTurnBook } from './sse-turns.js';

function sse(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function startMessage(res, model, id) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'request-id': `req_${id}` });
  sse(res, 'message_start', {
    type: 'message_start',
    message: {
      id: `msg_${id}`,
      type: 'message',
      role: 'assistant',
      model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 0 },
    },
  });
}

function textBlock(res, index, text) {
  sse(res, 'content_block_start', { type: 'content_block_start', index, content_block: { type: 'text', text: '' } });
  if (text) sse(res, 'content_block_delta', { type: 'content_block_delta', index, delta: { type: 'text_delta', text } });
  sse(res, 'content_block_stop', { type: 'content_block_stop', index });
}

function finish(res, stopReason) {
  sse(res, 'message_delta', { type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 1 } });
  sse(res, 'message_stop', { type: 'message_stop' });
  res.end();
}

function plainMessage(res, model, text) {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(
    JSON.stringify({
      id: 'msg_side',
      type: 'message',
      role: 'assistant',
      model,
      content: [{ type: 'text', text }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    }),
  );
}

/**
 * @param {{ script: any[], mainModel?: string, modelScripts?: Record<string, any[]> }} opts - `modelScripts` (Task 8): further main models, each with its own ordered script; their replies carry the requested model.
 */
export async function startAnthropicFixture({ script, mainModel = 'ff-probe-model', modelScripts = {} }) {
  const book = createTurnBook(script);
  const books = new Map([[mainModel, book], ...Object.entries(modelScripts).map(([model, turns]) => [model, createTurnBook(turns)])]);
  /** @type {{ path: string, body: any }[]} */
  const side = [];
  let seq = 0;

  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString('utf8');
    const url = new URL(req.url ?? '/', 'http://fixture');
    let body = null;
    if (raw) {
      try {
        body = JSON.parse(raw);
      } catch {
        body = { raw };
      }
    }
    if (req.method === 'POST' && url.pathname === '/v1/messages/count_tokens') {
      side.push({ path: url.pathname, body });
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ input_tokens: 1 }));
      return;
    }
    if (req.method !== 'POST' || url.pathname !== '/v1/messages') {
      book.unexpected.push({ path: `${req.method} ${url.pathname}`, reason: 'unknown endpoint' });
      res.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: 'not found' } }));
      return;
    }
    const tools = Array.isArray(body?.tools) ? body.tools.map((t) => t.name) : [];
    const isMain = books.has(body?.model) && tools.length > 0;
    if (!isMain) {
      side.push({ path: url.pathname, body });
      if (body?.stream) {
        startMessage(res, body?.model ?? mainModel, `side${seq++}`);
        textBlock(res, 0, 'ok');
        finish(res, 'end_turn');
      } else plainMessage(res, body?.model ?? mainModel, 'ok');
      return;
    }
    const modelBook = books.get(body.model);
    const { turn, spec, record } = modelBook.claim(url.pathname, body, req.headers);
    const id = `t${turn}_${seq++}`;
    res.on('close', () => {
      if (!res.writableFinished) record.aborted = true;
    });
    startMessage(res, body.model, id);
    if (!spec) {
      textBlock(res, 0, 'unexpected');
      return finish(res, 'end_turn');
    }
    if (spec.hold) {
      textBlock(res, 0, spec.text ?? 'working');
      await modelBook.holdFor(turn);
      if (res.destroyed) return;
      return finish(res, 'end_turn');
    }
    if (spec.tool) {
      const name = modelBook.pickTool(spec, tools);
      if (!name) {
        modelBook.unexpected.push({ path: url.pathname, reason: `turn ${turn}: tool not advertised`, body: tools });
        textBlock(res, 0, 'no tool');
        return finish(res, 'end_turn');
      }
      sse(res, 'content_block_start', {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: `toolu_${id}`, name, input: {} },
      });
      sse(res, 'content_block_delta', {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: JSON.stringify(spec.input ?? {}) },
      });
      sse(res, 'content_block_stop', { type: 'content_block_stop', index: 0 });
      return finish(res, 'tool_use');
    }
    textBlock(res, 0, (typeof spec.text === 'function' ? spec.text(body) : spec.text) ?? 'done');
    return finish(res, 'end_turn');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', () => r(undefined)));
  const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());
  return {
    url: `http://127.0.0.1:${port}`,
    requests: book.requests,
    /** @param {string} model */
    requestsFor: (model) => books.get(model)?.requests ?? [],
    side,
    get unexpected() {
      return [...books.values()].flatMap((b) => b.unexpected);
    },
    release: (turn) => book.release(turn),
    releaseFor: (model, turn) => books.get(model)?.release(turn),
    close: () =>
      new Promise((r) => {
        server.closeAllConnections();
        server.close(() => r(undefined));
      }),
  };
}
