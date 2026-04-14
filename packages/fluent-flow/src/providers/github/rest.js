/**
 * GitHub REST API client using fetch (Node 18+ built-in).
 * Supports both PAT auth (legacy) and installation-token auth (App).
 */
import logger from '../../logger.js';
import { getInstallationToken } from './token-cache.js';

const BASE_URL = 'https://api.github.com';

/**
 * Resolve the auth token for a request.
 * Prefers installation token when installation_id is provided; falls back to GITHUB_TOKEN PAT.
 * @param {{ installation_id?: number }} [ctx]
 * @returns {Promise<string>}
 */
async function resolveToken(ctx) {
  if (ctx?.installation_id) {
    return getInstallationToken(ctx.installation_id);
  }
  return process.env.GITHUB_TOKEN ?? '';
}

/**
 * Make an authenticated GitHub API request.
 * @param {string} path - API path (e.g. /repos/owner/repo/issues)
 * @param {object} [options] - fetch options
 * @param {string} [token] - auth token (pre-resolved)
 * @returns {Promise<object>} Parsed JSON response
 */
async function githubRequest(path, options = {}, token) {
  const authToken = token ?? process.env.GITHUB_TOKEN ?? '';
  const url = path.startsWith('https://') ? path : `${BASE_URL}${path}`;
  const response = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${authToken}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    const err = new Error(`GitHub API error: ${response.status} ${response.statusText} — ${path}`);
    err.status = response.status;
    err.body = body;
    throw err;
  }

  if (response.status === 204) return null;

  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    return response.json();
  }
  return response.text();
}

/**
 * Post a comment on an issue or PR.
 * @param {string} owner
 * @param {string} repo
 * @param {number} issueNumber
 * @param {string} body
 * @param {{ installation_id?: number }} [ctx]
 * @returns {Promise<object>} Created comment
 */
export async function postComment(owner, repo, issueNumber, body, ctx) {
  const token = await resolveToken(ctx);
  return githubRequest(`/repos/${owner}/${repo}/issues/${issueNumber}/comments`, {
    method: 'POST',
    body: JSON.stringify({ body }),
  }, token);
}

/**
 * Add a label to an issue or PR.
 */
export async function addLabel(owner, repo, issueNumber, label, ctx) {
  const token = await resolveToken(ctx);
  return githubRequest(`/repos/${owner}/${repo}/issues/${issueNumber}/labels`, {
    method: 'POST',
    body: JSON.stringify({ labels: [label] }),
  }, token);
}

/**
 * Remove a label from an issue or PR.
 */
export async function removeLabel(owner, repo, issueNumber, label, ctx) {
  const token = await resolveToken(ctx);
  try {
    return await githubRequest(
      `/repos/${owner}/${repo}/issues/${issueNumber}/labels/${encodeURIComponent(label)}`,
      { method: 'DELETE' },
      token
    );
  } catch (err) {
    if (err.status === 404) return null; // Label wasn't applied, ignore
    throw err;
  }
}

/**
 * Get the current labels on an issue.
 */
export async function getLabels(owner, repo, issueNumber, ctx) {
  const token = await resolveToken(ctx);
  const labels = await githubRequest(`/repos/${owner}/${repo}/issues/${issueNumber}/labels`, {}, token);
  return labels.map((l) => l.name);
}

/**
 * Get issue details.
 */
export async function getIssue(owner, repo, issueNumber, ctx) {
  const token = await resolveToken(ctx);
  return githubRequest(`/repos/${owner}/${repo}/issues/${issueNumber}`, {}, token);
}

/**
 * Check if a repo exists on GitHub.
 */
