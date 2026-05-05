import { and, eq, lt, sql } from 'drizzle-orm';
import { db, schema } from '@fluent-flow/db';
import { audit } from '../db/client.js';

const { reviewRetries } = schema;
import { resolveConfig, resolveOrgId, installationCtxForRepo } from '../config/loader.js';
import { addLabel, getReviews, dismissReview } from '../providers/github/rest.js';
import { enablePullRequestAutoMerge, getPRNodeId } from '../providers/github/graphql.js';
import { recordPause, getActivePause } from './pause-manager.js';
import { notifyReviewFailure, formatRichMessage, dispatch } from '../notifications/dispatcher.js';
import { createClaim, completeClaim, getActiveClaim } from '../agents/claim-manager.js';
import { resolveSession } from '../agents/session-manager.js';
import { onClaimDispatched, onClaimResolved } from './check-run.js';
import { getProvider } from '../providers/index.js';
import logger from '../logger.js';

/**
 * Dispatch an automated code review for a PR by creating a `review` claim.
 *
 * The claim is picked up by an online runner (long-poll) on the user's
 * machine; the configured harness (claude-code, aider, etc.) produces the
 * review and posts it as a PR review comment with a
 * `<!-- reviewer-result: {…} -->` marker that `handleReviewResult` parses.
 *
 * Replaces the earlier `workflow_dispatch` on a per-repo `pr-review.yml` —
 * target repos no longer need a workflow file or an API-key secret.
 *
 * @param {object} opts
 * @param {string} opts.owner
 * @param {string} opts.repo
 * @param {number} opts.prNumber
 * @param {string} [opts.ref='main'] - PR head branch (passed to the harness so
 *   its worktree can check out the PR head)
 * @param {string} [opts.headSha] - PR head commit SHA; required for GitHub
 *   check-run creation via `onClaimDispatched`. Omit only when the SHA is not
 *   known at call-site (e.g. the manual dispatch API route).
 * @param {number} [opts.attempt=1]
 * @param {Array} [opts.priorIssues=[]]
 * @returns {Promise<{claimed: boolean, claimId?: number, reason?: string}>}
 */
