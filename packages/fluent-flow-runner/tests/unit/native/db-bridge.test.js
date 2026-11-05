import { describe, it, expect, afterEach } from 'vitest';
import net from 'node:net';
import { existsSync, statSync } from 'node:fs';
import { startDbBridgeOutside, startDbBridgeInside } from '../../native/harness/db-bridge.js';

const closers = [];
afterEach(async () => {
  for (const c of closers.splice(0).reverse()) await c();
});

async function echoServer() {
  const connections = [];
  const server = net.createServer((socket) => {
    connections.push(socket);
    socket.on('data', (d) => socket.write(Buffer.concat([Buffer.from('echo:'), d])));
    socket.on('error', () => {});
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  closers.push(() => new Promise((r) => { for (const s of connections) s.destroy(); server.close(() => r()); }));
  return { port: /** @type {net.AddressInfo} */ (server.address()).port, connections };
}

function roundTrip(connect, payload) {
  return new Promise((resolve, reject) => {
    const socket = connect();
    const chunks = [];
    socket.on('error', reject);
    socket.on('data', (d) => {
      chunks.push(d);
      const all = Buffer.concat(chunks);
      if (all.length >= payload.length + 5) {
        socket.destroy();
        resolve(all);
      }
    });
    socket.write(payload);
  });
}

describe('native test database bridge (Task 7)', () => {
  it('bytes flow both ways from the inside TCP listener through db.sock to the configured target', async () => {
    const target = await echoServer();
    const databaseUrl = `postgres://ffuser@127.0.0.1:${target.port}/ff_connector_bridge_test`;
    const outside = await startDbBridgeOutside({ databaseUrl });
    closers.push(() => outside.close());
    const inside = await startDbBridgeInside({ databaseUrl, socketPath: outside.socketPath, port: 0 });
    closers.push(() => inside.close());
    const payload = Buffer.from('SELECT 1; 日本語 \u0000 binary\xff', 'latin1');
    const reply = await roundTrip(() => net.connect({ host: '127.0.0.1', port: inside.port }), payload);
    expect(reply.equals(Buffer.concat([Buffer.from('echo:'), payload]))).toBe(true);
    expect(target.connections).toHaveLength(1);
  });

  it('every connection to db.sock reaches only the configured target', async () => {
    const target = await echoServer();
    const other = await echoServer();
    const outside = await startDbBridgeOutside({ databaseUrl: `postgres://u@127.0.0.1:${target.port}/ff_connector_x` });
    closers.push(() => outside.close());
    for (const attempt of [`CONNECT 127.0.0.1:${other.port}\r\n\r\n`, `127.0.0.1:${other.port}`, 'GET http://example.test/ HTTP/1.1\r\n\r\n']) {
      const reply = await roundTrip(() => net.connect(outside.socketPath), Buffer.from(attempt));
      expect(reply.toString().startsWith('echo:')).toBe(true);
    }
    expect(target.connections).toHaveLength(3);
    expect(other.connections).toHaveLength(0);
  });

  it('a non-127.0.0.1 or portless URL is refused with database_bridge_refused', async () => {
    for (const databaseUrl of ['postgres://u@localhost:5432/ff_connector_x', 'postgres://u@[::1]:5432/ff_connector_x', 'postgres://u@10.0.0.5:5432/ff_connector_x', 'postgres://u@127.0.0.1/ff_connector_x', 'not a url']) {
      await expect(startDbBridgeOutside({ databaseUrl }), databaseUrl).rejects.toMatchObject({ code: 'database_bridge_refused' });
      await expect(startDbBridgeInside({ databaseUrl, socketPath: '/nonexistent/db.sock', port: 0 }), databaseUrl).rejects.toMatchObject({ code: 'database_bridge_refused' });
    }
  });

  it('db.sock is 0600 in a 0700 directory and both are removed on close', async () => {
    const target = await echoServer();
    const outside = await startDbBridgeOutside({ databaseUrl: `postgres://u@127.0.0.1:${target.port}/ff_connector_x` });
    expect(statSync(outside.directory).mode & 0o777).toBe(0o700);
    expect(statSync(outside.socketPath).mode & 0o777).toBe(0o600);
    expect(statSync(outside.socketPath).isSocket()).toBe(true);
    const inside = await startDbBridgeInside({ databaseUrl: `postgres://u@127.0.0.1:${target.port}/ff_connector_x`, socketPath: outside.socketPath, port: 0 });
    const open = net.connect({ host: '127.0.0.1', port: inside.port });
    await new Promise((r) => open.once('connect', r));
    open.on('error', () => {});
    await inside.close();
    await outside.close();
    expect(existsSync(outside.socketPath)).toBe(false);
    expect(existsSync(outside.directory)).toBe(false);
    await expect(new Promise((resolve, reject) => { const s = net.connect({ host: '127.0.0.1', port: inside.port }); s.on('connect', () => { s.destroy(); resolve('connected'); }); s.on('error', reject); })).rejects.toMatchObject({ code: 'ECONNREFUSED' });
  });
});
