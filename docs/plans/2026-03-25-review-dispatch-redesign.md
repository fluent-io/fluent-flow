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

**`check-run-handler.js` changes:**

Current: only handles `conclusion: failure` (CI failure notifications).

New: adds a success path.

```
check_run.completed arrives
├── conclusion: failure → existing CI failure notification (unchanged)
└── conclusion: success/neutral
    ├── reviewer not enabled → ignore
    ├── trigger_check configured
    │   ├── check name matches → find linked PR → dispatch review
    │   └── check name doesn't match → ignore
    └── no trigger_check (fallback)
        └── query all check runs for commit
            ├── all completed with success/neutral → find linked PR → dispatch review
            └── some pending/failed → ignore (wait)
```

The check-run handler resolves the PR number via `getPRsForCommit(sha)`, reads the retry record to get `priorIssues` and `attempt`, then calls `dispatchReview`.

**Ignore own check runs:** The review workflow itself creates check runs. The handler must skip check runs from the review workflow to avoid infinite loops. Filter by checking if `checkRun.name` starts with `review /` or matches the review workflow name.

**`webhook.js` changes:**

- `opened` / `reopened`: remove `dispatchReview` call. State transition to "In Review" remains.
- `synchronize`: remove `dispatchReview` call. Retry record reading and max-retry gating are removed (moved to check-run handler).

### Change 2: Auto-dismiss stale reviews on new dispatch

When `dispatchReview` is called, dismiss all prior Fluent Flow reviews before dispatching the new workflow.

**`review-manager.js` `dispatchReview` changes:**

Before dispatching the workflow:

1. Call `getReviews(owner, repo, prNumber)` to list all reviews on the PR.
2. Filter for reviews containing the `<!-- reviewer-result:` marker with state `CHANGES_REQUESTED`.
3. Call `dismissReview(owner, repo, prNumber, reviewId, "Superseded by new review")` for each.

This runs on every dispatch path (webhook, MCP tool) since it's inside `dispatchReview`.

### New REST helpers (`rest.js`)

| Function | Endpoint | Purpose |
|----------|----------|---------|
| `getCheckRunsForCommit(owner, repo, sha)` | `GET /repos/{owner}/{repo}/commits/{sha}/check-runs` | List check runs for a commit |
| `getReviews(owner, repo, prNumber)` | `GET /repos/{owner}/{repo}/pulls/{prNumber}/reviews` | List reviews on a PR |
| `dismissReview(owner, repo, prNumber, reviewId, message)` | `PUT /repos/{owner}/{repo}/pulls/{prNumber}/reviews/{reviewId}/dismissals` | Dismiss a review |

### Schema change (`config/schema.js`)

Add to `ReviewerConfigSchema`:

```js
trigger_check: z.string().optional(),
```

No migration needed — it's optional and the fallback (all checks pass) applies when absent.

## Files changed

| File | Change |
|------|--------|
| `src/config/schema.js` | Add `trigger_check` to `ReviewerConfigSchema` |
| `src/github/check-run-handler.js` | Add success path: dispatch review on CI pass |
| `src/github/rest.js` | Add `getCheckRunsForCommit`, `getReviews`, `dismissReview` |
| `src/engine/review-manager.js` | Dismiss stale reviews before dispatch in `dispatchReview` |
| `src/routes/webhook.js` | Remove review dispatch from `opened`/`reopened`/`synchronize` |
| `config/defaults.yml` | Document `trigger_check` field (no default value) |
| `README.md` | Update reviewer config docs |

## Test plan

- check-run handler: success dispatches review when trigger_check matches
- check-run handler: success ignored when trigger_check doesn't match
- check-run handler: fallback dispatches when all checks pass
- check-run handler: fallback waits when some checks pending
- check-run handler: skips own review check runs (no infinite loop)
- check-run handler: reads retry record for attempt/priorIssues
- review-manager: dismisses prior reviews before dispatch
- review-manager: no error if no prior reviews exist
- webhook handler: opened/reopened no longer dispatch reviews
- webhook handler: synchronize no longer dispatches reviews
- schema: trigger_check is optional string
