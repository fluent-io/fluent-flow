import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import yaml from 'js-yaml';
import { z } from 'zod';

const __dirname = dirname(fileURLToPath(import.meta.url));

const AgentTransportSchema = z.object({
  transport: z.enum(['webhook', 'workflow_dispatch']).default('webhook'),
  url: z.string().optional(),
  token_env: z.string().optional(),
  workflow: z.string().optional(),
  ref: z.string().optional(),
});

const AgentsRegistrySchema = z.object({
  agents: z.record(z.string(), AgentTransportSchema).default({}),
});

let agentsRegistry = null;

/**
 * Load and validate the agent registry from config/agents.yml.
 * @returns {z.infer<typeof AgentsRegistrySchema>}
 */
export function loadAgents() {
  if (agentsRegistry) return agentsRegistry;

  const agentsPath = join(__dirname, '../../config/agents.yml');
  const raw = readFileSync(agentsPath, 'utf8');
  const parsed = yaml.load(raw);
  agentsRegistry = AgentsRegistrySchema.parse(parsed);
  console.log({ msg: 'Loaded agent registry', count: Object.keys(agentsRegistry.agents).length });
  return agentsRegistry;
}

/**
 * Get the transport config for a registered agent.
 * @param {string} agentId
 * @returns {object|null}
 */
export function getAgentConfig(agentId) {
  if (!agentId) return null;
  const registry = loadAgents();
  return registry.agents[agentId] ?? null;
}

/**
 * Reset the cached registry (for testing).
 */
export function resetAgentsCache() {
  agentsRegistry = null;
}
