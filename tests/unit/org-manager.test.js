import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockQuery = vi.fn();
vi.mock('../../src/db/client.js', () => ({
  query: (...args) => mockQuery(...args),
  audit: vi.fn(),
}));

vi.mock('../../src/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { createOrg, getOrg, bootstrapSelfHosted } = await import('../../src/agents/org-manager.js');

describe('org-manager', () => {
  beforeEach(() => { mockQuery.mockReset(); });

  describe('createOrg', () => {
    it('inserts an org and returns it', async () => {
      const org = { id: 'acme', name: 'Acme Corp' };
      mockQuery.mockResolvedValueOnce({ rows: [{ ...org, settings: {}, created_at: '2026-03-28T00:00:00Z' }] });
      const result = await createOrg(org.id, org.name);
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO orgs'),
        ['acme', 'Acme Corp', '{}']
      );
      expect(result.id).toBe('acme');
    });

    it('throws on duplicate org', async () => {
      mockQuery.mockRejectedValueOnce(new Error('duplicate key'));
      await expect(createOrg('acme', 'Acme')).rejects.toThrow('duplicate key');
    });
  });

  describe('getOrg', () => {
    it('returns the org if found', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ id: 'acme', name: 'Acme Corp' }] });
      const result = await getOrg('acme');
      expect(result.id).toBe('acme');
    });

    it('returns null if not found', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });
      const result = await getOrg('missing');
      expect(result).toBeNull();
    });
  });

  describe('bootstrapSelfHosted', () => {
    it('creates default org if none exists', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] }); // getOrg returns nothing
      mockQuery.mockResolvedValueOnce({ rows: [{ id: 'self-hosted', name: 'Self-Hosted' }] }); // createOrg
      const result = await bootstrapSelfHosted();
      expect(result.id).toBe('self-hosted');
      expect(mockQuery).toHaveBeenCalledTimes(2);
    });

    it('skips creation if org already exists', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ id: 'self-hosted', name: 'Self-Hosted' }] });
      const result = await bootstrapSelfHosted();
      expect(result.id).toBe('self-hosted');
      expect(mockQuery).toHaveBeenCalledTimes(1);
    });
  });
});
