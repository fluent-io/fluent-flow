import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createConnectorClient } from '../../../src/connector/connector-client.js';

const base = 'http://127.0.0.1:4000';

function jsonResponse(body, status = 200) {
  return { ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) };
}

describe('connector client', () => {
  let fetchMock;
  let client;

  beforeEach(() => {
    fetchMock = vi.fn();
    client = createConnectorClient({ serverUrl: base, token: 'ffh_testtoken', fetch: fetchMock });
  });

  it('registers with protocol version, instance identity and catalog', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        hostId: 'host-1',
        connectorSessionId: 'cs-1',
        leaseEpoch: 3,
        heartbeatIntervalMs: 15000,
        staleAfterMs: 45000,
        offlineAfterMs: 120000,
      }),
    );
    const registration = await client.register({
      instanceId: 'pc-1',
      protocolVersion: 1,
      sdkVersion: '0.12.0',
      daemonVersion: '0.12.0',
      capabilities: { cancel: 'cli-stop', timeline: true },
      catalog: { repositories: [{ key: 'fluent-flow' }], profiles: [{ id: 'p1', name: 'Coder', provider: 'omp', model: 'ai3/x' }] },
    });
    expect(fetchMock).toHaveBeenCalledWith(
      `${base}/api/connector/v1/register`,
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'Content-Type': 'application/json',
          Authorization: 'Bearer ffh_testtoken',
        }),
      }),
    );
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.protocolVersion).toBe(1);
    expect(body.instanceId).toBe('pc-1');
    expect(body.catalog.repositories[0].key).toBe('fluent-flow');
    expect(registration.leaseEpoch).toBe(3);
    expect(registration.heartbeatIntervalMs).toBe(15000);
  });

  it('heartbeats with connector session, lease epoch and active runs', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true, status: 'online', leaseEpoch: 3 }));
    const res = await client.heartbeat({ connectorSessionId: 'cs-1', leaseEpoch: 3, activeRunIds: ['run-1'], observedAt: '2026-10-19T00:00:00Z' });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.connectorSessionId).toBe('cs-1');
    expect(body.leaseEpoch).toBe(3);
    expect(body.activeRunIds).toEqual(['run-1']);
    expect(res.status).toBe('online');
  });

  it('long-polls with waitMs and returns command list', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ commands: [{ id: 'cmd-1', runId: 'run-1', sessionId: null, kind: 'launch', payload: {}, createdAt: '2026-10-19T00:00:00Z', leaseEpoch: 3 }] }),
    );
    const res = await client.poll({ connectorSessionId: 'cs-1', leaseEpoch: 3, waitMs: 25000, limit: 1 });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.waitMs).toBe(25000);
    expect(body.limit).toBe(1);
    expect(res.commands).toHaveLength(1);
    expect(res.commands[0].kind).toBe('launch');
  });

  it('acks a terminal state with result and fence', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true, state: 'applied' }));
    await client.ack('cmd-1', { connectorSessionId: 'cs-1', leaseEpoch: 3, state: 'applied', result: { workspaceId: 'ws-1' } });
    expect(fetchMock.mock.calls[0][0]).toBe(`${base}/api/connector/v1/commands/cmd-1/ack`);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.state).toBe('applied');
    expect(body.leaseEpoch).toBe(3);
  });

  it('posts observation batches and returns accepted ids', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ acceptedEventIds: ['ev-1'], highWatermarks: {} }));
    const res = await client.observe({
      connectorSessionId: 'cs-1',
      leaseEpoch: 3,
      events: [{ eventId: 'ev-1', runId: 'run-1', sessionId: 's-1', observedAt: '2026-10-19T00:00:00Z', kind: 'state', payload: { state: 'running' } }],
    });
    expect(res.acceptedEventIds).toEqual(['ev-1']);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.events).toHaveLength(1);
  });

  it('surfaces stale-fence 409 responses as typed errors, not crashes', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ error: { code: 'stale_lease', message: 'fence superseded', requestId: 'r1' } }, 409),
    );
    await expect(
      client.heartbeat({ connectorSessionId: 'cs-1', leaseEpoch: 2, activeRunIds: [], observedAt: '2026-10-19T00:00:00Z' }),
    ).rejects.toMatchObject({ status: 409, code: 'stale_lease' });
  });

  it('surfaces 401 revoked-token responses with the status attached', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ error: { code: 'unauthorized', message: 'host token revoked', requestId: 'r2' } }, 401),
    );
    await expect(client.poll({ connectorSessionId: 'cs-1', leaseEpoch: 3, waitMs: 0, limit: 1 })).rejects.toMatchObject({ status: 401 });
  });

  it('refuses to send the bearer token over plain http to non-loopback hosts', () => {
    expect(() => createConnectorClient({ serverUrl: 'http://flow.example.com', token: 'ffh_x', fetch: fetchMock })).toThrow(/https/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('allows plain http for loopback control planes', () => {
    expect(() => createConnectorClient({ serverUrl: 'http://127.0.0.1:4000', token: 'ffh_x', fetch: fetchMock })).not.toThrow();
    expect(() => createConnectorClient({ serverUrl: 'http://[::1]:4000', token: 'ffh_x', fetch: fetchMock })).not.toThrow();
    expect(() => createConnectorClient({ serverUrl: 'http://localhost:4000', token: 'ffh_x', fetch: fetchMock })).not.toThrow();
  });

  it('rejects server URLs embedding userinfo credentials', () => {
    expect(() => createConnectorClient({ serverUrl: 'https://user:secret@flow.example.com', token: 'ffh_x', fetch: fetchMock })).toThrow(/credential|userinfo|url/i);
  });
});
