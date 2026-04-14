import logger from '../logger.js';

/**
 * Validate required environment variables at startup.
 * Returns an array of error messages (empty = all good).
 * @param {object} env - process.env or equivalent
 * @returns {string[]} List of validation errors
 */
export function validateEnv(env = process.env) {
  const errors = [];

  const required = ['DATABASE_URL', 'GITHUB_TOKEN'];
  for (const key of required) {
    if (!env[key]) {
      errors.push(`Missing required environment variable: ${key}`);
    }
  }

  if (!env.GITHUB_WEBHOOK_SECRET) {
    logger.warn({ msg: 'GITHUB_WEBHOOK_SECRET not set — webhook signature verification will be skipped' });
  }

  if (!env.MCP_AUTH_TOKEN) {
    logger.warn({ msg: 'MCP_AUTH_TOKEN not set — MCP endpoint will accept unauthenticated requests' });
  }

  // GitHub App env vars — required when FF_GITHUB_APP_ENABLED=true
  if (env.FF_GITHUB_APP_ENABLED === 'true') {
    const appRequired = [
      'FF_GITHUB_APP_ID',
      'FF_GITHUB_APP_PRIVATE_KEY',
      'FF_GITHUB_APP_WEBHOOK_SECRET',
    ];
    for (const key of appRequired) {
      if (!env[key]) {
        errors.push(`FF_GITHUB_APP_ENABLED=true but missing: ${key}`);
      }
    }
    if (!env.FF_GITHUB_APP_CLIENT_ID) {
      logger.warn({ msg: 'FF_GITHUB_APP_CLIENT_ID not set — OAuth flows will be unavailable' });
    }
    if (!env.FF_GITHUB_APP_CLIENT_SECRET) {
      logger.warn({ msg: 'FF_GITHUB_APP_CLIENT_SECRET not set — OAuth flows will be unavailable' });
    }
  }

  return errors;
}
