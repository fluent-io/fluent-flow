import { homedir } from 'node:os';
import { join } from 'node:path';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const EMPTY = { agents: {}, default_agent: null };

function credPath() {
  return join(homedir(), '.fluent-flow', 'credentials.json');
}

/**
 * Load credentials from ~/.fluent-flow/credentials.json.
 * Returns parsed object or empty default if file missing/invalid.
 * @returns {{ agents: Record<string, { token: string, server: string }>, default_agent: string|null }}
 */
export function loadCredentials() {
  try {
    const raw = readFileSync(credPath(), 'utf-8');
    return JSON.parse(raw);
  } catch {
    return { ...EMPTY, agents: {} };
  }
}

/**
 * Save credentials to ~/.fluent-flow/credentials.json.
 * Creates directory if needed.
 * @param {object} data
 */
export function saveCredentials(data) {
  const dir = join(homedir(), '.fluent-flow');
  mkdirSync(dir, { recursive: true });
  writeFileSync(credPath(), JSON.stringify(data, null, 2), 'utf-8');
}

/**
 * Get credentials for a specific agent.
 * @param {string} agentId
 * @returns {{ token: string, server: string }|null}
 */
export function getAgentCredentials(agentId) {
  const data = loadCredentials();
  return data.agents[agentId] ?? null;
}

/**
 * Save credentials for a specific agent.
 * Sets as default_agent if no default exists.
 * @param {string} agentId
 * @param {{ token: string, server: string }} creds
 */
export function setAgentCredentials(agentId, creds) {
  const data = loadCredentials();
  data.agents[agentId] = creds;
  if (!data.default_agent) {
    data.default_agent = agentId;
  }
  saveCredentials(data);
}
