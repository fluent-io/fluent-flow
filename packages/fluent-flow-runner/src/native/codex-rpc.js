
import { NativeProtocolError } from './jsonl.js';

/**
 * @param {{ messages: AsyncIterable<any>, send(message: object): Promise<void>, fail(error: NativeProtocolError): void }} channel
 * @param {{ onServerRequest?: (req: { id: number|string, method: string, params: any }) => Promise<{ result: any }|{ error: { code: number, message: string } }>, onNotification?: (msg: { method: string, params: any }) => unknown }} [handlers]
 */
export function createCodexRpc(channel, { onServerRequest, onNotification } = {}) {
  let nextId = 1;
  /** @type {Map<number, { resolve: (v: any) => void, reject: (e: Error) => void, timer: NodeJS.Timeout }>} */
  const pending = new Map();
  const expired = new Set();
  /** @type {NativeProtocolError|null} */
  let failure = null;

  function failAll(error) {
    if (!failure) failure = error;
    for (const [, p] of pending) {
      clearTimeout(p.timer);
      p.reject(failure);
    }
    pending.clear();
  }

  async function answer(message) {
    /** @type {{ result?: unknown, error?: { code: number, message: string } } | null | undefined} */
    let reply;
    try {
      reply = onServerRequest
        ? await onServerRequest({ id: message.id, method: message.method, params: message.params ?? {} })
        : { error: { code: -32601, message: `unsupported server request ${message.method}` } };
    } catch (err) {
      reply = { error: { code: -32603, message: err instanceof Error ? err.message : String(err) } };
    }
    const body = reply && 'error' in reply && reply.error ? { error: reply.error } : { result: reply?.result ?? {} };
    await channel.send({ id: message.id, ...body });
  }

  (async () => {
    for await (const message of channel.messages) {
      const hasId = message && message.id !== undefined && message.id !== null;
      if (hasId && typeof message.method === 'string') {
        answer(message).catch((err) => failAll(err instanceof NativeProtocolError ? err : new NativeProtocolError('stream_closed', String(err))));
      } else if (hasId) {
        const p = pending.get(message.id);
        if (!p) {
          if (expired.delete(message.id)) continue;
          const error = new NativeProtocolError('unknown_response', 'response for an unknown request id');
          failAll(error);
          channel.fail(error);
          return;
        }
        pending.delete(message.id);
        clearTimeout(p.timer);
        if (message.error) {
          const err = new NativeProtocolError('control_error', `native request failed: ${message.error.message ?? 'error'}`);
          /** @type {any} */ (err).rpcError = message.error;
          p.reject(err);
        } else p.resolve(message.result);
      } else if (typeof message?.method === 'string') {
        await onNotification?.({ method: message.method, params: message.params ?? {} });
      }
    }
  })()
    .catch((err) => failAll(err instanceof NativeProtocolError ? err : new NativeProtocolError('stream_closed', String(err))))
    .finally(() => failAll(new NativeProtocolError('stream_closed', 'native channel closed')));

  function request(method, params = {}, { timeoutMs = 30_000 } = {}) {
    if (failure) return Promise.reject(failure);
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        expired.add(id);
        reject(new NativeProtocolError('control_timeout', `native request ${method} timed out`));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      channel.send({ id, method, params }).catch((err) => {
        clearTimeout(timer);
        pending.delete(id);
        reject(err);
      });
    });
  }

  async function notify(method, params = {}) {
    if (failure) throw failure;
    await channel.send({ method, params });
  }

  return { request, notify };
}
