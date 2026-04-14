import { fetchInstallationToken } from './app-auth.js';
import logger from '../../logger.js';

// TTL buffer: refresh 10 minutes before expiry
const REFRESH_BUFFER_MS = 10 * 60 * 1000;

/**
 * @typedef {object} CacheEntry
 * @property {string} token
 * @property {Date} expiresAt
 * @property {Promise<{token: string, expiresAt: Date}>|null} [inflight]
 */

/** @type {Map<number, CacheEntry>} */
const cache = new Map();

/**
 * Clear the token cache (for tests).
 */
export function clearTokenCache() {
  cache.clear();
}

/**
 * Get an installation access token, using in-memory cache with single-flight.
 *
 * @param {number} installationId
 * @returns {Promise<string>} installation token
 */
export async function getInstallationToken(installationId) {
  const entry = cache.get(installationId);

  // Return cached token if still valid (with buffer)
  if (entry && !entry.inflight && entry.expiresAt > new Date(Date.now() + REFRESH_BUFFER_MS)) {
    return entry.token;
  }

  // If there's already an in-flight request for this installation, wait for it
  if (entry?.inflight) {
    const { token } = await entry.inflight;
    return token;
  }

  // Kick off a new fetch
  const { appId, privateKeyPem } = getAppCredentials();
  const inflight = fetchInstallationToken({ appId, privateKeyPem, installationId });

  // Store the inflight promise so concurrent callers can share it
  cache.set(installationId, { token: entry?.token ?? '', expiresAt: entry?.expiresAt ?? new Date(0), inflight });

  try {
    const result = await inflight;
    cache.set(installationId, { token: result.token, expiresAt: result.expiresAt, inflight: null });
    logger.info({ msg: 'getInstallationToken', installationId, expiresAt: result.expiresAt });
    return result.token;
  } catch (err) {
    // Clear the inflight entry on error so callers can retry
    const stale = cache.get(installationId);
    if (stale?.inflight === inflight) {
      cache.delete(installationId);
    }
    throw err;
  }
}

/**
 * Read GitHub App credentials from env.
 * Falls back gracefully if not configured (PAT path).
 */
function getAppCredentials() {
  const appId = process.env.FF_GITHUB_APP_ID;
  const privateKeyBase64 = process.env.FF_GITHUB_APP_PRIVATE_KEY;
  const privateKeyPem = privateKeyBase64
    ? Buffer.from(privateKeyBase64, 'base64').toString('utf8')
    : null;

  return { appId, privateKeyPem };
}