export async function dispatchReview({ owner, repo, prNumber, ref = 'main', headSha, attempt = 1, priorIssues = [], issueNumber, ctx }) {
  const repoKey = `${owner}/${repo}`;
  const config = await resolveConfig(owner, repo);

  if (!config.reviewer?.enabled) {
    logger.info({ msg: 'Reviewer disabled for repo', repo: repoKey });
    return { claimed: false, reason: 'reviewer_disabled' };
  }

  if (issueNumber) {
    const activePause = await getActivePause(repoKey, issueNumber);
    if (activePause) {
      logger.info({ msg: 'Skipping review dispatch — issue is paused', repo: repoKey, prNumber, issueNumber, pauseId: activePause.id });
      return { claimed: false, reason: 'paused' };
    }
  }

  // Resolve installation context for authenticated GitHub API calls.
  // Moved here (before stale-review dismiss) so getReviews/dismissReview/use it.
  const installCtx = ctx ?? await installationCtxForRepo(owner, repo);

  // Dismiss prior Fluent Flow reviews before dispatching new one so the
  // single-review invariant `handleReviewResult` depends on holds.
  try {
    const reviews = await getReviews(owner, repo, prNumber, installCtx);
    const staleReviews = reviews.filter(
      (r) => r.state === 'CHANGES_REQUESTED' && /<!--\s*reviewer-result:/.test(r.body)
    );
    for (const review of staleReviews) {
      try {
        await dismissReview(owner, repo, prNumber, review.id, 'Superseded by new review', installCtx);
        logger.info({ msg: 'Dismissed stale review', repo: repoKey, prNumber, reviewId: review.id });
      } catch (err) {
        // Safe to continue: per-review dismiss — a failed dismiss on one
        // stale review shouldn't block dismissing the rest.
        logger.warn({ msg: 'Failed to dismiss stale review', repo: repoKey, prNumber, reviewId: review.id, error: err.message });
      }
    }
  } catch (err) {
    // Safe to continue: stale review fetch/dismiss is best-effort cleanup
    // before the real work (claim creation). If it fails, the review
    // invariant may be temporarily violated but the claim still gets created.
    logger.warn({ msg: 'Failed to fetch reviews for dismiss', repo: repoKey, prNumber, error: err.message });
  }

  try {
    const orgId = await resolveOrgId(owner, repo);
    const newClaim = await createClaim({
      orgId,
      repo: repoKey,
      prNumber,
      attempt,
      claimType: 'review',
      payload: {
        priorIssues,
        onFailure: config.reviewer?.on_failure,
        branch: ref,
      },
      headSha,
    });
    if (!newClaim) {
      logger.info({ msg: 'Review claim skipped — claim already exists', repo: repoKey, prNumber, attempt });
      return { claimed: false, reason: 'conflict' };
    }

    const installationId = installCtx?.installation_id;
    if (installationId && headSha) {
      const providerClient = getProvider({ installation_id: installationId });
      onClaimDispatched(providerClient, { ...newClaim, head_sha: headSha, installation_id: installationId })
        .catch((err) => logger.warn({ msg: 'onClaimDispatched failed', error: err.message }));
    } else {
      logger.warn({ msg: 'Skipping onClaimDispatched — missing installation_id or headSha', repo: repoKey, prNumber, claimId: newClaim.id });
    }

    // Try to notify an online runner via long-poll (hint only).
    // If this push is lost, the runner still picks up the pending claim
    // on its next poll via claimPendingWork().
    try {
      const agentId = config.default_agent ?? config.agent_id;
      if (agentId) {
        const sessionId = await resolveSession(orgId, agentId, repoKey, prNumber);
        if (sessionId) {
          await dispatch({
            agentId,
            event: 'review',
            payload: { orgId, repo: repoKey, prNumber, session_id: sessionId },
          });
          logger.info({ msg: 'Pushed notification hint to runner', sessionId, claimId: newClaim.id });
        }
      }
    } catch (err) {
      logger.warn({ msg: 'Failed to push notification hint', error: err.message, claimId: newClaim.id });
    }

    logger.info({ msg: 'Review claim created', repo: repoKey, prNumber, attempt });
    audit('review_dispatched', { repo: repoKey, data: { prNumber, attempt } });
    return { claimed: true, claimId: newClaim.id };
  } catch (err) {
    logger.error({ msg: 'Failed to create review claim', repo: repoKey, prNumber, error: err.message });
    throw err;
  }
}

/**
 * Handle an incoming review result (posted by the GitHub Actions workflow).
 *
 * Parses the result and:
 * - PASS: enables auto-merge
 * - FAIL: increments retry counter, notifies agent
 * - FAIL + max retries exceeded: adds needs-human label → triggers pause
 *
 * @param {object} opts
 * @param {string} opts.owner
 * @param {string} opts.repo
 * @param {number} opts.prNumber
 * @param {number} opts.issueNumber - Associated issue number (for pause)
 * @param {object} opts.result - { status, blocking[], advisory[], attempt, summary }
 * @param {string} [opts.reviewSha] - Commit SHA the review was for
 * @returns {Promise<{ action: 'pass'|'fail'|'escalate' }>}
 */
