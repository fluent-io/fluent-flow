/**
 * GitHub REST API client using fetch (Node 18+ built-in).
 */
import logger from '../logger.js';

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const BASE_URL = 'https://api.github.com';

/**
 * Make an authenticated GitHub API request.
 * @param {string} path - API path (e.g. /repos/owner/repo/issues)
 * @param {object} [options] - fetch options
 * @returns {Promise<object>} Parsed JSON response
 */
async function githubRequest(path, options = {}) {
  const url = path.startsWith('https://') ? path : `${BASE_URL}${path}`;
  const response = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
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
 * @returns {Promise<object>} Created comment
 */
export async function postComment(owner, repo, issueNumber, body) {
  return githubRequest(`/repos/${owner}/${repo}/issues/${issueNumber}/comments`, {
    method: 'POST',
    body: JSON.stringify({ body }),
  });
}

/**
 * Add a label to an issue or PR.
 */
export async function addLabel(owner, repo, issueNumber, label) {
  return githubRequest(`/repos/${owner}/${repo}/issues/${issueNumber}/labels`, {
    method: 'POST',
    body: JSON.stringify({ labels: [label] }),
  });
}

/**
 * Remove a label from an issue or PR.
 */
export async function removeLabel(owner, repo, issueNumber, label) {
  try {
    return await githubRequest(
      `/repos/${owner}/${repo}/issues/${issueNumber}/labels/${encodeURIComponent(label)}`,
      { method: 'DELETE' }
    );
  } catch (err) {
    if (err.status === 404) return null; // Label wasn't applied, ignore
    throw err;
  }
}

/**
 * Get the current labels on an issue.
 */
export async function getLabels(owner, repo, issueNumber) {
  const labels = await githubRequest(`/repos/${owner}/${repo}/issues/${issueNumber}/labels`);
  return labels.map((l) => l.name);
}

/**
 * Get issue details.
 */
export async function getIssue(owner, repo, issueNumber) {
  return githubRequest(`/repos/${owner}/${repo}/issues/${issueNumber}`);
}

/**
 * Check if a repo exists on GitHub.
 * Returns true if found, false on 404, rethrows on other errors (auth, rate limit, network).
 * @param {string} owner
 * @param {string} repo
 * @returns {Promise<boolean>}
 */
export async function repoExists(owner, repo) {
  try {
    await githubRequest(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`);
    return true;
  } catch (err) {
    if (err.status === 404) return false;
    throw err;
  }
}

/**
 * Get PR details.
 */
export async function getPR(owner, repo, prNumber) {
  return githubRequest(`/repos/${owner}/${repo}/pulls/${prNumber}`);
}

/**
 * Get pull requests linked to an issue (searches for PRs referencing the issue).
 * Returns the first open PR number found, or null.
 */
export async function getLinkedPR(owner, repo, issueNumber) {
  // Search for PRs that mention this issue
  const result = await githubRequest(
    `/repos/${owner}/${repo}/pulls?state=open&per_page=100`
  );
  // There's no direct API; check PR bodies for "Fixes #N" or "Closes #N"
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
 * @param {string} owner
 * @param {string} repo
 * @param {string} workflowId - Workflow file name or ID
 * @param {string} ref - Branch or tag to run on
 * @param {object} inputs - Workflow inputs
 */
export async function dispatchWorkflow(owner, repo, workflowId, ref, inputs = {}) {
  return githubRequest(`/repos/${owner}/${repo}/actions/workflows/${workflowId}/dispatches`, {
    method: 'POST',
    body: JSON.stringify({ ref, inputs }),
  });
}

/**
 * Get file contents from a repo (returns base64-encoded content).
 * @returns {string|null} Base64-encoded file content, or null if not found
 */
export async function getRepoFileContents(owner, repo, path) {
  try {
    const result = await githubRequest(`/repos/${owner}/${repo}/contents/${path}`);
    return result.content?.replace(/\n/g, '') ?? null;
  } catch (err) {
    if (err.status === 404) return null;
    throw err;
  }
}

/**
 * Get the authenticated user's login.
 */
export async function getAuthenticatedUser() {
  const user = await githubRequest('/user');
  return user.login;
}

/**
 * Create or ensure a label exists in a repo.
 */
export async function ensureLabel(owner, repo, name, color = 'e11d48', description = '') {
  try {
    await githubRequest(`/repos/${owner}/${repo}/labels`, {
      method: 'POST',
      body: JSON.stringify({ name, color, description }),
    });
  } catch (err) {
    if (err.status === 422) return; // Already exists
    throw err;
  }
}

/**
 * Check if a file exists in a repo on the default branch.
 * @param {string} owner
 * @param {string} repo
 * @param {string} path - File path in the repo
 * @returns {Promise<boolean>} true if the file exists, false on 404
 */
export async function getFileExists(owner, repo, path) {
  try {
    await githubRequest(`/repos/${owner}/${repo}/contents/${path}`);
    return true;
  } catch (err) {
    if (err.status === 404) return false;
    throw err;
  }
}

/**
 * Create a file in a repo via the GitHub Contents API.
 * @param {string} owner
 * @param {string} repo
 * @param {string} path - File path to create
 * @param {string} content - Raw string content (will be base64-encoded)
 * @param {string} message - Commit message
 * @returns {Promise<object>} GitHub API response
 */
export async function createFile(owner, repo, path, content, message) {
  const encoded = Buffer.from(content).toString('base64');
  return githubRequest(`/repos/${owner}/${repo}/contents/${path}`, {
    method: 'PUT',
    body: JSON.stringify({ message, content: encoded }),
  });
}

/**
 * Get open PRs associated with a commit SHA.
 * Uses the GitHub Commit Pulls API (requires groot-preview header).
 * @param {string} owner
 * @param {string} repo
 * @param {string} sha - Commit SHA
 * @returns {Promise<Array>} Array of PR objects
 */
export async function getPRsForCommit(owner, repo, sha) {
  try {
    return await githubRequest(`/repos/${owner}/${repo}/commits/${sha}/pulls`, {
      headers: { Accept: 'application/vnd.github.groot-preview+json' },
    });
  } catch (err) {
    logger.warn({ msg: 'getPRsForCommit failed', owner, repo, sha, error: err.message });
    return [];
  }
}

/**
 * Get check runs for a commit (paginates, up to 100 per page).
 * @param {string} owner
 * @param {string} repo
 * @param {string} sha
 * @returns {Promise<Array>} Array of check run objects
 */
export async function getCheckRunsForCommit(owner, repo, sha) {
  const result = await githubRequest(`/repos/${owner}/${repo}/commits/${sha}/check-runs?per_page=100`);
  return result.check_runs ?? [];
}

/**
 * List reviews on a pull request.
 * @param {string} owner
 * @param {string} repo
 * @param {number} prNumber
 * @returns {Promise<Array>} Array of review objects
 */
export async function getReviews(owner, repo, prNumber) {
  return githubRequest(`/repos/${owner}/${repo}/pulls/${prNumber}/reviews`);
}

/**
 * Dismiss a pull request review.
 * @param {string} owner
 * @param {string} repo
 * @param {number} prNumber
 * @param {number} reviewId
 * @param {string} message
 */
export async function dismissReview(owner, repo, prNumber, reviewId, message) {
  return githubRequest(`/repos/${owner}/${repo}/pulls/${prNumber}/reviews/${reviewId}/dismissals`, {
    method: 'PUT',
    body: JSON.stringify({ message }),
  });
}
