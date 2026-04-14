import logger from '../logger.js';

/**
 * Validate required environment variables at startup.
 * Returns an array of error messages (empty = all good).
 * @param {object} env - process.env or equivalent
 * @returns {string[]} List of validation errors
 */
export function validateEnv(env = process.env) {
  const errors = [];

  const required = ['DATABASE_URL', 'GITHUB_APP_ID', 'GITHUB_APP_PRIVATE_KEY_PATH', 'GITHUB_APP_WEBHOOK_SECRET'];
  for (const key of required) {
    if (!env[key]) {
      errors.push(`Missing required environment variable: ${key}`);
    }
  }

  if (!env.GITHUB_TOKEN) {
    logger.warn({ msg: 'GITHUB_TOKEN not set — some legacy REST calls may fail' });
  }

  if (!env.MCP_AUTH_TOKEN) {
    logger.warn({ msg: 'MCP_AUTH_TOKEN not set — MCP endpoint will accept unauthenticated requests' });
  }

  if (!env.GITHUB_APP_CLIENT_ID) {
    logger.warn({ msg: 'GITHUB_APP_CLIENT_ID not set — OAuth flows will be unavailable' });
  }
  if (!env.GITHUB_APP_CLIENT_SECRET) {
    logger.warn({ msg: 'GITHUB_APP_CLIENT_SECRET not set — OAuth flows will be unavailable' });
  }

  return errors;
}
