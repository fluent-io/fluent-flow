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

  return errors;
}
