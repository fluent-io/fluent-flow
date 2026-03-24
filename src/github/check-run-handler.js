import { resolveAgentId, dispatch } from '../notifications/dispatcher.js';
import { getPRsForCommit } from './rest.js';
import { audit } from '../db/client.js';

/**
 * Handle GitHub check_run events (CI failures).
 * Notifies the configured agent when a check run fails on an open PR.
 * @param {string} owner
 * @param {string} repoName
 * @param {object} payload - GitHub webhook payload
 * @param {object} config - Fluent Flow config for this repo
 */
export async function handleCheckRun(owner, repoName, payload, config) {
  const { action, check_run: checkRun } = payload;

  // Only process completed failures
  if (action !== 'completed' || checkRun.conclusion !== 'failure') {
    return;
  }

  // Try to find linked PR via commit SHA
  let prNumber = null;
  let prTitle = '';
  let prBody;

  try {
    const prs = await getPRsForCommit(owner, repoName, checkRun.head_sha);
    if (prs && prs.length > 0) {
      prNumber = prs[0].number;
      prTitle = prs[0].title;
      prBody = prs[0].body;
    }
  } catch (err) {
    console.warn({ msg: 'Failed to fetch linked PRs for CI failure', repo: `${owner}/${repoName}`, sha: checkRun.head_sha, error: err.message });
  }

  const agentId = resolveAgentId({ prBody, config });
  if (!agentId) {
    console.log({ msg: 'No agent_id configured, skipping CI failure notification', repo: `${owner}/${repoName}` });
    return;
  }

  const repoFullName = `${owner}/${repoName}`;
  const message = prNumber
    ? `CI FAILED: ${repoFullName}#${prNumber} (${prTitle}) — check "${checkRun.name}" failed. Fix the issue and push.`
    : `CI FAILED: ${repoFullName} — check "${checkRun.name}" failed at ${checkRun.completed_at}. Fix and push.`;

  await dispatch({
    agentId,
    event: 'ci_failed',
    payload: { message, wakeMode: 'now', deliver: true, repo: repoFullName, prNumber, check: checkRun.name },
  });

  audit('ci_failed', { repo: repoFullName, data: { check: checkRun.name, pr: prNumber, sha: checkRun.head_sha } });
  console.log({ msg: 'CI failure notification sent', repo: repoFullName, check: checkRun.name, pr: prNumber });
}
