import { claimNext, markSucceeded, markFailed } from '../db/outbound-queue.js';
import { getInstallationToken } from '../providers/github/token-cache.js';
import logger from '../logger.js';

const GITHUB_API = 'https://api.github.com';
const HEADERS_BASE = {
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'Content-Type': 'application/json',
};

/**
 * Resolve an auth token for the given queue row.
 * Uses installation token if available, falls back to PAT.
 */
async function resolveToken(row) {
  if (row.installation_id) {
    return getInstallationToken(row.installation_id);
  }
  return process.env.GITHUB_TOKEN ?? '';
}

/**
 * Dispatch a single queued action via GitHub API.
 * Returns the fetch Response.
 */
async function dispatch(row) {
  const token = await resolveToken(row);
  const { kind, payload } = row;
  const auth = `Bearer ${token}`;

  switch (kind) {
    case 'comment': {
      const { owner, repo, prNumber, body } = payload;
      return fetch(`${GITHUB_API}/repos/${owner}/${repo}/issues/${prNumber}/comments`, {
        method: 'POST',
        headers: { ...HEADERS_BASE, Authorization: auth },
        body: JSON.stringify({ body }),
      });
    }

    case 'review': {
      const { owner, repo, prNumber, review } = payload;
      return fetch(`${GITHUB_API}/repos/${owner}/${repo}/pulls/${prNumber}/reviews`, {
        method: 'POST',
        headers: { ...HEADERS_BASE, Authorization: auth },
        body: JSON.stringify(review),
      });
    }

    case 'create_check_run': {
      const { owner, repo, ...input } = payload;
      return fetch(`${GITHUB_API}/repos/${owner}/${repo}/check-runs`, {
        method: 'POST',
        headers: { ...HEADERS_BASE, Authorization: auth },
        body: JSON.stringify(input),
      });
    }

    case 'update_check_run': {
      const { owner, repo, checkRunId, ...input } = payload;
      return fetch(`${GITHUB_API}/repos/${owner}/${repo}/check-runs/${checkRunId}`, {
        method: 'PATCH',
        headers: { ...HEADERS_BASE, Authorization: auth },
        body: JSON.stringify(input),
      });
    }

    default:
      throw new Error(`Unknown queue action kind: ${kind}`);
  }
}

/**
 * Check if a response indicates rate limiting.
 */
function isRateLimited(response) {
  if (response.status === 429) return true;
  if (response.status === 403 && response.headers.get('x-ratelimit-remaining') === '0') return true;
  return false;
}

/**
 * Drain one row from the outbound queue.
 * Returns true if a row was processed (regardless of outcome), false if queue was empty.
 */
export async function drainOnce() {
  const row = await claimNext();
  if (!row) return false;

  logger.info({ msg: 'drainOnce: dispatching', id: row.id, kind: row.kind });

  let response;
  try {
    response = await dispatch(row);
  } catch (err) {
    await markFailed(row.id, { rateLimited: false, error: err.message });
    logger.warn({ msg: 'drainOnce: dispatch error', id: row.id, error: err.message });
    return true;
  }

  if (response.ok) {
    await markSucceeded(row.id);
    logger.info({ msg: 'drainOnce: succeeded', id: row.id });
    return true;
  }

  if (isRateLimited(response)) {
    const retryAfter = response.headers.get('retry-after');
    await markFailed(row.id, { rateLimited: true, error: `rate-limited (${response.status})`, retryAfter });
    logger.warn({ msg: 'drainOnce: rate-limited', id: row.id, status: response.status, retryAfter });
    return true;
  }

  // Non-rate-limit failure
  const errorText = await response.text().catch(() => `HTTP ${response.status}`);
  await markFailed(row.id, { rateLimited: false, error: `HTTP ${response.status}: ${errorText}` });
  logger.warn({ msg: 'drainOnce: failed', id: row.id, status: response.status });
  return true;
}

/**
 * Start the outbound worker loop.
 * Runs continuously, sleeping 2s between empty-queue polls.
 */
export async function startOutboundWorker() {
  logger.info({ msg: 'startOutboundWorker: started' });
  const SLEEP_MS = 2000;
  while (true) {
    try {
      const processed = await drainOnce();
      if (!processed) {
        await new Promise((resolve) => setTimeout(resolve, SLEEP_MS));
      }
    } catch (err) {
      logger.error({ msg: 'startOutboundWorker: unhandled error', error: err.message });
      await new Promise((resolve) => setTimeout(resolve, SLEEP_MS));
    }
  }
}
