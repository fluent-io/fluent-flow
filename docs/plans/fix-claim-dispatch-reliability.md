# Fix Claim Dispatch Reliability

**Date:** 2026-05-05
**Status:** Draft
**Author:** fluent-flow-architect

---

## 1. Problem Summary

Three interrelated bugs in the claim/dispatch pipeline cause PRs to become orphaned — no runner picks up the work, and there is no recovery path.

### Bug 1: Claims are pre-assigned to sessions, creating orphans

`createClaim()` resolves an online session and writes `status = 'claimed'` + `session_id = <resolved>` directly into the DB. The claim is then pushed to the runner via the in-memory long-poll queue. But if that push is lost (server restart, runner restart, race condition), the claim sits in `claimed` state forever — `claimPendingWork()` only picks up `status = 'pending' AND session_id IS NULL`. The expiry worker will eventually mark it `expired`, but that triggers Bug 2.

**Root cause:** `createClaim()` conflates claim creation with claim assignment. These should be separate lifecycle steps.

### Bug 2: No auto-retry for expired claims

The expiry worker marks claims as `expired` and sets the session to `offline`. That's it — the claim is dead. The unique constraint `(org_id, repo, pr_number, attempt)` prevents creating a new claim at the same attempt. The PR has no recovery path until a human manually intervenes.

**Root cause:** Expiry is terminal. There is no re-dispatch mechanism.

### Bug 3: Runner hangs after network failures

The runner has exponential backoff with a `maxPollFailures` cap (default 30), but:
- At max backoff (60s), 30 failures takes ~30 minutes of sustained failure
- After reaching the cap, the runner stops entirely (`running = false`) — it does NOT exit the process
- The container stays "Up" but does nothing
- There is no external watchdog to detect and recover from this state

**Root cause:** No process-level health check or forced exit on persistent failure.

### Additional issues

- `onClaimDispatched` silently skips when `installation_id` or `headSha` is missing — no check-run is created on GitHub, so the user sees nothing in the PR UI
- `dispatchReview` returns normally even when claim creation is skipped (conflict), making callers think the dispatch succeeded
- The outbound queue insert for check-run creation has been observed to fail — needs investigation

---

## 2. Proposed Changes

### Change 1: Always create claims as `pending`, `session_id = NULL`

**File:** `packages/fluent-flow/src/agents/claim-manager.js`
**Function:** `createClaim()`

**Current:**
```js
const status = sessionId ? 'claimed' : 'pending';
const claimedAt = sessionId ? new Date() : null;
const expiresAt = sessionId ? new Date(Date.now() + ttlMs) : null;
```

**New:** Always set `status = 'pending'`, `sessionId = null`, `claimedAt = null`, `expiresAt = null`. Remove the `resolveSession()` / `findAvailableSession()` calls from `createClaim()` entirely. The claim sits in `pending` state until a runner picks it up via `claimPendingWork()`.

Keep the long-poll push as a **notification hint** — but resolve the session separately at dispatch time (in `review-manager.js` / `dispatcher.js`) rather than in `createClaim()`. If the push is lost, the runner still picks up the claim on its next poll via the `claimPendingWork()` path.

**Concrete diff:**

```js
export async function createClaim({ orgId, repo, prNumber, attempt, agentId, payload, claimType = 'review_fix', ttlMs = DEFAULT_CLAIM_TTL_MS }) {
-  let sessionId = null;
-  let resolvedAgentId = agentId;
-
-  if (agentId) {
-    sessionId = await resolveSession(orgId, agentId, repo, prNumber);
-  } else {
-    const available = await findAvailableSession(orgId, repo, prNumber);
-    if (available) {
-      sessionId = available.sessionId;
-      resolvedAgentId = available.agentId;
-    }
-  }
-
-  const status = sessionId ? 'claimed' : 'pending';
-  const claimedAt = sessionId ? new Date() : null;
-  const expiresAt = sessionId ? new Date(Date.now() + ttlMs) : null;

+  // Always create as pending. Runners claim via claimPendingWork().
+  // The long-poll push (in review-manager.js / dispatcher.js) is a
+  // notification hint only — if lost, the runner picks it up on next poll.
   const insertValues = {
     orgId,
     repo,
     prNumber,
     attempt,
-    sessionId,
+    sessionId: null,
     claimType,
-    status,
-    payload,
-    claimedAt,
-    expiresAt,
+    status: 'pending',
+    payload,
+    claimedAt: null,
+    expiresAt: null,
   };

   // ... (insert logic unchanged) ...

-  if (sessionId && resolvedAgentId) {
-    await setSessionStatus(orgId, resolvedAgentId, sessionId, 'busy');
-  }
-
   audit('claim_created', { ... });
-  logger.info({ msg: 'Claim created', orgId, repo, prNumber, attempt, sessionId, status, claimType });
+  logger.info({ msg: 'Claim created', orgId, repo, prNumber, attempt, status: 'pending', claimType });
   return toSnakeClaim(claim);
}
```

