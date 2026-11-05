import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import net from 'node:net';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, statSync, mkdirSync, symlinkSync, chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { ipcSocketPath, createIpcServer } from '../../../src/supervisor/ipc.js';
import { connectSupervisor } from '../../../src/supervisor/client.js';
import { SupervisorUnavailable } from '../../../src/supervisor/owner-lock.js';

let root;
let servers;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'ff-ipc-')); servers = []; });
afterEach(async () => {
  vi.restoreAllMocks();
  for (const s of servers.splice(0)) await s.close();
  rmSync(root, { recursive: true, force: true });
});

const uid = process.getuid();
function expectPrivateDir(path) {
  const st = statSync(path);
  expect(st.isDirectory()).toBe(true);
  expect(st.uid).toBe(uid);
  expect(st.mode & 0o777).toBe(0o700);
}

async function startServer(stateDir, handlers = {}) {
  const server = createIpcServer({ instanceId: 'inst-1', stateDir, handlers: { status: async () => ({ ok: true }), ...handlers } });
  servers.push(server);
  await server.listen();
  return server;
}

function rawFrames(path) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(path);
    let buf = '';
    const frames = [];
    socket.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) { frames.push(JSON.parse(buf.slice(0, i))); buf = buf.slice(i + 1); }
    });
    socket.once('connect', () => resolve({ socket, frames, closed: new Promise((r) => socket.once('close', r)) }));
    socket.once('error', reject);
  });
}

