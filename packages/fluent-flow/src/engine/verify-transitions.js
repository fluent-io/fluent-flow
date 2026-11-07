import { z } from 'zod';
import { sql } from 'drizzle-orm';
import {
  getVerificationResultByClaim,
  insertVerificationResult,
  markVerificationTransitionApplied,
} from '@fluent-flow/db';
import { createClaim, createClaimWithRetry, nextChainAttempt, countCompletedFixIterations } from '../agents/claim-manager.js';
import { dispatchReview } from './review-manager.js';
import { dispatch } from '../notifications/dispatcher.js';
import { getProvider } from '../providers/index.js';
import { addLabel, postComment } from '../providers/github/rest.js';
import { recordPause } from './pause-manager.js';
import { onClaimResolved, renderMatrixSummary } from './check-run.js';
import logger from '../logger.js';
import { resolveConfig, installationCtxForRepo } from '../config/loader.js';

export const VerifyOutcomeSchema = z.object({
  status: z.enum(['pass', 'assertion-fail', 'suite-error', 'skip']),
  message: z.string().max(2000).optional(),
  retries: z.number().int().optional(),
});

export const VerifyManifestSchema = z.object({
  pr_number: z.number().int(),
  requirements: z.array(z.object({
    requirement: z.object({
      id: z.string().regex(/^REQ-\d+$/),
      form: z.enum(['when', 'while', 'if', 'where', 'ubiquitous']),
      text: z.string().min(1).max(2000),
      source_finding_id: z.string().optional(),
    }),
    tests: z.array(z.string().regex(/^[A-Za-z0-9._\-/]+$/)).min(1),
    dependency_files: z.array(z.string().regex(/^[A-Za-z0-9._\-/]+$/)).default([]),
    framework: z.enum(['vitest', 'jest', 'node', 'custom']),
  })).min(1),
});

export const VerificationResultSchema = z.object({
  phase: z.enum(['red', 'green']),
  framework: z.enum(['vitest', 'jest', 'node', 'custom', 'none']),
  outcome: z.enum(['PASS', 'FAIL', 'TAMPERED', 'SKIPPED']),
  matrix: z.object({
    requirements: z.array(z.any()),
    suite: z.object({
      total: z.number().int(),
      passed: z.number().int(),
      failed: z.number().int(),
      flaky: z.number().int(),
      skipped: z.number().int(),
    }),
    schema_version: z.number().int(),
  }).nullable(),
  manifest: VerifyManifestSchema.optional(),
  test_hashes: z.array(z.object({ path: z.string(), sha256: z.string() })).optional(),
  artifact_sha: z.string().regex(/^[0-9a-f]{40}$/).nullable().optional(),
  red_base_sha: z.string().regex(/^[0-9a-f]{40}$/).nullable().optional(),
  green_sha: z.string().regex(/^[0-9a-f]{40}$/).nullable().optional(),
});

const MAX_FIX_ITERATIONS = 10;

function buildCheckRunNote(outcome, matrix) {
  if (outcome === 'FAIL' && matrix?.requirements?.some(r => r.status === 'FAIL')) {
    return 'Verification failed: one or more requirements did not pass.';
  }
  if (outcome === 'SKIPPED') {
    return 'Verification skipped: framework not detected or configured.';
  }
  return null;
}

const VERIFY_FRAMEWORKS = new Set(['vitest', 'jest', 'node', 'custom', 'none']);

function verificationFrameworkFromClaim(claim) {
  const configured = claim.payload?.verification?.framework;
  return VERIFY_FRAMEWORKS.has(configured) ? configured : 'none';
}

function buildRedispatchExhaustedVerification(claim) {
  const phase = claim.payload?.phase === 'green' ? 'green' : 'red';
  return {
    phase,
    framework: verificationFrameworkFromClaim(claim),
    outcome: 'FAIL',
    matrix: {
      requirements: [{
        id: 'VERIFY-EXHAUSTED',
        status: 'FAIL',
        text: 'Verification infrastructure retry limit exhausted; continuing with ungated review fix.',
        failed: 1,
        passed: 0,
      }],
      suite: { total: 0, passed: 0, failed: 0, flaky: 0, skipped: 0 },
      schema_version: 1,
    },
    ...(claim.payload?.red_base_sha ? { red_base_sha: claim.payload.red_base_sha } : {}),
    ...(phase === 'green' && claim.head_sha ? { green_sha: claim.head_sha } : {}),
  };
}

