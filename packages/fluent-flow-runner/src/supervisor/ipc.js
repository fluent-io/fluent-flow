import net from 'node:net';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, closeSync, fsyncSync, lstatSync, openSync, readFileSync, realpathSync, unlinkSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { ensurePrivateDir, SupervisorUnavailable } from './owner-lock.js';


const SUN_PATH_MAX = 107;
export const MAX_FRAME_BYTES = 1024 * 1024;
export const MAX_PENDING_REQUESTS = 64;
export const MAX_OUTBOUND_BYTES = 8 * 1024 * 1024;
const NEWLINE = 0x0a;
const HANDSHAKE_TIMEOUT_MS = 5_000;
const NONCE = /^[0-9a-f]{64}$/;
export const ROLES = Object.freeze(['connector', 'cli']);
const BOTH = ['connector', 'cli'];
export const METHOD_ROLES = Object.freeze({
  hello: BOTH,
  submit: ['connector'],
  reserveSlots: ['connector'],
  releaseSlots: ['connector'],
  deliver: ['connector'],
  events: ['connector'],
  eventChunk: ['connector'],
  ackEvents: ['connector'],
  status: BOTH,
  stop: BOTH,
  pendingQuestions: BOTH,
  localAnswer: ['cli'],
  controlPlaneStatus: ['connector'],
  workspace: ['connector'],
  wrapupPreflight: ['connector'],
  wrapupCloseSessions: ['connector'],
  wrapupArchive: ['connector'],
});
const PUBLIC_ERROR_CODES = new Set(['digest_mismatch', 'admission_stopped', 'invalid_request', 'request_unavailable', 'method_not_found', 'forbidden', 'ledger_conflict']);

export function proofFor(secret, side, clientNonce, serverNonce, instanceId) {
  return createHmac('sha256', secret).update(`${side}|${clientNonce}|${serverNonce}|${instanceId}`).digest('hex');
}

export function proofMatches(expected, received) {
  if (typeof received !== 'string' || !/^[0-9a-f]{64}$/.test(received)) return false;
  return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(received, 'hex'));
}

/**
 * @param {{ stateDir: string, runtimeDir?: string | null }} opts runtimeDir defaults to $XDG_RUNTIME_DIR
 */
export function ipcSocketPath({ stateDir, runtimeDir = process.env.XDG_RUNTIME_DIR }) {
  ensurePrivateDir(stateDir);
  const direct = join(ensurePrivateDir(join(stateDir, 'supervisor')), 'ipc.sock');
  if (Buffer.byteLength(direct) <= SUN_PATH_MAX) return direct;
  if (!runtimeDir) throw new SupervisorUnavailable('runtime_dir_missing');
  let st;
  try {
    st = lstatSync(runtimeDir);
  } catch (err) {
    throw new SupervisorUnavailable('runtime_dir_missing', { cause: err });
  }
  if (st.isSymbolicLink() || !st.isDirectory() || st.uid !== process.getuid() || (st.mode & 0o777) !== 0o700) {
    throw new SupervisorUnavailable('runtime_dir_not_private');
  }
  const hash = createHash('sha256').update(realpathSync(stateDir)).digest('hex').slice(0, 16);
  const dir = ensurePrivateDir(join(ensurePrivateDir(join(runtimeDir, 'fluent-flow')), hash));
  const path = join(dir, 'ipc.sock');
  if (Buffer.byteLength(path) > SUN_PATH_MAX) throw new SupervisorUnavailable('socket_path_too_long');
  return path;
}

function secretPath(stateDir) {
  return join(stateDir, 'supervisor', 'ipc-secret');
}

export function readSecret(stateDir) {
  const path = secretPath(stateDir);
  let st;
  try {
    st = lstatSync(path);
  } catch (err) {
    throw new SupervisorUnavailable('secret_missing', { cause: err });
  }
  if (!st.isFile() || st.isSymbolicLink() || st.uid !== process.getuid() || (st.mode & 0o777) !== 0o600 || st.size !== 32) {
    throw new SupervisorUnavailable('secret_not_private');
  }
  return readFileSync(path);
}

