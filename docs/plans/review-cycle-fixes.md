# Plan: Review Cycle Fixes (PRs #86, #87, #88)

**Date:** 2026-05-07
**Status:** Draft

## Summary

Three bugs in the review cycle preventing proper fix dispatch and re-review chaining.

---

## Bug 1: PASS with advisory issues — no fix dispatched (PR #86)

### Root Cause

In `review-manager.js`, `handleReviewResult()` treats `status === 'PASS'` as a terminal state:

```js
if (status === 'PASS') {
  // Enable auto-merge
  // Complete the active claim
  return { action: 'pass' };
}
```

It enables auto-merge and completes the claim, but **never checks for advisory issues**. The entire advisory array is ignored. Only the FAIL path creates `review_fix` claims.

### Fix

**File:** `packages/fluent-flow/src/engine/review-manager.js`
**Function:** `handleReviewResult()`, inside the `if (status === 'PASS')` block

After enabling auto-merge and completing the active review claim, add logic to create a `review_fix` claim when advisory issues exist:

```js
if (status === 'PASS') {
  // ... existing auto-merge code ...

  // ... existing claim completion code ...

  // NEW: Dispatch advisory fix even on PASS
  if (advisory && advisory.length > 0) {
    try {
      const passOrgId = await resolveOrgId(owner, repo);
      const passCtx = ctx ?? await installationCtxForRepo(owner, repo);

      // Calculate next attempt to avoid unique constraint collision
      // The review claim was at `attempt`, so review_fix should be at attempt + 1
      const fixClaim = await createClaim({
        orgId: passOrgId,
        repo: repoKey,
        prNumber,
        attempt: attempt + 1,
        claimType: 'review_fix',
        payload: {
          message: `Advisory issues from PASS review (attempt ${attempt})`,
          issues: advisory.map((a) => ({ ...a, severity: 'advisory' })),
          onFailure: config.reviewer?.on_failure,
          branch: headBranch,
        },
        headSha: reviewSha,
      });

      if (fixClaim) {
        if (passCtx?.installation_id) {
          const providerClient = getProvider({ installation_id: passCtx.installation_id });
          onClaimDispatched(providerClient, { ...fixClaim, head_sha: reviewSha, installation_id: passCtx.installation_id })
            .catch((err) => logger.warn({ msg: 'onClaimDispatched failed for advisory fix', error: err.message }));
        }

        // Notify agent to pick up the advisory fix
        const notifyAgent = agentId ?? config.default_agent ?? config.agent_id;
        if (notifyAgent) {
          await dispatch({
            agentId: notifyAgent,
            event: 'review_fix',
            payload: {
              message: `PASS with ${advisory.length} advisory issue(s) — review and fix if worthwhile`,
              repo: repoKey,
              prNumber,
            },
          });
        }

        logger.info({ msg: 'Advisory fix claim created on PASS', repo: repoKey, prNumber, advisoryCount: advisory.length });
      }
    } catch (err) {
      logger.warn({ msg: 'Failed to create advisory fix claim on PASS', error: err.message, repo: repoKey, prNumber });
    }
  }

  return { action: 'pass' };
}
```

**Key design decisions:**
- Auto-merge is still enabled (PASS means no blocking issues)
- Advisory fix runs in parallel with the merge window — the fixer pushes fixes, CI re-runs, and the next review cycle catches any regressions
- The fixer agent decides what's worth fixing (Victor's requirement)
- If auto-merge fires before the fixer finishes, the fixer's push simply has no effect (or the PR can be reopened)

### Risks / Edge Cases

1. **Race with auto-merge**: If auto-merge fires before the fixer pushes, the fixer's commit may fail or get lost. **Mitigation**: This is acceptable — advisory issues are non-blocking by definition. If the PR merges with advisories, they can be addressed in a follow-up.
2. **Infinite cycle risk**: If the advisory fixer's push triggers CI → review → PASS with advisories again. **Mitigation**: The `claimDispatch` / retry counter mechanism limits cycles. Also, advisory-only fixes are unlikely to introduce new advisories.
3. **`attempt` numbering**: Using `attempt + 1` keeps it one above the review attempt. The unique constraint on `(org_id, repo, pr_number, claim_type, attempt)` prevents duplicates.

---

