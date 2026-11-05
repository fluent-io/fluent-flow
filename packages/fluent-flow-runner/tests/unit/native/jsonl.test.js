import { describe, it, expect } from 'vitest';
import { PassThrough, Writable } from 'node:stream';
import { createJsonlChannel, NativeProtocolError } from '../../../src/native/jsonl.js';

async function collect(iterable) {
  const out = [];
  for await (const m of iterable) out.push(m);
  return out;
}

function channelWith(bytes, opts = {}) {
  const readable = new PassThrough();
  const writable = new PassThrough();
  const channel = createJsonlChannel({ readable, writable, ...opts });
  (async () => {
    for (const b of bytes) {
      readable.write(Buffer.from([b]));
      await new Promise((r) => setImmediate(r));
    }
    readable.end();
  })();
  return channel;
}

describe('createJsonlChannel', () => {
  it('splits messages across 1-byte chunks including multibyte UTF-8', async () => {
    const bytes = Buffer.from('{"a":"é😀"}\n{"b":1}\n', 'utf8');
    const channel = channelWith(bytes);
    expect(await collect(channel.messages)).toEqual([{ a: 'é😀' }, { b: 1 }]);
    expect((await channel.closed).error).toBeNull();
  });

  it('fails closed on a line longer than maxLineBytes', async () => {
    const channel = channelWith(Buffer.from('{"a":"0123456789"}\n{"b":1}\n'), { maxLineBytes: 8 });
    expect(await collect(channel.messages)).toEqual([]);
    const { error } = await channel.closed;
    expect(error).toBeInstanceOf(NativeProtocolError);
    expect(error.code).toBe('line_too_long');
  });

  it('reports a torn final line at EOF without parsing it', async () => {
    const channel = channelWith(Buffer.from('{"a":1}\n{"b":2}'));
    expect(await collect(channel.messages)).toEqual([{ a: 1 }]);
    expect((await channel.closed).error.code).toBe('torn_final_line');
  });

  it('invalid JSON fails the channel', async () => {
    const channel = channelWith(Buffer.from('{"a":1}\nnot json\n{"b":2}\n'));
    expect(await collect(channel.messages)).toEqual([{ a: 1 }]);
    expect((await channel.closed).error.code).toBe('invalid_json');
  });

  it('send waits for drain and rejects after close', async () => {
    const readable = new PassThrough();
    const chunks = [];
    let release;
    const writable = new Writable({
      highWaterMark: 1,
      write(chunk, _enc, cb) {
        chunks.push(chunk.toString('utf8'));
        release = cb;
      },
    });
    const channel = createJsonlChannel({ readable, writable });
    let settled = false;
    const sent = channel.send({ x: 1 }).then(() => {
      settled = true;
    });
    await new Promise((r) => setImmediate(r));
    expect(settled).toBe(false);
    release();
    await sent;
    expect(settled).toBe(true);
    expect(chunks.join('')).toBe('{"x":1}\n');
    readable.end();
    await channel.closed;
    await expect(channel.send({ y: 2 })).rejects.toMatchObject({ code: 'stream_closed' });
  });

  it('fail settles closed with the first error, closes both streams and rejects sends', async () => {
    const readable = new PassThrough();
    const writable = new PassThrough();
    const channel = createJsonlChannel({ readable, writable });
    const first = new NativeProtocolError('unknown_response', 'first');
    channel.fail(first);
    channel.fail(new NativeProtocolError('stream_closed', 'second'));
    const settled = await Promise.race([channel.closed, new Promise((r) => setTimeout(() => r('unsettled'), 200))]);
    expect(settled, 'closed settles').not.toBe('unsettled');
    const { error } = settled;
    expect(error).toBe(first);
    expect(readable.destroyed).toBe(true);
    expect(writable.destroyed).toBe(true);
    await expect(channel.send({ x: 1 })).rejects.toMatchObject({ code: 'stream_closed' });
  });
});
