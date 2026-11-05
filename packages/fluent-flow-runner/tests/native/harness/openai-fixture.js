
import http from 'node:http';
import { createTurnBook } from './sse-turns.js';

function sse(res, data) {
  res.write(`event: ${data.type}\ndata: ${JSON.stringify(data)}\n\n`);
}

function usage() {
  return { input_tokens: 1, input_tokens_details: { cached_tokens: 0 }, output_tokens: 1, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 2 };
}

function toolNames(body) {
  return (Array.isArray(body?.tools) ? body.tools : []).flatMap((t) =>
    t.type === 'namespace' && Array.isArray(t.tools) ? t.tools.map((inner) => `${t.name}.${inner.name}`) : [t.name ?? t.type],
  );
}

/**
 * @param {{ script: any[], mainModel?: string, modelScripts?: Record<string, any[]> }} opts - `modelScripts` (Task 8): further main models, each with its own ordered script.
 */
export async function startOpenAiFixture({ script, mainModel = 'ff-probe-model', modelScripts = {} }) {
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
    if (req.method === 'GET' && url.pathname === '/v1/models') {
      side.push({ path: url.pathname, body: null });
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ object: 'list', data: [], models: [] }));
      return;
    }
    if (req.method !== 'POST' || url.pathname !== '/v1/responses' || !books.has(body?.model)) {
      book.unexpected.push({ path: `${req.method} ${url.pathname}`, reason: 'unknown endpoint or model', body });
      res.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: 'not found', type: 'invalid_request_error' } }));
      return;
    }
    const modelBook = books.get(body.model);
    const { turn, spec, record } = modelBook.claim(url.pathname, body, req.headers);
    const responseId = `resp_${turn}_${seq++}`;
    if (spec?.httpError) {
      res.writeHead(spec.httpError.status, { 'content-type': 'application/json' }).end(JSON.stringify(spec.httpError.body));
      return;
    }
    res.on('close', () => {
      if (!res.writableFinished) record.aborted = true;
    });
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    sse(res, { type: 'response.created', response: { id: responseId, object: 'response', status: 'in_progress', output: [] } });

    const message = (text) => {
      const id = `msg_${responseId}`;
      sse(res, { type: 'response.output_item.added', output_index: 0, item: { type: 'message', id, role: 'assistant', status: 'in_progress', content: [] } });
      sse(res, { type: 'response.output_text.delta', item_id: id, output_index: 0, content_index: 0, delta: text });
      sse(res, {
        type: 'response.output_item.done',
        output_index: 0,
        item: { type: 'message', id, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] },
      });
    };
    const complete = () => {
      sse(res, { type: 'response.completed', response: { id: responseId, object: 'response', status: 'completed', output: [], usage: usage() } });
      res.end();
    };

    if (!spec) {
      message('unexpected');
      return complete();
    }
    if (spec.hold) {
      message(spec.text ?? 'working');
      await modelBook.holdFor(turn);
      if (res.destroyed) return;
      return complete();
    }
    if (spec.tool) {
      const name = modelBook.pickTool(spec, toolNames(body));
      if (!name) {
        modelBook.unexpected.push({ path: url.pathname, reason: `turn ${turn}: tool not advertised`, body: toolNames(body) });
        message('no tool');
        return complete();
      }
      const callId = `call_${responseId}`;
      const args = JSON.stringify(spec.input ?? {});
      const dot = name.indexOf('.');
      const target = dot === -1 ? { name } : { namespace: name.slice(0, dot), name: name.slice(dot + 1) };
      sse(res, {
        type: 'response.output_item.done',
        output_index: 0,
        item: { type: 'function_call', id: `fc_${responseId}`, call_id: callId, ...target, arguments: args, status: 'completed' },
      });
      return complete();
    }
    message((typeof spec.text === 'function' ? spec.text(body) : spec.text) ?? 'done');
    return complete();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', () => r(undefined)));
  const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());
  return {
    url: `http://127.0.0.1:${port}/v1`,
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
