import { getAgentCredentials, setAgentCredentials } from './credentials.js';
import { bootstrap } from './bootstrap.js';

/**
 * Normalize a server URL for consistent comparison and storage.
 * Strips trailing slashes so "https://host" and "https://host/" match.
 * @param {string} url
 * @returns {string}
 */
function normalizeServer(url) {
  return url.replace(/\/+$/, '');
}

/**
 * Resolve the agent token using the startup flow:
 * 1. If --token provided → use directly (backward compat)
 * 2. If no --token:
 *    a. Look up credentials file for the agent
 *    b. If found and server matches → use saved token
 *    c. If not found or server mismatch → bootstrap using MCP_AUTH_TOKEN
 *
 * @param {object} opts — parsed CLI options
 * @param {object} log — logger instance
 * @returns {Promise<string>} resolved token
 */
export async function resolveToken(opts, log) {
  // Case 1: explicit token — backward compat
  if (opts.token) return opts.token;

  const agentId = opts.agent;
  const server = normalizeServer(opts.server);

  // Case 2a: look up saved credentials
  const saved = getAgentCredentials(agentId);
  if (saved) {
    const savedServer = normalizeServer(saved.server);
    if (savedServer === server) {
      log.info('Using saved credentials', { agent: agentId });
      return saved.token;
    }
    log.info('Server mismatch for agent, re-authenticating', { agent: agentId });
  }

  // Case 2c: bootstrap with MCP_AUTH_TOKEN
  const mcpAuthToken = opts.mcpAuthToken || process.env.MCP_AUTH_TOKEN;
  if (!mcpAuthToken || mcpAuthToken.length < 8) {
    throw new Error('No saved credentials. Provide --mcp-auth-token or set MCP_AUTH_TOKEN env var to bootstrap.');
  }

  log.info('Bootstrapping agent', { agent: agentId });
  try {
    const { token } = await bootstrap({
      server,
      agentId,
      mcpAuthToken,
    });

    setAgentCredentials(agentId, { token, server });
    log.info('Credentials saved', { agent: agentId });

    return token;
  } catch (err) {
    const safeMsg = String(err.message || 'Unknown error')
      .replace(/https?:\/\/[^\s"']+/g, '[REDACTED]')
      .replace(/Bearer\s+\S+/gi, '[REDACTED]')
      .replace(/(?:ff_|mcp)[a-zA-Z0-9_-]{16,}/g, '[REDACTED]');
    throw new Error(`Bootstrap failed for agent "${agentId}": ${safeMsg}`);
  }
}