export async function applyVerifyTransition(claim, verification, ctx, external = {}) {
  const { orgId } = ctx;
  const { phase, outcome, matrix, test_hashes } = verification;
  const { repo, pr_number, head_sha, payload } = claim;
  const [owner, repoName] = repo.split('/');

  const {
    getNextAttempt = nextChainAttempt,
    getCountFixIterations = countCompletedFixIterations,
  } = external;

  const result = {
    action: null,
    claimSpec: null,
    notify: null,
    checkRun: null,
    dispatchReviewSpec: null,
  };

  if (outcome === 'TAMPERED') {
    result.action = 'needs_human';
    result.notify = {
      type: 'pr_comment',
      owner,
      repo: repoName,
      prNumber: pr_number,
      body: 'Verification detected modified verifier tests on this PR. Escalated to a human.',
    };
    return result;
  }

  if (phase === 'red') {
    if (outcome === 'PASS') {
      result.action = 'create_claim';
      const nextAttempt = await getNextAttempt(orgId, repo, pr_number);
      const immutability = test_hashes?.map(h => h.path) ?? [];
      result.claimSpec = {
        orgId,
        repo,
        prNumber: pr_number,
        attempt: nextAttempt,
        claimType: 'review_fix',
        payload: {
          source_claim_id: claim.id,
          immutability,
          branch: payload?.branch,
          findings: payload?.findings ?? [],
        },
        headSha: head_sha,
      };
      return result;
    }

    if (outcome === 'FAIL' || outcome === 'SKIPPED') {
      result.action = 'create_claim';
      result.checkRun = { summary: buildCheckRunNote(outcome, matrix) };
      const nextAttempt = await getNextAttempt(orgId, repo, pr_number);
      const immutability = test_hashes?.map((h) => h.path).filter(Boolean) ?? [];
      result.claimSpec = {
        orgId,
        repo,
        prNumber: pr_number,
        attempt: nextAttempt,
        claimType: 'review_fix',
        payload: {
          source_claim_id: claim.id,
          branch: payload?.branch,
          findings: payload?.findings ?? [],
          immutability,
        },
        headSha: head_sha,
      };
      if (outcome === 'FAIL') {
        result.notify = {
          type: 'review_fix',
          repo,
          prNumber: pr_number,
          message: 'Verification failed. Review and fix the requirements.',
        };
      }
      return result;
    }
  }

  if (phase === 'green') {
    if (outcome === 'PASS') {
      result.action = 'dispatch_review';
      const nextAttempt = await getNextAttempt(orgId, repo, pr_number);
      result.dispatchReviewSpec = {
        owner,
        repo: repoName,
        prNumber: pr_number,
        ref: payload?.branch ?? 'main',
        headSha: head_sha,
        attempt: nextAttempt,
      };
      return result;
    }

    if (outcome === 'FAIL') {
      const completedFixes = await getCountFixIterations(orgId, repo, pr_number);
      if (completedFixes >= MAX_FIX_ITERATIONS) {
        result.action = 'needs_human';
        result.notify = {
          type: 'escalation',
          repo,
          prNumber: pr_number,
          message: 'Maximum fix iterations reached. Escalation required.',
        };
      } else {
        result.action = 'create_claim';
        const nextAttempt = await getNextAttempt(orgId, repo, pr_number);
        const sourceRedClaimId = payload?.red_claim_id ?? claim.id;
        const immutability = Array.isArray(payload?.red_record?.test_hashes)
          ? payload.red_record.test_hashes.map((hash) => hash.path).filter(Boolean)
          : [];
        result.claimSpec = {
          orgId,
          repo,
          prNumber: pr_number,
          attempt: nextAttempt,
          claimType: 'review_fix',
          payload: {
            source_claim_id: sourceRedClaimId,
            source_green_claim_id: claim.id,
            branch: payload?.branch,
            findings: payload?.findings ?? [],
            immutability,
          },
          headSha: head_sha,
        };
      }
      return result;
    }

    if (outcome === 'SKIPPED') {
      const skipPolicy = payload?.verification?.skip_policy ?? 'allow_ungated';
      if (skipPolicy === 'allow_ungated') {
        result.action = 'dispatch_review';
        const nextAttempt = await getNextAttempt(orgId, repo, pr_number);
        result.dispatchReviewSpec = {
          owner,
          repo: repoName,
          prNumber: pr_number,
          ref: payload?.branch ?? 'main',
          headSha: head_sha,
          attempt: nextAttempt,
        };
      } else if (skipPolicy === 'require') {
        result.action = 'needs_human';
        result.notify = {
          type: 'escalation',
          repo,
          prNumber: pr_number,
          message: 'Verification skipped and policy requires human review.',
        };
      } else if (skipPolicy === 'manual') {
        result.action = 'pause';
        result.notify = {
          type: 'pause',
          repo,
          prNumber: pr_number,
          message: 'Verification skipped; awaiting manual decision.',
        };
      }
      return result;
    }
  }

  logger.warn({ msg: 'Unknown verify transition', phase, outcome, claimId: claim.id });
  return result;
}

