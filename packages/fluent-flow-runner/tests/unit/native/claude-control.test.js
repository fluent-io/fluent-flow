import { describe, it, expect, vi } from 'vitest';
import { PassThrough } from 'node:stream';
import { createClaudeControl } from '../../../src/native/claude-control.js';
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
  let done = false;
  const messages = {
    async *[Symbol.asyncIterator]() {
      for (;;) {
        if (queue.length) {
          yield queue.shift();
          continue;
        }
        if (done) return;
        await new Promise((r) => (wake = r));
      }
    },
  };
  const push = (m) => {
    queue.push(m);
    wake?.();
  };
  return {
    sent,
    push,
    finish() {
      done = true;
      wake?.();
    },
    channel: {
      messages,
      send: async (m) => {
        sent.push(m);
      },
      end: async () => {},
      closed: new Promise(() => {}),
      fail: () => {},
    },
  };
}

const tick = () => new Promise((r) => setTimeout(r, 5));

describe('createClaudeControl', () => {
  it('correlates control_response by request_id', async () => {
    const f = fakeChannel();
    const control = createClaudeControl(f.channel, {});
    const ok = control.request('initialize', { hooks: null });
    const bad = control.request('set_model', { model: 'x' });
    await tick();
    expect(f.sent[0]).toMatchObject({ type: 'control_request', request: { subtype: 'initialize', hooks: null } });
    expect(typeof f.sent[0].request_id).toBe('string');
    expect(f.sent[1].request_id).not.toBe(f.sent[0].request_id);
    f.push({ type: 'control_response', response: { subtype: 'error', request_id: f.sent[1].request_id, error: 'nope' } });
    f.push({ type: 'control_response', response: { subtype: 'success', request_id: f.sent[0].request_id, response: { commands: [] } } });
    await expect(ok).resolves.toEqual({ commands: [] });
    await expect(bad).rejects.toMatchObject({ code: 'control_error' });
  });

  it('answers each CLI control request once', async () => {
    const f = fakeChannel();
    const onControlRequest = vi.fn(async ({ request }) => ({ behavior: 'deny', message: request.tool_name }));
    createClaudeControl(f.channel, { onControlRequest });
    f.push({ type: 'control_request', request_id: 'r1', request: { subtype: 'can_use_tool', tool_name: 'Bash' } });
    f.push({ type: 'control_request', request_id: 'r1', request: { subtype: 'can_use_tool', tool_name: 'Bash' } });
    f.push({ type: 'control_request', request_id: 'r2', request: { subtype: 'can_use_tool', tool_name: 'Boom' } });
    await tick();
    const responses = f.sent.filter((m) => m.type === 'control_response');
    expect(responses.filter((m) => m.response.request_id === 'r1')).toEqual([
      { type: 'control_response', response: { subtype: 'success', request_id: 'r1', response: { behavior: 'deny', message: 'Bash' } } },
    ]);
    expect(onControlRequest).toHaveBeenCalledTimes(2);
  });

  it('turns a throwing handler into an error response', async () => {
    const f = fakeChannel();
    createClaudeControl(f.channel, {
      onControlRequest: async () => {
        throw new Error('handler failed');
      },
    });
    f.push({ type: 'control_request', request_id: 'r9', request: { subtype: 'can_use_tool' } });
    await tick();
    expect(f.sent).toEqual([
      { type: 'control_response', response: { subtype: 'error', request_id: 'r9', error: 'handler failed' } },
    ]);
  });

  it('control_cancel_request calls onCancelRequest and drops the late answer', async () => {
    const f = fakeChannel();
    let finish;
    const onCancelRequest = vi.fn();
    createClaudeControl(f.channel, {
      onControlRequest: () => new Promise((r) => (finish = r)),
      onCancelRequest,
    });
    f.push({ type: 'control_request', request_id: 'r1', request: { subtype: 'can_use_tool', tool_name: 'Bash' } });
    await tick();
    f.push({ type: 'control_cancel_request', request_id: 'r1' });
    await tick();
    expect(onCancelRequest).toHaveBeenCalledWith({ requestId: 'r1', request: { subtype: 'can_use_tool', tool_name: 'Bash' } });
    finish({ behavior: 'allow' });
    await tick();
    expect(f.sent).toEqual([]);
  });

  it('sendUser writes the verbatim user envelope', async () => {
    const f = fakeChannel();
    const control = createClaudeControl(f.channel, {});
    await control.sendUser({ uuid: 'u-1', sessionId: 's-1', text: '/login --resume x @README.md' });
    expect(f.sent).toEqual([
      {
        type: 'user',
        uuid: 'u-1',
        session_id: 's-1',
        parent_tool_use_id: null,
        client_composed: true,
        message: { role: 'user', content: [{ type: 'text', text: '/login --resume x @README.md' }] },
      },
    ]);
  });

  it('ignores the echo of its own answer to a CLI control request', async () => {
    const f = fakeChannel();
    const control = createClaudeControl(f.channel, { onControlRequest: async () => ({ behavior: 'deny', message: 'no' }) });
    f.push({ type: 'control_request', request_id: 'r1', request: { subtype: 'can_use_tool' } });
    await tick();
    f.push({ type: 'control_response', response: { subtype: 'success', request_id: 'r1', response: { behavior: 'deny', message: 'no' } } });
    f.push({ type: 'result' });
    f.finish();
    const events = [];
    for await (const e of control.events) events.push(e.type);
    expect(events).toEqual(['result']);
  });

  it('an unknown control_response fails pending and later requests', async () => {
    const f = fakeChannel();
    const control = createClaudeControl(f.channel, {});
    const pending = control.request('initialize');
    await tick();
    f.push({ type: 'control_response', response: { subtype: 'success', request_id: 'zzz-unknown', response: {} } });
    await expect(pending).rejects.toMatchObject({ code: 'unknown_response' });
    await expect(control.request('interrupt')).rejects.toMatchObject({ code: 'unknown_response' });
  });

  it('an unknown control_response closes the channel with unknown_response', async () => {
    const r = realChannel();
    const control = createClaudeControl(r.channel, {});
    const pending = control.request('initialize');
    r.push({ type: 'control_response', response: { subtype: 'success', request_id: 'zzz-unknown', response: {} } });
    await expect(pending).rejects.toMatchObject({ code: 'unknown_response' });
    const settled = await Promise.race([r.channel.closed, new Promise((r) => setTimeout(() => r('unsettled'), 200))]);
    expect(settled, 'closed settles').not.toBe('unsettled');
    const { error } = settled;
    expect(error?.code).toBe('unknown_response');
    expect(r.readable.destroyed && r.writable.destroyed).toBe(true);
    await expect(control.sendUser({ uuid: 'u', sessionId: 's', text: 't' })).rejects.toMatchObject({ code: 'stream_closed' });
  });

  it('forwards non-control messages to events', async () => {
    const f = fakeChannel();
    const control = createClaudeControl(f.channel, {});
    f.push({ type: 'system', subtype: 'init' });
    f.push({ type: 'result' });
    f.finish();
    const events = [];
    for await (const e of control.events) events.push(e.type);
    expect(events).toEqual(['system', 'result']);
  });

  it('a timeout rejects control_timeout and ignores the late response', async () => {
    const f = fakeChannel();
    const control = createClaudeControl(f.channel, {});
    const p = control.request('interrupt', {}, { timeoutMs: 20 });
    await expect(p).rejects.toMatchObject({ code: 'control_timeout' });
    f.push({ type: 'control_response', response: { subtype: 'success', request_id: f.sent[0].request_id, response: {} } });
    f.push({ type: 'result' });
    f.finish();
    const events = [];
    for await (const e of control.events) events.push(e.type);
    expect(events).toEqual(['result']);
  });
});
