/**
 * MCP server factory — creates a McpServer with all tools registered.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerQueryTools } from './tools/queries.js';
import { registerPendingTool } from './tools/pending.js';
import { registerCommandTools } from './tools/commands.js';
import { registerAgentTools } from './tools/agents.js';

/**
 * Create a new McpServer instance with all Fluent Flow tools registered.
 * @returns {McpServer}
 */
export function createMcpServer() {
  const server = new McpServer({
    name: 'fluent-flow',
    version: '1.0.0',
  });

  registerQueryTools(server);
  registerPendingTool(server);
  registerCommandTools(server);
  registerAgentTools(server);

  return server;
}
