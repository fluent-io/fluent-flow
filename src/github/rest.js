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
