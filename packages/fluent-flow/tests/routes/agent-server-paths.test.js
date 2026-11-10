import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/logger.js', async () => {
  const { createMockLogger } = await import('../helpers/mock-logger.js');
  return { default: createMockLogger() };
});

vi.mock('../../src/mcp/handler.js', () => ({
  mcpHandler: (_req, res) => res.status(200).json({}),
  mcpMethodNotAllowed: (_req, res) => res.status(405).json({}),
}));

vi.mock('../../src/mcp/auth.js', () => ({
  mcpAuthMiddleware: (_req, _res, next) => next(),
}));

const { createApp } = await import('../../src/app.js');

describe('agent-server route cutover', () => {
  let server;
  let baseUrl;

  beforeAll(async () => {
    server = createApp().listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  it('mounts agent-server registration and removes runner registration', async () => {
    const request = (path) => fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });

    const [agentServerResponse, runnerResponse] = await Promise.all([
      request('/api/agent-server/register'),
      request('/api/runner/register'),
    ]);

    expect(agentServerResponse.status).not.toBe(404);
    expect(runnerResponse.status).toBe(404);
  });
});