export async function applyVerifyTransitionWithEffects(claim, verification, ctx, precomputedDecision = null) {
  const { repo, pr_number, payload } = claim;
  const [owner, repoName] = repo.split('/');

  const expectedNextAttempt = claim.attempt + 1;
  const decision = precomputedDecision ?? await applyVerifyTransition(claim, verification, ctx);
  if (
    decision.action === 'create_claim' &&
    decision.claimSpec?.attempt === expectedNextAttempt
  ) {
    await createClaimWithRetry(decision.claimSpec, createClaim);
    logger.info({
      msg: 'Created claim after verify transition',
      claimType: decision.claimSpec.claimType,
      attempt: decision.claimSpec.attempt,
    });
  }

  if (
    decision.action === 'dispatch_review' &&
    decision.dispatchReviewSpec?.attempt === expectedNextAttempt
  ) {
    await dispatchReview(decision.dispatchReviewSpec);
    logger.info({ msg: 'Dispatched re-review after green PASS', repo, prNumber: pr_number });
  }

  if (decision.action === 'needs_human') {
    const installCtx = await installationCtxForRepo(owner, repoName);
    await addLabel(owner, repoName, pr_number, 'needs-human', installCtx);
    logger.info({ msg: 'Added needs-human label', repo, prNumber: pr_number });
  }

  if (decision.action === 'pause' && payload?.verification?.skip_policy === 'manual') {
    const issueNumber = payload?.issue_number;
    if (issueNumber) {
      await recordPause({
        owner,
        repo: repoName,
        issueNumber,
        prNumber: pr_number,
        reason: 'verify-skipped-manual',
        context: 'Verification skipped with manual policy; awaiting human decision.',
        actor: 'fluent-flow',
      });
      logger.info({ msg: 'Recorded pause for manual skip policy', repo, prNumber: pr_number });
    } else {
      logger.warn({ msg: 'Manual skip policy without issue_number — no pause recorded', repo, prNumber: pr_number });
    }
  }

  if (decision.notify?.type === 'pr_comment') {
    const installCtx = await installationCtxForRepo(owner, repoName);
    await postComment(owner, repoName, pr_number, decision.notify.body, installCtx);
    logger.info({ msg: 'Posted verification PR comment', repo, prNumber: pr_number });
  }

  if (decision.notify) {
    const agentId = payload?.agent_id ?? (await resolveConfig(owner, repoName)).default_agent;
    if (agentId) {
      await dispatch({
        agentId,
        event: 'notification',
        payload: decision.notify,
      });
      logger.info({ msg: 'Dispatched notification after verify transition', type: decision.notify.type });
    }
  }

  const installCtx = await installationCtxForRepo(owner, repoName);
  const provider = getProvider({ provider: 'github', installation_id: installCtx.installation_id });
  const conclusion = verification.outcome === 'PASS'
    ? 'success'
    : verification.outcome === 'SKIPPED'
      ? 'neutral'
      : 'failure';
  await onClaimResolved(provider, claim, {
    conclusion,
    output: renderMatrixSummary(verification),
  });

  return decision;
}

export async function applyVerifyTransitionOnce(claim, verification, ctx, precomputedDecision = null) {
  // markVerificationTransitionApplied is a compare-and-set that moves
  // transition_applied_at from NULL to now(). We set the marker BEFORE running
  // side effects so replays can never re-run them — the effects (createClaim,
  // addLabel, postComment, dispatch) call external systems that are not
  // transactional and cannot be rolled back. Only one caller wins the CAS;
  // concurrent or retried callers see no row returned and skip the effects.
  const marker = await markVerificationTransitionApplied(claim.id);
  if (!marker) {
    const existing = await getVerificationResultByClaim(ctx.orgId, claim.id);
    if (!existing) throw new Error('Verification result is unavailable');
    return { applied: false, decision: precomputedDecision };
  }
  const decision = precomputedDecision ?? await applyVerifyTransition(claim, verification, ctx);
  const appliedDecision = await applyVerifyTransitionWithEffects(
    claim,
    verification,
    ctx,
    decision,
  );
  return { applied: true, decision: appliedDecision };
}


