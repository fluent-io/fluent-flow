import logger from '../../logger.js';

const BASE_URL = 'https://api.github.com';

/**
 * Create a GitHub Check Run.
 * @param {string} token - Installation token
 * @param {string} owner
 * @param {string} repo
 * @param {object} input - { name, head_sha, status, external_id? }
 * @returns {Promise<object>} Created check run with { id, ... }
 */
export async function createCheckRunDirect(token, owner, repo, input) {
  const response = await fetch(`${BASE_URL}/repos/${owner}/${repo}/check-runs`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(input),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    const err = new Error(`GitHub check run create failed: ${response.status} — ${body}`);
    err.status = response.status;
    throw err;
  }

  return response.json();
}

/**
 * Update a GitHub Check Run.
 * @param {string} token - Installation token
 * @param {string} owner
 * @param {string} repo
 * @param {number} checkRunId
 * @param {object} input - { status, conclusion?, started_at?, completed_at?, output? }
 */
export async function updateCheckRunDirect(token, owner, repo, checkRunId, input) {
  const response = await fetch(`${BASE_URL}/repos/${owner}/${repo}/check-runs/${checkRunId}`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(input),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    const err = new Error(`GitHub check run update failed: ${response.status} — ${body}`);
    err.status = response.status;
    throw err;
  }

  logger.info({ msg: 'updateCheckRunDirect', owner, repo, checkRunId, status: input.status });
}
