import { hostname } from 'node:os';

/**
 * Auto-register an agent and generate a token using the MCP auth token.
 *
 * @param {object} opts
 * @param {string} opts.server — Fluent Flow server base URL
 * @param {string} opts.agentId — agent ID to register
 * @param {string} opts.mcpAuthToken — MCP_AUTH_TOKEN for admin API access
 * @param {string} [opts.agentType] — agent type (default: 'claude-code')
 * @param {Function} [opts.fetch] — fetch implementation (default: globalThis.fetch)
 * @returns {Promise<{ token: string }>}
 */
export async function bootstrap({ server, agentId, mcpAuthToken, agentType = 'claude-code', fetch: fetchFn = globalThis.fetch }) {
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
      agent_type: agentType,
      transport: 'long_poll',
    }),
  });

  if (!regRes.ok) {
    const text = await regRes.text().catch(() => '');
    throw new Error(`Agent registration failed: ${regRes.status}${text ? ` — ${text}` : ''}`);
  }

  // Step 2: Generate token
  const label = `auto-${hostname()}`;
  const tokRes = await fetchFn(`${base}/api/agents/${agentId}/tokens`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ label }),
  });

  if (!tokRes.ok) {
    const text = await tokRes.text().catch(() => '');
    throw new Error(`Token generation failed: ${tokRes.status}${text ? ` — ${text}` : ''}`);
  }

  const tokData = await tokRes.json();
  return { token: tokData.token };
}
