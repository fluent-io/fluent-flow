import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockValidateToken = vi.fn();
const mockRegisterSession = vi.fn();
const mockTouchSession = vi.fn();
const mockDequeue = vi.fn();
const mockHasPending = vi.fn();

vi.mock('../../src/agents/token-manager.js', () => ({
  validateToken: (...args) => mockValidateToken(...args),
}));
vi.mock('../../src/agents/session-manager.js', () => ({
  registerSession: (...args) => mockRegisterSession(...args),
  touchSession: (...args) => mockTouchSession(...args),
  setSessionStatus: vi.fn(),
}));
vi.mock('../../src/agents/claim-manager.js', () => ({
  completeClaim: vi.fn(),
  failClaim: vi.fn(),
}));
vi.mock('../../src/notifications/transports/long-poll.js', () => ({
  dequeue: (...args) => mockDequeue(...args),
  hasPending: (...args) => mockHasPending(...args),
}));
vi.mock('../../src/db/client.js', () => ({
  query: vi.fn().mockResolvedValue({ rows: [] }),
  audit: vi.fn(),
}));
vi.mock('../../src/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { authenticateRunner, handleRegister, handlePoll } = await import('../../src/routes/runner.js');

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
      mockTouchSession.mockResolvedValueOnce();
      const req = { tokenInfo: { org_id: 'acme', agent_id: 'a1' }, body: { session_id: 10 } };
      const res = { json: vi.fn() };
      await handlePoll(req, res, { pollTimeoutMs: 0 });
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ work: { claim_id: 1, message: 'fix it' } }));
    });

    it('returns empty if no work after timeout', async () => {
      mockHasPending.mockReturnValue(false);
      mockTouchSession.mockResolvedValue();
      const req = { tokenInfo: { org_id: 'acme', agent_id: 'a1' }, body: { session_id: 10 } };
      const res = { json: vi.fn() };
      await handlePoll(req, res, { pollTimeoutMs: 0 });
      expect(res.json).toHaveBeenCalledWith({ work: null });
    });
  });
});
