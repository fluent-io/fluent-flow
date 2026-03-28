import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockQuery = vi.fn();
vi.mock('../../src/db/client.js', () => ({
  query: (...args) => mockQuery(...args),
  audit: vi.fn(),
}));

vi.mock('../../src/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { createToken, validateToken, revokeToken, listTokens, hashToken } = await import('../../src/agents/token-manager.js');

describe('token-manager', () => {
  beforeEach(() => { mockQuery.mockReset(); });

  describe('hashToken', () => {
    it('produces a consistent sha256 hash', () => {
      const hash1 = hashToken('test-token');
      const hash2 = hashToken('test-token');
      expect(hash1).toBe(hash2);
      expect(hash1).toHaveLength(64);
    });

    it('produces different hashes for different tokens', () => {
      expect(hashToken('a')).not.toBe(hashToken('b'));
    });
  });

  describe('createToken', () => {
    it('returns plaintext token with ff_ prefix and inserts hashed version', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ id: 1, org_id: 'acme', agent_id: 'a1', label: 'laptop' }] });
      const result = await createToken('acme', 'a1', 'laptop');
      expect(result.plaintext).toBeDefined();
      expect(result.plaintext.startsWith('ff_')).toBe(true);
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO agent_tokens'),
        expect.arrayContaining(['acme', 'a1'])
      );
    });
  });

  describe('validateToken', () => {
    it('returns org_id and agent_id for valid token', async () => {
      const validToken = 'ff_' + 'a'.repeat(64);
      const hash = hashToken(validToken);
      mockQuery.mockResolvedValueOnce({ rows: [{ id: 1, org_id: 'acme', agent_id: 'a1' }] });
      const result = await validateToken(validToken);
      expect(result).toEqual({ id: 1, org_id: 'acme', agent_id: 'a1' });
      expect(mockQuery).toHaveBeenCalledWith(expect.stringContaining('SELECT'), [hash]);
    });

    it('returns null for invalid token', async () => {
      expect(await validateToken('ff_bad')).toBeNull();
      expect(mockQuery).not.toHaveBeenCalled();
    });

    it('returns null for token without ff_ prefix', async () => {
      expect(await validateToken('xx_' + 'a'.repeat(64))).toBeNull();
      expect(mockQuery).not.toHaveBeenCalled();
    });
  });

  describe('revokeToken', () => {
    it('soft-revokes a token', async () => {
      mockQuery.mockResolvedValueOnce({ rowCount: 1 });
      expect(await revokeToken('acme', 1)).toBe(true);
    });
  });

  describe('listTokens', () => {
    it('returns tokens without hash column', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [
        { id: 1, org_id: 'acme', agent_id: 'a1', label: 'laptop', created_at: '2026-03-28', expires_at: null, revoked_at: null }
      ]});
      const result = await listTokens('acme', 'a1');
      expect(result[0].token_hash).toBeUndefined();
      expect(result[0].id).toBe(1);
    });
  });
});
