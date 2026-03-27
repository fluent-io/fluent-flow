# Dispatch Dedup: Prevent Duplicate Review Dispatches

**Date:** 2026-03-26
**Status:** Approved

## Problem

When CI passes, GitHub fires multiple `check_run.completed` webhooks (one per job). In the all-checks fallback path (`trigger_check` not set), each webhook handler evaluates whether all checks passed. If the last checks complete near-simultaneously, multiple handlers see "all passed" and each dispatches a review for the same commit.

This causes:
1. Duplicate review dispatches for the same SHA
2. Each duplicate review result increments `retry_count` in `handleReviewResult`
3. Attempt numbers skip (e.g., attempt 1 → attempt 3)
4. Max retries reached prematurely

**Observed in production:** fluent-io/fluent-hive PR #15 — attempt jumped from 1 to 3.

## Solution

Add `last_dispatch_sha TEXT` column to `review_retries`. Before dispatching in the automated check-run path, atomically claim the SHA via an upsert that only succeeds when the SHA differs from what's already stored.

### Approach: Atomic Claim in `handleCheckRunSuccess`

The dedup guard lives in the automated path only. Manual dispatches (REST API `/api/review/dispatch`, MCP tool `dispatch_review`) bypass the claim and always go through — they are intentional actions where re-dispatching for the same SHA is valid.

## Schema Change

New migration `004_dispatch_dedup.sql`:

```sql
ALTER TABLE review_retries ADD COLUMN IF NOT EXISTS last_dispatch_sha TEXT;
```

## Logic Change

### New function: `claimDispatch(repo, prNumber, sha, maxRetries)`

Lives in `review-manager.js`. Single atomic query:

```sql
INSERT INTO review_retries (repo, pr_number, last_dispatch_sha)
VALUES ($1, $2, $3)
ON CONFLICT (repo, pr_number) DO UPDATE
  SET last_dispatch_sha = $3, updated_at = NOW()
  WHERE review_retries.last_dispatch_sha IS DISTINCT FROM $3
    AND review_retries.retry_count < $4
RETURNING retry_count
```

- **Row returned** → claim succeeded. `attempt = retry_count + 1`. Proceed to `dispatchReview`.
- **No row returned** → duplicate (same SHA already dispatched) or max retries reached. Skip.

### Changes to `handleCheckRunSuccess`

Replace the current read-then-dispatch flow:

```
// Before (race-prone):
const retryRecord = await getRetryRecord(repoKey, pr.number);
const retryCount = retryRecord?.retry_count ?? 0;
if (retryCount >= maxRetries) return;
const attempt = retryCount + 1;
await dispatchReview(...);

// After (atomic):
const claim = await claimDispatch(repoKey, pr.number, checkRun.head_sha, maxRetries);
if (!claim) return; // duplicate or max retries
const attempt = (claim.retry_count ?? 0) + 1;
await dispatchReview(...);
```

### Changes to `resetRetries`

Also null `last_dispatch_sha` so a fresh push cycle can dispatch again:

```sql
UPDATE review_retries
SET retry_count = 0, last_issues = NULL, last_dispatch_sha = NULL, updated_at = NOW()
WHERE repo = $1 AND pr_number = $2
```

## Scope

### Changed files
- `src/db/migrations/004_dispatch_dedup.sql` — new migration
- `src/engine/review-manager.js` — add `claimDispatch`, update `resetRetries`
- `src/github/check-run-handler.js` — use `claimDispatch` instead of `getRetryRecord` read

### Unchanged
- `dispatchReview` — no changes, manual callers unaffected
- `src/routes/review.js` — REST API dispatch unchanged
- `src/mcp/tools/commands.js` — MCP tool dispatch unchanged
- `handleReviewResult` — retry increment logic unchanged

## Tests

- `claimDispatch`: first call returns row, second call with same SHA returns null
- `claimDispatch`: different SHA succeeds after first claim
- `claimDispatch`: returns null when `retry_count >= maxRetries`
- `claimDispatch`: inserts new row when no retry record exists
- `resetRetries`: clears `last_dispatch_sha` allowing re-dispatch
- `handleCheckRunSuccess`: integration test — concurrent calls with same SHA dispatch only once
- Update existing check-run-handler tests to work with new claim flow
