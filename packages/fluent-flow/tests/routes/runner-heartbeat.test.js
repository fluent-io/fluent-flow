import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/logger.js', async () => {
  const { createMockLogger } = await import('../helpers/mock-logger.js');
  return { default: createMockLogger() };
});

vi.mock('../../src/db/client.js', () => ({
  audit: vi.fn(),
}));

vi.mock('../../src/agents/session-manager.js', () => ({
  touchSession: vi.fn(),
  registerSession: vi.fn(),
  setSessionStatus: vi.fn(),
}));

vi.mock('../../src/agents/claim-manager.js', () => ({
  extendClaim: vi.fn(),
  completeClaim: vi.fn(),
  failClaim: vi.fn(),
  completeClaimById: vi.fn(),
  failClaimById: vi.fn(),
  getClaimById: vi.fn(),
  getClaimByAttempt: vi.fn(),
  createClaim: vi.fn(),
  redispatchClaim: vi.fn(),
  nextChainAttempt: vi.fn(),
  countCompletedFixIterations: vi.fn(),
  createClaimWithRetry: vi.fn(),
}));

import { touchSession } from '../../src/agents/session-manager.js';
import { extendClaim } from '../../src/agents/claim-manager.js';
import { audit } from '../../src/db/client.js';
import { handleHeartbeat } from '../../src/routes/runner.js';

function makeRes() {
  const res = {
    headersSent: false,
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; this.headersSent = true; return this; },
    json(payload) { this.body = payload; this.headersSent = true; return this; },
  };
  return res;
}

const REQ = (body) => ({
  body,
  tokenInfo: { org_id: 'o1', agent_id: 'a1' },
});

beforeEach(() => {
  vi.clearAllMocks();
  touchSession.mockResolvedValue(true);
  extendClaim.mockResolvedValue({ id: 7 });
});

describe('POST /api/runner/heartbeat (handleHeartbeat)', () => {
  it('touches the session and extends a matching claim, auditing only the extension', async () => {
    const res = makeRes();
    await handleHeartbeat(REQ({ session_id: 3, claim_id: 7 }), res);

    expect(touchSession).toHaveBeenCalledWith('o1', 'a1', 3);
    expect(extendClaim).toHaveBeenCalledWith(expect.objectContaining({ orgId: 'o1', claimId: 7, sessionId: 3 }));
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ ok: true, claim: { id: 7 } });
    expect(audit).toHaveBeenCalledWith('claim_heartbeat', expect.anything());
  });

  it('returns 410 with the poll-shaped error when the session cannot be touched', async () => {
    touchSession.mockResolvedValueOnce(false);
    const res = makeRes();
    await handleHeartbeat(REQ({ session_id: 3, claim_id: 7 }), res);

    expect(res.statusCode).toBe(410);
    expect(res.body).toEqual({ error: 'Session expired or offline — re-register' });
    expect(extendClaim).not.toHaveBeenCalled();
  });

  it('returns 200 with claim:null when the claim is gone or not owned — session still touched', async () => {
    extendClaim.mockResolvedValueOnce(null);
    const res = makeRes();
    await handleHeartbeat(REQ({ session_id: 3, claim_id: 404 }), res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ ok: true, claim: null });
    expect(touchSession).toHaveBeenCalledTimes(1);
    expect(audit).not.toHaveBeenCalled();
  });

  it('session-only heartbeat (no claim_id) returns ok without touching claims', async () => {
    const res = makeRes();
    await handleHeartbeat(REQ({ session_id: 3 }), res);

    expect(res.body).toEqual({ ok: true });
    expect(extendClaim).not.toHaveBeenCalled();
  });

  it('rejects invalid bodies with 400', async () => {
    const res = makeRes();
    await handleHeartbeat(REQ({ session_id: 'nope' }), res);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe('Validation failed');
  });
});
