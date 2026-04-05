import { Router } from 'express';
import { handleCheckRun } from '../github/check-run-handler.js';
import { audit } from '../db/client.js';
import { webhookSignatureMiddleware } from '../github/webhook-verify.js';
import { resolveConfig, invalidateConfig } from '../config/loader.js';
import { executeTransition, autoTransition, getCurrentState } from '../engine/state-machine.js';
import { recordPause, processResume, parseResumeCommand, getActivePause } from '../engine/pause-manager.js';
import { handleReviewResult, resetRetries } from '../engine/review-manager.js';
import { resolveAgentId, notifyPRMerged, resolveAgentForIssue } from '../notifications/dispatcher.js';
import { getLinkedPR, getPR } from '../github/rest.js';
import logger from '../logger.js';

const router = Router();

/**
 * Parse an agent-pause structured comment.
 * Format: <!-- agent-pause: {"reason": "...", "context": "...", "checklist": [...]} -->
 * @param {string} body
 * @returns {object|null}
 */
function parseAgentPauseComment(body) {
  if (!body) return null;
  const match = body.match(/<!--\s*agent-pause:\s*({.*?})\s*-->/s);
  if (!match) return null;
  try {
    return JSON.parse(match[1]);
  } catch {
    return null;
  }
}

/**
 * Extract issue number linked to a PR from PR body.
 * Looks for "Fixes #N", "Closes #N", "Resolves #N".
 * @param {string} body
 * @returns {number|null}
 */
