import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockCreateAgent = vi.fn();
const mockGetAgent = vi.fn();
const mockListAgents = vi.fn();
const mockUpdateAgent = vi.fn();
const mockDeleteAgent = vi.fn();
const mockCreateToken = vi.fn();
const mockListTokens = vi.fn();
const mockRevokeToken = vi.fn();

vi.mock('../../src/agents/agent-manager.js', () => ({
  createAgent: (...args) => mockCreateAgent(...args),
  getAgent: (...args) => mockGetAgent(...args),
  listAgents: (...args) => mockListAgents(...args),
  updateAgent: (...args) => mockUpdateAgent(...args),
  deleteAgent: (...args) => mockDeleteAgent(...args),
}));
vi.mock('../../src/agents/token-manager.js', () => ({
  createToken: (...args) => mockCreateToken(...args),
  listTokens: (...args) => mockListTokens(...args),
  revokeToken: (...args) => mockRevokeToken(...args),
  validateToken: vi.fn(),
}));
const mockRepoExists = vi.fn();
vi.mock('../../src/github/rest.js', () => ({
  repoExists: (...args) => mockRepoExists(...args),
}));
vi.mock('../../src/agents/session-manager.js', () => ({
  getActiveSessions: vi.fn().mockResolvedValue([]),
}));
vi.mock('../../src/db/client.js', () => ({
  query: vi.fn().mockResolvedValue({ rows: [] }),
  audit: vi.fn(),
}));
vi.mock('../../src/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { handleCreateAgent, handleGetAgent, handleListAgents, handleUpdateAgent, handleDeleteAgent, handleCreateToken } = await import('../../src/routes/agents.js');

const adminReq = (body = {}, params = {}) => ({ adminOrg: 'acme', body, params });
const fakeRes = () => ({ status: vi.fn().mockReturnThis(), json: vi.fn(), end: vi.fn() });

describe('agent routes', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  describe('handleCreateAgent', () => {
    it('creates an agent and returns 201', async () => {
      mockCreateAgent.mockResolvedValueOnce({ id: 'a1', org_id: 'acme' });
      const res = fakeRes();
      await handleCreateAgent(adminReq({ id: 'a1', agent_type: 'claude-code', transport: 'long_poll' }), res);
      expect(mockCreateAgent).toHaveBeenCalledWith(expect.objectContaining({ id: 'a1', orgId: 'acme' }));
      expect(res.status).toHaveBeenCalledWith(201);
    });
  });

  describe('handleGetAgent', () => {
    it('returns agent if found', async () => {
      mockGetAgent.mockResolvedValueOnce({ id: 'a1' });
      const res = fakeRes();
      await handleGetAgent(adminReq({}, { id: 'a1' }), res);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ id: 'a1' }));
    });

    it('returns 404 if not found', async () => {
      mockGetAgent.mockResolvedValueOnce(null);
      const res = fakeRes();
      await handleGetAgent(adminReq({}, { id: 'missing' }), res);
      expect(res.status).toHaveBeenCalledWith(404);
    });
  });

  describe('handleListAgents', () => {
    it('returns all agents for org', async () => {
      mockListAgents.mockResolvedValueOnce([{ id: 'a1' }, { id: 'a2' }]);
      const res = fakeRes();
      await handleListAgents(adminReq(), res);
      expect(res.json).toHaveBeenCalledWith({ agents: [{ id: 'a1' }, { id: 'a2' }] });
    });
  });

  describe('handleDeleteAgent', () => {
    it('returns 204 on success', async () => {
      mockDeleteAgent.mockResolvedValueOnce(true);
      const res = fakeRes();
      await handleDeleteAgent(adminReq({}, { id: 'a1' }), res);
      expect(res.status).toHaveBeenCalledWith(204);
    });
  });

  describe('handleCreateToken', () => {
    it('returns plaintext token on creation', async () => {
      mockCreateToken.mockResolvedValueOnce({ plaintext: 'ff_abc', id: 1 });
      const res = fakeRes();
      await handleCreateToken(adminReq({ label: 'laptop' }, { id: 'a1' }), res);
      expect(res.status).toHaveBeenCalledWith(201);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ token: 'ff_abc' }));
    });
  });

  describe('validation', () => {
    it('returns 400 on invalid create agent body', async () => {
      const res = fakeRes();
      await handleCreateAgent(adminReq({ id: 'a1', agent_type: 'invalid-type', transport: 'long_poll' }), res);
      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: 'Validation failed' }));
    });

    it('returns 400 on missing required fields', async () => {
      const res = fakeRes();
      await handleCreateAgent(adminReq({}), res);
      expect(res.status).toHaveBeenCalledWith(400);
    });

    it('returns 500 on DB error', async () => {
      mockGetAgent.mockRejectedValueOnce(new Error('connection refused'));
      const res = fakeRes();
      await handleGetAgent(adminReq({}, { id: 'a1' }), res);
      expect(res.status).toHaveBeenCalledWith(500);
    });
  });

  describe('repo validation', () => {
    it('returns 400 on invalid repo format', async () => {
      const res = fakeRes();
      await handleCreateAgent(adminReq({ id: 'a1', agent_type: 'claude-code', transport: 'long_poll', repos: ['not-a-repo'] }), res);
      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: expect.stringContaining('Invalid repo format') }));
    });

    it('returns 400 when repo does not exist on GitHub', async () => {
      mockRepoExists.mockResolvedValue(false);
      const res = fakeRes();
      await handleCreateAgent(adminReq({ id: 'a1', agent_type: 'claude-code', transport: 'long_poll', repos: ['owner/nonexistent'] }), res);
      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: expect.stringContaining('not found on GitHub') }));
    });

    it('creates agent when repos exist on GitHub', async () => {
      mockRepoExists.mockResolvedValue(true);
      mockCreateAgent.mockResolvedValueOnce({ id: 'a1', org_id: 'acme' });
      const res = fakeRes();
      await handleCreateAgent(adminReq({ id: 'a1', agent_type: 'claude-code', transport: 'long_poll', repos: ['fluent-io/fluent-flow'] }), res);
      expect(mockRepoExists).toHaveBeenCalledWith('fluent-io', 'fluent-flow');
      expect(res.status).toHaveBeenCalledWith(201);
    });

    it('creates agent when repos is omitted', async () => {
      mockCreateAgent.mockResolvedValueOnce({ id: 'a1', org_id: 'acme' });
      const res = fakeRes();
      await handleCreateAgent(adminReq({ id: 'a1', agent_type: 'claude-code', transport: 'long_poll' }), res);
      expect(mockRepoExists).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(201);
    });

    it('returns 400 on update with non-existent repo', async () => {
      mockRepoExists.mockResolvedValue(false);
      const res = fakeRes();
      await handleUpdateAgent(adminReq({ repos: ['owner/gone'] }, { id: 'a1' }), res);
      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: expect.stringContaining('not found on GitHub') }));
    });
  });

  describe('duplicate agent', () => {
    it('returns 409 when agent already exists', async () => {
      const err = new Error('duplicate key');
      err.code = '23505';
      mockCreateAgent.mockRejectedValueOnce(err);
      mockRepoExists.mockResolvedValue(true);
      const res = fakeRes();
      await handleCreateAgent(adminReq({ id: 'a1', agent_type: 'claude-code', transport: 'long_poll', repos: ['fluent-io/fluent-flow'] }), res);
      expect(res.status).toHaveBeenCalledWith(409);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: expect.stringContaining('already exists') }));
    });
  });
});