export async function handleReviewResult({ owner, repo, prNumber, issueNumber, result, reviewSha, agentId, headBranch, ctx }) {
  const repoKey = `${owner}/${repo}`;
  const config = await resolveConfig(owner, repo);
  const maxRetries = config.reviewer?.max_retries ?? 3;

  const { status, blocking = [], advisory = [], attempt = 1 } = result;

  if (status === 'PASS') {
    // Enable auto-merge via GraphQL
    try {
      const passCtx = ctx ?? await installationCtxForRepo(owner, repo);
      const prNodeId = await getPRNodeId(owner, repo, prNumber, passCtx);
      if (prNodeId) {
        await enablePullRequestAutoMerge(prNodeId, 'SQUASH', passCtx);
        logger.info({ msg: 'Enabled auto-merge after PASS', repo: repoKey, prNumber });
      audit('review_result_pass', { repo: repoKey, data: { prNumber, attempt } });
      }
    } catch (err) {
      // Safe to continue: auto-merge is a convenience — if it fails
      // (e.g. branch protection misconfigured), the review still passed
      // and the PR can be merged manually.
      logger.error({ msg: 'Failed to enable auto-merge', repo: repoKey, prNumber, error: err.message });
    }

    await db
      .update(reviewRetries)
      .set({ lastReviewSha: reviewSha ?? null, updatedAt: sql`NOW()` })
      .where(and(eq(reviewRetries.repo, repoKey), eq(reviewRetries.prNumber, prNumber)));

    // Complete the active claim for this PR (claim was created on FAIL, attempt may differ)
    try {
      const resolvedOrgId = await resolveOrgId(owner, repo);
      const activeClaim = await getActiveClaim(resolvedOrgId, repoKey, prNumber);
      if (activeClaim) {
        await completeClaim(resolvedOrgId, repoKey, prNumber, activeClaim.attempt);
        // Emit check-run resolved (fire-and-forget)
        const providerClient = getProvider({ installation_id: activeClaim.installation_id });
        onClaimResolved(providerClient, activeClaim, { conclusion: 'success' })
          .catch((err) => logger.warn({ msg: 'onClaimResolved failed', error: err.message }));
      }
    } catch (err) {
      // Safe to continue: claim completion on pass is bookkeeping — if it
      // fails, the claim will be cleaned up by the expiry worker. The review
      // result has already been processed.
      logger.error({ msg: 'Failed to complete claim on pass', error: err.message, repo: repoKey, prNumber });
    }

    return { action: 'pass' };
  }

  // FAIL: increment retry count
  const allIssues = [
    ...blocking.map((b) => ({ ...b, severity: 'blocking' })),
    ...advisory.map((a) => ({ ...a, severity: 'advisory' })),
  ];

  const [retryRecord] = await db
    .insert(reviewRetries)
    .values({
      repo: repoKey,
      prNumber,
      retryCount: 1,
      lastIssues: allIssues,
      lastReviewSha: reviewSha ?? null,
    })
    .onConflictDoUpdate({
      target: [reviewRetries.repo, reviewRetries.prNumber],
      set: {
        retryCount: sql`${reviewRetries.retryCount} + 1`,
        lastIssues: allIssues,
        lastReviewSha: reviewSha ?? null,
        updatedAt: sql`NOW()`,
      },
    })
    .returning();
  const newRetryCount = retryRecord.retryCount;

  logger.info({ msg: 'Review failed', repo: repoKey, prNumber, attempt, retryCount: newRetryCount, maxRetries });

  // Always create claim (even without agentId) so polling agents can pick it up
  const explicitAgent = agentId;
  try {
    const failOrgId = await resolveOrgId(owner, repo);
    // Use attempt + 1 to avoid upserting the original review claim.
    // The unique constraint is (org_id, repo, pr_number, attempt), so
    // reusing the same attempt would overwrite the completed review.
    const newClaim = await createClaim({
      orgId: failOrgId,
      repo: repoKey,
      prNumber,
      attempt: attempt + 1,
      agentId: explicitAgent,
      claimType: 'review_fix',
      payload: {
        message: formatRichMessage({ repo: repoKey, prNumber, attempt, blocking, advisory }),
        issues: allIssues,
        onFailure: config.reviewer?.on_failure,
        branch: headBranch,
      },
      headSha: reviewSha,
    });
    // Emit check-run dispatched (fire-and-forget)
    if (newClaim) {
      const providerClient = getProvider({ installation_id: newClaim.installation_id });
      onClaimDispatched(providerClient, { ...newClaim, head_sha: reviewSha })
        .catch((err) => logger.warn({ msg: 'onClaimDispatched failed', error: err.message }));
    }
  } catch (err) {
    // Safe to continue: claim creation on failure is best-effort — if it
    // fails, the agent won't auto-retry, but the failure is already recorded
    // in the review retries table. A human can manually trigger a retry.
    logger.warn({ msg: 'Failed to create claim on review failure', error: err.message });
  }

  // Notify agent if we know which one (explicit or resolved from config)
  const notifyAgent = explicitAgent ?? config.default_agent ?? config.agent_id;
  if (notifyAgent) {
    await notifyReviewFailure({
      agentId: notifyAgent,
      repo: repoKey,
      prNumber,
      attempt,
      issues: allIssues,
      onFailure: config.reviewer?.on_failure,
      delivery: config.delivery ?? {},
      branch: headBranch,
    });
  } else {
    logger.info({ msg: 'Claim created — no notification agent configured, pending claim will be picked up by polling runners', repo: repoKey, prNumber });
  }

  // Check if we've hit max retries
  if (newRetryCount >= maxRetries) {
    logger.info({ msg: 'Max review retries reached — escalating', repo: repoKey, prNumber, retryCount: newRetryCount });
    audit('review_escalated', { repo: repoKey, data: { prNumber, attempt, blockingCount: blocking.length } });

    // Reset retry counter so future pushes start a fresh review cycle
    await resetRetries(repoKey, prNumber);

    // Add needs-human label to trigger pause
    try {
      if (issueNumber) {
        const escalationCtx = ctx ?? await installationCtxForRepo(owner, repo);
        await addLabel(owner, repo, issueNumber, 'needs-human', escalationCtx);
      }
    } catch (err) {
      // Safe to continue: adding a label is best-effort — if it fails,
      // the escalation is still recorded in the DB and the pause will
      // still be created below.
      logger.error({ msg: 'Failed to add needs-human label on escalation', error: err.message });
    }

    // Record a pause for the escalation
    if (issueNumber) {
      try {
        await recordPause({
          owner,
          repo,
          issueNumber,
          prNumber,
          reason: 'review-escalation',
          ctx,
          context: `Automated review failed ${newRetryCount} times. Blocking issues:\n${blocking.map((b) => `- ${b.file}:${b.line} — ${b.issue}`).join('\n')}`,
          actor: 'fluent-flow',
          agentId: notifyAgent,
        });
      } catch (err) {
        // Safe to continue: recording the pause is best-effort — the
        // escalation is already logged and the label may already be added.
        // A human can manually pause if needed.
        logger.error({ msg: 'Failed to record escalation pause', error: err.message });
      }
    }

    return { action: 'escalate' };
  }

  // Do NOT re-dispatch here — wait for the agent to push new commits.
  // The check_run.completed handler will dispatch a fresh review with last_issues
  // as prior context when CI passes after the agent pushes new commits.
  logger.info({ msg: 'Review failed — waiting for agent to push fixes', repo: repoKey, prNumber, retryCount: newRetryCount });
  audit('review_result_fail', { repo: repoKey, data: { prNumber, attempt, retryCount: newRetryCount } });

  return { action: 'fail' };
}

