import express from 'express';
import { captureRawBody } from './providers/github/webhook-verify.js';
import logger from './logger.js';

// MCP
import { mcpHandler, mcpMethodNotAllowed } from './mcp/handler.js';
import { mcpAuthMiddleware } from './mcp/auth.js';

// Routes
import webhookRouter from './routes/webhook.js';
import githubAppWebhookRouter from './routes/github-app-webhook.js';
import transitionRouter from './routes/transition.js';
import pauseRouter from './routes/pause.js';
import stateRouter from './routes/state.js';
import reviewRouter from './routes/review.js';
import configRouter from './routes/config.js';
import healthRouter from './routes/health.js';
import agentsRouter from './routes/agents.js';
import runnerRouter from './routes/runner.js';
import collabRouter from './collab/routes.js';
import connectorRouter from './collab/routes-connector.js';
import { collabMcpHandler } from './collab/mcp.js';

/**
 * Build the Express app. Separated from startup (src/index.js) so tests can
 * mount the same wiring — route mounts, middleware, error handling — without
 * triggering DB connections, migrations, or listening on a port.
 */
export function createApp() {
  const app = express();

  // Capture raw body for webhook signature verification (must be before json parser)
  app.use(express.json({ verify: captureRawBody, limit: '5mb' }));
  app.set('trust proxy', true);

  // Request logging (skip /api/health to reduce poll noise)
  app.use((req, res, next) => {
    const start = Date.now();
    res.on('finish', () => {
      const duration = Date.now() - start;
      if (req.path !== '/api/health') {
        logger.info({
          msg: 'request',
          method: req.method,
          path: req.path,
          status: res.statusCode,
          duration_ms: duration,
        });
      }
    });
    next();
  });

  // Mount routes
  app.use('/api', webhookRouter);
  // github-app-webhook is mounted at root (not /api) so the route resolves at
  // /webhooks/github-app — the URL configured on GitHub's App Webhook settings.
  // Other routers stay under /api as they're internal API endpoints.
  app.use(githubAppWebhookRouter);
  app.use('/api', transitionRouter);
  app.use('/api', pauseRouter);
  app.use('/api', stateRouter);
  app.use('/api', reviewRouter);
  app.use('/api', configRouter);
  app.use('/api', healthRouter);
  app.use('/api', agentsRouter);
  app.use('/api', runnerRouter);

  // Collaboration API (actor-assertion auth boundary inside the router).
  app.use('/api/collab/v1', collabRouter);

  // Connector protocol (host Bearer-token auth inside the router).
  app.use('/api/connector/v1', connectorRouter);

  // MCP endpoint
  app.post('/mcp', mcpAuthMiddleware, mcpHandler);
  app.post('/mcp/collab', collabMcpHandler);
  app.get('/mcp/collab', mcpMethodNotAllowed);
  app.delete('/mcp/collab', mcpMethodNotAllowed);
  app.get('/mcp', mcpMethodNotAllowed);
  app.delete('/mcp', mcpMethodNotAllowed);

  // 404 handler
  app.use((req, res) => {
    res.status(404).json({ error: 'Not found' });
  });

  // Error handler
  app.use((err, req, res, _next) => {
    logger.error({ msg: 'Unhandled error', error: err.message, stack: err.stack, path: req.path });
    res.status(500).json({ error: 'Internal server error' });
  });

  return app;
}
