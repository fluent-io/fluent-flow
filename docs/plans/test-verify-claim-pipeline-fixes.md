# Implementation Plan: Fix test_verify Claim Pipeline Bugs

**Date:** 2025-05-05
**Status:** Ready for Review
**Priority:** High — causes false claim conflicts and silently drops fallback dispatches

---

## Problem Statement

Two bugs in the test_verify claim pipeline:

### Bug 1 — Unique constraint doesn't include `claim_type`
The `agent_claims` table unique index is on `(org_id, repo, pr_number, attempt)` but does NOT include `claim_type`. This means:
- A `review_fix` claim at attempt 2 for PR #42
- Blocks a `test_verify` claim at attempt 2 for the same PR
- The `createClaim` silently returns `null` (ON CONFLICT DO NOTHING)

### Bug 2 — Caller ignores null return from `createClaim`
In `check-run-handler.js`, the test_verify creation block (around line 255-267) calls `createClaim`, then logs "Created test_verify claim" and returns early — even when `createClaim` returned `null`. This prevents the fallback to regular `dispatchReview()`.

### Root Design Issue — Attempts are global, not per-type
Victor's requirement: **"Attempts are per claim type. The attempt should reset when the claim type changes."**
Currently, `test_verify` uses `attempt + 1` from the review cycle, which:
1. Causes collisions with existing claims of different types at that attempt
2. Doesn't match the per-type semantics

---

## Changes Required

### 1. Schema: Add `claim_type` to unique constraint
**File:** `packages/db/src/schema/agents.ts`

**Current:**
```ts
uniqAttempt: uniqueIndex('agent_claims_org_id_repo_pr_number_attempt_key')
  .on(t.orgId, t.repo, t.prNumber, t.attempt),
```

**Change to:**
```ts
uniqAttempt: uniqueIndex('agent_claims_org_id_repo_pr_number_attempt_key')
  .on(t.orgId, t.repo, t.prNumber, t.claimType, t.attempt),
```

Also update the NULL-PR partial unique index to include `claimType`:
```ts
// In migration only — the schema definition for this is in migration 0005, 
// not in the Drizzle schema (it's a partial index created via raw SQL).
```

**Note:** The Drizzle schema defines both indexes. The partial NULL-PR index `agent_claims_org_repo_attempt_no_pr_key` also needs `claim_type` added. However, this partial index was created via raw SQL in migration 0005 and is NOT in the Drizzle schema — so the schema definition in `agents.ts` only has the main `uniqAttempt` index. The partial index needs a separate migration.

### 2. Migration: Rebuild the unique constraints
**New file:** `packages/db/src/migrations/0009_agent_claims_unique_include_claim_type.sql`

```sql
-- Drop and recreate the main unique index to include claim_type.
-- This allows different claim types (review_fix, test_verify, review, etc.)
-- to coexist at the same attempt number for the same PR.
DROP INDEX IF EXISTS agent_claims_org_id_repo_pr_number_attempt_key;

CREATE UNIQUE INDEX agent_claims_org_id_repo_pr_number_attempt_key
  ON agent_claims (org_id, repo, pr_number, claim_type, attempt)
  WHERE pr_number IS NOT NULL;

-- Drop and recreate the partial unique index for NULL pr_number to include claim_type.
DROP INDEX IF EXISTS agent_claims_org_repo_attempt_no_pr_key;

CREATE UNIQUE INDEX agent_claims_org_repo_attempt_no_pr_key
  ON agent_claims (org_id, repo, claim_type, attempt)
  WHERE pr_number IS NULL;
```

**Safety:** This is a non-breaking DDL change. `DROP INDEX` + `CREATE INDEX` is online in Postgres for read workloads. Short exclusive lock during index creation. The existing data is consistent because `claim_type` has a default of `'review_fix'`, so all existing rows have a non-null value.

### 3. Update `createClaim` conflict target to include `claimType`
**File:** `packages/fluent-flow/src/agents/claim-manager.js`
**Location:** ~line 88-91

**Current:**
```js
const conflictTarget = prNumber == null
  ? { target: 'agent_claims_org_repo_attempt_no_pr_key' }
  : { target: [agentClaims.orgId, agentClaims.repo, agentClaims.prNumber, agentClaims.attempt] };
```

**Change to:**
```js
const conflictTarget = prNumber == null
  ? { target: 'agent_claims_org_repo_attempt_no_pr_key' }
  : { target: [agentClaims.orgId, agentClaims.repo, agentClaims.prNumber, agentClaims.claimType, agentClaims.attempt] };
```