Also remove the unused imports: `resolveSession`, `findAvailableSession`, `setSessionStatus`.

### Change 2: Update `dispatchReview()` to resolve session for notification only

**File:** `packages/fluent-flow/src/engine/review-manager.js`
**Function:** `dispatchReview()`

After creating the claim, resolve a session for the notification hint push (long-poll). This is the same logic that was in `createClaim()`, but now it's the caller's responsibility — making the boundary clear: `createClaim()` only creates; the caller decides whether to push-notify.

```js
// After: if (newClaim) { ... }
if (newClaim) {
  // ... onClaimDispatched (unchanged) ...

  // Try to notify an online runner via long-poll (hint only)
  try {
    const agentId = config.default_agent ?? config.agent_id;
    if (agentId) {
      const { resolveSession } = await import('../agents/session-manager.js');
      const sessionId = await resolveSession(orgId, repoKey, prNumber);
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
}
```

**Note:** `resolveSession()` is already imported in `session-manager.js` and exported. The import above is just illustrative — it should be a top-level import in practice.

Also update `handleReviewResult()` in the same file — the FAIL path creates a `review_fix` claim and then calls `notifyReviewFailure()`. After Change 1, the claim is always `pending`, so the notification push is purely informational. No code change needed there since `notifyReviewFailure` → `dispatch` already handles this.

### Change 3: Auto-retry expired claims

**File:** `packages/fluent-flow/src/workers/claim-expiry.js`

After marking claims as expired, re-dispatch a new claim for each one. This replaces the current terminal expiry with a retry loop.

**Strategy:** Bump the attempt number. This avoids changing the unique constraint and preserves the history trail (each attempt is a separate row).

```js
export async function expireClaimsTick() {
  try {
    const expired = await expireClaims();
    if (!expired || expired.length === 0) return expired;

    // Re-dispatch: for each expired claim, create a new claim at attempt + 1
    for (const claim of expired) {
      try {
        const newAttempt = claim.attempt + 1;

        // Cap retries to prevent infinite loops (e.g. bad PR that always fails)
        const MAX_RETRY_ATTEMPTS = 10;
        if (newAttempt > MAX_RETRY_ATTEMPTS) {
          logger.warn({
            msg: 'Claim expired and max retry attempts reached — giving up',
            repo: claim.repo,
            prNumber: claim.pr_number,
            attempt: claim.attempt,
            maxAttempts: MAX_RETRY_ATTEMPTS,
          });
          continue;
        }

        const newClaim = await createClaim({
          orgId: claim.org_id,
          repo: claim.repo,
          prNumber: claim.pr_number,
          attempt: newAttempt,
          claimType: claim.claim_type,
          payload: claim.payload,
        });
        if (newClaim) {
          logger.info({
            msg: 'Re-dispatched claim after expiry',
            repo: claim.repo,
            prNumber: claim.pr_number,
            oldAttempt: claim.attempt,
            newAttempt,
            claimId: newClaim.id,
          });
        } else {
          logger.warn({
            msg: 'Failed to re-dispatch claim (conflict?)',
            repo: claim.repo,
            prNumber: claim.pr_number,
            newAttempt,
          });
        }
      } catch (err) {
        logger.error({
          msg: 'Error re-dispatching expired claim',
          error: err.message,
          claimId: claim.id,
        });
      }
    }
    return expired;
  } catch (err) {
    logger.error({ msg: 'expireClaimsTick: error', error: err.message });
  }
}
```

