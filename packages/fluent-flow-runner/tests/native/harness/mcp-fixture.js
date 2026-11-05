
import http from 'node:http';

export const MCP_TOOL = 'ff_probe_report';

export async function startMcpFixture({ token }) {
  /** @type {{ method: string, authorization: string|undefined, params: any }[]} */
  const calls = [];
  const server = http.createServer(async (req, res) => {
    if (req.method !== 'POST') {
      res.writeHead(405).end();
      return;
    }
    let body = '';
    for await (const chunk of req) body += chunk;
    let msg;
    try {
      msg = JSON.parse(body);
    } catch {
      res.writeHead(400).end();
      return;
    }
    const authorization = req.headers.authorization;
    calls.push({ method: msg.method, authorization, params: msg.params });
    if (authorization !== `Bearer ${token}`) {
      res.writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }
    if (msg.id === undefined) {
      res.writeHead(202).end();
      return;
    }
    const reply = (result) => {
      res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'ff-probe-session' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }));
    };
    switch (msg.method) {
      case 'initialize':
        return reply({
          protocolVersion: msg.params?.protocolVersion ?? '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: 'ff-probe-mcp', version: '0.0.0' },
        });
      case 'tools/list':
        return reply({
          tools: [
            {
              name: MCP_TOOL,
              description: 'Report probe status to Fluent Flow.',
              inputSchema: { type: 'object', properties: { status: { type: 'string' } }, required: ['status'] },
            },
          ],
        });
      case 'tools/call':
        return reply({ content: [{ type: 'text', text: 'reported' }], isError: false });
      case 'ping':
        return reply({});
      default:
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'method not found' } }));
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', () => r(undefined)));
  const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    calls,
    close: () =>
      new Promise((r) => {
        server.closeAllConnections();
        server.close(() => r(undefined));
      }),
  };
}
