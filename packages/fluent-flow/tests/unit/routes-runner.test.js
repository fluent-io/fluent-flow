import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockValidateToken = vi.fn();
const mockRegisterSession = vi.fn();
const mockTouchSession = vi.fn();
const mockDequeue = vi.fn();
const mockHasPending = vi.fn();
const mockCompleteClaim = vi.fn();
const mockFailClaim = vi.fn();

vi.mock('../../src/agents/token-manager.js', () => ({
  validateToken: (...args) => mockValidateToken(...args),
}));
vi.mock('../../src/agents/session-manager.js', () => ({
  registerSession: (...args) => mockRegisterSession(...args),
  touchSession: (...args) => mockTouchSession(...args),
  setSessionStatus: vi.fn(),
}));
vi.mock('../../src/agents/claim-manager.js', () => ({
  completeClaim: (...args) => mockCompleteClaim(...args),
  failClaim: (...args) => mockFailClaim(...args),
}));
vi.mock('../../src/notifications/transports/long-poll.js', () => ({
  dequeue: (...args) => mockDequeue(...args),
  hasPending: (...args) => mockHasPending(...args),
}));
const mockQuery = vi.fn().mockResolvedValue({ rows: [] });
vi.mock('../../src/db/client.js', () => ({
  query: (...args) => mockQuery(...args),
  audit: vi.fn(),
}));
vi.mock('../../src/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { authenticateRunner, handleRegister, handlePoll, handleClaimResult } = await import('../../src/routes/runner.js');

describe('runner routes', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  describe('authenticateRunner', () => {
    it('returns 401 if no Authorization header', async () => {
      const req = { headers: {} };
      const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };
      const next = vi.fn();
      await authenticateRunner(req, res, next);
      expect(res.status).toHaveBeenCalledWith(401);
      expect(next).not.toHaveBeenCalled();
    });

    it('returns 403 if token is invalid', async () => {
      mockValidateToken.mockResolvedValueOnce(null);
      const req = { headers: { authorization: 'Bearer ff_' + 'a'.repeat(64) } };
      const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };
      const next = vi.fn();
      await authenticateRunner(req, res, next);
      expect(res.status).toHaveBeenCalledWith(403);
    });

    it('attaches tokenInfo to req and calls next on valid token', async () => {
      mockValidateToken.mockResolvedValueOnce({ id: 1, org_id: 'acme', agent_id: 'a1' });
      const req = { headers: { authorization: 'Bearer ff_' + 'a'.repeat(64) } };
      const res = {};
      const next = vi.fn();
      await authenticateRunner(req, res, next);
      expect(req.tokenInfo).toEqual({ id: 1, org_id: 'acme', agent_id: 'a1' });
      expect(next).toHaveBeenCalled();
    });

    it('returns 500 if validateToken throws', async () => {
      mockValidateToken.mockRejectedValueOnce(new Error('DB down'));
      const req = { headers: { authorization: 'Bearer ff_' + 'a'.repeat(64) } };
      const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };
      const next = vi.fn();
      await authenticateRunner(req, res, next);
      expect(res.status).toHaveBeenCalledWith(500);
      expect(next).not.toHaveBeenCalled();
    });
  });

  describe('handleRegister', () => {
    it('registers a session and returns session_id', async () => {
      mockRegisterSession.mockResolvedValueOnce({ id: 10, status: 'online' });
      const req = { tokenInfo: { org_id: 'acme', agent_id: 'a1' }, body: { meta: { hostname: 'dev' } } };
      const res = { json: vi.fn() };
      await handleRegister(req, res);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ session_id: 10 }));
    });
  });

  describe('handlePoll', () => {
    it('returns payload immediately if work is queued', async () => {
      mockHasPending.mockReturnValueOnce(true);
      mockDequeue.mockReturnValueOnce({ claim_id: 1, message: 'fix it' });
      mockTouchSession.mockResolvedValueOnce(true);
      const req = { tokenInfo: { org_id: 'acme', agent_id: 'a1' }, body: { session_id: 10 }, on: vi.fn() };
      const res = { json: vi.fn(), headersSent: false };
      await handlePoll(req, res, { pollTimeoutMs: 0 });
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ work: { claim_id: 1, message: 'fix it' } }));
    });

    it('picks up unassigned pending claim when long-poll queue is empty', async () => {
      mockHasPending.mockReturnValue(false);
      mockTouchSession.mockResolvedValue(true);
      mockQuery.mockResolvedValueOnce({
        rows: [{ id: 1, repo: 'owner/repo', pr_number: 5, attempt: 1, payload: '{"message":"fix"}' }],
      });
      const req = { tokenInfo: { org_id: 'acme', agent_id: 'a1' }, body: { session_id: 10 }, on: vi.fn() };
      const res = { json: vi.fn(), headersSent: false };
      await handlePoll(req, res, { pollTimeoutMs: 0 });
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('agent_claims'),
        expect.arrayContaining(['acme', 'a1', 10])
      );
      expect(res.json).toHaveBeenCalledWith({
        work: expect.objectContaining({ repo: 'owner/repo', pr_number: 5 }),
      });
    });

    it('returns empty if no work and no pending claims after timeout', async () => {
      mockHasPending.mockReturnValue(false);
      mockTouchSession.mockResolvedValue(true);
      mockQuery.mockResolvedValueOnce({ rows: [] });
      const req = { tokenInfo: { org_id: 'acme', agent_id: 'a1' }, body: { session_id: 10 }, on: vi.fn() };
      const res = { json: vi.fn(), headersSent: false };
      await handlePoll(req, res, { pollTimeoutMs: 0 });
      expect(res.json).toHaveBeenCalledWith({ work: null });
    });

    it('returns 400 if session_id is missing', async () => {
      const req = { tokenInfo: { org_id: 'acme', agent_id: 'a1' }, body: {}, on: vi.fn() };
      const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };
      await handlePoll(req, res, { pollTimeoutMs: 0 });
      expect(res.status).toHaveBeenCalledWith(400);
    });

    it('passes org_id and agent_id to touchSession', async () => {
      mockHasPending.mockReturnValue(false);
      mockTouchSession.mockResolvedValue(true);
      const req = { tokenInfo: { org_id: 'acme', agent_id: 'a1' }, body: { session_id: 10 }, on: vi.fn() };
      const res = { json: vi.fn(), headersSent: false };
      await handlePoll(req, res, { pollTimeoutMs: 0 });
      expect(mockTouchSession).toHaveBeenCalledWith('acme', 'a1', 10);
    });
  });

  describe('handleClaimResult', () => {
    it('completes a claim on status completed', async () => {
      mockCompleteClaim.mockResolvedValueOnce({ id: 1, status: 'completed' });
      const req = { tokenInfo: { org_id: 'acme' }, body: { status: 'completed', repo: 'o/r', pr_number: 7, attempt: 1 } };
      const res = { json: vi.fn() };
      await handleClaimResult(req, res);
      expect(mockCompleteClaim).toHaveBeenCalledWith('acme', 'o/r', 7, 1);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ ok: true }));
    });

    it('fails a claim on status failed', async () => {
      mockFailClaim.mockResolvedValueOnce({ id: 1, status: 'failed' });
      const req = { tokenInfo: { org_id: 'acme' }, body: { status: 'failed', repo: 'o/r', pr_number: 7, attempt: 1 } };
      const res = { json: vi.fn() };
      await handleClaimResult(req, res);
      expect(mockFailClaim).toHaveBeenCalledWith('acme', 'o/r', 7, 1);
    });

    it('returns 404 if claim not found', async () => {
      mockCompleteClaim.mockResolvedValueOnce(null);
      const req = { tokenInfo: { org_id: 'acme' }, body: { status: 'completed', repo: 'o/r', pr_number: 7, attempt: 1 } };
      const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };
      await handleClaimResult(req, res);
      expect(res.status).toHaveBeenCalledWith(404);
    });

    it('returns 400 on invalid body', async () => {
      const req = { tokenInfo: { org_id: 'acme' }, body: { status: 'invalid' } };
      const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };
      await handleClaimResult(req, res);
      expect(res.status).toHaveBeenCalledWith(400);
    });
  });
});