describe('owner-only supervisor IPC', () => {
  it('ipc.sock sits in a 0700 directory owned by the uid; a long stateDir uses the XDG path', () => {
    const stateDir = join(root, 'state');
    mkdirSync(stateDir, { mode: 0o700 });
    const short = ipcSocketPath({ stateDir });
    expect(short).toBe(join(stateDir, 'supervisor', 'ipc.sock'));
    expectPrivateDir(dirname(short));

    const longState = join(root, 'x'.repeat(120));
    mkdirSync(longState, { mode: 0o700 });
    const runtimeDir = join(root, 'run');
    mkdirSync(runtimeDir, { mode: 0o700 });
    const long = ipcSocketPath({ stateDir: longState, runtimeDir });
    expect(long).toMatch(new RegExp(`^${runtimeDir}/fluent-flow/[0-9a-f]{16}/ipc\\.sock$`));
    expect(Buffer.byteLength(long)).toBeLessThanOrEqual(107);
    expectPrivateDir(dirname(long));
    expectPrivateDir(dirname(dirname(long)));
    expect(ipcSocketPath({ stateDir: longState, runtimeDir })).toBe(long);
  });

  it('a symlinked, foreign-owned or wider-mode directory fails closed', () => {
    const real = join(root, 'real');
    mkdirSync(real, { mode: 0o700 });
    const linked = join(root, 'linked');
    mkdirSync(linked, { mode: 0o700 });
    symlinkSync(real, join(linked, 'supervisor'));
    expect(() => ipcSocketPath({ stateDir: linked })).toThrow(SupervisorUnavailable);

    const wide = join(root, 'wide');
    mkdirSync(join(wide, 'supervisor'), { recursive: true, mode: 0o700 });
    chmodSync(join(wide, 'supervisor'), 0o755);
    expect(() => ipcSocketPath({ stateDir: wide })).toThrow(SupervisorUnavailable);

    const longState = join(root, 'y'.repeat(120));
    mkdirSync(longState, { mode: 0o700 });
    expect(() => ipcSocketPath({ stateDir: longState, runtimeDir: '/tmp' })).toThrow(SupervisorUnavailable);
    expect(() => ipcSocketPath({ stateDir: longState, runtimeDir: null })).toThrow(SupervisorUnavailable);
  });

  it('a server without the secret cannot complete the handshake and receives no request', async () => {
    const stateDir = join(root, 'state');
    mkdirSync(stateDir, { mode: 0o700 });
    const path = ipcSocketPath({ stateDir });
    writeFileSync(join(stateDir, 'supervisor', 'ipc-secret'), randomBytes(32), { mode: 0o600 });
    const received = [];
    const fake = net.createServer((socket) => {
      let buf = '';
      socket.on('data', (d) => {
        buf += d;
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const frame = JSON.parse(buf.slice(0, i));
          buf = buf.slice(i + 1);
          received.push(frame);
          if (frame.t === 'hello') socket.write(`${JSON.stringify({ t: 'challenge', nonce: randomBytes(32).toString('hex'), proof: randomBytes(32).toString('hex') })}\n`);
        }
      });
    });
    await new Promise((r) => fake.listen(path, r));
    try {
      await expect(connectSupervisor({ instanceId: 'inst-1', stateDir, role: 'cli' })).rejects.toBeInstanceOf(SupervisorUnavailable);
      await new Promise((r) => setTimeout(r, 50));
      expect(received.map((f) => f.t)).toEqual(['hello']);
    } finally {
      await new Promise((r) => fake.close(r));
    }
  });

  it('a client without the secret or with another instance id is refused', async () => {
    const stateDir = join(root, 'state');
    mkdirSync(stateDir, { mode: 0o700 });
    const status = vi.fn(async () => ({ ok: true }));
    await startServer(stateDir, { status });
    await expect(connectSupervisor({ instanceId: 'inst-other', stateDir, role: 'cli' })).rejects.toBeInstanceOf(SupervisorUnavailable);

    const raw = await rawFrames(ipcSocketPath({ stateDir }));
    raw.socket.write(`${JSON.stringify({ t: 'hello', role: 'cli', nonce: randomBytes(32).toString('hex') })}\n`);
    await new Promise((r) => setTimeout(r, 50));
    raw.socket.write(`${JSON.stringify({ t: 'auth', proof: randomBytes(32).toString('hex') })}\n`);
    raw.socket.write(`${JSON.stringify({ id: 1, method: 'status', params: {} })}\n`);
    await raw.closed;
    expect(raw.frames.some((f) => f.t === 'ready' || 'result' in f)).toBe(false);
    expect(status).not.toHaveBeenCalled();

    const ok = await connectSupervisor({ instanceId: 'inst-1', stateDir, role: 'cli' });
    expect(await ok.request('status', {})).toEqual({ ok: true });
    await ok.close();
  });

  it('a second connector is refused while one is attached; cli clients are allowed', async () => {
    const stateDir = join(root, 'state');
    mkdirSync(stateDir, { mode: 0o700 });
    await startServer(stateDir);
    const first = await connectSupervisor({ instanceId: 'inst-1', stateDir, role: 'connector' });
    await expect(connectSupervisor({ instanceId: 'inst-1', stateDir, role: 'connector' })).rejects.toMatchObject({ code: 'connector_attached' });
    const cli = await connectSupervisor({ instanceId: 'inst-1', stateDir, role: 'cli' });
    expect(await cli.request('status', {})).toEqual({ ok: true });
    await cli.close();
    await first.close();
    await new Promise((r) => setTimeout(r, 50));
    const next = await connectSupervisor({ instanceId: 'inst-1', stateDir, role: 'connector' });
    expect(await next.request('status', {})).toEqual({ ok: true });
    await next.close();
  });

  it('captured socket bytes never contain the secret', async () => {
    const stateDir = join(root, 'state');
    mkdirSync(stateDir, { mode: 0o700 });
    const written = [];
    const read = [];
    const origWrite = net.Socket.prototype.write;
    vi.spyOn(net.Socket.prototype, 'write').mockImplementation(function (chunk, ...rest) {
      written.push(Buffer.from(chunk));
      return origWrite.call(this, chunk, ...rest);
    });
    const origEmit = net.Socket.prototype.emit;
    vi.spyOn(net.Socket.prototype, 'emit').mockImplementation(function (event, ...args) {
      if (event === 'data') read.push(Buffer.from(args[0]));
      return origEmit.call(this, event, ...args);
    });
    await startServer(stateDir);
    const client = await connectSupervisor({ instanceId: 'inst-1', stateDir, role: 'connector' });
    await client.request('status', {});
    await client.close();
    const secret = readFileSync(join(stateDir, 'supervisor', 'ipc-secret'));
    expect(secret.length).toBe(32);
    expect(statSync(join(stateDir, 'supervisor', 'ipc-secret')).mode & 0o777).toBe(0o600);
    const wire = Buffer.concat([...written, ...read]);
    expect(wire.length).toBeGreaterThan(0);
    for (const encoding of ['hex', 'base64', 'base64url', 'latin1']) {
      expect(wire.includes(secret.toString(encoding))).toBe(false);
    }
    expect(wire.includes(secret)).toBe(false);
  });
});
