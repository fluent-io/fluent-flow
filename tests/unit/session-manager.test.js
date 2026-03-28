import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockQuery = vi.fn();
vi.mock('../../src/db/client.js', () => ({
  query: (...args) => mockQuery(...args),
  audit: vi.fn(),
}));

vi.mock('../../src/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { registerSession, touchSession, expireSessions, getActiveSessions, resolveSession, setSessionStatus } = await import('../../src/agents/session-manager.js');

describe('session-manager', () => {
  beforeEach(() => { mockQuery.mockReset(); });

  describe('registerSession', () => {
    it('inserts a session with TTL and returns it', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ id: 1, org_id: 'acme', agent_id: 'a1', status: 'online' }] });
      const result = await registerSession('acme', 'a1', { hostname: 'dev-laptop' });
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO agent_sessions'),
        expect.arrayContaining(['acme', 'a1'])
      );
      expect(result.status).toBe('online');
    });
  });

  describe('touchSession', () => {
    it('updates last_seen_at and extends expires_at scoped by org and agent', async () => {
      mockQuery.mockResolvedValueOnce({ rowCount: 1 });
      await touchSession('acme', 'a1', 1);
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE agent_sessions'),
        expect.arrayContaining(['acme', 'a1', 1])
      );
    });
  });

  describe('expireSessions', () => {
    it('marks expired sessions as offline', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ id: 1 }, { id: 2 }] });
      const expired = await expireSessions();
      expect(expired).toHaveLength(2);
    });
  });

  describe('getActiveSessions', () => {
    it('returns online sessions for an agent', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ id: 1 }, { id: 2 }] });
      const result = await getActiveSessions('acme', 'a1');
      expect(result).toHaveLength(2);
    });
  });

  describe('resolveSession', () => {
    it('prefers previous session for same PR if still online', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ session_id: 5 }] });
      mockQuery.mockResolvedValueOnce({ rows: [{ id: 5 }] });
      const result = await resolveSession('acme', 'a1', 'owner/repo', 7);
      expect(result).toBe(5);
    });

    it('falls back to first available if no previous session', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });
      mockQuery.mockResolvedValueOnce({ rows: [{ id: 3 }] });
      const result = await resolveSession('acme', 'a1', 'owner/repo', 7);
      expect(result).toBe(3);
    });

    it('returns null if no sessions available', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });
      mockQuery.mockResolvedValueOnce({ rows: [] });
      const result = await resolveSession('acme', 'a1', 'owner/repo', 7);
      expect(result).toBeNull();
    });
  });

  describe('setSessionStatus', () => {
    it('updates session status scoped by org and agent', async () => {
      mockQuery.mockResolvedValueOnce({ rowCount: 1 });
      await setSessionStatus('acme', 'a1', 1, 'busy');
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE agent_sessions SET status'),
        ['acme', 'a1', 1, 'busy']
      );
    });
  });

  describe('resolveSession', () => {
    it('handles missing agent_claims table gracefully', async () => {
      const err = new Error('relation "agent_claims" does not exist');
      err.code = '42P01';
      mockQuery.mockRejectedValueOnce(err); // agent_claims query fails
      mockQuery.mockResolvedValueOnce({ rows: [{ id: 3 }] }); // first available
      const result = await resolveSession('acme', 'a1', 'owner/repo', 7);
      expect(result).toBe(3);
    });
  });
});