**Import needed:** Add `import { createClaim } from '../agents/claim-manager.js';` at the top.

**Important:** The new claim created by re-dispatch will also be `pending` (per Change 1). Runners will pick it up via `claimPendingWork()`.

**Edge case — check-run tracking:** The re-dispatched claim has a new `id` and `attempt`. The old claim's `check_run_external_id` is orphaned on the expired row. The new claim won't have a `check_run_external_id` unless `onClaimDispatched` is called for it. We should add a call to `onClaimDispatched` in the re-dispatch path, but this requires `installation_id` and `headSha`, which aren't stored on the claim row today. See Change 5 for this.

### Change 4: Runner watchdog — force exit on persistent failure

**File:** `packages/fluent-flow-runner/src/runner.js`

Add a total-time watchdog. If the runner has been in backoff for a configurable total duration, force-exit the process. This lets the container orchestrator (Docker, systemd) restart it.

**New constant:**
```js
/** Maximum total time (ms) spent in consecutive backoff before forced exit. */
const MAX_BACKOFF_TOTAL_MS = 10 * 60 * 1000; // 10 minutes
```

**In the poll loop:**
```js
let consecutiveFailures = 0;
let backoffStart = null;

while (running) {
  try {
    const work = await client.poll(sessionId);
    consecutiveFailures = 0;
    backoffStart = null; // reset on success
    // ...
  } catch (err) {
    if (!running) break;
    consecutiveFailures++;
    if (!backoffStart) backoffStart = Date.now();

    const backoff = Math.min(BASE_BACKOFF_MS * 2 ** (consecutiveFailures - 1), MAX_BACKOFF_MS);

    // Watchdog: if total backoff time exceeds threshold, force exit
    if (Date.now() - backoffStart >= MAX_BACKOFF_TOTAL_MS) {
      log.error('Watchdog: total backoff exceeded threshold, forcing exit', {
        totalBackoffMs: Date.now() - backoffStart,
        thresholdMs: MAX_BACKOFF_TOTAL_MS,
        consecutiveFailures,
      });
      process.exit(1); // Let the orchestrator restart us
    }

    log.error('Poll error', { error: err.message, consecutiveFailures, maxFailures, nextRetryMs: backoff });

    // ... (410 re-register logic unchanged) ...

    if (consecutiveFailures >= maxFailures) {
      log.error('Max consecutive poll failures reached, stopping runner', { consecutiveFailures, maxFailures });
      running = false;
      break;
    }
    await new Promise((r) => setTimeout(r, backoff));
  }
}
```

This is additive — the existing `maxFailures` cap still applies, but the watchdog provides a time-based safety net that catches cases where backoff keeps cycling at the cap without actual recovery.

### Change 5: Store `head_sha` on claims for re-dispatch check-run creation

**File:** `packages/fluent-flow/src/engine/review-manager.js`

When creating a claim, ensure `headSha` is stored on the claim row. Currently, `head_sha` is a column on `agent_claims` but is only set if the caller passes it through. The re-dispatch in Change 3 needs it.

**In `dispatchReview()`:** The `headSha` parameter is already available. We need to pass it into `createClaim()` and have `createClaim()` store it.

**Update `createClaim()` signature:**
```js
export async function createClaim({ orgId, repo, prNumber, attempt, agentId, payload, claimType = 'review_fix', ttlMs = DEFAULT_CLAIM_TTL_MS, headSha = null }) {
```

**In the insert values:**
```js
const insertValues = {
  orgId,
  repo,
  prNumber,
  attempt,
  sessionId: null,
  claimType,
  status: 'pending',
  payload,
  claimedAt: null,
  expiresAt: null,
  headSha, // store for re-dispatch check-run creation
};
```

**In `dispatchReview()`:** Pass `headSha` through:
```js
const newClaim = await createClaim({
  orgId,
  repo: repoKey,
  prNumber,
  attempt,
  claimType: 'review',
  payload: { priorIssues, onFailure: config.reviewer?.on_failure, branch: ref },
  headSha, // <-- new
});
```

