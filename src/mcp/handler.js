/**
 * Express handler for MCP Streamable HTTP transport (stateless).
 * Creates a fresh McpServer + transport per request.
 */
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createMcpServer } from './server.js';
import logger from '../logger.js';

/**
 * Handle POST /mcp — MCP JSON-RPC over Streamable HTTP.
 */
export async function mcpHandler(req, res) {
  try {
    const server = createMcpServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

    res.on('close', () => {
      transport.close().catch(() => {});
      server.close().catch(() => {});
    });

    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    logger.error({ msg: 'MCP handler error', error: err.message });
    if (!res.headersSent) {
      res.status(500).json({ error: 'MCP server error' });
    }
  }
}

/**
 * Handle GET/DELETE /mcp — method not allowed (stateless mode).
 */
export function mcpMethodNotAllowed(req, res) {
  res.status(405).json({ error: 'Method not allowed. Use POST for MCP requests.' });
}
