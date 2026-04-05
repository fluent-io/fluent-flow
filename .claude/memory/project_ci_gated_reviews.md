---
name: CI-gated review dispatch, inline comments, and workflow architecture
description: Reviews dispatch on check_run.completed, post inline comments, workflow split (review.yml + pr-review.yml), auto-dismiss
type: project
---

**Review dispatch (PR #14):** Reviews dispatch on `check_run.completed` with success, not `pull_request.opened`. Eliminates duplicate review races.

**trigger_check config:** `reviewer.trigger_check` (optional string) matches check run names via `startsWith` — handles matrix jobs like `test (20)` matching `test`. Fallback: waits for all non-review checks to pass (recommend `trigger_check` for production).

**Inline comments (PR #15):** `post-review.mjs` parses the PR diff, posts blocking/advisory issues as inline PR comments via GitHub Reviews API (with `line` + `side: RIGHT` + `commit_id`). Issues outside the diff fall back to the review body. Graceful fallback if inline comments fail.

**Auto-dismiss:** `dispatchReview` dismisses prior Fluent Flow reviews (`CHANGES_REQUESTED` with `<!--\s*reviewer-result:` regex) before dispatching new ones.

**Workflow split (PR #15):**
- `review.yml` — reusable workflow (`workflow_call`), contains all review logic
- `pr-review.yml` — thin per-repo caller (`workflow_dispatch`), passes secrets explicitly
- Split was necessary because dual `workflow_call` + `workflow_dispatch` in one file caused org secrets to be inaccessible

**Review workflow filtering:** `isReviewCheckRun()` at top level of `handleCheckRun` — filters on both failure and success paths. Prevents infinite loops and noisy CI failure notifications for review runs.

**Dogfooding:** fluent-flow onboarded to itself (`.github/fluent-flow.yml` with `default_agent: claude-code`, `trigger_check: test`).

**How to apply:** When configuring `trigger_check`, use the job name prefix (not the full matrix name). For fluent-hive: `lint-and-test`, for fluent-flow: `test`. fluent-hive needs its `pr-review.yml` updated to reference `review.yml`.