**In the re-dispatch path (Change 3):** Now `claim.head_sha` is available, so we can attempt check-run creation:
```js
if (newClaim && claim.head_sha) {
  try {
    const installCtx = await installationCtxForRepo(...claim.repo.split('/'));
    if (installCtx?.installation_id) {
      const providerClient = getProvider({ installation_id: installCtx.installation_id });
      onClaimDispatched(providerClient, { ...newClaim, head_sha: claim.head_sha, installation_id: installCtx.installation_id });
    }
  } catch (err) {
    logger.warn({ msg: 'Failed to create check-run for re-dispatched claim', error: err.message });
  }
}
```

### Change 6: Log warnings instead of silently skipping `onClaimDispatched`

**File:** `packages/fluent-flow/src/engine/review-manager.js`
**Function:** `dispatchReview()`

Already has a `logger.warn` when `installation_id` or `headSha` is missing. This is fine — just ensure it stays. No code change needed; this is acknowledged and acceptable when dispatching from contexts where the SHA isn't known (e.g. manual API dispatch).

### Change 7: Make `dispatchReview` return a result indicating claim creation status

**File:** `packages/fluent-flow/src/engine/review-manager.js`

Currently `dispatchReview` returns `void`. Make it return `{ claimed: boolean, claimId?: number, reason?: string }` so callers (webhook handlers, API routes) know whether a claim was actually created.

```js
// At the end of dispatchReview:
if (!newClaim) {
  logger.info({ msg: 'Review claim skipped — claim already exists', repo: repoKey, prNumber, attempt });
  return { claimed: false, reason: 'conflict' };
}
// ... (notification push) ...
return { claimed: true, claimId: newClaim.id };
```

This is a non-breaking change since the function currently returns `void` (callers ignore the return value).

---

## 3. Migration Notes

### No schema changes required

All changes are code-level. The existing schema already supports the new behavior:

- `agent_claims.status` defaults to `'pending'` — no change needed
- `agent_claims.session_id` is already nullable — creating claims with `NULL` is valid
- `agent_claims.head_sha` column already exists — we're just ensuring it's populated
- The unique constraint `(org_id, repo, pr_number, attempt)` works with the bump-attempt retry strategy
- `agent_claims.expires_at` is already nullable — pending claims without `expires_at` won't be swept by the expiry worker (which only matches `status = 'claimed'`)

### Data cleanup

Before deploying, run a one-time SQL to find and fix any existing orphans:

```sql
-- Find claims stuck in 'claimed' state for > 30 minutes (orphaned)
SELECT id, org_id, repo, pr_number, attempt, status, claimed_at, expires_at
FROM agent_claims
WHERE status = 'claimed'
  AND expires_at < NOW() - INTERVAL '15 minutes'
ORDER BY claimed_at DESC;

-- Reset them to 'pending' so runners can pick them up
UPDATE agent_claims
SET status = 'pending', session_id = NULL, claimed_at = NULL, expires_at = NULL
WHERE status = 'claimed'
  AND expires_at < NOW() - INTERVAL '15 minutes';
```

This can be run as a manual migration before deployment. After deployment, the new code prevents this condition.

---

## 4. Validation Steps

### Unit tests

1. **`createClaim` always creates as pending:**
   ```bash
   cd packages/fluent-flow && npx vitest run --reporter=verbose src/agents/__tests__/claim-manager.test.js
   ```
   - Assert `status = 'pending'`, `session_id = null`, `claimed_at = null`, `expires_at = null` regardless of whether sessions exist

2. **`expireClaimsTick` re-dispatches:**
   ```bash
   npx vitest run --reporter=verbose src/workers/__tests__/claim-expiry.test.js
   ```
   - Expire a claim, assert a new claim is created at `attempt + 1`
   - Assert retry cap at `MAX_RETRY_ATTEMPTS`

3. **`claimPendingWork` picks up pending claims:**
   - Existing behavior, but verify the `session_id IS NULL` condition still works after creating claims without session assignment

### Integration tests

