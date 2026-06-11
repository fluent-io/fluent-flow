# Loop Engine v2 — Phase 0: Claim Pipeline Stabilization

**Date:** 2026-06-11
**Status:** Draft
**Owner:** fluent-flow-architect
**Scope:** Server (`packages/fluent-flow`) + Runner (`packages/fluent-flow-runner`) + DB (`packages/db`)
**Depends on:** Nothing — Phase 0 lands before any new loop-engine schema.
**Blocks:** Phase 1+ (explicit loop tables: `loops`, `loop_iterations`, `loop_signals`, etc.)

---

## 0. Provenance & Missing Parents

The task brief references two upstream docs that are not present in this repo:

- `docs/specs/2026-06-10-loop-engineering-product-architecture.md`
- `docs/plans/2026-06-10-loop-engine-v2-phased-plan.md`

**Action item before Phase 0 ships:** the architecture spec and phased plan must be committed (or pointers added here) so this plan has a documented parent. Until they land, this plan derives Phase 0 scope from the three live drafts that already enumerate the stabilization surface:

- `docs/plans/test-verify-claim-pipeline-fixes.md` (Ready for Review, 2025-05-05)
- `docs/plans/fix-claim-dispatch-reliability.md` (Draft, 2026-05-05)
- `docs/plans/review-cycle-fixes.md` (Draft, 2026-05-07)

…cross-referenced against the "Immediate Next Steps" list in `docs/PROJECT_STATE_SUMMARY.md` (2026-05-08).

