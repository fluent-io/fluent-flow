import express from 'express';
import { captureRawBody } from './github/webhook-verify.js';
import { getPool, closePool, healthCheck, runMigrations } from './db/client.js';
import { loadDefaults } from './config/loader.js';
import { loadAgents } from './config/agents.js';
import { validateEnv } from './config/env.js';
import { bootstrapSelfHosted } from './agents/org-manager.js';
import logger from './logger.js';

// MCP
import { mcpHandler, mcpMethodNotAllowed } from './mcp/handler.js';
import { mcpAuthMiddleware } from './mcp/auth.js';

// Routes
import webhookRouter from './routes/webhook.js';
import transitionRouter from './routes/transition.js';
import pauseRouter from './routes/pause.js';
import stateRouter from './routes/state.js';
import reviewRouter from './routes/review.js';
import configRouter from './routes/config.js';
import healthRouter from './routes/health.js';

const PORT = parseInt(process.env.PORT || '3847', 10);

const app = express();

// Capture raw body for webhook signature verification (must be before json parser)
app.use(express.json({ verify: captureRawBody, limit: '5mb' }));

// Trust proxy (running behind Docker/nginx)
app.set('trust proxy', true);

// Request logging
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
app.use('/api', transitionRouter);
app.use('/api', pauseRouter);
app.use('/api', stateRouter);
app.use('/api', reviewRouter);
app.use('/api', configRouter);
app.use('/api', healthRouter);

// MCP endpoint
app.post('/mcp', mcpAuthMiddleware, mcpHandler);
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

// Graceful shutdown
async function shutdown(signal) {
  logger.info({ msg: 'Shutting down', signal });
  try {
    await closePool();
    logger.info({ msg: 'Database pool closed' });
  } catch (err) {
    logger.error({ msg: 'Error closing pool', error: err.message });
  }
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Startup
async function start() {
  try {
    // Validate environment
    const envErrors = validateEnv();
    if (envErrors.length > 0) {
      for (const err of envErrors) logger.error({ msg: err });
      throw new Error(`Missing required environment variables: ${envErrors.length} error(s)`);
    }

    // Validate config
    loadDefaults();
    loadAgents();
    logger.info({ msg: 'Defaults config and agent registry loaded' });

    // Run migrations + test DB connection
    await runMigrations();
    await healthCheck();
    logger.info({ msg: 'Database connected, migrations applied' });

    // Bootstrap self-hosted org (idempotent)
    await bootstrapSelfHosted();

    app.listen(PORT, '0.0.0.0', () => {
      logger.info({ msg: 'Fluent Flow started', port: PORT, env: process.env.NODE_ENV || 'development' });
    });
  } catch (err) {
    logger.error({ msg: 'Failed to start', error: err.message, stack: err.stack });
    process.exit(1);
  }
}

start();
