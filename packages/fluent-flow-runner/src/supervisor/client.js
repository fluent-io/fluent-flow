import net from 'node:net';
import { randomBytes } from 'node:crypto';
import { frameReader, ipcSocketPath, proofFor, proofMatches, readSecret, ROLES, send } from './ipc.js';
import { SupervisorUnavailable } from './owner-lock.js';


const CONNECT_TIMEOUT_MS = 5_000;

export class SupervisorRefused extends Error {
  constructor(code) {
    super(`Supervisor refused the connection: ${code}`);
    this.name = 'SupervisorRefused';
    this.code = code;
  }
}

export class SupervisorRequestError extends Error {
  constructor(method, code) {
    super(`Supervisor request ${method} failed: ${code}`);
    this.name = 'SupervisorRequestError';
    this.code = code;
  }
}

/**
 * @param {{ instanceId: string, stateDir: string, role: 'connector' | 'cli' }} opts
 */
export async function connectSupervisor({ instanceId, stateDir, role }) {
  if (!ROLES.includes(role)) throw new TypeError(`Unknown supervisor client role ${role}`);
  const path = ipcSocketPath({ stateDir });
  const secret = readSecret(stateDir);
  const socket = net.connect(path);
  const pending = new Map();
  let nextId = 1;
  let phase = 'connecting';
  const clientNonce = randomBytes(32).toString('hex');

  const closed = new Promise((resolveClosed) => socket.once('close', resolveClosed));
  closed.then(() => {
    for (const { reject, method } of pending.values()) reject(new SupervisorRequestError(method, 'connection_closed'));
    pending.clear();
  });

  await new Promise((resolveReady, reject) => {
    const fail = (err) => {
      socket.destroy();
      reject(err);
    };
    const timer = setTimeout(() => fail(new SupervisorUnavailable('handshake_timeout')), CONNECT_TIMEOUT_MS);
    socket.once('error', (err) => { clearTimeout(timer); fail(new SupervisorUnavailable('connect_failed', { cause: err })); });
    socket.once('close', () => { clearTimeout(timer); reject(new SupervisorUnavailable('connection_closed')); });
    socket.once('connect', () => {
      phase = 'challenge';
      send(socket, { t: 'hello', role, nonce: clientNonce });
    });
    frameReader(socket, (frame) => {
      if (phase === 'challenge') {
        const serverNonce = frame?.nonce;
        if (frame?.t !== 'challenge' || typeof serverNonce !== 'string' || !/^[0-9a-f]{64}$/.test(serverNonce) ||
            !proofMatches(proofFor(secret, 'server', clientNonce, serverNonce, instanceId), frame.proof)) {
          clearTimeout(timer);
          return fail(new SupervisorUnavailable('server_not_authenticated'));
        }
        phase = 'awaiting_ready';
        return send(socket, { t: 'auth', proof: proofFor(secret, 'client', clientNonce, serverNonce, instanceId) });
      }
      if (phase === 'awaiting_ready') {
        clearTimeout(timer);
        if (frame?.t === 'ready') {
          phase = 'ready';
          socket.removeAllListeners('error');
          socket.on('error', () => {
          });
          return resolveReady();
        }
        return fail(frame?.t === 'refused' ? new SupervisorRefused(frame.code) : new SupervisorUnavailable('unexpected_frame'));
      }
      const waiter = pending.get(frame?.id);
      if (!waiter) return;
      pending.delete(frame.id);
      if (frame.error) waiter.reject(new SupervisorRequestError(waiter.method, frame.error.code));
      else waiter.resolve(frame.result);
    });
  });

  return {
    closed,
    request(method, params = {}) {
      if (socket.destroyed) return Promise.reject(new SupervisorRequestError(method, 'connection_closed'));
      const id = nextId++;
      return new Promise((resolveRequest, reject) => {
        pending.set(id, { resolve: resolveRequest, reject, method });
        try {
          send(socket, { id, method, params });
        } catch (err) {
          pending.delete(id);
          if (err?.code !== 'frame_too_large') throw err;
          reject(new SupervisorRequestError(method, 'request_too_large'));
        }
      });
    },
    async close() {
      socket.end();
      socket.destroySoon?.();
      await closed;
    },
  };
}

export class SupervisorEventIncomplete extends Error {
  /** @param {number} seq @param {{ cause?: unknown }} [options] */
  constructor(seq, options) {
    super(`Supervisor event ${seq} was incomplete after reassembly`, options);
    this.name = 'SupervisorEventIncomplete';
    this.code = 'event_incomplete';
  }
}

const strictUtf8 = new TextDecoder('utf-8', { fatal: true });

/**
 * @param {{ request: (method: string, params?: object) => Promise<any> }} client
 * @param {{ afterSeq: number, limit?: number }} opts
 */
export async function fetchEvents(client, { afterSeq, limit }) {
  const { events } = await client.request('events', { afterSeq, ...(limit ? { limit } : {}) });
  const out = [];
  for (const event of events) {
    if (!event.chunked) {
      out.push(event);
      continue;
    }
    const total = event.chunked.bytes;
    const parts = [];
    let received = 0;
    while (received < total) {
      const { data, total: reported } = await client.request('eventChunk', { seq: event.seq, offset: received });
      const part = Buffer.from(data, 'base64');
      if (reported !== total || part.length === 0 || received + part.length > total) throw new SupervisorEventIncomplete(event.seq);
      parts.push(part);
      received += part.length;
    }
    let payload;
    try {
      payload = JSON.parse(strictUtf8.decode(Buffer.concat(parts, total)));
    } catch (err) {
      throw new SupervisorEventIncomplete(event.seq, { cause: err });
    }
    const { chunked: _chunked, ...rest } = event;
    out.push({ ...rest, payload });
  }
  return out;
}
