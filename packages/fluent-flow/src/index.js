import './tracing.cjs';
import { closePool, healthCheck, runMigrations } from './db/client.js';
import { loadDefaults } from './config/loader.js';
import { loadAgents } from './config/agents.js';
import { validateEnv } from './config/env.js';
import { bootstrapSelfHosted } from './agents/org-manager.js';
import { startOutboundWorker } from './workers/outbound.js';
import logger from './logger.js';
import { createApp } from './app.js';

const PORT = parseInt(process.env.PORT || '3847', 10);

const app = createApp();

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
      // Start outbound queue worker after server is listening
      startOutboundWorker().catch((err) =>
        logger.error({ msg: 'Outbound worker crashed', error: err.message })
      );
    });
  } catch (err) {
    logger.error({ msg: 'Failed to start', error: err.message, stack: err.stack });
    process.exit(1);
  }
}

start();
