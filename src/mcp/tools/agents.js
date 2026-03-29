import { z } from 'zod';
import { createAgent, listAgents, deleteAgent } from '../../agents/agent-manager.js';
import { audit } from '../../db/client.js';

/**
 * Register agent management tools on the MCP server.
 * @param {import('@modelcontextprotocol/sdk/server/mcp.js').McpServer} server
 */
export function registerAgentTools(server) {
  server.tool(
    'create_agent',
    'Create a new agent in the registry',
    {
      id: z.string().describe('Unique agent identifier'),
      org_id: z.string().default('self-hosted').describe('Organization ID'),
      agent_type: z.enum(['claude-code', 'codex', 'devin', 'openclaw', 'aider', 'custom']),
      transport: z.enum(['webhook', 'workflow_dispatch', 'long_poll', 'api']),
      transport_meta: z.record(z.any()).optional(),
      repos: z.array(z.string()).optional(),
    },
    async ({ id, org_id, agent_type, transport, transport_meta, repos }) => {
      audit('mcp_tool_call', { data: { tool: 'create_agent', agentId: id } });
      try {
        const agent = await createAgent({ id, orgId: org_id, agentType: agent_type, transport, transportMeta: transport_meta, repos });
        return { content: [{ type: 'text', text: JSON.stringify({ ok: true, agent }) }] };
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: errorMsg }) }], isError: true };
      }
    }
  );

  server.tool(
    'list_agents',
    'List all registered agents for the organization',
    { org_id: z.string().default('self-hosted').describe('Organization ID') },
    async ({ org_id }) => {
      audit('mcp_tool_call', { data: { tool: 'list_agents' } });
      try {
        const agents = await listAgents(org_id);
        return { content: [{ type: 'text', text: JSON.stringify({ agents }) }] };
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: errorMsg }) }], isError: true };
      }
    }
  );

  server.tool(
    'delete_agent',
    'Delete an agent from the registry',
    { id: z.string(), org_id: z.string().default('self-hosted') },
    async ({ id, org_id }) => {
      audit('mcp_tool_call', { data: { tool: 'delete_agent', agentId: id } });
      try {
        const deleted = await deleteAgent(org_id, id);
        return { content: [{ type: 'text', text: JSON.stringify({ ok: deleted === true }) }] };
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: errorMsg }) }], isError: true };
      }
    }
  );
}
