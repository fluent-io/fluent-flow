import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { mcpAuthMiddleware } from '../../src/mcp/auth.js';

function mockReqRes(authHeader) {
  const req = { headers: authHeader ? { authorization: authHeader } : {} };
  const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };
  const next = vi.fn();
  return { req, res, next };
}

describe('mcpAuthMiddleware', () => {
  const originalEnv = process.env.MCP_AUTH_TOKEN;

  beforeEach(() => {
    delete process.env.MCP_AUTH_TOKEN;
  });

  afterAll(() => {
    if (originalEnv) process.env.MCP_AUTH_TOKEN = originalEnv;
    else delete process.env.MCP_AUTH_TOKEN;
  });

  it('allows requests when no token configured (dev mode)', () => {
    const { req, res, next } = mockReqRes();
    mcpAuthMiddleware(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  it('allows requests with valid token', () => {
    process.env.MCP_AUTH_TOKEN = 'secret123';
    const { req, res, next } = mockReqRes('Bearer secret123');
    mcpAuthMiddleware(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  it('rejects requests with missing Authorization header', () => {
    process.env.MCP_AUTH_TOKEN = 'secret123';
    const { req, res, next } = mockReqRes();
    mcpAuthMiddleware(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('rejects requests with wrong token', () => {
    process.env.MCP_AUTH_TOKEN = 'secret123';
    const { req, res, next } = mockReqRes('Bearer wrongtoken');
    mcpAuthMiddleware(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  it('rejects non-Bearer auth schemes', () => {
    process.env.MCP_AUTH_TOKEN = 'secret123';
    const { req, res, next } = mockReqRes('Basic abc123');
    mcpAuthMiddleware(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
  });
});