4. **End-to-end dispatch → claim → poll → result:**
   ```bash
   cd packages/fluent-flow && npm run test:integration
   ```
   - `dispatchReview()` creates a `pending` claim
   - Runner polls, `claimPendingWork()` atomically claims it
   - Runner reports result, claim is completed

5. **Expiry → re-dispatch → pickup:**
   - Create a claim, artificially set `status = 'claimed'` and `expires_at` in the past
   - Run `expireClaimsTick()`
   - Assert new claim created at `attempt + 1` with `status = 'pending'`
   - Assert runner can pick it up via `claimPendingWork()`

### Manual verification

6. **Runner watchdog:**
   - Start a runner with the server unreachable
   - Verify it force-exits after `MAX_BACKOFF_TOTAL_MS` (10 minutes)
   - Check logs for "Watchdog: total backoff exceeded threshold"

7. **Orphan recovery:**
   - Deploy to staging
   - Create a review claim
   - Kill the runner mid-process
   - Wait for expiry (15 min)
   - Verify a new claim is auto-created
   - Start the runner, verify it picks up the new claim

---

## 5. Risk Assessment

### Low risk

- **Change 1 (pending-only claims):** The `claimPendingWork()` path already exists and works. We're just making it the only path. The long-poll push becoming a hint is non-breaking — runners already fall through to `claimPendingWork()` when the queue is empty.
- **Change 7 (return value):** Non-breaking; callers ignore return value today.

### Medium risk

- **Change 3 (auto-retry on expiry):** New code path in the worker loop. Risk of infinite re-dispatch if claims keep expiring. Mitigated by `MAX_RETRY_ATTEMPTS = 10` cap. Each retry bumps the attempt number, so there's a natural ceiling.
- **Change 4 (runner watchdog):** `process.exit(1)` is aggressive but appropriate — the runner is already broken at that point. The container restart policy handles recovery. Risk: if the server is genuinely down for >10 minutes, all runners will cycle. This is acceptable — they'd be useless anyway.

### Higher risk

- **Change 2 (session resolution in review-manager):** Moves session resolution from `createClaim()` to the caller. This is a behavior change in the dispatch flow. Risk: if callers other than `dispatchReview()` relied on the session resolution in `createClaim()` (e.g. `handleReviewResult`'s auto-chain), they won't get push notifications. **Mitigation:** The auto-chain paths in `handleClaimResult` (review → review_fix, spec → build, test_verify → re-review) also create claims. After Change 1, these claims are `pending` and runners pick them up on next poll. This is actually correct behavior — auto-chained claims shouldn't assume the same runner/session.

### Deployment order

Deploy in this order to minimize risk:

1. **Change 1 + Change 5** (pending-only claims, store head_sha) — server-side only
2. **Change 2** (session resolution in review-manager) — server-side only
3. **Change 7** (return value) — server-side only
4. **Change 3** (auto-retry) — server-side only
5. **Change 4** (runner watchdog) — runner-side, separate deployment
6. **Data cleanup SQL** — run after step 1

Steps 1-4 can be deployed together in a single server release. Step 5 is independent.

---

## 6. Rollback Plan

### Server-side (Changes 1-3, 5-7)

All changes are in application code with no schema changes. Rollback is a standard redeploy of the previous version.

**Post-rollback data state:**
- Claims created as `pending` during the new deployment will continue to work — `claimPendingWork()` picks them up regardless of version
- Any re-dispatched claims (from Change 3) will have higher attempt numbers — the old code will not re-dispatch on expiry, so they'll accumulate as expired. This is the same behavior as before the fix (acceptable during rollback)
- The `head_sha` column was already in the schema; populated values are harmless

### Runner-side (Change 4)

Rollback is a redeploy of the previous runner image. The watchdog is additive — removing it returns to the old behavior (runner hangs on persistent failure). No data impact.

### Emergency: manual orphan cleanup

If the new code causes unexpected behavior:

```sql
-- Reset all pending claims that aren't being picked up
UPDATE agent_claims
SET status = 'expired', completed_at = NOW()
WHERE status IN ('pending', 'claimed')
  AND created_at < NOW() - INTERVAL '30 minutes';
```

This is destructive (claims are marked expired with no retry) but restores the system to a clean state.
