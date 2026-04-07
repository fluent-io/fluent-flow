import { hostname } from 'node:os';

/**
 * Auto-register an agent and generate a token using the MCP auth token.
 *
 * @param {object} opts
 * @param {string} opts.server — Fluent Flow server base URL
 * @param {string} opts.agentId — agent ID to register
 * @param {string} opts.mcpAuthToken — MCP_AUTH_TOKEN for admin API access
 * @param {string} [opts.agentType] — agent type (default: env FLUENT_FLOW_AGENT_TYPE or 'claude-code')
 * @param {Function} [opts.fetch] — fetch implementation (default: globalThis.fetch)
 * @returns {Promise<{ token: string }>}
 */
export async function bootstrap({ server, agentId, mcpAuthToken, agentType, fetch: fetchFn = globalThis.fetch }) {
  if (!mcpAuthToken || typeof mcpAuthToken !== 'string') {
    throw new Error('MCP_AUTH_TOKEN is required');
  }
  if (mcpAuthToken.length < 8) {
    throw new Error('MCP_AUTH_TOKEN must be at least 8 characters');
  }

  const resolvedAgentType = agentType || process.env.FLUENT_FLOW_AGENT_TYPE || 'claude-code';
  const base = server.replace(/\/+$/, '');
  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${mcpAuthToken}`,
  };

  // Step 1: Register agent (idempotent — returns existing if already registered)
  const regRes = await fetchFn(`${base}/api/agents`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      id: agentId,
      agent_type: resolvedAgentType,
      transport: 'long_poll',
    }),
  });

  if (!regRes.ok) {
    await regRes.text().catch(() => {});
    if (regRes.status !== 409) {
      throw new Error(`Agent registration failed: ${regRes.status}`);
    }
  }

  // Step 2: Generate token
  const label = `auto-${hostname()}-${Date.now().toString(36)}`;
  const tokRes = await fetchFn(`${base}/api/agents/${encodeURIComponent(agentId)}/tokens`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ label }),
  });

  if (!tokRes.ok) {
    await tokRes.text().catch(() => {});
    throw new Error(`Token generation failed: ${tokRes.status}`);
  }

  const tokData = await tokRes.json();
  return { token: tokData.token };
}
