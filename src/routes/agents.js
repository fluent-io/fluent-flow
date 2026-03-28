import { Router } from 'express';
import { createAgent, getAgent, listAgents, updateAgent, deleteAgent } from '../agents/agent-manager.js';
import { createToken, listTokens, revokeToken } from '../agents/token-manager.js';
import { getActiveSessions } from '../agents/session-manager.js';
import logger from '../logger.js';

const router = Router();

/**
 * Admin auth middleware.
 * Uses MCP_AUTH_TOKEN for now. Will be replaced by proper admin auth.
 */
function adminAuth(req, res, next) {
  const token = process.env.MCP_AUTH_TOKEN;
  if (!token) {
    req.adminOrg = 'self-hosted';
    return next();
  }
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ') || auth.slice(7) !== token) {
    return res.status(403).json({ error: 'Unauthorized' });
  }
  req.adminOrg = process.env.ORG_ID || 'self-hosted';
  next();
}

export async function handleCreateAgent(req, res) {
  const { id, agent_type, transport, transport_meta, repos } = req.body;
  const agent = await createAgent({ id, orgId: req.adminOrg, agentType: agent_type, transport, transportMeta: transport_meta, repos });
  res.status(201).json(agent);
}

export async function handleGetAgent(req, res) {
  const agent = await getAgent(req.adminOrg, req.params.id);
  if (!agent) return res.status(404).json({ error: 'Agent not found' });
  res.json(agent);
}

export async function handleListAgents(req, res) {
  const agents = await listAgents(req.adminOrg);
  res.json({ agents });
}

export async function handleUpdateAgent(req, res) {
  const { agent_type, transport, transport_meta, repos } = req.body;
  const agent = await updateAgent(req.adminOrg, req.params.id, {
    agentType: agent_type, transport, transportMeta: transport_meta, repos,
  });
  if (!agent) return res.status(404).json({ error: 'Agent not found' });
  res.json(agent);
}

export async function handleDeleteAgent(req, res) {
  const deleted = await deleteAgent(req.adminOrg, req.params.id);
  if (!deleted) return res.status(404).json({ error: 'Agent not found' });
  res.status(204).end();
}

export async function handleCreateToken(req, res) {
  const { label, expires_at } = req.body;
  const result = await createToken(req.adminOrg, req.params.id, label, expires_at);
  res.status(201).json({ token: result.plaintext, id: result.id });
}

export async function handleListTokens(req, res) {
  const tokens = await listTokens(req.adminOrg, req.params.id);
  res.json({ tokens });
}

export async function handleRevokeToken(req, res) {
  const revoked = await revokeToken(req.adminOrg, parseInt(req.params.tokenId, 10));
  if (!revoked) return res.status(404).json({ error: 'Token not found' });
  res.json({ ok: true });
}

export async function handleListSessions(req, res) {
  const sessions = await getActiveSessions(req.adminOrg, req.params.id);
  res.json({ sessions });
}

router.use('/agents', adminAuth);
router.post('/agents', handleCreateAgent);
router.get('/agents', handleListAgents);
router.get('/agents/:id', handleGetAgent);
router.patch('/agents/:id', handleUpdateAgent);
router.delete('/agents/:id', handleDeleteAgent);
router.post('/agents/:id/tokens', handleCreateToken);
router.get('/agents/:id/tokens', handleListTokens);
router.delete('/agents/:id/tokens/:tokenId', handleRevokeToken);
router.get('/agents/:id/sessions', handleListSessions);

export default router;