export async function handleVerifyRedispatchExhausted(claim, ctx) {
  const verification = buildRedispatchExhaustedVerification(claim);
  let stored = await getVerificationResultByClaim(claim.org_id, claim.id);
  if (!stored) {
    stored = await insertVerificationResult({
      orgId: claim.org_id,
      claimId: claim.id,
      repo: claim.repo,
      prNumber: claim.pr_number,
      phase: verification.phase,
      framework: verification.framework,
      outcome: verification.outcome,
      matrix: verification.matrix,
      manifest: null,
      testHashes: null,
      artifactSha: null,
      redBaseSha: verification.red_base_sha ?? null,
      greenSha: verification.green_sha ?? null,
    });
    if (!stored) stored = await getVerificationResultByClaim(claim.org_id, claim.id);
  }
  if (!stored) throw new Error('Verification result is unavailable');

  const applied = await applyVerifyTransitionOnce(claim, verification, ctx);

  logger.warn({
    msg: 'Verify re-dispatch exhausted; created terminal follow-up',
    repo: claim.repo,
    prNumber: claim.pr_number,
    claimId: claim.id,
    phase: verification.phase,
  });
  return { decision: applied.decision, verification };
}
export async function sweepStrandedVerifyClaims(db) {
  const errors = [];
  logger.info({ msg: 'Starting sweep for stranded verify claims' });

  const strandedWithResult = await db.execute(sql`
    SELECT c.id, c.org_id, c.repo, c.pr_number, c.attempt, c.payload, c.head_sha, c.status
    FROM agent_claims c
    INNER JOIN verification_results v ON v.claim_id = c.id
    WHERE c.claim_type = 'verify'
      AND c.status IN ('completed', 'failed')
      AND v.transition_applied_at IS NULL
  `);

  for (const claim of strandedWithResult.rows ?? strandedWithResult) {
    try {
      const resultRows = await db.execute(sql`
        SELECT phase, framework, outcome, matrix, test_hashes, artifact_sha, red_base_sha, green_sha
        FROM verification_results
        WHERE claim_id = ${claim.id}
      `);
      const resultRow = (resultRows.rows ?? resultRows)[0];
      if (!resultRow) continue;

      const verification = {
        phase: resultRow.phase,
        framework: resultRow.framework,
        outcome: resultRow.outcome,
        matrix: resultRow.matrix,
        test_hashes: resultRow.test_hashes,
        artifact_sha: resultRow.artifact_sha,
        red_base_sha: resultRow.red_base_sha,
        green_sha: resultRow.green_sha,
      };

      const applied = await applyVerifyTransitionOnce(
        claim,
        verification,
        { orgId: claim.org_id },
      );
      if (applied.applied) {
        logger.info({ msg: 'Replayed transition for stranded verify claim', claimId: claim.id });
      }
    } catch (err) {
      errors.push(err);
      logger.error({
        msg: 'Failed to replay transition for stranded verify claim',
        claimId: claim.id,
        error: err,
        safeToContinue: true,
      });
    }
  }

  const exhaustedWithoutResult = await db.execute(sql`
    SELECT c.id, c.org_id, c.repo, c.pr_number, c.attempt, c.payload, c.head_sha, c.status
    FROM agent_claims c
    WHERE c.claim_type = 'verify'
      AND c.status = 'failed'
      AND c.attempt >= 10
      AND NOT EXISTS (
        SELECT 1 FROM verification_results v WHERE v.claim_id = c.id
      )
      AND NOT EXISTS (
        SELECT 1 FROM agent_claims c2
        WHERE c2.org_id = c.org_id
          AND c2.repo = c.repo
          AND c2.pr_number = c.pr_number
          AND c2.attempt > c.attempt
      )
  `);

  for (const claim of exhaustedWithoutResult.rows ?? exhaustedWithoutResult) {
    try {
      await handleVerifyRedispatchExhausted(claim, { orgId: claim.org_id });
    } catch (err) {
      errors.push(err);
      logger.error({
        msg: 'Failed to recover exhausted verify claim',
        claimId: claim.id,
        error: err,
        safeToContinue: true,
      });
    }
  }

  if (errors.length > 0) {
    throw new AggregateError(errors, 'Verification transition sweep failed');
  }

  logger.info({ msg: 'Completed sweep for stranded verify claims' });
}