This plan **closes out** those drafts: items already shipped (PRs #107, #108, #112) are listed for traceability only; only unfinished items appear in the task list.

---

## 1. Goal

Bring the existing implicit claim pipeline to a known-good baseline so that Phase 1 (explicit `loops` / `loop_iterations` tables) can be built on stable foundations. After Phase 0 the pipeline must:

1. Never silently drop a dispatch (no `null` claim, no missing notification, no orphaned `claimed` row).
2. Always associate a claim with the head SHA it was created for (so re-dispatch and check-run creation work after expiry).
3. Auto-recover from runner outages, network partitions, and webhook redeliveries without human intervention.
4. Report a structured outcome from every dispatch entry point (no `void` returns that hide conflicts).
5. Surface auth failures loudly on every GitHub API write path (no silent 401 on `pull_request.closed` / review-dismissal).

Non-goals:

- Introducing the `loops`/`loop_iterations` schema (Phase 1).
- Renaming `agent_type` → `harness` (Medium-term, not Phase 0).
- Runner npm publish, dashboard key regeneration (out of scope for stabilization).

---

## 2. Already Landed — Reference Only

The following items from the precursor drafts are already in `main` and do **not** require Phase 0 work. Listed here so reviewers can verify the baseline:

| Item | Shipped In | Source Plan |
|------|-----------|-------------|
| `claim_type` added to `agent_claims` unique constraint (main + partial NULL-PR) | PR #108 / migration `0009` | `test-verify-claim-pipeline-fixes.md` §1–3 |
| `check-run-handler.js` test_verify path: `attempt: 1` + null-return fall-through to `dispatchReview` | PR #108 | `test-verify-claim-pipeline-fixes.md` §4 |
| Pending-only claim creation (no session pre-assignment) | PR #107 | `fix-claim-dispatch-reliability.md` Change 1 |
| `expireClaimsTick` re-dispatches at `attempt+1` with `MAX_RETRY_ATTEMPTS = 10` cap | PR #107 | `fix-claim-dispatch-reliability.md` Change 3 |
| Runner total-backoff watchdog (`process.exit(1)` on persistent failure) | PR #107 | `fix-claim-dispatch-reliability.md` Change 4 |
| Advisory `review_fix` claim on PASS verdict | PR #112 | `review-cycle-fixes.md` Bug 1 |
| `review_fix` lookup scoped to current `head_sha` | PR #112 | `review-cycle-fixes.md` Bug 2/3 Fix B |
| `test_verify → re-review` auto-chain passes `headSha` + `issueNumber` (`runner.js:315-332`) | PR #112 | `review-cycle-fixes.md` Bug 2/3 Fix A/C |
| Migration 0009 uses `ALTER TABLE DROP CONSTRAINT` (production safety fix) | PR #111 | — |
| Migration journal CI check | PR #110 | — |

**Phase 0 closes the three precursor draft plans** (mark them `Shipped — superseded by 2026-06-11 Phase 0 plan`) once the items below land.

---

## 3. Phase 0 Tasks (Unfinished Items)

Each task is independently shippable. Recommended landing order in §6.

### Task 1 — Persist `head_sha` on every claim create path

**Source:** `fix-claim-dispatch-reliability.md` Change 5 — partially shipped (the column is populated by `dispatchReview` and `check-run-handler`'s test_verify path) but **the auto-chain create paths in `runner.js` and `review-manager.js` do not yet pass `headSha` through**.

**Why this matters for Phase 0:** the expiry re-dispatch path (`workers/claim-expiry.js`) needs `head_sha` on the *expired* row to create a check-run for the *re-dispatched* row. Auto-chain claims (`review → review_fix`, `spec → build`) currently insert with `head_sha = NULL`, so any re-dispatch from those chains can't surface in the GitHub PR UI.

**Files:**

| File | Change |
|------|--------|
| `packages/fluent-flow/src/agents/claim-manager.js` | Confirm `createClaim()` accepts and persists `headSha`; add explicit `headSha = null` default and `head_sha: headSha` to `insertValues`. Add JSDoc note: "Required for check-run creation on re-dispatch." |
| `packages/fluent-flow/src/engine/review-manager.js` | In `handleReviewResult()` FAIL path, pass `headSha: reviewSha` into the `createClaim` call for the `review_fix` follow-on. |
| `packages/fluent-flow/src/routes/runner.js` | In the `review → review_fix` and `spec → build` auto-chain blocks (lines ~275–312), pass `headSha: claim.head_sha` into `createClaim`. |
| `packages/fluent-flow/src/workers/claim-expiry.js` | When re-dispatching, pass `headSha: claim.head_sha` into `createClaim`. After creation, if `claim.head_sha` is present, also call `onClaimDispatched` to create the GitHub Check Run for the new claim (uses `installationCtxForRepo`). |

**Acceptance:**

- For every row inserted into `agent_claims` via any production code path, `head_sha` is non-null whenever the parent claim/event had a SHA available.
- Re-dispatched (post-expiry) review claims that had a `head_sha` on the original row produce a new GitHub Check Run on the same SHA.

---

### Task 2 — `dispatchReview()` returns structured result everywhere

**Source:** `fix-claim-dispatch-reliability.md` Change 7. Function currently returns `void` in some branches; callers (webhook handlers, MCP tools, dashboard `/api/repos/{id}/claims`) cannot distinguish "claimed" from "conflict" from "paused".

**Files:**

| File | Change |
|------|--------|
| `packages/fluent-flow/src/engine/review-manager.js` | `dispatchReview()` returns `{ claimed: boolean, claimId?: number, reason?: 'conflict' \| 'paused' \| 'no_config' \| 'no_installation' }` on every branch. |
| `packages/fluent-flow/src/providers/github/check-run-handler.js` | At fall-through to `dispatchReview()` (after test_verify null), inspect the return and log `{ msg, claimed, reason }` so we see "review skipped — paused" vs "review skipped — conflict". |
| `packages/fluent-flow/src/routes/runner.js` | In `test_verify → re-review` auto-chain (line 324), capture and log the return; if `claimed === false` for reason other than `'conflict'`, downgrade to `warn` rather than `info`. |
| `packages/fluent-flow/src/mcp/tools/*.js` (any tool that calls `dispatchReview`) | Propagate the new return shape in the tool response so MCP clients get structured feedback. |
| `packages/dashboard/src/app/api/repos/[id]/claims/route.ts` | If `dispatchReview` is called from the dashboard claim creation route, return HTTP 409 with `{ reason }` on `claimed: false`. |

**Acceptance:**

- `grep -rn "await dispatchReview(" packages/` shows every call site either uses or explicitly discards the return value (no implicit `void` consumers).
- A unit test asserts each return-shape variant from a stub.

---

### Task 3 — Move session resolution from `createClaim` callers into one helper

**Source:** `fix-claim-dispatch-reliability.md` Change 2 (only the dispatcher half landed in PR #107; the helper unification did not).

`createClaim()` no longer resolves sessions (good — PR #107). But the "notification hint push" lives inline in `dispatchReview()`, and the same logic is duplicated (or absent) in `runner.js` auto-chain blocks. Phase 1 needs one place to ask "who should we notify for this claim?".

**Files:**

| File | Change |
|------|--------|
| `packages/fluent-flow/src/agents/session-manager.js` | Add `notifyClaimAvailable({ orgId, repo, prNumber, claimId, agentId? })` — resolves a session (preferring `agentId`), and dispatches the long-poll hint. Returns `{ notified: boolean, sessionId?: number }`. Catches and logs internally — never throws. |
| `packages/fluent-flow/src/engine/review-manager.js` | Replace inline session-resolve + dispatch block (~30 lines after `createClaim`) with a single `await notifyClaimAvailable({ ... })` call. |
| `packages/fluent-flow/src/routes/runner.js` | Add `await notifyClaimAvailable(...)` after each of the three auto-chain `createClaim` calls so auto-chained claims get the same notification hint as initial dispatches. |
| `packages/fluent-flow/src/workers/claim-expiry.js` | After successful re-dispatch, call `notifyClaimAvailable(...)` so re-dispatched claims aren't dependent on the next poll tick. |

**Acceptance:**

- One function owns "find a session and push the hint". Three call sites (initial dispatch, auto-chain, re-dispatch) all use it.
- No call site does its own `resolveSession()` + `dispatch()` pair.

---

### Task 4 — `touchSession` rejects expired sessions

**Source:** `PROJECT_STATE_SUMMARY.md` §8 item 9.

A heartbeat on an already-expired session currently revives the session row (`status = 'online'`, new `expires_at`), creating a window where the expired session can claim work that was already re-dispatched to a fresh session.

**Files:**

| File | Change |
|------|--------|
| `packages/fluent-flow/src/agents/session-manager.js` | In `touchSession()`, add `AND expires_at > NOW()` to the `UPDATE` WHERE clause. If the update affects 0 rows, return `{ touched: false, reason: 'expired' }`. |
| `packages/fluent-flow/src/routes/runner.js` | In the poll route, when `touchSession` returns `{ touched: false }`, respond `410 Gone` so the runner re-registers (matches existing 410 handling). |

**Acceptance:**

- Unit test: insert a session with `expires_at` in the past, call `touchSession`, assert no rows updated and route returns 410.
- Integration test (existing): runner re-registration after 410 still works end-to-end.

---

### Task 5 — Fix non-check-run webhook auth (`pull_request.closed`, review dismissal)

**Source:** `PROJECT_STATE_SUMMARY.md` §8 item 2; also flagged in `2026-04-25-onboarding-repos-workflow.md` operational notes ("a separate `pull_request.closed` review-dismissal path still emitted a GitHub 401").

These paths still call GitHub REST helpers without resolving installation context, so any write (dismiss review, delete branch, close auto-merge) silently 401s in production logs.

**Files:**

| File | Change |
|------|--------|
| `packages/fluent-flow/src/routes/webhook.js` (or `github-app-webhook.js` — whichever owns `pull_request.closed`) | Resolve `installationCtxForRepo(owner, repo)` at the top of each handler branch; pass the resulting client/token down to any helper that hits GitHub. |
| `packages/fluent-flow/src/engine/review-manager.js` — `dismissStaleReviews()` and any review-dismissal call | Require an `installationId` argument; throw (fail-fast per CLAUDE.md) if missing. |
| `packages/fluent-flow/src/providers/github/*.js` | Audit every exported helper: any function performing a write that does **not** take an installation context argument is converted to require one. No silent skip. |

**Acceptance:**

- `grep -rn "fetch.*api\.github\.com\|provider.*\.(post\|patch\|put\|delete)" packages/fluent-flow/src/` — every match either operates on the read-only path or has installation context in scope.
- A `pull_request.closed` event delivered in staging produces 0 GitHub 401s in logs.

---

### Task 6 — Outbound worker uses installation **external** ID, not internal FK

**Source:** `PROJECT_STATE_SUMMARY.md` §8 item 3.

`workers/outbound.js:18` calls `getInstallationToken(row.installation_id)` — `token-cache.js` expects the **GitHub external installation ID**, but the outbound queue rows store the **`provider_installations.id` internal FK**. Tokens fail to resolve, the row is retried until it dies in the queue.

**Files:**

| File | Change |
|------|--------|
| `packages/fluent-flow/src/workers/outbound.js` | In `resolveToken`, join `provider_installations` to translate the stored FK into the external installation ID before calling `getInstallationToken`. Cache the lookup if it's hot. |
| `packages/fluent-flow/src/db/outbound-queue.js` | Add a JSDoc note on `enqueue({ installation_id })` clarifying which ID the caller must pass; if practical, rename the column or add a sibling `external_installation_id` for clarity (consider for Phase 1, not blocking Phase 0). |
| `packages/fluent-flow/src/providers/enqueue.js` | Audit all callers — currently passing `installationId` from `getProvider({ installation_id })` context. Document the contract: "must be external GitHub installation ID". |

**Acceptance:**

- Outbound queue `failed_at` rows from the last 7 days in staging stop accumulating for "token resolve failed".
- A unit test stubs the join and asserts the worker calls `getInstallationToken` with the external ID, not the FK.

---

### Task 7 — Verdict parsing falls back to GitHub API

**Source:** `PROJECT_STATE_SUMMARY.md` §8 item 4; lessons learned §7.4.

`reviewer-result` HTML-comment marker parsed from stdout works for `claude-code` but is fragile for `codex`/`aider`. After the agent exits, fetch the latest review from `GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews` and parse the body marker from there as a fallback.

**Files:**

| File | Change |
|------|--------|
| `packages/fluent-flow/src/engine/review-manager.js` | Add `parseVerdictFromReviewBody(body)` (already exists for stdout — extract to one helper). Add `fetchLatestReviewVerdict({ owner, repo, prNumber, installationId, agentLogin })` that hits the GitHub API. |
| `packages/fluent-flow/src/routes/runner.js` | When the claim result reports `verdict = null` (or missing), call the fallback fetch before treating the claim as malformed. |
| `packages/fluent-flow/src/providers/github/*` | Add `listReviews(prNumber)` if not present; require installation context. |

**Acceptance:**

- A `review` claim completed by an agent that does not echo the marker still resolves to a `PASS`/`FAIL`/`NEEDS_CHANGES` verdict via the GitHub API fallback.
- Existing stdout-marker path continues to work (regression test for `claude-code`).

---

### Task 8 — Close out precursor draft plans

**Files:**

| File | Change |
|------|--------|
| `docs/plans/test-verify-claim-pipeline-fixes.md` | Update header: `Status: Shipped — superseded by 2026-06-11 Phase 0 plan (test_verify items in PR #108)`. Keep file for history. |
| `docs/plans/fix-claim-dispatch-reliability.md` | Header: `Status: Partially shipped (PR #107) — remaining items absorbed into 2026-06-11 Phase 0 plan Tasks 1, 2, 3`. |
| `docs/plans/review-cycle-fixes.md` | Header: `Status: Shipped — see PR #112; superseded by 2026-06-11 Phase 0 plan`. |

**Acceptance:** All three precursor plans link forward to this plan; no contradictory "open" status remains.

---

## 4. Test Strategy

All tests run under the existing Vitest harness (`cd packages/fluent-flow && npm test`, sequential per CLAUDE.md). Add tests alongside the file being modified.

### Unit Tests (new)

| Test File | Asserts |
|-----------|---------|
| `packages/fluent-flow/tests/agents/claim-manager-head-sha.test.js` | `createClaim` persists `head_sha` on insert; absence preserved as NULL. |
| `packages/fluent-flow/tests/engine/dispatch-review-result-shape.test.js` | Returns `{ claimed, reason }` for each branch: success, conflict, paused, no_installation, no_config. |
| `packages/fluent-flow/tests/agents/notify-claim-available.test.js` | New helper resolves session, pushes hint, returns `{ notified, sessionId }`; never throws. |
| `packages/fluent-flow/tests/agents/touch-session-expired.test.js` | Expired session row is not revived; helper returns `{ touched: false }`. |
| `packages/fluent-flow/tests/routes/poll-410-on-expired-session.test.js` | Poll route returns 410 when `touchSession` reports expired. |
| `packages/fluent-flow/tests/workers/outbound-installation-id-translation.test.js` | Worker joins to `provider_installations` and calls `getInstallationToken` with external ID. |
| `packages/fluent-flow/tests/providers/github/closed-pr-installation-context.test.js` | `pull_request.closed` handler resolves installation context before write calls; no helper invoked with null context. |
| `packages/fluent-flow/tests/engine/verdict-fallback.test.js` | Stdout-missing verdict → GitHub API fetch path → parsed from review body marker. |

### Regression / integration

| Test | Asserts |
|------|---------|
| `packages/fluent-flow/tests/workers/expire-claims-redispatch.test.js` (extend existing) | Re-dispatched claim inherits `head_sha` and triggers `onClaimDispatched`. |
| `packages/fluent-flow/tests/routes/runner-auto-chain.test.js` (extend) | `review → review_fix` and `spec → build` auto-chains pass `head_sha` through. |
| `packages/fluent-flow/tests/integration/dispatch-result-contract.test.js` (new) | Every public caller of `dispatchReview` handles the new return shape without throwing. |

### Manual / staging

1. Deliver a `check_run.completed` event for a PR with a completed `review_fix` at the same SHA → `test_verify` claim created → runner completes it → re-review dispatched with correct `head_sha` → check-run visible in PR UI.
2. Force a session expiry by pausing the runner; verify the next heartbeat receives 410 and re-registers cleanly.
3. Trigger `pull_request.closed` on staging with a PR that had reviews → assert no 401s in server logs and the review dismissal call succeeds.
4. Plant an outbound row with a known repo and `installation_id` = internal FK → worker drains it (no `failed_at`).

---

## 5. Acceptance Criteria — Phase 0 Done

Phase 0 is complete when **all** of the following are observable:

1. ✅ Every row in `agent_claims` inserted via any production code path has `head_sha` populated whenever the originating context had a SHA (verified by SQL: `SELECT count(*) FROM agent_claims WHERE created_at > $phase0_start AND head_sha IS NULL AND claim_type IN ('review','review_fix','test_verify')` returns 0).
2. ✅ `dispatchReview()` returns a structured result at every call site; no `void`-discarding caller in `grep`.
3. ✅ Single `notifyClaimAvailable` helper used by all three claim-create surfaces (initial dispatch, auto-chain, re-dispatch).
4. ✅ Expired session heartbeats return 410; staging logs show 0 cases of expired sessions claiming work.
5. ✅ `pull_request.closed` / review-dismissal paths produce 0 GitHub 401s in staging logs over a 24-hour soak.
6. ✅ Outbound queue `failed_at` rate for "token resolve failed" drops to 0 over a 24-hour soak.
7. ✅ A review claim completed by an agent that does not echo `<!-- reviewer-result -->` still resolves to a verdict via GitHub API fallback.
8. ✅ All three precursor draft plans have a `Status: Shipped — superseded` header pointing back to this plan.
9. ✅ Full test suite (~410 + new tests) passes via `npm test` at repo root.
10. ✅ Deploy smoke checks pass (webhook 401, dashboard 200, auth gating) post-deploy.

Phase 1 (`loops` / `loop_iterations` schema) **must not start** until criteria 1, 4, 6 hold in staging — those three are the hard pre-requisites for explicit loop tables (head_sha tracking, session integrity, outbound delivery).

---

## 6. Deployment Order

Each task is independently shippable; bundle by surface area to keep PRs small.

1. **PR A — Server: head_sha + structured return** (Tasks 1 + 2)
   - Pure server changes, no schema, no runner changes.
   - Backward-compatible: callers that ignore the return value continue to work.
2. **PR B — Server: session helpers** (Tasks 3 + 4)
   - Extracts/centralizes session resolution; tightens `touchSession`.
   - Runner-visible behavior: heartbeat may return 410 sooner; existing runner already handles 410 re-register.
3. **PR C — Webhook & outbound auth** (Tasks 5 + 6)
   - Independent of PRs A/B; can land in parallel.
4. **PR D — Verdict fallback** (Task 7)
   - Independent; land after PR A to inherit structured return.
5. **PR E — Plan housekeeping** (Task 8)
   - Doc-only; land last so the "shipped" markers reflect real merge state.

No DB migrations required — Phase 0 is code-only on top of `0009`. The `agent_claims.head_sha` column already exists (added pre-2026-05).

---

## 7. Rollback Notes

### Per-PR rollback

All PRs are application-code-only; rollback = redeploy previous container image. There are no schema changes in Phase 0.

| PR | Rollback impact |
|----|-----------------|
| A | Claims created during rollout retain `head_sha`; harmless on old code which simply ignores the column on read. Callers that started using the new return shape need a forward fix or temporary tolerant handling — keep wrappers defensive. |
| B | `notifyClaimAvailable` helper is additive; reverting removes the helper but inline call sites need to be restored. Recommend keeping the original inline logic in a single revert commit on hand during PR B's rollout window. `touchSession` 410 behavior: rolling back returns to the silent-revive bug; no data loss. |
| C | Reverting restores the silent 401 behavior on `pull_request.closed`; no data corruption — the writes simply fail again. |
| D | Reverting drops the GitHub API verdict fallback; agents echoing stdout markers continue to work; non-echoing agents return to the prior "malformed verdict" failure mode. |
| E | Doc-only — `git revert` is sufficient. |

### Emergency data cleanup (only if needed)

Pending claims accumulating without pickup (signal that PR B introduced a regression in `notifyClaimAvailable`):

```sql
-- Find pending claims older than 5 minutes with no session ever assigned
SELECT id, repo, pr_number, claim_type, created_at
FROM agent_claims
WHERE status = 'pending'
  AND session_id IS NULL
  AND created_at < NOW() - INTERVAL '5 minutes'
ORDER BY created_at DESC
LIMIT 50;
```

The existing `claimPendingWork()` path still picks these up on every poll regardless of notification hint, so this would only signify *latency*, not *loss*. If real loss is observed, roll back PR B; the data heals on the next poll cycle once the inline notification is restored.

### Cross-PR safety

- The `head_sha` plumbing in PR A is forward-compatible with the re-dispatch logic from PR #107 — even partially deployed (server new, runner old) is safe.
- The structured return in PR A is additive — old callers ignoring `await dispatchReview()` continue to work.
- PRs B/C/D do not change DB shape or wire-format — runner ↔ server compatibility is preserved across any combination of deployed versions within Phase 0.

---

## 8. Phase 0 → Phase 1 Hand-off Checklist

When Phase 0 acceptance criteria all hold, hand-off to Phase 1 includes:

- [ ] All §5 criteria verified in staging.
- [ ] Phase 1 spec (`docs/specs/2026-06-10-loop-engineering-product-architecture.md` — currently missing, must be committed before Phase 1 work begins).
- [ ] Phase 1 phased plan (`docs/plans/2026-06-10-loop-engine-v2-phased-plan.md` — currently missing).
- [ ] An ADR or section of the architecture spec that describes how `loops` / `loop_iterations` rows relate to the existing `agent_claims` table (Phase 1 cannot start until this is decided — own-the-table vs. join-table is a structural choice).
- [ ] Snapshot of `agent_claims` schema after Phase 0 (no changes expected; record column list for the architecture spec).
