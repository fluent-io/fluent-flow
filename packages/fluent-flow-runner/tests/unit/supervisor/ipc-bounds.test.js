import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import net from 'node:net';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createIpcServer, frameReader, ipcSocketPath, proofFor, readSecret } from '../../../src/supervisor/ipc.js';
import { connectSupervisor } from '../../../src/supervisor/client.js';

const LIMIT = 1024 * 1024;

let root;
let servers;
let sockets;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'ff-ipcb-')); servers = []; sockets = []; });
afterEach(async () => {
  for (const s of sockets.splice(0)) s.destroy();
  for (const s of servers.splice(0)) await s.close();
  rmSync(root, { recursive: true, force: true });
});

let pairs = 0;
async function readerPair() {
  const path = join(root, `pair-${(pairs += 1)}.sock`);
  const admitted = [];
  let serverSide;
  const server = net.createServer((s) => {
    serverSide = s;
    frameReader(s, (frame) => admitted.push(frame));
  });
  await new Promise((r) => server.listen(path, r));
  servers.push({ close: () => new Promise((r) => server.close(() => r())) });
  const client = net.connect(path);
  sockets.push(client);
  await new Promise((r) => client.once('connect', r));
  const closed = new Promise((r) => client.once('close', () => r(true)));
  client.on('error', () => {});
  const write = (bytes) => new Promise((r) => client.write(bytes, () => r()));
  const settle = () => new Promise((r) => setTimeout(r, 150));
  return { admitted, closed, write, settle, serverSide: () => serverSide };
}

const raced = (promise, ms) => Promise.race([promise, new Promise((r) => setTimeout(() => r('timeout'), ms))]);

describe('IPC frame bounds', () => {
  it('a complete frame that crosses the limit with its final chunk is rejected before parsing', async () => {
    const p = await readerPair();
    const body = JSON.stringify('x'.repeat(LIMIT + 100));
    await p.write(body.slice(0, LIMIT - 10));
    await p.settle();
    await p.write(`${body.slice(LIMIT - 10)}\n`);
    expect(await raced(p.closed, 2000)).toBe(true);
    expect(p.admitted).toHaveLength(0);
  });

  it('a frame of exactly the limit is admitted, one byte more is not, also with a multibyte character split across chunks', async () => {
    const ok = await readerPair();
    const pad = 'a'.repeat(LIMIT - 2 - 2 * 1000);
    const atLimit = Buffer.from(JSON.stringify(`${'é'.repeat(1000)}${pad}`));
    expect(atLimit.length).toBe(LIMIT);
    await ok.write(atLimit.subarray(0, 1001));
    await ok.settle();
    await ok.write(Buffer.concat([atLimit.subarray(1001), Buffer.from('\n')]));
    await ok.settle();
    expect(ok.admitted).toHaveLength(1);
    expect(ok.admitted[0].startsWith('é'.repeat(1000))).toBe(true);

    const over = await readerPair();
    const overLimit = Buffer.from(JSON.stringify(`${'é'.repeat(1000)}${pad}a`));
    expect(overLimit.length).toBe(LIMIT + 1);
    await over.write(Buffer.concat([overLimit, Buffer.from('\n')]));
    expect(await raced(over.closed, 2000)).toBe(true);
    expect(over.admitted).toHaveLength(0);
  });

  it('a reply larger than the frame limit is refused with a code instead of being sent', async () => {
    const stateDir = join(root, 'state');
    mkdirSync(stateDir, { mode: 0o700 });
    const server = createIpcServer({ instanceId: 'inst-1', stateDir, handlers: { status: async () => ({ blob: 'y'.repeat(LIMIT + 10) }) } });
    servers.push(server);
    await server.listen();
    const client = await connectSupervisor({ instanceId: 'inst-1', stateDir, role: 'cli' });
    await expect(client.request('status')).rejects.toMatchObject({ code: 'response_too_large' });
    await client.close();
  });
});

async function rawClient(stateDir, role = 'connector') {
  const path = ipcSocketPath({ stateDir });
  const secret = readSecret(stateDir);
  const socket = net.connect(path);
  sockets.push(socket);
  socket.on('error', () => {});
  const closed = new Promise((r) => socket.once('close', () => r(true)));
  const nonce = randomBytes(32).toString('hex');
  const frames = [];
  let buf = '';
  const onData = (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      frames.push(JSON.parse(buf.slice(0, i)));
      buf = buf.slice(i + 1);
    }
  };
  socket.on('data', onData);
  await new Promise((r) => socket.once('connect', r));
  socket.write(`${JSON.stringify({ t: 'hello', role, nonce })}\n`);
  const waitFor = async (pred) => { while (!frames.some(pred)) await new Promise((r) => setTimeout(r, 10)); return frames.find(pred); };
  const challenge = await waitFor((f) => f.t === 'challenge');
  socket.write(`${JSON.stringify({ t: 'auth', proof: proofFor(secret, 'client', nonce, challenge.nonce, 'inst-1') })}\n`);
  await waitFor((f) => f.t === 'ready');
  return { socket, frames, closed, waitFor, stopReading: () => socket.pause(), resumeReading: () => socket.resume() };
}

