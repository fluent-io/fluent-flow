import { describe, it, expect } from 'vitest';
import { PassThrough } from 'node:stream';
import { createCodexRpc } from '../../../src/native/codex-rpc.js';
import { createJsonlChannel } from '../../../src/native/jsonl.js';

function realChannel() {
  const readable = new PassThrough();
  const writable = new PassThrough();
  const channel = createJsonlChannel({ readable, writable });
  return { readable, writable, channel, push: (m) => readable.write(`${JSON.stringify(m)}\n`) };
}


function fakeChannel() {
  const sent = [];
  const queue = [];
  let wake = null;
  let resolveClosed;
  const closed = new Promise((r) => (resolveClosed = r));
  const messages = {
    async *[Symbol.asyncIterator]() {
      for (;;) {
        if (queue.length) {
          yield queue.shift();
          continue;
        }
        await new Promise((r) => (wake = r));
      }
    },
  };
  return {
    sent,
    push(m) {
      queue.push(m);
      wake?.();
    },
    closedWith: null,
    channel: {
      messages,
      send: async (m) => {
        sent.push(m);
      },
      end: async () => {},
      closed,
      fail(error) {
        resolveClosed({ error });
      },
    },
  };
}

const tick = () => new Promise((r) => setTimeout(r, 5));

describe('createCodexRpc', () => {
  it('messages never carry jsonrpc and correlate by id', async () => {
    const f = fakeChannel();
    const rpc = createCodexRpc(f.channel, {});
    const a = rpc.request('initialize', { clientInfo: { name: 'ff' } });
    const b = rpc.request('account/read', { refreshToken: false });
    await rpc.notify('initialized');
    await tick();
    expect(f.sent.every((m) => !('jsonrpc' in m))).toBe(true);
    expect(f.sent[0]).toEqual({ id: expect.anything(), method: 'initialize', params: { clientInfo: { name: 'ff' } } });
    expect(f.sent[2]).toEqual({ method: 'initialized', params: {} });
    f.push({ id: f.sent[1].id, result: { account: null } });
    f.push({ id: f.sent[0].id, error: { code: -32600, message: 'bad' } });
    await expect(b).resolves.toEqual({ account: null });
    await expect(a).rejects.toMatchObject({ code: 'control_error', rpcError: { code: -32600, message: 'bad' } });
  });

  it('server requests are answered under the same id', async () => {
    const f = fakeChannel();
    createCodexRpc(f.channel, {
      onServerRequest: async ({ method }) =>
        method === 'item/commandExecution/requestApproval' ? { result: { decision: 'decline' } } : { error: { code: -32601, message: 'unsupported' } },
    });
    f.push({ id: 7, method: 'item/commandExecution/requestApproval', params: { command: 'touch x' } });
    f.push({ id: 'z', method: 'other', params: {} });
    await tick();
    expect(f.sent).toEqual([
      { id: 7, result: { decision: 'decline' } },
      { id: 'z', error: { code: -32601, message: 'unsupported' } },
    ]);
  });

  it('notifications dispatch in order', async () => {
    const f = fakeChannel();
    const seen = [];
    createCodexRpc(f.channel, { onNotification: ({ method, params }) => seen.push([method, params.n]) });
    for (let n = 0; n < 5; n++) f.push({ method: 'item/agentMessage/delta', params: { n } });
    await tick();
    expect(seen).toEqual([0, 1, 2, 3, 4].map((n) => ['item/agentMessage/delta', n]));
  });

  it('a response for an unknown id fails the channel', async () => {
    const f = fakeChannel();
    const rpc = createCodexRpc(f.channel, {});
    const pending = rpc.request('thread/start', {});
    await tick();
    f.push({ id: 99999, result: {} });
    await expect(pending).rejects.toMatchObject({ code: 'unknown_response' });
    await expect(rpc.request('thread/list', {})).rejects.toMatchObject({ code: 'unknown_response' });
  });

  it('an unknown response id closes the channel with unknown_response', async () => {
    const r = realChannel();
    const rpc = createCodexRpc(r.channel, {});
    const pending = rpc.request('thread/start', {});
    r.push({ id: 99999, result: {} });
    await expect(pending).rejects.toMatchObject({ code: 'unknown_response' });
    const settled = await Promise.race([r.channel.closed, new Promise((r) => setTimeout(() => r('unsettled'), 200))]);
    expect(settled, 'closed settles').not.toBe('unsettled');
    const { error } = settled;
    expect(error?.code).toBe('unknown_response');
    expect(r.readable.destroyed && r.writable.destroyed).toBe(true);
    await expect(rpc.notify('initialized')).rejects.toMatchObject({ code: 'unknown_response' });
  });

  it('a timeout rejects control_timeout', async () => {
    const f = fakeChannel();
    const rpc = createCodexRpc(f.channel, {});
    await expect(rpc.request('turn/interrupt', {}, { timeoutMs: 20 })).rejects.toMatchObject({ code: 'control_timeout' });
  });
});
