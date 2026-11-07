import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/logger.js', async () => {
  const { createMockLogger } = await import('../helpers/mock-logger.js');
  return { default: createMockLogger() };
});

vi.mock('../../src/db/client.js', () => ({ audit: vi.fn() }));

vi.mock('../../src/agents/token-manager.js', () => ({
  validateToken: vi.fn(),
}));

vi.mock('../../src/agents/session-manager.js', () => ({
  registerSession: vi.fn(),
  touchSession: vi.fn(),
  setSessionStatus: vi.fn(),
}));

vi.mock('../../src/agents/claim-manager.js', () => ({
  assertClaimOwner: vi.fn(),
  withClaimOwner: vi.fn(),
  completeClaim: vi.fn(),
  failClaim: vi.fn(),
  completeClaimById: vi.fn(),
  failClaimById: vi.fn(),
  cancelClaimById: vi.fn(),
  getClaimById: vi.fn(),
  getClaimByAttempt: vi.fn(),
  createClaim: vi.fn(),
  createFollowOnClaim: vi.fn(),
  redispatchClaim: vi.fn(),
  extendClaim: vi.fn(),
}));

vi.mock('@fluent-flow/db', async (importOriginal) => ({
  ...(await importOriginal()),
  db: {},
  appendClaimEvents: vi.fn(),
  cancelClaimRequest: vi.fn(),
  upsertClaimRequest: vi.fn(),
  leaseClaimCommands: vi.fn(),
  renewClaimCommand: vi.fn(),
  ackClaimCommand: vi.fn(),
  getVerificationResultByClaim: vi.fn(),
  insertVerificationResult: vi.fn(),
  insertVerificationResultAtomic: vi.fn(),
  markVerificationTransitionApplied: vi.fn(),
}));

import {
  ackClaimCommand,
  cancelClaimRequest,
  appendClaimEvents,
  leaseClaimCommands,
  upsertClaimRequest,
  renewClaimCommand,
} from '@fluent-flow/db';
import { withClaimOwner } from '../../src/agents/claim-manager.js';
import {
  handleClaimCommandAck,
  handleClaimRequestCancellation,
  handleClaimCommandsPoll,
  handleClaimEvents,
  handleClaimCommandRenewal,
  handleClaimRequest,
} from '../../src/routes/runner.js';

function makeRes() {
  return {
    headersSent: false,
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; this.headersSent = true; return this; },
  };
}

function request(body, params = { claimId: '7' }) {
  return { body, params, tokenInfo: { org_id: 'o1', agent_id: 'a1' } };
}

function ownershipError(statusCode, detail) {
  return Object.assign(new Error(detail), { statusCode });
}

const EVENT = { seq: 1, kind: 'agent_message', payload: { text: 'done' } };

const OWNER_CLIENT = { query: vi.fn() };

beforeEach(() => {
  vi.clearAllMocks();
  withClaimOwner.mockImplementation(async (_input, operation) => operation(OWNER_CLIENT));
});

describe('runner claim interaction ownership', () => {
  it('accepts events only after proving the current token agent and session own the claim', async () => {
    appendClaimEvents.mockResolvedValue({ inserted: 1, lastSeq: 1 });
    const res = makeRes();

    await handleClaimEvents(request({ session_id: 3, events: [EVENT] }), res);

    expect(withClaimOwner).toHaveBeenCalledWith(
      { orgId: 'o1', agentId: 'a1', sessionId: 3, claimId: 7 },
      expect.any(Function),
    );
    expect(appendClaimEvents).toHaveBeenCalledWith({ orgId: 'o1', claimId: 7, events: [EVENT] }, OWNER_CLIENT);
    expect(res.body).toEqual({ ok: true, inserted: 1, lastSeq: 1 });
  });

  it.each([
    ['foreign or missing claim', 404, 'claim belongs to o2'],
    ['another runner session or agent', 409, 'session 9 belongs to a2'],
    ['terminal claim', 409, 'claim is completed'],
  ])('returns a generic status for %s without touching interactions', async (_label, statusCode, detail) => {
    withClaimOwner.mockRejectedValueOnce(ownershipError(statusCode, detail));
    const res = makeRes();

    await handleClaimEvents(request({ session_id: 3, events: [EVENT] }), res);

    expect(res.statusCode).toBe(statusCode);
    expect(res.body).toEqual({ error: statusCode === 404 ? 'Claim not found' : 'Claim is not active for this runner' });
    expect(JSON.stringify(res.body)).not.toContain(detail);
    expect(appendClaimEvents).not.toHaveBeenCalled();
  });

  it('proves current ownership for request, command poll, and command acknowledgement routes', async () => {
    upsertClaimRequest.mockResolvedValue({ requestKey: '1:permission:4', kind: 'permission', payload: { title: 'Write?' }, status: 'open', orgId: 'o1', claimId: 7, response: null });
    leaseClaimCommands.mockResolvedValue([]);
    ackClaimCommand.mockResolvedValue({ id: 11 });

    await handleClaimRequest(request({ session_id: 3, request: { requestKey: '1:permission:4', kind: 'permission', payload: { title: 'Write?' } } }), makeRes());
    await handleClaimCommandsPoll(request({ session_id: 3 }), makeRes());
    await handleClaimCommandAck(request({ session_id: 3, status: 'acked', result: { applied: true } }, { claimId: '7', commandId: '11' }), makeRes());

    expect(withClaimOwner).toHaveBeenCalledTimes(3);
    expect(withClaimOwner).toHaveBeenNthCalledWith(1, { orgId: 'o1', agentId: 'a1', sessionId: 3, claimId: 7 }, expect.any(Function));
    expect(withClaimOwner).toHaveBeenNthCalledWith(2, { orgId: 'o1', agentId: 'a1', sessionId: 3, claimId: 7 }, expect.any(Function));
    expect(withClaimOwner).toHaveBeenNthCalledWith(3, { orgId: 'o1', agentId: 'a1', sessionId: 3, claimId: 7 }, expect.any(Function));
    expect(upsertClaimRequest).toHaveBeenCalledWith(expect.objectContaining({ orgId: 'o1', claimId: 7 }), OWNER_CLIENT);
    expect(leaseClaimCommands).toHaveBeenCalledWith({ orgId: 'o1', claimId: 7, limit: 25 }, OWNER_CLIENT);
    expect(ackClaimCommand).toHaveBeenCalledWith(expect.objectContaining({ orgId: 'o1', claimId: 7, commandId: 11 }), OWNER_CLIENT);
  });
});