## Bug 2 & 3: FAIL review fix completed, but no re-review triggered (PRs #87, #88)

### Root Cause Analysis

The expected chain is:
1. `review` FAIL → `review_fix` claim created (via `handleReviewResult` FAIL path) ✅
2. Agent picks up `review_fix`, pushes fixes ✅
3. CI runs and passes ✅
4. `handleCheckRunSuccess` fires, detects completed `review_fix` → creates `test_verify` claim ✅ (code exists)
5. `test_verify` completes → auto-chains to `dispatchReview()` via runner.js ✅ (code exists)

**The break is in step 4 → step 5.** Here's why:

When `handleCheckRunSuccess` creates the `test_verify` claim, it does an **early return**:
```js
// check-run-handler.js line ~230
if (testVerifyClaim) {
  logger.info({ msg: 'Created test_verify claim after review_fix + CI pass', ... });
  return;  // ← RETURNS HERE, never dispatches review
}
```

So far so good — the `test_verify` claim is created. The problem is in **what happens next**.

The `test_verify` claim gets picked up by a runner. The runner completes it and calls `POST /api/runner/claim` with `{ status: 'completed', claim_type: 'test_verify' }`. 

Looking at `runner.js`, the auto-chain for `test_verify → re-review` is:
```js
// Auto-chain: test_verify → re-review
if (claimType === 'test_verify') {
  const [owner, repoName] = repo.split('/');
  const { dispatchReview } = await import('../engine/review-manager.js');
  const headBranch = claim.payload?.branch ?? 'main';
  await dispatchReview({ owner, repo: repoName, prNumber: pr_number, ref: headBranch, attempt: attempt + 1 });
}
```

**This calls `dispatchReview()` without a `headSha` parameter.** Looking at `dispatchReview()`:

```js
if (installationId && headSha) {
  // Creates check run on GitHub
  onClaimDispatched(providerClient, { ...newClaim, head_sha: headSha, ... })
} else {
  logger.warn({ msg: 'Skipping onClaimDispatched — missing installation_id or headSha', ... });
}
```

The claim gets created but **without a check run** on GitHub. This isn't a fatal problem for the re-review itself (the claim exists and a runner can pick it up), but the `headSha` is also needed for `claimDispatch` later.

**However, the bigger problem is the `headSha` for the new review claim.** The `test_verify` claim's payload stores `{ branch: pr.head?.ref }` but not the head SHA. When the auto-chain calls `dispatchReview`, it passes `ref: headBranch` but no `headSha`. The review claim is created without `headSha`.

Now here's the critical issue: when the re-review completes and calls `handleReviewResult`, the `reviewSha` passed is `pr.head.sha` from the webhook payload. But the **retry record** (which `claimDispatch` uses) was potentially already reset or the SHA may have changed between fix pushes and re-review.

Let me trace more carefully...

**Actually, the most likely failure point is simpler:**

When `handleClaimResult` in `runner.js` auto-chains `test_verify → re-review`, it calls:
```js
await dispatchReview({ owner, repo: repoName, prNumber: pr_number, ref: headBranch, attempt: attempt + 1 });
```

This goes to `dispatchReview()` which:
1. Dismisses stale reviews ✅
2. Creates a `review` claim at `attempt: attempt + 1` ✅
3. Notifies runner ✅

The review should be dispatched. Let me check if `dispatchReview` requires an `issueNumber` for pause checking...

Yes, `dispatchReview` checks:
```js
if (issueNumber) {
  const activePause = await getActivePause(repoKey, issueNumber);
  if (activePause) return { claimed: false, reason: 'paused' };
}
```

