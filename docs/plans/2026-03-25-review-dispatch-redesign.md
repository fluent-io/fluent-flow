# Review Dispatch Redesign: CI-Gated Reviews + Auto-Dismiss

## Problem

Two bugs in the current review dispatch:

1. **Duplicate reviews on PR open.** `pull_request.opened` and `pull_request.synchronize` can fire within seconds of each other (e.g. rapid push after PR creation), both dispatching reviews. This causes skipped attempt numbers (attempt 1 → attempt 3) and wasted reviewer runs.

2. **Stale reviews block PRs.** When an agent pushes fixes, the old `CHANGES_REQUESTED` review stays on the PR. The developer sees a stale blocking review while the new review is running.

## Solution

### Change 1: Dispatch reviews on `check_run.completed` instead of `pull_request.opened`

Reviews should only run after CI passes. This eliminates the race between `opened` and `synchronize`, avoids reviewing code that doesn't build, and naturally deduplicates — a given check run completes exactly once.

**Config addition:**

```yaml
reviewer:
  trigger_check: "lint-and-test"  # optional
```

- When `trigger_check` is set: only that check's success triggers a review dispatch.
- When unset (fallback): waits for ALL check runs on the commit to pass (queries `GET /repos/{owner}/{repo}/commits/{sha}/check-runs`, dispatches only when every check run is completed with `success` or `neutral` conclusion).

**Known limitation of the fallback path:** Check runs arrive asynchronously — a fast check may complete before a slower check has even been created by GitHub Actions. The fallback could prematurely dispatch if it sees 1/1 checks passing before the remaining jobs are enqueued. **Production deployments should set `trigger_check` explicitly.** The fallback is a convenience for simple repos with a single CI job.

**`check-run-handler.js` changes:**

Current: only handles `conclusion: failure` (CI failure notifications).

New: adds a success path.

```
check_run.completed arrives
├── conclusion: failure → existing CI failure notification (unchanged)
├── conclusion: success/neutral
│   ├── reviewer not enabled → ignore
│   ├── is a review workflow check run (name contains "review") → ignore (prevent infinite loop)
│   ├── trigger_check configured
│   │   ├── check name matches → find linked PR → check max retries → dispatch review
│   │   └── check name doesn't match → ignore
│   └── no trigger_check (fallback)
│       └── query all check runs for commit (exclude review workflow runs)
│           ├── all completed with success/neutral → find linked PR → check max retries → dispatch review
│           └── some pending/failed → ignore (wait)
└── any other conclusion (cancelled, timed_out, stale, etc.) → ignore
```

**Resolving PR context from check runs:** `getPRsForCommit(sha)` returns PR objects that include `base.ref`. The handler extracts `ref` from `pr.base.ref` for the `dispatchReview` call. If multiple PRs are linked to the same commit, dispatch a review for the first open PR only (same as current behavior in the failure path).

**Max-retry gating:** Before dispatching, the handler reads the retry record via `getRetryRecord(repo, prNumber)`. If `retryCount >= config.reviewer.max_retries`, skip the dispatch (escalation is in progress). Otherwise, compute `attempt = retryCount + 1` and pass `priorIssues = retryRecord?.last_issues ?? []`.

**Filtering own check runs:** The review workflow creates check runs with names like `review / Automated Code Review`. Filter these out by checking if `checkRun.name` includes `review` (case-insensitive) AND the check run's `app.slug` is `github-actions`. This prevents infinite loops where a review completion triggers another review. Applied in both the trigger_check matching and the fallback all-checks query.

**`webhook.js` changes:**

- `opened` / `reopened`: remove `dispatchReview` call. State transition to "In Review" remains. Note: "In Review" means "PR is open and review is pending/in progress" — the review will dispatch once CI passes.
- `reopened` edge case: if the PR is reopened without new commits, CI won't re-run and `check_run.completed` won't fire. This is an accepted gap — the user can manually re-run CI or use the `dispatch_review` MCP tool.
- `synchronize`: remove `dispatchReview` call and all retry record logic. The `synchronize` handler becomes a no-op for review purposes. The check-run handler is the sole dispatch path.

### Change 2: Auto-dismiss stale reviews on new dispatch

When `dispatchReview` is called, dismiss all prior Fluent Flow reviews before dispatching the new workflow.

**`review-manager.js` `dispatchReview` changes:**

Before dispatching the workflow:

1. Call `getReviews(owner, repo, prNumber)` to list all reviews on the PR.
2. Filter for reviews containing the `<!-- reviewer-result:` marker with state `CHANGES_REQUESTED`.
3. Call `dismissReview(owner, repo, prNumber, reviewId, "Superseded by new review")` for each.
4. If `dismissReview` fails (404, permission error), log a warning and continue — don't block the new review dispatch.

This runs on every dispatch path (webhook, MCP tool) since it's inside `dispatchReview`.

### New REST helpers (`rest.js`)

| Function | Endpoint | Purpose |
|----------|----------|---------|
| `getCheckRunsForCommit(owner, repo, sha)` | `GET /repos/{owner}/{repo}/commits/{sha}/check-runs` | List check runs for a commit (returns `check_runs` array) |
| `getReviews(owner, repo, prNumber)` | `GET /repos/{owner}/{repo}/pulls/{prNumber}/reviews` | List reviews on a PR |
| `dismissReview(owner, repo, prNumber, reviewId, message)` | `PUT /repos/{owner}/{repo}/pulls/{prNumber}/reviews/{reviewId}/dismissals` | Dismiss a review |

### Schema change (`config/schema.js`)

Add to `ReviewerConfigSchema`:

```js
trigger_check: z.string().optional(),
```

No migration needed — it's optional and the fallback (all checks pass) applies when absent. Since `RepoConfigSchema` uses `ReviewerConfigSchema.partial().optional()` and `MergedConfigSchema` extends `DefaultsConfigSchema`, the field flows through correctly without additional changes.

## Files changed

| File | Change |
|------|--------|
| `src/config/schema.js` | Add `trigger_check` to `ReviewerConfigSchema` |
| `src/github/check-run-handler.js` | Add success path: dispatch review on CI pass with max-retry gating |
| `src/github/rest.js` | Add `getCheckRunsForCommit`, `getReviews`, `dismissReview` |
| `src/engine/review-manager.js` | Dismiss stale reviews before dispatch in `dispatchReview` |
| `src/routes/webhook.js` | Remove review dispatch from `opened`/`reopened`/`synchronize` |
| `config/defaults.yml` | Document `trigger_check` field (no default value) |
| `README.md` | Update reviewer config docs |

## Test plan

### check-run handler
- success dispatches review when trigger_check matches
- success ignored when trigger_check doesn't match
- success ignored for non-success/neutral conclusions (cancelled, timed_out, etc.)
- fallback dispatches when all checks pass
- fallback waits when some checks pending/failed
- fallback excludes review workflow check runs from the all-checks query
- skips own review check runs (no infinite loop)
- reads retry record for attempt/priorIssues
- skips dispatch when max retries reached (escalation in progress)
- extracts ref from PR's base.ref (not hardcoded to main)
- handles multiple PRs for same commit (uses first open PR)

### review-manager
- dismisses prior Fluent Flow reviews (CHANGES_REQUESTED with reviewer-result marker) before dispatch
- no error if no prior reviews exist
- continues dispatch if dismissReview fails (logs warning)
- dismiss runs on MCP dispatch path too

### webhook handler
- opened no longer dispatches reviews (state transition still works)
- reopened no longer dispatches reviews
- synchronize no longer dispatches reviews
- synchronize no longer reads retry record

### schema
- trigger_check is optional string
- trigger_check flows through merged config correctly