describe('runner claim interaction replay and delivery', () => {
  it('returns exact event replay results and maps a conflicting replay to a generic 409', async () => {
    appendClaimEvents
      .mockResolvedValueOnce({ inserted: 1, lastSeq: 1 })
      .mockResolvedValueOnce({ inserted: 0, lastSeq: 1 })
      .mockRejectedValueOnce(new Error('Interaction conflict. seq=1 payload differs'));
    const body = { session_id: 3, events: [EVENT] };
    const first = makeRes();
    const replay = makeRes();
    const conflict = makeRes();

    await handleClaimEvents(request(body), first);
    await handleClaimEvents(request(body), replay);
    await handleClaimEvents(request(body), conflict);

    expect(first.body).toEqual({ ok: true, inserted: 1, lastSeq: 1 });
    expect(replay.body).toEqual({ ok: true, inserted: 0, lastSeq: 1 });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.body).toEqual({ error: 'Interaction conflict' });
    expect(JSON.stringify(conflict.body)).not.toContain('seq=1');
  });

  it('returns only fixed safe fields for an exact request replay and rejects a conflicting replay generically', async () => {
    const stored = {
      orgId: 'o1',
      claimId: 7,
      requestKey: '1:elicitation:8',
      kind: 'elicitation',
      payload: { prompt: 'Choose' },
      status: 'open',
      response: null,
      createdAt: new Date('2026-01-01T00:00:00Z'),
      resolvedAt: null,
    };
    upsertClaimRequest
      .mockResolvedValueOnce(stored)
      .mockResolvedValueOnce(stored)
      .mockRejectedValueOnce(new Error('Interaction conflict. request row detail'));
    const body = { session_id: 3, request: { requestKey: stored.requestKey, kind: stored.kind, payload: stored.payload } };
    const first = makeRes();
    const replay = makeRes();
    const conflict = makeRes();

    await handleClaimRequest(request(body), first);
    await handleClaimRequest(request(body), replay);
    await handleClaimRequest(request(body), conflict);

    const safeResponse = { ok: true, request: { request_key: stored.requestKey, kind: stored.kind, payload: stored.payload, status: 'open' } };
    expect(first.body).toEqual(safeResponse);
    expect(replay.body).toEqual(safeResponse);
    expect(first.body.request).not.toHaveProperty('orgId');
    expect(first.body.request).not.toHaveProperty('claimId');
    expect(first.body.request).not.toHaveProperty('response');
    expect(conflict.statusCode).toBe(409);
    expect(conflict.body).toEqual({ error: 'Interaction conflict' });
  });

  it('cancels an open request for the current claim owner and treats a terminal request as a conflict', async () => {
    cancelClaimRequest
      .mockResolvedValueOnce({ requestKey: '1:permission:4', status: 'cancelled' })
      .mockResolvedValueOnce(null);
    const accepted = makeRes();
    const conflict = makeRes();
    const req = request({ session_id: 3 }, { claimId: '7', requestKey: '1:permission:4' });

    await handleClaimRequestCancellation(req, accepted);
    await handleClaimRequestCancellation(req, conflict);

    expect(accepted.body).toEqual({ ok: true });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.body).toEqual({ error: 'Request cancellation conflict' });
  });

  it('renews a live command lease and declines one whose acknowledgement deadline elapsed', async () => {
    renewClaimCommand
      .mockResolvedValueOnce({ id: 11, status: 'delivered' })
      .mockResolvedValueOnce(null);
    const renewed = makeRes();
    const expired = makeRes();
    const req = request({ session_id: 3 }, { claimId: '7', commandId: '11' });

    await handleClaimCommandRenewal(req, renewed);
    await handleClaimCommandRenewal(req, expired);

    expect(renewed.body).toEqual({ renewed: true });
    expect(expired.body).toEqual({ renewed: false });
  });

  it('leases commands in a fixed wire shape and acknowledges a delivered command', async () => {
    leaseClaimCommands.mockResolvedValueOnce([
      { id: 11, orgId: 'o1', claimId: 7, idempotencyKey: 'secret-internal-key', requestKey: '1:permission:4', kind: 'permission', payload: { behavior: 'allow' }, status: 'delivered', result: null },
    ]);
    ackClaimCommand.mockResolvedValueOnce({ id: 11, status: 'acked' });
    const poll = makeRes();
    const ack = makeRes();

    await handleClaimCommandsPoll(request({ session_id: 3 }), poll);
    await handleClaimCommandAck(request({ session_id: 3, status: 'acked', result: { applied: true } }, { claimId: '7', commandId: '11' }), ack);

    expect(leaseClaimCommands).toHaveBeenCalledWith({ orgId: 'o1', claimId: 7, limit: 25 }, OWNER_CLIENT);
    expect(poll.body).toEqual({ commands: [{ id: 11, kind: 'permission', payload: { behavior: 'allow' }, request_key: '1:permission:4' }] });
    expect(ackClaimCommand).toHaveBeenCalledWith({ orgId: 'o1', claimId: 7, commandId: 11, status: 'acked', result: { applied: true } }, OWNER_CLIENT);
    expect(ack.body).toEqual({ ok: true });
  });

  it('does not redeliver a prompt whose previous lease became uncertain', async () => {
    leaseClaimCommands.mockResolvedValueOnce([]).mockResolvedValueOnce([]);

    const first = makeRes();
    const second = makeRes();
    await handleClaimCommandsPoll(request({ session_id: 3 }), first);
    await handleClaimCommandsPoll(request({ session_id: 3 }), second);

    expect(first.body).toEqual({ commands: [] });
    expect(second.body).toEqual({ commands: [] });
    expect(leaseClaimCommands).toHaveBeenCalledTimes(2);
  });

  it('maps a stale or conflicting acknowledgement to a generic 409', async () => {
    ackClaimCommand.mockResolvedValueOnce(null);
    const res = makeRes();

    await handleClaimCommandAck(request({ session_id: 3, status: 'acked', result: {} }, { claimId: '7', commandId: '11' }), res);

    expect(res.statusCode).toBe(409);
    expect(res.body).toEqual({ error: 'Command acknowledgement conflict' });
  });
});

