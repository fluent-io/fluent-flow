import { Router } from 'express';
import { z } from 'zod';
import { createAgent, getAgent, listAgents, updateAgent, deleteAgent } from '../agents/agent-manager.js';
import { createToken, listTokens, revokeToken } from '../agents/token-manager.js';
import { getActiveSessions } from '../agents/session-manager.js';
import logger from '../logger.js';

const router = Router();

// --- Zod schemas ---

const CreateAgentSchema = z.object({
  id: z.string().min(1),
  agent_type: z.enum(['claude-code', 'codex', 'devin', 'openclaw', 'aider', 'custom']),
  transport: z.enum(['webhook', 'workflow_dispatch', 'long_poll', 'api']),
  transport_meta: z.record(z.any()).optional(),
  repos: z.array(z.string()).optional(),
});

const UpdateAgentSchema = z.object({
  agent_type: z.enum(['claude-code', 'codex', 'devin', 'openclaw', 'aider', 'custom']).optional(),
  transport: z.enum(['webhook', 'workflow_dispatch', 'long_poll', 'api']).optional(),
  transport_meta: z.record(z.any()).optional(),
  repos: z.array(z.string()).optional(),
}).refine(
  (data) => Object.values(data).some((v) => v !== undefined),
  { message: 'At least one field must be provided for update' },
);

const CreateTokenSchema = z.object({
  label: z.string().optional(),
  expires_at: z.string().datetime().optional(),
});

// --- Auth middleware ---

let adminAuthWarningLogged = false;

/**
 * Admin auth middleware.
 * Uses MCP_AUTH_TOKEN for now. Will be replaced by proper admin auth.
 */
function adminAuth(req, res, next) {
  const token = process.env.MCP_AUTH_TOKEN;
  if (!token) {
    if (process.env.NODE_ENV === 'production') {
      logger.error({ msg: 'Admin API accessed without MCP_AUTH_TOKEN in production' });
      return res.status(500).json({ error: 'Admin API misconfigured: MCP_AUTH_TOKEN is not set' });
    }
    if (!adminAuthWarningLogged) {
      logger.warn({ msg: 'Admin API running without MCP_AUTH_TOKEN — unauthenticated access enabled (non-production only)' });
      adminAuthWarningLogged = true;
    }
    req.adminOrg = 'self-hosted';
    return next();
  }
  const auth = req.headers.authorization;
  if (!auth) {
    return res.status(401).json({ error: 'Missing Authorization header' });
  }
  if (!auth.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Invalid Authorization header: expected Bearer scheme' });
  }
  if (auth.slice(7) !== token) {
    return res.status(403).json({ error: 'Invalid admin authorization token' });
  }
  req.adminOrg = 'self-hosted';
  next();
}

// --- Handlers ---

export async function handleCreateAgent(req, res) {
  const parsed = CreateAgentSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Validation failed', details: parsed.error.flatten() });
  try {
    const agent = await createAgent({
      id: parsed.data.id, orgId: req.adminOrg, agentType: parsed.data.agent_type,
      transport: parsed.data.transport, transportMeta: parsed.data.transport_meta, repos: parsed.data.repos,
    });
    res.status(201).json(agent);
  } catch (err) {
    logger.error({ msg: 'Failed to create agent', error: err.message });
    res.status(500).json({ error: 'Internal server error' });
  }
}

export async function handleGetAgent(req, res) {
  try {
    const agent = await getAgent(req.adminOrg, req.params.id);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });
    res.json(agent);
  } catch (err) {
    logger.error({ msg: 'Failed to get agent', error: err.message });
    res.status(500).json({ error: 'Internal server error' });
  }
}

export async function handleListAgents(req, res) {
  try {
    const agents = await listAgents(req.adminOrg);
    res.json({ agents });
  } catch (err) {
    logger.error({ msg: 'Failed to list agents', error: err.message });
    res.status(500).json({ error: 'Internal server error' });
  }
}

export async function handleUpdateAgent(req, res) {
  const parsed = UpdateAgentSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Validation failed', details: parsed.error.flatten() });
  try {
    const agent = await updateAgent(req.adminOrg, req.params.id, {
      agentType: parsed.data.agent_type, transport: parsed.data.transport,
      transportMeta: parsed.data.transport_meta, repos: parsed.data.repos,
    });
    if (!agent) return res.status(404).json({ error: 'Agent not found' });
    res.json(agent);
  } catch (err) {
    logger.error({ msg: 'Failed to update agent', error: err.message });
    res.status(500).json({ error: 'Internal server error' });
  }
}

export async function handleDeleteAgent(req, res) {
  try {
    const deleted = await deleteAgent(req.adminOrg, req.params.id);
    if (!deleted) return res.status(404).json({ error: 'Agent not found' });
    res.status(204).end();
  } catch (err) {
    logger.error({ msg: 'Failed to delete agent', error: err.message });
    res.status(500).json({ error: 'Internal server error' });
  }
}

export async function handleCreateToken(req, res) {
  const parsed = CreateTokenSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Validation failed', details: parsed.error.flatten() });
  try {
    const expiresAt = parsed.data.expires_at ? new Date(parsed.data.expires_at) : null;
    const result = await createToken(req.adminOrg, req.params.id, parsed.data.label, expiresAt);
    res.status(201).json({ token: result.plaintext, id: result.id });
  } catch (err) {
    logger.error({ msg: 'Failed to create token', error: err.message });
    res.status(500).json({ error: 'Internal server error' });
  }
}

export async function handleListTokens(req, res) {
  try {
    const tokens = await listTokens(req.adminOrg, req.params.id);
    res.json({ tokens });
  } catch (err) {
    logger.error({ msg: 'Failed to list tokens', error: err.message });
    res.status(500).json({ error: 'Internal server error' });
  }
}

export async function handleRevokeToken(req, res) {
  try {
    const tokenId = parseInt(req.params.tokenId, 10);
    if (Number.isNaN(tokenId)) return res.status(400).json({ error: 'Invalid token ID' });
    const revoked = await revokeToken(req.adminOrg, tokenId);
    if (!revoked) return res.status(404).json({ error: 'Token not found' });
    res.json({ ok: true });
  } catch (err) {
    logger.error({ msg: 'Failed to revoke token', error: err.message });
    res.status(500).json({ error: 'Internal server error' });
  }
}

export async function handleListSessions(req, res) {
  try {
    const sessions = await getActiveSessions(req.adminOrg, req.params.id);
    res.json({ sessions });
  } catch (err) {
    logger.error({ msg: 'Failed to list sessions', error: err.message });
    res.status(500).json({ error: 'Internal server error' });
  }
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
