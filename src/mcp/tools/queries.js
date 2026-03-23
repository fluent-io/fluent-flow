/**
 * MCP read-only query tools. Each wraps an existing engine function.
 */
import { z } from 'zod';
import { getCurrentState, getTransitionHistory } from '../../engine/state-machine.js';
import { getRetryRecord } from '../../engine/review-manager.js';
import { getActivePause } from '../../engine/pause-manager.js';
import { resolveConfig } from '../../config/loader.js';
import { audit } from '../../db/client.js';

/**
 * Register all query tools on the MCP server.
 * @param {import('@modelcontextprotocol/sdk/server/mcp.js').McpServer} server
 */
export function registerQueryTools(server) {
  server.tool(
    'get_current_state',
    'Get the current workflow state of an issue',
    { repo: z.string().describe('"owner/repo" format'), issue_number: z.number().int(), agent_id: z.string() },
    async ({ repo, issue_number, agent_id }) => {
      audit('mcp_tool_call', { actor: agent_id, data: { tool: 'get_current_state', repo, issue_number } });
      const state = await getCurrentState(repo, issue_number);
      return { content: [{ type: 'text', text: JSON.stringify({ state, repo, issue_number }) }] };
    }
  );

  server.tool(
    'get_transition_history',
    'Get the full state transition history for an issue',
    { repo: z.string(), issue_number: z.number().int(), agent_id: z.string() },
    async ({ repo, issue_number, agent_id }) => {
      audit('mcp_tool_call', { actor: agent_id, data: { tool: 'get_transition_history', repo, issue_number } });
      const transitions = await getTransitionHistory(repo, issue_number);
      return { content: [{ type: 'text', text: JSON.stringify({ transitions }) }] };
    }
  );

  server.tool(
    'get_retry_record',
    'Get the review retry record for a pull request',
    { repo: z.string(), pr_number: z.number().int(), agent_id: z.string() },
    async ({ repo, pr_number, agent_id }) => {
      audit('mcp_tool_call', { actor: agent_id, data: { tool: 'get_retry_record', repo, pr_number } });
      const record = await getRetryRecord(repo, pr_number);
      return { content: [{ type: 'text', text: JSON.stringify({ record }) }] };
    }
  );

  server.tool(
    'get_active_pause',
    'Get the active (unresolved) pause for an issue, if any',
    { repo: z.string(), issue_number: z.number().int(), agent_id: z.string() },
    async ({ repo, issue_number, agent_id }) => {
      audit('mcp_tool_call', { actor: agent_id, data: { tool: 'get_active_pause', repo, issue_number } });
      const pause = await getActivePause(repo, issue_number);
      return { content: [{ type: 'text', text: JSON.stringify({ pause }) }] };
    }
  );

  server.tool(
    'get_config',
    'Get the resolved Fluent Flow configuration for a repository',
    { owner: z.string(), repo: z.string(), agent_id: z.string() },
    async ({ owner, repo, agent_id }) => {
      audit('mcp_tool_call', { actor: agent_id, data: { tool: 'get_config', owner, repo } });
      const config = await resolveConfig(owner, repo);
      return { content: [{ type: 'text', text: JSON.stringify({ config }) }] };
    }
  );
}