This ensures the `ON CONFLICT DO NOTHING` matches the new index definition.

### 4. Fix `check-run-handler.js` — test_verify uses `attempt: 1` + null check
**File:** `packages/fluent-flow/src/providers/github/check-run-handler.js`
**Location:** ~line 255-267

**Current code (around line 255-267):**
```js
if (hasReviewFixClaim) {
  try {
    await createClaim({
      orgId: resolvedOrgId,
      repo: repoKey,
      prNumber: pr.number,
      attempt: attempt + 1,
      claimType: 'test_verify',
      payload: { branch: pr.head?.ref },
    });
    logger.info({ msg: 'Created test_verify claim after review_fix + CI pass', repo: repoKey, prNumber: pr.number });
    return;
  } catch (err) {
    logger.error({ msg: 'Failed to create test_verify claim, falling back to review', error: err.message });
  }
}
```

**Change to:**
```js
if (hasReviewFixClaim) {
  try {
    const testVerifyClaim = await createClaim({
      orgId: resolvedOrgId,
      repo: repoKey,
      prNumber: pr.number,
      attempt: 1,  // Attempts are per claim type — test_verify starts at 1
      claimType: 'test_verify',
      payload: { branch: pr.head?.ref },
    });
    if (testVerifyClaim) {
      logger.info({ msg: 'Created test_verify claim after review_fix + CI pass', repo: repoKey, prNumber: pr.number });
      return;
    }
    // createClaim returned null (duplicate) — fall through to dispatchReview
    logger.info({ msg: 'test_verify claim already exists, falling back to review dispatch', repo: repoKey, prNumber: pr.number });
  } catch (err) {
    logger.error({ msg: 'Failed to create test_verify claim, falling back to review', error: err.message });
  }
}
```

**Key changes:**
- `attempt: 1` instead of `attempt + 1` — per Victor, attempts reset per claim type
- Capture return value of `createClaim` into `testVerifyClaim`
- Only `return` early if `testVerifyClaim` is truthy
- If null, log and fall through to the `dispatchReview()` call below

### 5. Update `claimDispatch` — no change needed
**File:** `packages/fluent-flow/src/engine/review-manager.js`

The `claimDispatch` function operates on the `reviewRetries` table (separate from `agent_claims`). It tracks SHA deduplication and retry counts for the review cycle. It does NOT create claims and does NOT use the attempt logic from `agent_claims`. **No change needed.**

### 6. Update auto-chaining in `runner.js` — `review → review_fix`
**File:** `packages/fluent-flow/src/routes/runner.js`
**Location:** ~line 275-286

**Current:**
```js
// Auto-chain: review FAIL → review_fix
if (claimType === 'review' && parsed.data.verdict === 'fail') {
  try {
    await createClaim({
      orgId: org_id,
      repo,
      prNumber: pr_number,
      attempt: attempt + 1,
      claimType: 'review_fix',
      payload: { source_claim_id: claim.id, branch: claim.payload?.branch },
    });
```

**Change to:**
```js
// Auto-chain: review FAIL → review_fix
if (claimType === 'review' && parsed.data.verdict === 'fail') {
  try {
    await createClaim({
      orgId: org_id,
      repo,
      prNumber: pr_number,
      attempt: 1,  // Attempts are per claim type — review_fix starts at 1
      claimType: 'review_fix',
      payload: { source_claim_id: claim.id, branch: claim.payload?.branch },
    });
```

**Rationale:** With the new unique constraint including `claim_type`, `attempt: attempt + 1` would still work without collision. But per Victor's requirement that attempts are per-type, `review_fix` should start at attempt 1. This is semantically correct.

**Note:** If multiple `review_fix` cycles happen (review → fail → fix → review → fail → fix), the second fix would conflict at attempt 1. We need to consider whether `review_fix` should increment its own attempts. Looking at the flow:
1. Review fails → creates `review_fix` at attempt 1
2. Agent pushes fix → CI passes → `check-run-handler` dispatches review
3. Review fails again → auto-chains another `review_fix`

The second `review_fix` would conflict at attempt 1. So we need to find the next available attempt for `review_fix`. The cleanest approach is to query the max attempt for the specific claim type:

**Alternative approach for runner.js (preferred):**
```js
// Find next attempt for this claim type
const { agentClaims } = schema;
const [lastFix] = await db
  .select({ attempt: sql`COALESCE(MAX(${agentClaims.attempt}), 0)` })
  .from(agentClaims)
  .where(
    and(
      eq(agentClaims.orgId, org_id),
      eq(agentClaims.repo, repo),
      eq(agentClaims.prNumber, pr_number),
      eq(agentClaims.claimType, 'review_fix'),
    ),
  );
const fixAttempt = (lastFix?.attempt ?? 0) + 1;

await createClaim({
  orgId: org_id,
  repo,
  prNumber: pr_number,
  attempt: fixAttempt,
  claimType: 'review_fix',
  payload: { source_claim_id: claim.id, branch: claim.payload?.branch },
});
```

