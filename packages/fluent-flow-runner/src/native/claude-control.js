
import { randomUUID } from 'node:crypto';
import { NativeProtocolError } from './jsonl.js';

/**
 * @param {{ messages: AsyncIterable<any>, send(message: object): Promise<void>, fail(error: NativeProtocolError): void }} channel
 * @param {{ onControlRequest?: (req: { requestId: string, request: any }) => Promise<object>|object, onCancelRequest?: (req: { requestId: string, request: any }) => void }} [handlers]
 */
export function createClaudeControl(channel, { onControlRequest, onCancelRequest } = {}) {
  /** @type {Map<string, { resolve: (v: any) => void, reject: (e: Error) => void, timer: NodeJS.Timeout }>} */
  const pending = new Map();
  const expired = new Set();
  /** @type {Map<string, { request: any, cancelled: boolean }>} */
  const inbound = new Map();
  /** @type {any[]} */
  const events = [];
  /** @type {((value?: unknown) => void)|null} */
  let wake = null;
  /** @type {NativeProtocolError|null} */
  let failure = null;
  let done = false;

  function failAll(error) {
    failure = error;
    for (const [, p] of pending) {
      clearTimeout(p.timer);
      p.reject(error);
    }
    pending.clear();
  }

  async function answer(requestId, entry) {
    let reply;
    try {
      const body = onControlRequest
        ? await onControlRequest({ requestId, request: entry.request })
        : (() => {
            throw new Error(`unsupported control request ${entry.request?.subtype}`);
          })();
      reply = { subtype: 'success', request_id: requestId, response: body ?? {} };
    } catch (err) {
      reply = { subtype: 'error', request_id: requestId, error: err instanceof Error ? err.message : String(err) };
    }
    if (entry.cancelled) return;
    await channel.send({ type: 'control_response', response: reply });
  }

  function onMessage(message) {
    if (message?.type === 'control_response') {
      const id = message.response?.request_id;
      const p = pending.get(id);
      if (!p) {
        if (expired.delete(id)) return;
        if (inbound.has(id)) return;
        const error = new NativeProtocolError('unknown_response', 'control response for an unknown request');
        failAll(error);
        channel.fail(error);
        return 'stop';
      }
      pending.delete(id);
      clearTimeout(p.timer);
      if (message.response.subtype === 'success') p.resolve(message.response.response ?? {});
      else {
        const err = new NativeProtocolError('control_error', 'native control request failed');
        /** @type {any} */ (err).detail = message.response.error;
        p.reject(err);
      }
      return;
    }
    if (message?.type === 'control_request') {
      const id = message.request_id;
      if (inbound.has(id)) return;
      const entry = { request: message.request, cancelled: false };
      inbound.set(id, entry);
      answer(id, entry).catch((err) => failAll(err instanceof NativeProtocolError ? err : new NativeProtocolError('stream_closed', String(err))));
      return;
    }
    if (message?.type === 'control_cancel_request') {
      const entry = inbound.get(message.request_id);
      if (entry && !entry.cancelled) {
        entry.cancelled = true;
        onCancelRequest?.({ requestId: message.request_id, request: entry.request });
      }
      return;
    }
    events.push(message);
    wake?.();
  }

  (async () => {
    for await (const message of channel.messages) {
      if (onMessage(message) === 'stop') break;
    }
  })()
    .catch((err) => failAll(new NativeProtocolError('stream_closed', String(err))))
    .finally(() => {
      if (!failure) failAll(new NativeProtocolError('stream_closed', 'native channel closed'));
      done = true;
      wake?.();
    });

  function request(subtype, body = {}, { timeoutMs = 30_000 } = {}) {
    if (failure) return Promise.reject(failure);
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(requestId);
        expired.add(requestId);
        reject(new NativeProtocolError('control_timeout', `control request ${subtype} timed out`));
      }, timeoutMs);
      pending.set(requestId, { resolve, reject, timer });
      channel.send({ type: 'control_request', request_id: requestId, request: { subtype, ...body } }).catch((err) => {
        clearTimeout(timer);
        pending.delete(requestId);
        reject(err);
      });
    });
  }

  async function sendUser({ uuid, sessionId, text }) {
    await channel.send({
      type: 'user',
      uuid,
      session_id: sessionId,
      parent_tool_use_id: null,
      client_composed: true,
      message: { role: 'user', content: [{ type: 'text', text }] },
    });
  }

  const eventStream = {
    async *[Symbol.asyncIterator]() {
      for (;;) {
        if (events.length) {
          yield events.shift();
          continue;
        }
        if (done) return;
        await new Promise((r) => (wake = r));
        wake = null;
      }
    },
  };

  return { request, sendUser, events: eventStream };
}