describe('IPC queue and outbound bounds', () => {
  it('requests beyond the per-connection queue bound are refused while a handler is blocked', async () => {
    const stateDir = join(root, 'state');
    mkdirSync(stateDir, { mode: 0o700 });
    let calls = 0;
    const server = createIpcServer({ instanceId: 'inst-1', stateDir, handlers: { status: () => { calls += 1; return new Promise(() => {}); } } });
    servers.push(server);
    await server.listen();
    const c = await rawClient(stateDir, 'cli');
    let burst = '';
    for (let id = 1; id <= 1000; id++) burst += `${JSON.stringify({ id, method: 'status', params: {} })}\n`;
    c.socket.write(burst);
    const refused = await raced(c.waitFor((f) => f.error?.code === 'overloaded'), 2000);
    expect(refused).not.toBe('timeout');
    await new Promise((r) => setTimeout(r, 100));
    const overloaded = c.frames.filter((f) => f.error?.code === 'overloaded');
    expect(overloaded.length).toBeGreaterThan(900);
    expect(calls).toBe(1);
  });

  it('a reader that stops reading is disconnected once buffered replies pass the outbound bound', async () => {
    const stateDir = join(root, 'state');
    mkdirSync(stateDir, { mode: 0o700 });
    const server = createIpcServer({ instanceId: 'inst-1', stateDir, handlers: { status: async () => ({ blob: 'z'.repeat(800 * 1024) }) } });
    servers.push(server);
    await server.listen();
    const c = await rawClient(stateDir, 'cli');
    c.stopReading();
    let burst = '';
    for (let id = 1; id <= 40; id++) burst += `${JSON.stringify({ id, method: 'status', params: {} })}\n`;
    c.socket.write(burst);
    await new Promise((r) => setTimeout(r, 1000));
    c.resumeReading();
    expect(await raced(c.closed, 3000)).toBe(true);
    expect(c.frames.filter((f) => f.id !== undefined).length).toBeLessThan(40);
  });
});

describe('IPC request envelopes', () => {
  async function serverWith(handlers) {
    const stateDir = join(root, 'state');
    mkdirSync(stateDir, { mode: 0o700 });
    const server = createIpcServer({ instanceId: 'inst-1', stateDir, handlers });
    servers.push(server);
    await server.listen();
    return stateDir;
  }
  const healthy = async (stateDir) => {
    const client = await connectSupervisor({ instanceId: 'inst-1', stateDir, role: 'cli' });
    const result = await client.request('hello');
    await client.close();
    return result;
  };

  it('a legal-size request with a huge id while the queue is full drops only that connection', async () => {
    let release;
    const blocked = new Promise((r) => { release = r; });
    const stateDir = await serverWith({ status: () => blocked, hello: async () => ({ ok: true }) });
    const c = await rawClient(stateDir, 'cli');
    let burst = '';
    for (let id = 1; id <= 64; id++) burst += `${JSON.stringify({ id, method: 'status', params: {} })}\n`;
    c.socket.write(burst);
    await new Promise((r) => setTimeout(r, 100));
    const overhead = Buffer.byteLength(JSON.stringify({ id: '', method: 'status' }));
    const big = JSON.stringify({ id: 'i'.repeat(LIMIT - overhead), method: 'status' });
    expect(Buffer.byteLength(big)).toBe(LIMIT);
    c.socket.write(`${big}\n`);
    expect(await raced(c.closed, 2000)).toBe(true);
    expect(c.frames.some((f) => f.result !== undefined)).toBe(false);
    release({ late: true });
    expect(await healthy(stateDir)).toEqual({ ok: true });
  });

  it('invalid ids or envelopes reach no handler, get no reply and close the connection', async () => {
    let calls = 0;
    const stateDir = await serverWith({ status: async () => { calls += 1; return { ok: true }; }, hello: async () => ({ ok: true }) });
    const bad = [
      { id: { nested: true }, method: 'status' },
      { id: [1], method: 'status' },
      { id: 'text', method: 'status' },
      { id: -1, method: 'status' },
      { id: 1.5, method: 'status' },
      { method: 'status' },
      { id: 1, method: 7 },
      { id: 1, method: 'status', params: [1] },
      [1, 2],
      'status',
    ];
    for (const frame of bad) {
      const c = await rawClient(stateDir, 'cli');
      c.socket.write(`${JSON.stringify(frame)}\n`);
      expect(await raced(c.closed, 2000)).toBe(true);
      expect(c.frames.filter((f) => f.t === undefined)).toEqual([]);
    }
    expect(calls).toBe(0);
    expect(await healthy(stateDir)).toEqual({ ok: true });
  });
});
