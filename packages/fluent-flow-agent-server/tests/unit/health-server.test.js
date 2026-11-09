import { connect } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';

const httpServers = vi.hoisted(() => []);

vi.mock('node:http', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    createServer: (...args) => {
      const server = actual.createServer(...args);
      httpServers.push(server);
      return server;
    },
  };
});

import { createHealthServer } from '../../src/health-server.js';

const listeners = [];

const healthy = {
  status: 'healthy',
  instance_id: 'instance-public',
  provider: 'claude-code',
  capacity: 2,
  active: 1,
  online_slots: 2,
};

async function startHealth(getStatus = () => healthy, extraOptions = {}) {
  const listener = createHealthServer({
    getStatus,
    host: '127.0.0.1',
    port: 0,
    ...extraOptions,
  });
  listeners.push(listener);
  const address = await listener.start();
  return {
    listener,
    address,
    url: `http://127.0.0.1:${address.port}`,
  };
}

afterEach(async () => {
  await Promise.allSettled(listeners.splice(0).map((listener) => listener.stop()));
});

describe('private health HTTP server', () => {
  it.each(['/healthz', '/status'])('%s returns exactly the six public JSON fields', async (path) => {
    const source = {
      ...healthy,
      token: 'ff_never_public',
      enrollmentToken: 'enroll_never_public',
      providerSecret: 'provider-never-public',
      stateDir: '/private/state',
      workDir: '/private/work',
      sessionIds: ['session-secret'],
      nested: { internal: true },
    };
    const { url } = await startHealth(() => source);

    const response = await fetch(`${url}${path}`);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toMatch(/^application\/json\b/u);
    expect(body).toEqual(healthy);
    expect(Object.keys(body).sort()).toEqual([
      'active', 'capacity', 'instance_id', 'online_slots', 'provider', 'status',
    ]);
    expect(JSON.stringify(body)).not.toMatch(/ff_never|enroll_never|provider-never|\/private|session-secret/u);
  });

  it.each([
    ['healthy', 200],
    ['degraded', 200],
    ['unhealthy', 503],
  ])('/healthz for %s status returns HTTP %i', async (status, expectedCode) => {
    const { url } = await startHealth(() => ({ ...healthy, status }));

    const response = await fetch(`${url}/healthz`);

    expect(response.status).toBe(expectedCode);
    expect(await response.json()).toEqual({ ...healthy, status });
  });

  it.each(['healthy', 'degraded', 'unhealthy'])('keeps /status inspectable when status is %s', async (status) => {
    const { url } = await startHealth(() => ({ ...healthy, status }));

    const response = await fetch(`${url}/status`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ...healthy, status });
  });

  it('returns 404 for an unknown path without reflecting private status data', async () => {
    const { url } = await startHealth(() => ({ ...healthy, token: 'ff_never_public' }));

    const response = await fetch(`${url}/metrics`);
    const text = await response.text();

    expect(response.status).toBe(404);
    expect(text).not.toContain('ff_never_public');
  });

  it.each(['POST', 'PUT', 'DELETE', 'PATCH'])('returns 405 for %s without invoking getStatus', async (method) => {
    let statusReads = 0;
    const { url } = await startHealth(() => {
      statusReads += 1;
      return healthy;
    });

    const response = await fetch(`${url}/healthz`, { method });

    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('GET');
    expect(statusReads).toBe(0);
  });

  it('starts idempotently on one ephemeral loopback port', async () => {
    const { listener, address } = await startHealth();

    const repeatedAddress = await listener.start();

    expect(repeatedAddress).toEqual(address);
    expect(address.address).toBe('127.0.0.1');
    expect(address.port).toBeGreaterThan(0);
  });

  it('stops idempotently and resolves only after the listener is closed', async () => {
    const { listener, url } = await startHealth();

    await Promise.all([listener.stop(), listener.stop(), listener.stop()]);

    await expect(fetch(`${url}/healthz`)).rejects.toThrow();
    await expect(listener.stop()).resolves.toBeUndefined();
  });
});

function rawRequest(port, requestText) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const socket = connect({ host: '127.0.0.1', port });
    socket.once('error', reject);
    socket.on('data', (chunk) => chunks.push(chunk));
    socket.once('close', () => resolve(Buffer.concat(chunks).toString('utf8')));
    socket.write(requestText);
  });
}

describe('private health HTTP server resilience', () => {
  it('answers a malformed request target with a generic JSON error and keeps serving', async () => {
    const { address, url } = await startHealth();

    const raw = await rawRequest(address.port, 'GET //[ HTTP/1.1\r\nHost: health.local\r\nConnection: close\r\n\r\n');
    const [head, ...bodyParts] = raw.split('\r\n\r\n');
    const body = bodyParts.join('\r\n\r\n');

    expect(head).toMatch(/^HTTP\/1\.1 400 /u);
    expect(head).toMatch(/content-type: application\/json/iu);
    expect(JSON.parse(body)).toEqual({ error: expect.any(String) });
    expect(raw).not.toContain('//[');

    const response = await fetch(`${url}/healthz`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(healthy);
  });

  it('logs and answers 500 without leaking the failure when status retrieval throws', async () => {
    const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const { url } = await startHealth(() => {
      throw new Error('internal failure with ff_never_public');
    }, { log });

    const response = await fetch(`${url}/status`);
    const text = await response.text();

    expect(response.status).toBe(500);
    expect(JSON.parse(text)).toEqual({ error: 'Health status unavailable' });
    expect(text).not.toContain('ff_never_public');
    expect(log.error).toHaveBeenCalledOnce();
    expect(typeof log.error.mock.calls[0][0]).toBe('string');
  });

  it('logs a malformed request target at debug level without warning', async () => {
    const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const { address } = await startHealth(() => healthy, { log });

    const raw = await rawRequest(address.port, 'GET //[ HTTP/1.1\r\nHost: health.local\r\nConnection: close\r\n\r\n');

    expect(raw).toMatch(/^HTTP\/1\.1 400 /u);
    expect(log.warn).not.toHaveBeenCalled();
    expect(log.error).not.toHaveBeenCalled();
    expect(log.debug).toHaveBeenCalledOnce();
    expect(typeof log.debug.mock.calls[0][0]).toBe('string');
    expect(JSON.stringify(log.debug.mock.calls)).not.toContain('//[');
  });

  it('logs an error event on the listening server through log.error and keeps serving', async () => {
    const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const { url } = await startHealth(() => healthy, { log });
    const server = httpServers.at(-1);

    expect(() => server.emit('error', new Error('listener failed for ff_listener_secret'))).not.toThrow();

    expect(log.error).toHaveBeenCalledOnce();
    expect(typeof log.error.mock.calls[0][0]).toBe('string');
    expect(JSON.stringify(log.error.mock.calls)).not.toContain('ff_listener_secret');
    const response = await fetch(`${url}/healthz`);
    expect(response.status).toBe(200);
  });
});