function loadOrCreateSecret(stateDir) {
  const path = secretPath(stateDir);
  let fd;
  try {
    fd = openSync(path, 'wx', 0o600);
  } catch (err) {
    if (err.code !== 'EEXIST') throw new SupervisorUnavailable('secret_create_failed', { cause: err });
  }
  if (fd !== undefined) {
    try {
      writeSync(fd, randomBytes(32));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }
  return readSecret(stateDir);
}

export class FrameTooLarge extends Error {
  constructor() {
    super(`IPC frame exceeds ${MAX_FRAME_BYTES} bytes`);
    this.name = 'FrameTooLarge';
    this.code = 'frame_too_large';
  }
}

export function frameReader(socket, onFrame) {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let pending = [];
  let pendingBytes = 0;
  socket.on('data', (chunk) => {
    let buf = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
    while (buf.length) {
      const index = buf.indexOf(NEWLINE);
      const part = index === -1 ? buf : buf.subarray(0, index);
      if (pendingBytes + part.length > MAX_FRAME_BYTES) {
        socket.destroy();
        return;
      }
      if (index === -1) {
        pending.push(part);
        pendingBytes += part.length;
        return;
      }
      const line = pending.length ? Buffer.concat([...pending, part]) : part;
      pending = [];
      pendingBytes = 0;
      buf = buf.subarray(index + 1);
      let frame;
      try {
        frame = JSON.parse(decoder.decode(line));
      } catch {
        socket.destroy();
        return;
      }
      onFrame(frame);
      if (socket.destroyed) return;
    }
  });
}

export function send(socket, frame) {
  if (socket.destroyed) return;
  const line = `${JSON.stringify(frame)}\n`;
  if (Buffer.byteLength(line) - 1 > MAX_FRAME_BYTES) throw new FrameTooLarge();
  socket.write(line);
  if (socket.writableLength > MAX_OUTBOUND_BYTES) socket.destroy();
}

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function validEnvelope(frame) {
  if (!isPlainObject(frame)) return false;
  const { id, method, params } = frame;
  return Number.isSafeInteger(id) && id > 0 &&
    typeof method === 'string' && method.length > 0 && method.length <= 64 &&
    (params === undefined || isPlainObject(params));
}

/**
 * @param {{ instanceId: string, stateDir: string, handlers: Record<string, (params: any, ctx: { role: string, connectorEpoch?: number }) => Promise<any> | any>, log?: (entry: object) => void }} opts
 */
export function createIpcServer({ instanceId, stateDir, handlers, log = () => {} }) {
  let server = null;
  let socketPath = null;
  let secret = null;
  let connector = null;
  let connectorEpoch = 0;
  const sockets = new Set();

  function onConnection(socket) {
    sockets.add(socket);
    let connectionEpoch = null;
    socket.once('close', () => {
      sockets.delete(socket);
      if (connector === socket) {
        connector = null;
        Promise.resolve(handlers.connectorDetached?.({}, { role: 'connector', connectorEpoch: connectionEpoch }))
          .catch((err) => log({ msg: 'supervisor connector detach update failed', error: err?.message }));
      }
    });
    socket.on('error', (err) => log({ msg: 'supervisor ipc socket error', code: err.code }));
    const timer = setTimeout(() => socket.destroy(), HANDSHAKE_TIMEOUT_MS);
    let phase = 'hello';
    let role = null;
    let clientNonce = null;
    let serverNonce = null;
    let queue = Promise.resolve();
    let pendingRequests = 0;

    frameReader(socket, (frame) => {
      try {
        onFrame(frame);
      } catch (err) {
        if (!(err instanceof FrameTooLarge)) throw err;
        log({ msg: 'supervisor ipc reply too large', code: err.code });
        socket.destroy();
      }
    });

    function onFrame(frame) {
      if (phase === 'hello') {
        if (frame?.t !== 'hello' || !ROLES.includes(frame.role) || !NONCE.test(frame.nonce ?? '')) return socket.destroy();
        role = frame.role;
        clientNonce = frame.nonce;
        serverNonce = randomBytes(32).toString('hex');
        phase = 'auth';
        return send(socket, { t: 'challenge', nonce: serverNonce, proof: proofFor(secret, 'server', clientNonce, serverNonce, instanceId) });
      }
      if (phase === 'auth') {
        if (frame?.t !== 'auth' || !proofMatches(proofFor(secret, 'client', clientNonce, serverNonce, instanceId), frame.proof)) {
          log({ msg: 'supervisor ipc client failed authentication' });
          return socket.destroy();
        }
        clearTimeout(timer);
        if (role === 'connector' && connector) {
          send(socket, { t: 'refused', code: 'connector_attached' });
          return socket.end();
        }
        if (role === 'connector') {
          connector = socket;
          connectionEpoch = ++connectorEpoch;
          phase = 'attaching';
          Promise.resolve(handlers.connectorAttached?.({}, { role: 'connector', connectorEpoch: connectionEpoch }))
            .then(() => {
              if (socket.destroyed || connector !== socket) {
                return handlers.connectorDetached?.({}, { role: 'connector', connectorEpoch: connectionEpoch });
              }
              phase = 'ready';
              return send(socket, { t: 'ready' });
            })
            .catch((err) => {
              log({ msg: 'supervisor connector attach update failed', error: err?.message });
              socket.destroy();
            });
          return;
        }
        phase = 'ready';
        return send(socket, { t: 'ready' });
      }
      if (phase !== 'ready') return socket.destroy();
      if (!validEnvelope(frame)) {
        log({ msg: 'supervisor ipc request envelope invalid' });
        return socket.destroy();
      }
      const { id, method, params } = frame;
      if (pendingRequests >= MAX_PENDING_REQUESTS) return send(socket, { id, error: { code: 'overloaded' } });
      pendingRequests += 1;
      queue = queue
        .then(() => dispatch(socket, role, connectionEpoch, id, method, params))
        .catch((err) => {
          log({ msg: 'supervisor ipc dispatch failed', code: err?.code, error: err?.message });
          socket.destroy();
        })
        .finally(() => { pendingRequests -= 1; });
    }
  }

  async function dispatch(socket, role, connectorEpoch, id, method, params) {
    const handler = Object.hasOwn(METHOD_ROLES, method) ? handlers[method] : undefined;
    if (!handler) return send(socket, { id, error: { code: 'method_not_found' } });
    if (!METHOD_ROLES[method].includes(role)) return send(socket, { id, error: { code: 'forbidden' } });
    try {
      const context = role === 'connector' ? { role, connectorEpoch } : { role };
      send(socket, { id, result: (await handler(params ?? {}, context)) ?? null });
    } catch (err) {
      if (err instanceof FrameTooLarge) {
        log({ msg: 'supervisor ipc reply too large', method });
        return send(socket, { id, error: { code: 'response_too_large' } });
      }
      const code = PUBLIC_ERROR_CODES.has(err?.code) ? err.code : 'internal_error';
      log({ msg: 'supervisor ipc request failed', method, code, error: err?.message });
      send(socket, { id, error: { code } });
    }
  }

  return {
    get path() {
      return socketPath;
    },

    async listen() {
      const path = ipcSocketPath({ stateDir });
      secret = loadOrCreateSecret(stateDir);
      await removeStaleSocket(path);
      server = net.createServer(onConnection);
      await new Promise((resolveListen, reject) => {
        server.once('error', reject);
        server.listen(path, () => {
          server.removeListener('error', reject);
          resolveListen();
        });
      });
      chmodSync(path, 0o600);
      socketPath = path;
      return path;
    },

    async close() {
      if (!server) return;
      const closing = new Promise((resolveClose) => server.close(() => resolveClose()));
      for (const socket of sockets) socket.destroy();
      await closing;
      server = null;
      socketPath = null;
    },
  };
}

async function removeStaleSocket(path) {
  let st;
  try {
    st = lstatSync(path);
  } catch (err) {
    if (err.code === 'ENOENT') return;
    throw err;
  }
  if (!st.isSocket() || st.uid !== process.getuid()) throw new SupervisorUnavailable('socket_path_occupied');
  const live = await new Promise((resolveProbe) => {
    const probe = net.connect(path);
    probe.once('connect', () => { probe.destroy(); resolveProbe(true); });
    probe.once('error', () => resolveProbe(false));
  });
  if (live) throw new SupervisorUnavailable('socket_in_use');
  unlinkSync(path);
}
