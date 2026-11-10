import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createClient } from '../../src/client.js';

describe('client', () => {
  let fetchMock;
  let client;

  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true }), text: async () => '' });
    client = createClient({ serverUrl: 'https://flow.example.com/', token: 'ff_test', fetch: fetchMock });
  });

  it('registers with metadata and bearer authentication', async () => {
    await client.register({ hostname: 'runner-1' });
    expect(fetchMock).toHaveBeenCalledWith('https://flow.example.com/api/agent-server/register', expect.objectContaining({
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ff_test' },
      body: JSON.stringify({ meta: { hostname: 'runner-1' } }),
    }));
  });

  it('enrolls with the one-time credential without replacing durable client authentication', async () => {
    const runtimeToken = `ff_${'a'.repeat(64)}`;
    const instanceId = '2cee51c9-6351-43bd-92b8-f8763d47fdea';
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ token: runtimeToken }),
      text: async () => '',
    });

    await expect(client.enroll('enroll_once', instanceId)).resolves.toBe(runtimeToken);
    expect(fetchMock).toHaveBeenNthCalledWith(1, 'https://flow.example.com/api/agent-server/enroll', expect.objectContaining({
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer enroll_once' },
      body: JSON.stringify({ instance_id: instanceId }),
    }));

    await client.register({ hostname: 'runner-1' });
    expect(fetchMock).toHaveBeenNthCalledWith(2, 'https://flow.example.com/api/agent-server/register', expect.objectContaining({
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ff_test' },
    }));
  });

  it('gives enrollment HTTP failures a stable generic operation label', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 401, text: async () => 'credential expired' });

    await expect(client.enroll('enroll_once', '2cee51c9-6351-43bd-92b8-f8763d47fdea'))
      .rejects.toThrow('Enrollment failed: 401');
  });

  it('gives enrollment network failures a stable generic operation label', async () => {
    fetchMock.mockRejectedValueOnce(new Error('offline'));

    await expect(client.enroll('enroll_once', '2cee51c9-6351-43bd-92b8-f8763d47fdea'))
      .rejects.toThrow('Enrollment request failed: offline');
  });

  it('polls with the runner registration session and returns work', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ work: { claim_id: 9 } }), text: async () => '' });
    await expect(client.poll('runner-session')).resolves.toEqual({ claim_id: 9 });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ session_id: 'runner-session' });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://flow.example.com/api/agent-server/poll',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ session_id: 'runner-session' }) }),
    );
  });

  it('returns null when polling has no work', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ work: null }), text: async () => '' });
    await expect(client.poll('runner-session')).resolves.toBeNull();
  });

  it('heartbeats the owned claim', async () => {
    await client.heartbeat('runner-session', 9);
    expect(fetchMock).toHaveBeenCalledWith('https://flow.example.com/api/agent-server/heartbeat', expect.objectContaining({
      body: JSON.stringify({ session_id: 'runner-session', claim_id: 9 }),
    }));
  });

  it('reports the claim with its runner registration session', async () => {
    const claim = { claim_id: 9, session_id: 'runner-session', status: 'completed' };
    await client.reportClaim(claim);
    expect(fetchMock).toHaveBeenCalledWith('https://flow.example.com/api/agent-server/claim', expect.objectContaining({ body: JSON.stringify(claim) }));
  });

  it.each([
    ['postClaimEvents', ['runner-session', 9, [{ seq: 1, kind: 'state', payload: {} }]], '/api/agent-server/claims/9/events', { session_id: 'runner-session', events: [{ seq: 1, kind: 'state', payload: {} }] }],
    ['postClaimRequest', ['runner-session', 9, { requestKey: 'req-1', kind: 'permission', payload: { optionId: 'allow' } }], '/api/agent-server/claims/9/requests', { session_id: 'runner-session', request: { requestKey: 'req-1', kind: 'permission', payload: { optionId: 'allow' } } }],
    ['cancelClaimRequest', ['runner-session', 9, 'request/1'], '/api/agent-server/claims/9/requests/request%2F1/cancel', { session_id: 'runner-session' }],
    ['pollClaimCommands', ['runner-session', 9], '/api/agent-server/claims/9/commands/poll', { session_id: 'runner-session' }],
    ['renewClaimCommand', ['runner-session', 9, 'cmd/1'], '/api/agent-server/claims/9/commands/cmd%2F1/renew', { session_id: 'runner-session' }],
    ['ackClaimCommand', ['runner-session', 9, 'cmd/1', 'uncertain', { reason: 'transport lost' }], '/api/agent-server/claims/9/commands/cmd%2F1/ack', { session_id: 'runner-session', status: 'uncertain', result: { reason: 'transport lost' } }],
  ])('%s posts the ownership-bound endpoint contract', async (method, args, path, body) => {
    await client[method](...args);
    expect(fetchMock).toHaveBeenCalledWith(`https://flow.example.com${path}`, expect.objectContaining({ method: 'POST', body: JSON.stringify(body) }));
  });

  it.each([
    ['poll', ['runner-session'], 'Poll'],
    ['pollClaimCommands', ['runner-session', 9], 'Claim commands'],
    ['ackClaimCommand', ['runner-session', 9, 'command-1', 'acked', { applied: true }], 'Claim command acknowledgement'],
  ])('%s forwards external cancellation and keeps its stable operation label', async (method, args, label) => {
    const controller = new AbortController();
    fetchMock.mockImplementationOnce((_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new Error('runner stopped')), { once: true });
    }));
    const rejection = expect(client[method](...args, { signal: controller.signal }))
      .rejects.toThrow(`${label} request failed: runner stopped`);
    controller.abort();
    await rejection;
  });

  it.each([
    ['postClaimEvents', ['s', 1, []], 'Claim events'],
    ['postClaimRequest', ['s', 1, { requestKey: 'r' }], 'Claim request'],
    ['pollClaimCommands', ['s', 1], 'Claim commands'],
    ['ackClaimCommand', ['s', 1, 'c', 'failed', {}], 'Claim command acknowledgement'],
  ])('%s gives HTTP failures a stable operation label', async (method, args, label) => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 409, text: async () => 'stale' });
    await expect(client[method](...args)).rejects.toThrow(`${label} failed: 409`);
  });

  it('labels register HTTP failures', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 401, text: async () => 'nope' });
    await expect(client.register({})).rejects.toThrow('Register failed: 401');
  });

  it('labels timeout errors with the timeout duration', async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation((_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new Error('aborted')));
    }));
    const rejection = expect(client.poll('s')).rejects.toThrow('Poll request failed after 35000ms: aborted');
    await vi.advanceTimersByTimeAsync(35_000);
    await rejection;
    vi.useRealTimers();
  });

  it('labels network errors without calling them timeouts', async () => {
    fetchMock.mockRejectedValueOnce(new Error('offline'));
    await expect(client.poll('s')).rejects.toThrow('Poll request failed: offline');
  });
});
