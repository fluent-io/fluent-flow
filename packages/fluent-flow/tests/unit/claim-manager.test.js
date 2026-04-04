import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockQuery = vi.fn();
vi.mock('../../src/db/client.js', () => ({
  query: (...args) => mockQuery(...args),
  audit: vi.fn(),
}));

vi.mock('../../src/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const mockResolveSession = vi.fn();
const mockSetSessionStatus = vi.fn();
const mockFindAvailableSession = vi.fn();
vi.mock('../../src/agents/session-manager.js', () => ({
  resolveSession: (...args) => mockResolveSession(...args),
  setSessionStatus: (...args) => mockSetSessionStatus(...args),
  findAvailableSession: (...args) => mockFindAvailableSession(...args),
}));

const { createClaim, completeClaim, failClaim, expireClaims, getActiveClaim } = await import('../../src/agents/claim-manager.js');

describe('claim-manager', () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockResolveSession.mockReset();
    mockSetSessionStatus.mockReset();
    mockFindAvailableSession.mockReset();
  });

  describe('createClaim', () => {
    it('creates a claimed record when session is available', async () => {
      mockResolveSession.mockResolvedValueOnce(5);
      mockQuery.mockResolvedValueOnce({ rows: [{ id: 1, status: 'claimed', session_id: 5, org_id: 'acme' }] });
      mockSetSessionStatus.mockResolvedValueOnce();
      const result = await createClaim({
        orgId: 'acme', repo: 'owner/repo', prNumber: 7, attempt: 1,
        agentId: 'a1', payload: { message: 'fix it' },
      });
      expect(result.status).toBe('claimed');
      expect(result.session_id).toBe(5);
      expect(mockSetSessionStatus).toHaveBeenCalledWith('acme', 'a1', 5, 'busy');
    });

    it('creates a pending record when no session available', async () => {
      mockResolveSession.mockResolvedValueOnce(null);
      mockQuery.mockResolvedValueOnce({ rows: [{ id: 1, status: 'pending', session_id: null }] });
      const result = await createClaim({
        orgId: 'acme', repo: 'owner/repo', prNumber: 7, attempt: 1,
        agentId: 'a1', payload: {},
      });
      expect(result.status).toBe('pending');
      expect(mockSetSessionStatus).not.toHaveBeenCalled();
    });

    it('passes claim_type through to insert', async () => {
      mockResolveSession.mockResolvedValueOnce(null);
      mockQuery.mockResolvedValueOnce({ rows: [{ id: 1, status: 'pending', claim_type: 'issue_work' }] });
      await createClaim({
        orgId: 'acme', repo: 'owner/repo', prNumber: 7, attempt: 1,
        agentId: 'a1', payload: {}, claimType: 'issue_work',
      });
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('claim_type'),
        expect.arrayContaining(['issue_work'])
      );
    });
  });

  describe('createClaim without agentId', () => {
    it('uses findAvailableSession when agentId is not provided', async () => {
      mockFindAvailableSession.mockResolvedValueOnce({ agentId: 'runner1', sessionId: 3 });
      mockQuery.mockResolvedValueOnce({ rows: [{ id: 1, session_id: 3, status: 'claimed' }] });
      mockSetSessionStatus.mockResolvedValueOnce();
      const claim = await createClaim({
        orgId: 'acme', repo: 'owner/repo', prNumber: 1, attempt: 1, payload: {},
      });
      expect(mockFindAvailableSession).toHaveBeenCalledWith('acme', 'owner/repo', 1);
      expect(mockResolveSession).not.toHaveBeenCalled();
      expect(claim.session_id).toBe(3);
      expect(mockSetSessionStatus).toHaveBeenCalledWith('acme', 'runner1', 3, 'busy');
    });

    it('creates pending claim when no session available and no agentId', async () => {
      mockFindAvailableSession.mockResolvedValueOnce(null);
      mockQuery.mockResolvedValueOnce({ rows: [{ id: 1, session_id: null, status: 'pending' }] });
      const claim = await createClaim({
        orgId: 'acme', repo: 'owner/repo', prNumber: 1, attempt: 1, payload: {},
      });
      expect(claim.status).toBe('pending');
      expect(mockSetSessionStatus).not.toHaveBeenCalled();
    });

    it('uses resolveSession when agentId is provided', async () => {
      mockResolveSession.mockResolvedValueOnce(5);
      mockQuery.mockResolvedValueOnce({ rows: [{ id: 1, session_id: 5, status: 'claimed' }] });
      mockSetSessionStatus.mockResolvedValueOnce();
      await createClaim({
        orgId: 'acme', repo: 'owner/repo', prNumber: 1, attempt: 1, agentId: 'explicit', payload: {},
      });
      expect(mockResolveSession).toHaveBeenCalledWith('acme', 'explicit', 'owner/repo', 1);
      expect(mockFindAvailableSession).not.toHaveBeenCalled();
    });
  });

  describe('completeClaim', () => {
    it('marks claim completed and frees session atomically', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ id: 1, session_id: 5, session_agent_id: 'a1', status: 'completed', org_id: 'acme' }] });
      mockSetSessionStatus.mockResolvedValueOnce();
      const result = await completeClaim('acme', 'owner/repo', 7, 1);
      expect(result.status).toBe('completed');
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('SELECT agent_id FROM agent_sessions'),
        expect.anything()
      );
      expect(mockSetSessionStatus).toHaveBeenCalledWith('acme', 'a1', 5, 'online');
    });

    it('returns null if no active claim', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });
      expect(await completeClaim('acme', 'owner/repo', 7, 99)).toBeNull();
    });

    it('skips session update if no session_id', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ id: 1, session_id: null, session_agent_id: null, status: 'completed' }] });
      const result = await completeClaim('acme', 'owner/repo', 7, 1);
      expect(result.status).toBe('completed');
      expect(mockSetSessionStatus).not.toHaveBeenCalled();
    });
  });

  describe('failClaim', () => {
    it('marks claim failed and frees session atomically', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ id: 1, session_id: 5, session_agent_id: 'a1', status: 'failed', org_id: 'acme' }] });
      mockSetSessionStatus.mockResolvedValueOnce();
      await failClaim('acme', 'owner/repo', 7, 1);
      expect(mockSetSessionStatus).toHaveBeenCalledWith('acme', 'a1', 5, 'online');
    });
  });

  describe('expireClaims', () => {
    it('expires overdue claims and offlines sessions atomically', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [
        { id: 1, session_id: 5, session_agent_id: 'a1', org_id: 'acme' },
        { id: 2, session_id: 6, session_agent_id: 'a2', org_id: 'acme' },
      ]});
      mockSetSessionStatus.mockResolvedValue();
      const expired = await expireClaims();
      expect(expired).toHaveLength(2);
      expect(mockSetSessionStatus).toHaveBeenCalledWith('acme', 'a1', 5, 'offline');
      expect(mockSetSessionStatus).toHaveBeenCalledWith('acme', 'a2', 6, 'offline');
    });

    it('continues processing if freeSession throws for one claim', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [
        { id: 1, session_id: 5, session_agent_id: 'a1', org_id: 'acme' },
        { id: 2, session_id: 6, session_agent_id: 'a2', org_id: 'acme' },
      ]});
      mockSetSessionStatus.mockRejectedValueOnce(new Error('DB error'));
      mockSetSessionStatus.mockResolvedValueOnce();
      const expired = await expireClaims();
      expect(expired).toHaveLength(2);
      // Second session still freed despite first failing
      expect(mockSetSessionStatus).toHaveBeenCalledTimes(2);
    });
  });

  describe('getActiveClaim', () => {
    it('returns active claim for a PR', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ id: 1, status: 'claimed' }] });
      expect((await getActiveClaim('acme', 'owner/repo', 7)).status).toBe('claimed');
    });

    it('returns null if none', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });
      expect(await getActiveClaim('acme', 'owner/repo', 7)).toBeNull();
    });
  });
});