describe('runner claim interaction validation and limits', () => {
  it.each([
    ['events', handleClaimEvents, request({ session_id: 3, events: [] }, { claimId: 'nope' })],
    ['request', handleClaimRequest, request({ session_id: 3, request: { requestKey: '', kind: 'permission', payload: {} } })],
    ['poll', handleClaimCommandsPoll, request({ session_id: 0 })],
    ['ack', handleClaimCommandAck, request({ session_id: 3, status: 'invalid', result: {} }, { claimId: '7', commandId: 'bad' })],
  ])('returns a generic 400 for malformed %s input', async (_label, handler, req) => {
    const res = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: 'Validation failed' });
    expect(res.body).not.toHaveProperty('details');
    expect(withClaimOwner).not.toHaveBeenCalled();
  });

  it('returns 413 before persistence for excessive event count', async () => {
    const events = Array.from({ length: 101 }, (_, index) => ({ seq: index + 1, kind: 'notice', payload: {} }));
    const res = makeRes();
    await handleClaimEvents(request({ session_id: 3, events }), res);
    expect(res.statusCode).toBe(413);
    expect(res.body).toEqual({ error: 'Payload too large' });
    expect(appendClaimEvents).not.toHaveBeenCalled();
  });

  it.each([
    ['event', handleClaimEvents, { session_id: 3, events: [{ seq: 1, kind: 'terminal_output', payload: { text: 'x'.repeat(256 * 1024 + 1) } }] }],
    ['request', handleClaimRequest, { session_id: 3, request: { requestKey: '1:elicitation:1', kind: 'elicitation', payload: { prompt: 'x'.repeat(256 * 1024 + 1) } } }],
    ['ack', handleClaimCommandAck, { session_id: 3, status: 'failed', result: { error: 'x'.repeat(64 * 1024 + 1) } }],
  ])('returns 413 for an oversized %s body without exposing validation details', async (_label, handler, body) => {
    const params = handler === handleClaimCommandAck ? { claimId: '7', commandId: '11' } : { claimId: '7' };
    const res = makeRes();
    await handler(request(body, params), res);
    expect(res.statusCode).toBe(413);
    expect(res.body).toEqual({ error: 'Payload too large' });
  });

  it('returns a generic server error without database details', async () => {
    appendClaimEvents.mockRejectedValueOnce(new Error('relation agent_claim_events does not exist at /srv/private/db.ts'));
    const res = makeRes();
    await handleClaimEvents(request({ session_id: 3, events: [EVENT] }), res);
    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({ error: 'Internal server error' });
    expect(JSON.stringify(res.body)).not.toContain('agent_claim_events');
  });
});
