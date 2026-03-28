import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockQuery = vi.fn();
vi.mock('../../src/db/client.js', () => ({
  query: (...args) => mockQuery(...args),
  audit: vi.fn(),
}));

vi.mock('../../src/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { createAgent, getAgent, listAgents, updateAgent, deleteAgent } = await import('../../src/agents/agent-manager.js');

describe('agent-manager', () => {
  beforeEach(() => { mockQuery.mockReset(); });

  describe('createAgent', () => {
    it('inserts and returns the agent', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ id: 'claude-1', org_id: 'acme', agent_type: 'claude-code', transport: 'long_poll', transport_meta: {}, repos: [] }] });
      const result = await createAgent({ id: 'claude-1', orgId: 'acme', agentType: 'claude-code', transport: 'long_poll' });
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO agents'),
        ['claude-1', 'acme', 'claude-code', 'long_poll', '{}', []]
      );
      expect(result.id).toBe('claude-1');
    });
  });

  describe('getAgent', () => {
    it('returns agent if found', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ id: 'claude-1', org_id: 'acme' }] });
      expect((await getAgent('acme', 'claude-1')).id).toBe('claude-1');
    });

    it('returns null if not found', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });
      expect(await getAgent('acme', 'missing')).toBeNull();
    });
  });

  describe('listAgents', () => {
    it('returns all agents for an org', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ id: 'a' }, { id: 'b' }] });
      expect(await listAgents('acme')).toHaveLength(2);
    });
  });

  describe('updateAgent', () => {
    it('updates specified fields and returns updated agent', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ id: 'claude-1', transport: 'webhook' }] });
      const result = await updateAgent('acme', 'claude-1', { transport: 'webhook' });
      expect(result.transport).toBe('webhook');
    });

    it('returns null if agent not found', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });
      expect(await updateAgent('acme', 'missing', { transport: 'webhook' })).toBeNull();
    });
  });

  describe('deleteAgent', () => {
    it('deletes and returns true', async () => {
      mockQuery.mockResolvedValueOnce({ rowCount: 1 });
      expect(await deleteAgent('acme', 'claude-1')).toBe(true);
    });

    it('returns false if not found', async () => {
      mockQuery.mockResolvedValueOnce({ rowCount: 0 });
      expect(await deleteAgent('acme', 'missing')).toBe(false);
    });
  });
});
