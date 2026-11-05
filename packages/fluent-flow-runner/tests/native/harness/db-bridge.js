import net from 'node:net';
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export class DatabaseBridgeRefused extends Error {
  constructor(reason) {
    super(`database_bridge_refused (${reason})`);
    this.name = 'DatabaseBridgeRefused';
    this.code = 'database_bridge_refused';
  }
}

export function bridgeTarget(databaseUrl) {
  let url;
  try {
    url = new URL(databaseUrl);
  } catch {
    throw new DatabaseBridgeRefused('unparsable_url');
  }
  if (url.hostname !== '127.0.0.1') throw new DatabaseBridgeRefused('host_not_127.0.0.1');
  if (url.port === '') throw new DatabaseBridgeRefused('no_explicit_port');
  return { host: '127.0.0.1', port: Number(url.port) };
}

function pipeBoth(a, b) {
  const end = () => {
    a.destroy();
    b.destroy();
  };
  a.on('error', end);
  b.on('error', end);
  a.on('close', end);
  b.on('close', end);
  a.pipe(b);
  b.pipe(a);
}

function tracked(server) {
  const sockets = new Set();
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  return () => {
    for (const socket of sockets) socket.destroy();
  };
}

const listening = (server, ...args) => new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(...args, () => {
    server.removeListener('error', reject);
    resolve();
  });
});

/**
 * @param {{ databaseUrl: string, dir?: string }} opts - `dir` is the parent of the private temp directory
 * @returns {Promise<{ socketPath: string, directory: string, close: () => Promise<void> }>}
 */
export async function startDbBridgeOutside({ databaseUrl, dir = tmpdir() }) {
  const target = bridgeTarget(databaseUrl);
  const directory = mkdtempSync(join(dir, 'ff-db-bridge-'));
  chmodSync(directory, 0o700);
  const socketPath = join(directory, 'db.sock');
  const server = net.createServer((client) => {
    pipeBoth(client, net.connect({ host: target.host, port: target.port }));
  });
  const destroyAll = tracked(server);
  try {
    await listening(server, socketPath);
    chmodSync(socketPath, 0o600);
  } catch (err) {
    rmSync(directory, { recursive: true, force: true });
    throw err;
  }
  return {
    socketPath,
    directory,
    async close() {
      destroyAll();
      await new Promise((resolve) => server.close(() => resolve()));
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

/**
 * @param {{ databaseUrl: string, socketPath: string, port?: number }} opts - `port` defaults to the URL's port; the default-suite test passes a free port because the stand-in target already holds the URL's port there
 * @returns {Promise<{ port: number, close: () => Promise<void> }>}
 */
export async function startDbBridgeInside({ databaseUrl, socketPath, port }) {
  const target = bridgeTarget(databaseUrl);
  const server = net.createServer((client) => {
    pipeBoth(client, net.connect(socketPath));
  });
  const destroyAll = tracked(server);
  await listening(server, port ?? target.port, '127.0.0.1');
  const address = /** @type {import('node:net').AddressInfo} */ (server.address());
  return {
    port: address.port,
    async close() {
      destroyAll();
      await new Promise((resolve) => server.close(() => resolve()));
    },
  };
}