/**
 * Get the retry record for a PR.
 * @param {string} repo - "owner/repo"
 * @param {number} prNumber
 * @returns {Promise<object|null>}
 */
export async function getRetryRecord(repo, prNumber) {
  const [row] = await db
    .select()
    .from(reviewRetries)
    .where(and(eq(reviewRetries.repo, repo), eq(reviewRetries.prNumber, prNumber)))
    .limit(1);
  return row ?? null;
}

/**
 * Atomically claim a dispatch slot for a SHA. Returns the retry record if
 * the claim succeeds (new SHA or first dispatch), or null if the SHA was
 * already dispatched or max retries reached.
 *
 * @param {string} repo - "owner/repo"
 * @param {number} prNumber
 * @param {string} sha - Commit SHA to claim
 * @param {number} maxRetries
 * @returns {Promise<object|null>}
 */
export async function claimDispatch(repo, prNumber, sha, maxRetries) {
  const [row] = await db
    .insert(reviewRetries)
    .values({ repo, prNumber, lastDispatchSha: sha })
    .onConflictDoUpdate({
      target: [reviewRetries.repo, reviewRetries.prNumber],
      set: { lastDispatchSha: sha, updatedAt: sql`NOW()` },
      setWhere: and(
        sql`${reviewRetries.lastDispatchSha} IS DISTINCT FROM ${sha}`,
        lt(reviewRetries.retryCount, maxRetries),
      ),
    })
    .returning();
  return row ?? null;
}

/**
 * Reset the retry counter for a PR (e.g. after a new commit is pushed).
 * @param {string} repo
 * @param {number} prNumber
 */
export async function resetRetries(repo, prNumber) {
  await db
    .update(reviewRetries)
    .set({
      retryCount: 0,
      lastIssues: null,
      lastDispatchSha: null,
      updatedAt: sql`NOW()`,
    })
    .where(and(eq(reviewRetries.repo, repo), eq(reviewRetries.prNumber, prNumber)));
}