export async function repoExists(owner, repo, ctx) {
  const token = await resolveToken(ctx);
  try {
    await githubRequest(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`, {}, token);
    return true;
  } catch (err) {
    if (err.status === 404) return false;
    throw err;
  }
}

/**
 * Get PR details.
 */
export async function getPR(owner, repo, prNumber, ctx) {
  const token = await resolveToken(ctx);
  return githubRequest(`/repos/${owner}/${repo}/pulls/${prNumber}`, {}, token);
}

/**
 * Get pull requests linked to an issue.
 * Returns the first open PR number found, or null.
 */
export async function getLinkedPR(owner, repo, issueNumber, ctx) {
  const token = await resolveToken(ctx);
  const result = await githubRequest(`/repos/${owner}/${repo}/pulls?state=open&per_page=100`, {}, token);
  const patterns = [
    new RegExp(`(?:fixes|closes|resolves)\\s+#${issueNumber}\\b`, 'i'),
    new RegExp(`(?:fixes|closes|resolves)\\s+${owner}/${repo}#${issueNumber}\\b`, 'i'),
  ];
  for (const pr of result) {
    const body = `${pr.title} ${pr.body || ''}`;
    if (patterns.some((p) => p.test(body))) {
      return pr.number;
    }
  }
  return null;
}

/**
 * Dispatch a workflow via workflow_dispatch event.
 */
export async function dispatchWorkflow(owner, repo, workflowId, ref, inputs = {}, ctx) {
  const token = await resolveToken(ctx);
  return githubRequest(`/repos/${owner}/${repo}/actions/workflows/${workflowId}/dispatches`, {
    method: 'POST',
    body: JSON.stringify({ ref, inputs }),
  }, token);
}

/**
 * Get file contents from a repo (returns base64-encoded content).
 */
export async function getRepoFileContents(owner, repo, path, ctx) {
  const token = await resolveToken(ctx);
  try {
    const result = await githubRequest(`/repos/${owner}/${repo}/contents/${path}`, {}, token);
    return result.content?.replace(/\n/g, '') ?? null;
  } catch (err) {
    if (err.status === 404) return null;
    throw err;
  }
}

/**
 * Get the authenticated user's login.
 */
export async function getAuthenticatedUser(ctx) {
  const token = await resolveToken(ctx);
  const user = await githubRequest('/user', {}, token);
  return user.login;
}

/**
 * Create or ensure a label exists in a repo.
 */
export async function ensureLabel(owner, repo, name, color = 'e11d48', description = '', ctx) {
  const token = await resolveToken(ctx);
  try {
    await githubRequest(`/repos/${owner}/${repo}/labels`, {
      method: 'POST',
      body: JSON.stringify({ name, color, description }),
    }, token);
  } catch (err) {
    if (err.status === 422) return; // Already exists
    throw err;
  }
}

/**
 * Check if a file exists in a repo on the default branch.
 */
export async function getFileExists(owner, repo, path, ctx) {
  const token = await resolveToken(ctx);
  try {
    await githubRequest(`/repos/${owner}/${repo}/contents/${path}`, {}, token);
    return true;
  } catch (err) {
    if (err.status === 404) return false;
    throw err;
  }
}

/**
 * Create a file in a repo via the GitHub Contents API.
 */
export async function createFile(owner, repo, path, content, message, ctx) {
  const token = await resolveToken(ctx);
  const encoded = Buffer.from(content).toString('base64');
  return githubRequest(`/repos/${owner}/${repo}/contents/${path}`, {
    method: 'PUT',
    body: JSON.stringify({ message, content: encoded }),
  }, token);
}

/**
 * Get open PRs associated with a commit SHA.
 */
export async function getPRsForCommit(owner, repo, sha, ctx) {
  const token = await resolveToken(ctx);
  try {
    return await githubRequest(`/repos/${owner}/${repo}/commits/${sha}/pulls`, {
      headers: { Accept: 'application/vnd.github.groot-preview+json' },
    }, token);
  } catch (err) {
    logger.warn({ msg: 'getPRsForCommit failed', owner, repo, sha, error: err.message });
    return [];
  }
}

/**
 * Get check runs for a commit.
 */
export async function getCheckRunsForCommit(owner, repo, sha, ctx) {
  const token = await resolveToken(ctx);
  const result = await githubRequest(`/repos/${owner}/${repo}/commits/${sha}/check-runs?per_page=100`, {}, token);
  return result.check_runs ?? [];
}

/**
 * List reviews on a pull request.
 */
export async function getReviews(owner, repo, prNumber, ctx) {
  const token = await resolveToken(ctx);
  return githubRequest(`/repos/${owner}/${repo}/pulls/${prNumber}/reviews`, {}, token);
}

/**
 * Get check run annotations.
 */
export async function getCheckRunAnnotations(owner, repo, checkRunId, ctx) {
  const token = await resolveToken(ctx);
  try {
    const result = await githubRequest(
      `/repos/${owner}/${repo}/check-runs/${checkRunId}/annotations?per_page=100`,
      {},
      token
    );
    return Array.isArray(result) ? result : [];
  } catch (err) {
    logger.warn({ msg: 'Failed to fetch check run annotations', owner, repo, checkRunId, error: err.message });
    return [];
  }
}

export async function dismissReview(owner, repo, prNumber, reviewId, message, ctx) {
  const token = await resolveToken(ctx);
  return githubRequest(`/repos/${owner}/${repo}/pulls/${prNumber}/reviews/${reviewId}/dismissals`, {
    method: 'PUT',
    body: JSON.stringify({ message }),
  }, token);
}
