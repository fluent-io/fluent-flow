---
name: pause-enforcement-bugs
description: Two bugs found and fixed in PR #8 — stale retry records after PR close causing notification loops, and no pause enforcement in review pipeline
type: project
---

Two bugs discovered when PR #359 on getonit kept generating Discord notifications after being closed and paused.

**Bug 1: Stale retry records after PR close.** `handlePullRequest` closed handler never called `resetRetries()`, so `get_pending_actions` kept returning stale `review_failed` actions indefinitely. Fixed by calling `resetRetries` unconditionally at the top of the closed case (before merged/not-merged branches).

**Bug 2: No pause enforcement in review pipeline.** `dispatchReview` and the `synchronize` webhook handler dispatched reviews without checking for active pauses. The pause record existed in DB but nothing read it. Fixed by adding a pause guard to `dispatchReview` (accepts optional `issueNumber`, checks `getActivePause`) and a max-retries guard in `synchronize` handler.

**Why:** Agent pushed → synchronize fired → review dispatched → agent notified → agent pushed again, ignoring pause entirely. Closed PRs had stale retry rows that kept appearing in `get_pending_actions`.

**How to apply:** The pause system now has enforcement at the dispatch level. Future review pipeline features should respect the pause guard pattern — check `getActivePause` before triggering agent-facing actions. The `handlePullRequest` function is now exported for testing.