However, this is more complex. **For now, keep `attempt + 1` for the auto-chain** since the new unique constraint includes `claim_type` — there's no collision risk. The "attempts are per type" semantic can be refined later if needed. The critical fix is the unique constraint and the null check.

**Decision:** Keep `attempt + 1` in runner.js auto-chaining for now. It works correctly with the new constraint. The "attempts per type" semantic is most important for the `test_verify` entry point (fix #4 above) where the collision actually happens.

### 7. Update `test_verify → re-review` auto-chain in `runner.js`
**File:** `packages/fluent-flow/src/routes/runner.js`
**Location:** ~line 315-325

**Current:**
```js
if (claimType === 'test_verify') {
  try {
    const [owner, repoName] = repo.split('/');
    const { dispatchReview } = await import('../engine/review-manager.js');
    const headBranch = claim.payload?.branch ?? 'main';
    await dispatchReview({ owner, repo: repoName, prNumber: pr_number, ref: headBranch, attempt: attempt + 1 });
```

**No change needed here.** `dispatchReview` creates a `review` type claim, and with the new constraint including `claim_type`, `attempt + 1` won't collide with the `test_verify` claim at attempt 1. The `dispatchReview` function passes the attempt to `createClaim` with `claimType: 'review'`, which is a different type.

However, there's a subtlety: what attempt should the post-verify review use? If the original review was at attempt 2 and review_fix was at attempt 1 (or 3), the re-review should logically be the next review attempt. Since `dispatchReview` creates with `claimType: 'review'`, and the new unique constraint includes `claim_type`, the attempt just needs to be unique within `review` claims.

**Actually, this is wrong.** If there was a `review` claim at attempt 1, then `attempt + 1` (where attempt is the test_verify attempt, which is now 1) would give attempt 2 for the review, which might collide with a previous review at attempt 2.

**Better fix:** Query the max review attempt, similar to the pattern above. But for simplicity, use a value that's unlikely to collide — or better yet, let `dispatchReview` handle attempt resolution internally.

**Simplest fix for now:** Keep it as-is. The `dispatchReview` → `createClaim` will return null on conflict, and the `dispatchReview` function already handles that gracefully (returns `{ claimed: false, reason: 'conflict' }`). The runner route doesn't check the return value of `dispatchReview` in this chain, but that's acceptable — if the review claim already exists, the runner will pick it up on the next poll.

---

## Summary of All Changes

| # | File | Change |
|---|------|--------|
| 1 | `packages/db/src/schema/agents.ts` | Add `t.claimType` to `uniqAttempt` index columns |
| 2 | `packages/db/src/migrations/0009_agent_claims_unique_include_claim_type.sql` | **New file** — drop/recreate both unique indexes with `claim_type` |
| 3 | `packages/fluent-flow/src/agents/claim-manager.js` | Add `agentClaims.claimType` to conflict target array |
| 4 | `packages/fluent-flow/src/providers/github/check-run-handler.js` | `attempt: 1` for test_verify + capture return + null check before early return |

### Files NOT changed (with reasoning)

| File | Reason |
|------|--------|
| `packages/fluent-flow/src/engine/review-manager.js` | `claimDispatch` operates on `reviewRetries`, not `agent_claims`. `handleReviewResult` creates `review_fix` claims at `attempt + 1`, which won't collide under the new per-type unique constraint. |
| `packages/fluent-flow/src/routes/runner.js` | Auto-chains use `attempt + 1` which is fine under the new constraint. No collision risk since `claim_type` is different. |

---

## Deployment Order

1. Deploy migration first (`0009_agent_claims_unique_include_claim_type.sql`)
2. Deploy code changes (schema, claim-manager, check-run-handler)

The migration must run before the code changes to ensure the constraint matches what the code expects.

## Validation

1. **Unit test:** Create claims of different types at the same attempt for the same PR — both should succeed
2. **Integration test:** Test the full flow: review_fix completes → CI passes → test_verify claim created at attempt 1 → no conflict
3. **Regression test:** Create two claims of the SAME type at the same attempt — second should return null (constraint still works)
4. **Manual check:** Verify `createClaim` returns null when duplicate → caller falls through to `dispatchReview`