But the auto-chain doesn't pass `issueNumber`. So pause checking is skipped. That shouldn't cause the issue unless the PR is paused (it shouldn't be for PRs #87, #88).

**Let me re-examine the actual flow more carefully.**

The key question: does the runner actually report `test_verify` claim completion?

Looking at `handleClaimResult` in runner.js:

```js
const existingClaim = await getClaimByAttempt(org_id, repo, pr_number, attempt);
const claimType = existingClaim?.claim_type ?? 'review_fix';
const claim = await completeClaim(org_id, repo, pr_number, attempt, claimType);
```

The runner sends `{ status, repo, pr_number, attempt }` but **not `claim_type`**. The claim type is looked up from the DB. This should work correctly.

**Wait — I think I found the actual bug.** Let me re-examine the `test_verify` claim creation in `check-run-handler.js`:

```js
const testVerifyClaim = await createClaim({
  orgId: resolvedOrgId,
  repo: repoKey,
  prNumber: pr.number,
  attempt: nextTestVerifyAttempt,
  claimType: 'test_verify',
  payload: { branch: pr.head?.ref },
  headSha: checkRun.head_sha,
});
```

This creates the claim. Now the runner picks it up and reports completion with `attempt: nextTestVerifyAttempt`. The auto-chain triggers `dispatchReview` at `attempt: nextTestVerifyAttempt + 1`.

**But here's the problem:** `dispatchReview` creates a `review` claim. The `claimDispatch` function in `handleCheckRunSuccess` uses the `review_retries` table to gate dispatches. The retry counter may have been incremented during the initial FAIL path but not reset.

Actually wait, let me reconsider. The re-review dispatch from `test_verify` auto-chain calls `dispatchReview()` directly — it does NOT go through `handleCheckRunSuccess`. It bypasses the `claimDispatch` gate entirely. So the review should be created.

**The real issue may be timing/ordering:**

1. `review_fix` agent pushes fix commit (new SHA)
2. CI runs on the new SHA
3. `handleCheckRunSuccess` fires for the new SHA
4. It checks for completed `review_fix` claim → finds one → creates `test_verify`
5. `test_verify` runner completes, auto-chains to `dispatchReview()`
6. `dispatchReview()` creates a new `review` claim
7. Reviewer agent picks up the review claim, reviews, posts result
8. Webhook `pull_request_review` fires → `handlePullRequestReview` → `handleReviewResult`

**OR**, the `test_verify` claim might not actually be getting picked up by a runner, or the runner might be failing it silently.

**Actually, I think I've identified the most probable root cause:**

Looking at `handleCheckRunSuccess` more carefully:

```js
// Check if a review_fix claim was recently completed for this PR
let hasReviewFixClaim = false;
// ...
const rows = await db
  .select({ one: agentClaims.id })
  .from(agentClaims)
  .where(
    and(
      eq(agentClaims.orgId, resolvedOrgId),
      eq(agentClaims.repo, repoKey),
      eq(agentClaims.prNumber, pr.number),
      eq(agentClaims.claimType, 'review_fix'),
      eq(agentClaims.status, 'completed'),
    ),
  )
  .limit(1);
hasReviewFixClaim = rows.length > 0;
```

This query checks if **any** completed `review_fix` claim exists for this PR, ever. This is not scoped to a specific SHA or attempt. Once a single `review_fix` has ever completed on this PR, **every subsequent CI pass** will route through the `test_verify` path and skip the direct `dispatchReview()`.

**The test_verify path early-returns**, so if `test_verify` claim creation succeeds, the function returns without calling `dispatchReview()` at the bottom. The re-review is now dependent on:
1. The `test_verify` claim being picked up by a runner
2. The runner completing it
3. The auto-chain in `runner.js` triggering `dispatchReview()`

If any of these steps fails, the re-review never happens.

**Possible failure points in the test_verify path:**

1. **No runner picks up `test_verify`**: If the agent/harness doesn't handle `test_verify` claim type, it may ignore it or fail silently.
2. **Runner doesn't report `test_verify` completion**: The harness may complete the verification but not call the claim result endpoint.
3. **`test_verify` claim already exists (idempotency check)**: The code checks for an existing `test_verify` claim for the same `headSha`. If a matrix job fires multiple `check_run.completed` events for the same SHA, the first creates `test_verify`, the second sees it exists and falls through to `dispatchReview()` — this is actually fine.
4. **`createClaim` returns null**: If the `(org, repo, pr, claim_type, attempt)` unique constraint already has a row, `createClaim` returns null and the code falls through to `dispatchReview()`. This could happen on webhook redelivery.

**Most likely scenario**: The `test_verify` claim IS being created, but the runner harness doesn't properly handle `test_verify` claims — either it doesn't pick them up, or it completes them without calling the claim result endpoint. Without seeing the runner harness code and logs, the safest fix is to make the chain more robust.

### Fix

**Primary fix: Make `handleCheckRunSuccess` more robust**

**File:** `packages/fluent-flow/src/providers/github/check-run-handler.js`
**Function:** `handleCheckRunSuccess()`

The `test_verify` step is an optimization — it verifies tests pass before re-review. But it creates a fragile dependency chain. The fix should:

1. **Scope the `review_fix` check to the current attempt cycle** — don't match stale `review_fix` claims from earlier cycles
2. **Add a fallback**: If `test_verify` claim creation fails (returns null), ensure the review still gets dispatched
3. **Pass `headSha` in the auto-chain** so the re-dispatched review has the correct SHA

**Specific changes:**

#### Change 1: Scope `review_fix` check to current head SHA

The query should check that the `review_fix` was for the **same head SHA** that just passed CI. Otherwise, a stale `review_fix` from a prior cycle could interfere.

```js
// BEFORE:
const rows = await db
  .select({ one: agentClaims.id })
  .from(agentClaims)
  .where(
    and(
      eq(agentClaims.orgId, resolvedOrgId),
      eq(agentClaims.repo, repoKey),
      eq(agentClaims.prNumber, pr.number),
      eq(agentClaims.claimType, 'review_fix'),
      eq(agentClaims.status, 'completed'),
    ),
  )
  .limit(1);

// AFTER:
const rows = await db
  .select({ one: agentClaims.id })
  .from(agentClaims)
  .where(
    and(
      eq(agentClaims.orgId, resolvedOrgId),
      eq(agentClaims.repo, repoKey),
      eq(agentClaims.prNumber, pr.number),
      eq(agentClaims.claimType, 'review_fix'),
      eq(agentClaims.status, 'completed'),
      eq(agentClaims.headSha, checkRun.head_sha),
    ),
  )
  .limit(1);
```

This ensures only `review_fix` claims for the **exact same commit** trigger the `test_verify` path. A `review_fix` from a prior commit won't interfere.

#### Change 2: Remove the early return and ensure review dispatch always happens

Instead of early-returning when `test_verify` is created, let the function fall through to also dispatch a review. The `test_verify` and `review` can run in parallel, or we can make the review conditional on `test_verify` not being created.

**Better approach:** Keep the early return but add logging and ensure the `test_verify` auto-chain is reliable. Actually, the simplest and most robust fix:

**Remove the `test_verify` intermediate step entirely for the fix-to-re-review path.** The `test_verify` is an optimization that adds a hop in the chain. CI already passed — the tests are verified. Just dispatch the re-review directly.

```js
// BEFORE (the hasReviewFixClaim block):
if (hasReviewFixClaim) {
  try {
    // ... create test_verify claim ...
    if (testVerifyClaim) {
      logger.info({ msg: 'Created test_verify claim after review_fix + CI pass', ... });
      return;  // ← early return
    }
  } catch (err) { ... }
}

// ... dispatchReview at the bottom ...

// AFTER:
// Remove the entire test_verify block. The re-review is dispatched directly
// via dispatchReview at the bottom, which already handles the review cycle.
// The retry counter / claimDispatch gating ensures we don't over-dispatch.
```

Wait, but then we lose the `test_verify` step. Let me think about what `test_verify` actually does...

The `test_verify` claim type is supposed to run E2E verification. If we skip it, we lose the verification step. But the CI check that triggered `handleCheckRunSuccess` already confirms tests pass. So `test_verify` may be redundant here.

**Revised approach: Keep `test_verify` but fix the chain reliability.**

The most targeted fix with least risk:

#### Fix A: Pass `headSha` in the test_verify → review auto-chain

**File:** `packages/fluent-flow/src/routes/runner.js`

```js
// BEFORE:
if (claimType === 'test_verify') {
  try {
    const [owner, repoName] = repo.split('/');
    const { dispatchReview } = await import('../engine/review-manager.js');
    const headBranch = claim.payload?.branch ?? 'main';
    await dispatchReview({ owner, repo: repoName, prNumber: pr_number, ref: headBranch, attempt: attempt + 1 });
  }
}

// AFTER:
if (claimType === 'test_verify') {
  try {
    const [owner, repoName] = repo.split('/');
    const { dispatchReview } = await import('../engine/review-manager.js');
    const headBranch = claim.payload?.branch ?? 'main';
    const headSha = claim.head_sha;  // ← add this
    await dispatchReview({ owner, repo: repoName, prNumber: pr_number, ref: headBranch, headSha, attempt: attempt + 1 });
  }
}
```

This ensures the re-dispatched review has the correct `headSha` for check-run creation.

#### Fix B: Scope the review_fix query to the current SHA (as described above)

This prevents stale `review_fix` claims from triggering the `test_verify` path when it shouldn't.

#### Fix C: Add issueNumber to the auto-chain dispatchReview call

```js
// Also pass issueNumber so pause checking works
await dispatchReview({
  owner, repo: repoName, prNumber: pr_number,
  ref: headBranch, headSha,
  attempt: attempt + 1,
  issueNumber: claim.payload?.issueNumber,  // ← add this
});
```

But the `test_verify` claim payload only stores `{ branch }`. We need to also store `issueNumber` when creating the `test_verify` claim.

**File:** `packages/fluent-flow/src/providers/github/check-run-handler.js`

```js
// BEFORE:
payload: { branch: pr.head?.ref },

// AFTER:
payload: { branch: pr.head?.ref, issueNumber },
```

---

## Summary of All Changes

### File 1: `packages/fluent-flow/src/engine/review-manager.js`

| Location | Change | Bug |
|----------|--------|-----|
| `handleReviewResult()`, PASS block, after claim completion | Add advisory fix claim creation when `advisory.length > 0` on PASS | Bug 1 |

### File 2: `packages/fluent-flow/src/providers/github/check-run-handler.js`

| Location | Change | Bug |
|----------|--------|-----|
| `handleCheckRunSuccess()`, review_fix query | Add `eq(agentClaims.headSha, checkRun.head_sha)` condition | Bugs 2, 3 |
| `handleCheckRunSuccess()`, test_verify claim creation | Add `issueNumber` to payload | Bugs 2, 3 |

### File 3: `packages/fluent-flow/src/routes/runner.js`

| Location | Change | Bug |
|----------|--------|-----|
| `handleClaimResult()`, test_verify auto-chain | Pass `headSha` from `claim.head_sha` to `dispatchReview()` | Bugs 2, 3 |
| `handleClaimResult()`, test_verify auto-chain | Pass `issueNumber` from `claim.payload?.issueNumber` | Bugs 2, 3 |

---

## Validation Plan

1. **Bug 1 test**: Create a PR that gets reviewed as PASS with advisory issues. Verify:
   - Auto-merge is enabled ✅
   - `review_fix` claim is created for advisory items ✅
   - Fixer agent picks up the claim ✅
   - Fixer pushes fix (or decides not to) ✅

2. **Bug 2/3 test**: Create a PR that gets reviewed as FAIL. Verify:
   - `review_fix` claim is created ✅
   - Agent pushes fix, CI passes ✅
   - `handleCheckRunSuccess` detects review_fix for correct SHA ✅
   - `test_verify` claim is created ✅
   - `test_verify` completes → auto-chains to `dispatchReview()` ✅
   - Re-review is dispatched with correct `headSha` ✅

3. **Edge case**: Multiple CI check runs for same SHA (matrix jobs). Verify:
   - Only one `test_verify` is created (idempotency) ✅
   - Re-review isn't double-dispatched ✅

4. **Edge case**: Stale `review_fix` from prior cycle. Verify:
   - Doesn't trigger `test_verify` on new SHA ✅

---

## Risks

1. **Auto-merge race (Bug 1)**: Advisory fix pushes after merge completes. Low risk — advisory fixes can become a follow-up PR.
2. **Test_verify runner support (Bugs 2/3)**: If the runner harness doesn't handle `test_verify` claims, the chain still breaks. Alternative: bypass `test_verify` entirely and go straight to re-review after CI pass + review_fix. This is the nuclear option if the runner doesn't support it.
3. **Attempt numbering collision**: The `attempt + 1` logic in multiple places needs to stay consistent. Consider centralizing the next-attempt calculation.

## Open Questions

1. Does the runner harness actually handle `test_verify` claims? If not, we should remove the `test_verify` intermediate step entirely and go directly to re-review.
2. Should advisory fixes on PASS block auto-merge? Currently the plan enables auto-merge AND dispatches fixer. An alternative is to delay auto-merge until the advisory fixer completes.