function extractLinkedIssue(body) {
  if (!body) return null;
  const match = body.match(/(?:fixes|closes|resolves)\s+#(\d+)/i);
  return match ? parseInt(match[1], 10) : null;
}

// POST /api/webhook/github — unified webhook endpoint
router.post('/webhook/github', webhookSignatureMiddleware, async (req, res) => {
  const event = req.headers['x-github-event'];
  const payload = req.body;

  // Always respond quickly to GitHub
  res.status(200).json({ ok: true, event });

  // Process asynchronously
  try {
    await routeWebhookEvent(event, payload);
  } catch (err) {
    logger.error({ msg: 'Webhook processing error', event, error: err.message, stack: err.stack });
  }
});

/**
 * Route a GitHub webhook event to the appropriate handler.
 */
async function routeWebhookEvent(event, payload) {
  const repo = payload.repository;
  if (!repo) {
    logger.info({ msg: 'Webhook without repository, skipping', event });
    return;
  }

  const [owner, repoName] = repo.full_name.split('/');

  // Check if this repo has Fluent Flow config
  let config;
  try {
    config = await resolveConfig(owner, repoName);
  } catch (err) {
    logger.info({ msg: 'No Fluent Flow config for repo, ignoring', repo: repo.full_name, event });
    return;
  }

  if (!config) {
    logger.info({ msg: 'Repo not onboarded, ignoring', repo: repo.full_name });
    return;
  }

  logger.info({ msg: 'Processing webhook', event, action: payload.action, repo: repo.full_name });
  audit('webhook_received', { repo: repo.full_name, data: { event, action: payload.action } });

  switch (event) {
    case 'pull_request':
      await handlePullRequest(owner, repoName, payload, config);
      break;
    case 'pull_request_review':
      await handlePullRequestReview(owner, repoName, payload, config);
      break;
    case 'issues':
      await handleIssues(owner, repoName, payload, config);
      break;
    case 'issue_comment':
      await handleIssueComment(owner, repoName, payload, config);
      break;
    case 'projects_v2_item':
      await handleProjectItem(owner, repoName, payload, config);
      break;
    case 'push':
      await handlePush(owner, repoName, payload, config);
      break;
    case 'check_run':
      await handleCheckRun(owner, repoName, payload, config);
      break;
    default:
      logger.info({ msg: 'Unhandled event type', event });
  }
}

/**
 * Handle pull_request events.
 */
async function handlePullRequest(owner, repo, payload, config) {
  const { action, pull_request: pr } = payload;
  const prNumber = pr.number;
  const issueNumber = extractLinkedIssue(pr.body);

  switch (action) {
    case 'opened':
    case 'reopened': {
      // Move linked issue to In Review
      if (issueNumber) {
        try {
          await executeTransition({
            owner,
            repo,
            issueNumber,
            toState: 'In Review',
            triggerType: 'webhook',
            triggerDetail: `pull_request.${action}`,
            actor: pr.user?.login,
            context: { linked_pr: prNumber },
            metadata: { pr_number: prNumber },
          });
        } catch (err) {
          logger.warn({ msg: 'Could not transition to In Review', error: err.message, issueNumber });
        }
      }

      break;
    }

    case 'closed': {
      // Clean up review retries unconditionally — works even without linked issue
      const repoKey = `${owner}/${repo}`;
      try {
        await resetRetries(repoKey, prNumber);
        audit('retries_cleared', { repo: repoKey, data: { prNumber, trigger: 'pr_closed' } });
      } catch (err) {
        logger.warn({ msg: 'Failed to clear retries on PR close', error: err.message, prNumber });
      }

      if (pr.merged && issueNumber) {
        // PR merged → move issue to Done
        try {
          await executeTransition({
            owner,
            repo,
            issueNumber,
            toState: 'Done',
            triggerType: 'webhook',
            triggerDetail: 'pull_request.closed (merged)',
            actor: pr.merged_by?.login ?? pr.user?.login,
            context: { merged_pr: prNumber },
            metadata: { pr_number: prNumber },
          });
        } catch (err) {
          logger.warn({ msg: 'Could not transition to Done on merge', error: err.message, issueNumber });
        }

        // Notify the agent that created this PR
        const agentId = resolveAgentId({ prBody: pr.body, config });
        if (agentId) {
          await notifyPRMerged({
            agentId,
            repo: `${owner}/${repo}`,
            prNumber,
            issueNumber,
            delivery: config.delivery ?? {},
          });
        }
      } else if (!pr.merged && issueNumber) {
        // PR closed without merge → move back to In Progress
        try {
          await executeTransition({
            owner,
            repo,
            issueNumber,
            toState: 'In Progress',
            triggerType: 'webhook',
            triggerDetail: 'pull_request.closed (not merged)',
            actor: pr.user?.login,
          });
        } catch (err) {
          logger.warn({ msg: 'Could not transition back to In Progress', error: err.message, issueNumber });
        }
      }
      break;
    }

    case 'synchronize': {
      // Review dispatch moved to check_run.completed handler (CI-gated)
      break;
    }
  }
}

/**
 * Handle pull_request_review events.
 */
async function handlePullRequestReview(owner, repo, payload, config) {
  const { action, review, pull_request: pr } = payload;
  if (action !== 'submitted') return;

  const prNumber = pr.number;
  const issueNumber = extractLinkedIssue(pr.body);

  // Parse machine-readable result from review body
  const resultMatch = review.body?.match(/<!--\s*reviewer-result:\s*({.*?})\s*-->/s);

  if (resultMatch) {
    // This is from our automated reviewer
    try {
      const result = JSON.parse(resultMatch[1]);
      const agentId = resolveAgentId({ prBody: pr.body, config });
      await handleReviewResult({
        owner,
        repo,
        prNumber,
        issueNumber,
        result,
        reviewSha: pr.head.sha,
        agentId,
        headBranch: pr.head.ref,
      });
    } catch (err) {
      logger.error({ msg: 'Failed to handle automated review result', error: err.message, prNumber });
    }
    return;
  }

  // Human review — handle state transitions
  if (review.state === 'changes_requested' && issueNumber) {
    await autoTransition(owner, repo, issueNumber, 'review_rejected', review.user?.login, {
      pr_number: prNumber,
      review_id: review.id,
    });
  }
}

/**
 * Handle issues events (label changes).
 */
async function handleIssues(owner, repo, payload, config) {
  const { action, issue, label } = payload;
  const issueNumber = issue.number;

  if (action === 'labeled' && label?.name === 'needs-human') {
    // Pause the issue
    const currentState = await getCurrentState(`${owner}/${repo}`, issueNumber);
    if (currentState !== 'Awaiting Human') {
      const agentId = await resolveAgentForIssue(owner, repo, issueNumber, config);
      await recordPause({
        owner,
        repo,
        issueNumber,
        reason: 'manual',
        context: 'Labeled needs-human',
        actor: payload.sender?.login,
        agentId,
      });
    }
  } else if (action === 'unlabeled' && label?.name === 'needs-human') {
    // Resume the issue
    const activePause = await getActivePause(`${owner}/${repo}`, issueNumber);
    if (activePause) {
      const agentId = activePause.agent_id ?? config.default_agent ?? config.agent_id ?? null;
      await processResume({
        owner,
        repo,
        issueNumber,
        resumedBy: payload.sender?.login,
        agentId,
      });
    }
  }
}

/**
 * Handle issue_comment events (/resume, agent-pause).
 */
async function handleIssueComment(owner, repo, payload, config) {
  const { action, comment, issue } = payload;
  if (action !== 'created') return;

  const issueNumber = issue.number;
  const body = comment.body;

  // Check for /resume command
  const { isResume, toState, instructions } = parseResumeCommand(body);
  if (isResume) {
    try {
      const agentId = await resolveAgentForIssue(owner, repo, issueNumber, config);
      await processResume({
        owner,
        repo,
        issueNumber,
        toState,
        instructions,
        resumedBy: comment.user?.login,
        agentId,
      });
    } catch (err) {
      logger.warn({ msg: 'Resume command failed', error: err.message, issueNumber });
    }
    return;
  }

  // Check for agent-pause structured comment
  const pauseData = parseAgentPauseComment(body);
  if (pauseData) {
    try {
      // Find linked PR if any
      const linkedPR = await getLinkedPR(owner, repo, issueNumber);
      const agentId = await resolveAgentForIssue(owner, repo, issueNumber, config);
      await recordPause({
        owner,
        repo,
        issueNumber,
        prNumber: linkedPR,
        reason: pauseData.reason ?? 'agent-stuck',
        context: pauseData.context,
        actor: comment.user?.login,
        agentId,
      });
    } catch (err) {
      logger.error({ msg: 'Agent pause failed', error: err.message, issueNumber });
    }
  }
}

/**
 * Handle projects_v2_item events (card dragged on board).
 */
async function handleProjectItem(owner, repo, payload, config) {
  // projects_v2_item events have limited info — the changes are in the payload
  // We'd need to query the current state from GraphQL to validate
  // For now, log and handle in future phase
  logger.info({
    msg: 'Project item event received',
    action: payload.action,
    repo: `${owner}/${repo}`,
    // projects_v2_item events don't include repo directly,
    // they're org-level — we'll need to handle this differently
  });
}

/**
 * Handle push events — invalidate config cache if .github/fluent-flow.yml was changed.
 */
async function handlePush(owner, repo, payload, config) {
  const commits = payload.commits ?? [];
  const configChanged = commits.some((c) =>
    [...(c.added ?? []), ...(c.modified ?? []), ...(c.removed ?? [])].includes('.github/fluent-flow.yml')
  );

  if (configChanged) {
    logger.info({ msg: 'Config file changed, invalidating cache', repo: `${owner}/${repo}` });
    await invalidateConfig(owner, repo);
  }
}

export { handlePullRequest, handleIssues, handleIssueComment };
export default router;
