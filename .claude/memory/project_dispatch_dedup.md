---
name: Dispatch dedup — race condition fix
description: Concurrent check_run webhooks caused duplicate dispatches; fixed with atomic last_dispatch_sha claim in review_retries
type: project
---

**Problem:** When CI passes, GitHub fires multiple `check_run.completed` webhooks. In the all-checks fallback path (no `trigger_check`), concurrent handlers both see "all passed" and dispatch duplicate reviews. Each duplicate increments `retry_count`, causing attempt numbers to skip.

**Fix:** `claimDispatch()` in `review-manager.js` uses an atomic upsert with `WHERE last_dispatch_sha IS DISTINCT FROM $sha`. Second concurrent handler gets 0 rows and skips.

**Why:** Only applies to the automated check-run path. Manual dispatches (REST API, MCP tool) bypass the claim — they're intentional re-dispatches.

**How to apply:** If similar race conditions appear in other webhook handlers, the same atomic claim pattern works. The dedup is per-PR per-SHA, so new commits naturally reset via `resetRetries`.
