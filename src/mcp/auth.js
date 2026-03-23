/**
 * Bearer token authentication middleware for MCP endpoint.
 */
export function mcpAuthMiddleware(req, res, next) {
  const token = process.env.MCP_AUTH_TOKEN;
  if (!token) {
    // No token configured — allow unauthenticated access (dev mode)
    return next();
  }

  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing Authorization header' });
  }

  if (auth.slice(7) !== token) {
    return res.status(403).json({ error: 'Invalid token' });
  }

  next();
}
