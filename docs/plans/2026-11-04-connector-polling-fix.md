# Connector idle polling fix

[Plans](README.md)

**Goal:** Honor the connector's existing long-poll contract and prevent rapid empty-response loops. This is a bug fix, not a scheduling or task-start change.

## Constraints

- Preserve all existing uncommitted Projects/startup/runner work. No commits, pushes, schema changes, production operations, token rotation, data resets, new AI runs or workspace cleanup.
- Keep the current response/error envelopes, atomic command claiming, delivery-time authorization checks, lease fencing, redelivery identities, acknowledgements and independent heartbeat/observation behavior.
- Use Node22. Tests that reset a DB use separate loopback ff_*_test databases; never reset ff_demo. Local PG:127.0.0.1:55432, roleffuser. No credentials in logs.
- There is an active real run: leave the live app/connector/agent alone during implementation. Root owns the controlled service restart and final live cadence check after verification.
- Observe behavioral RED before production edits, then GREEN. Add linked README entries for tests/behavior. No subagents or commits from implementer.

## Confirmed cause

`packages/db/src/collaboration/connector.ts:pollConnectorCommands` validates waitMs(default25000,max25000) but only claims once and returns immediately. `packages/fluent-flow-runner/src/connector/loop.js` polls immediately again after a successful empty response. The endpoint logs as `/poll` because request logging sees the mounted route path. Live evidence: repeated millisecond200responses, command queue initially one applied row; saved dev log ~4.4GB. Later inspection found a second, running run, so no live execution interruption is authorized during implementation.

### Task 1: Restore bounded, cancellable connector polling

**Files:** DB `src/collaboration/connector.ts`; server `src/collab/routes-connector.js`; runner `src/connector/loop.js`; focused mounted API and runner loop tests; relevant existing READMEs. Do not change unrelated UI or runner setup files.

**Contract:** Existing POST `/api/connector/v1/poll`, body waitMs0..25000(default25000), unchanged `{data:{commands:[]}}`/command DTOs. Add internal AbortSignal support for request cancellation without changing the HTTP body. Keep waitMs0 nonblocking. Polls with no deliverable work wait until work arrives, cancellation occurs or the requested deadline expires. Existing ready work returns promptly. The server rechecks with a bounded short interval (e.g.500ms) and never holds a DB transaction, connection, host row/advisory lock across a timer wait. Revalidate fencing and host authority on each claim attempt. Cancellation must remove timers/listeners and stop further DB rechecks. Use response-close/request-aborted semantics, not the ordinary completed POST request's close event.

Runner safeguard: ensure a minimum idle poll cycle of about1second when an otherwise healthy server returns empty immediately; account for time already spent waiting, preserve prompt draining of non-empty batches and independent heartbeat/observation delivery, and make sleep promptly interruptible on shutdown. Reuse existing configuration/timer seams where appropriate; avoid adding test-only production switches.

- [x] Read current code and test harnesses; use test-driven-development/writing-good-tests guidance. Write mounted real-app+Postgres regressions first: empty positive wait remains pending then expires, waitMs0 immediate, existing commands immediate, a newly queued command wakes a waiting poll promptly, a heartbeat/ack/another claim can proceed during the wait, disconnect stops rechecks, and revoked token/stale fence fails promptly during a wait. Capture behavioral RED. Test DB ff_poll_routes_test; never ff_demo.
- [x] Write runner regression first proving repeated immediate empty200 responses cannot spin; cover no unnecessary delay on a server-held request/nonempty batches, interruptible stop, heartbeat/observation continuation and normal error backoff. Preserve existing protocol test assertions. Capture behavioral RED.
- [x] Implement minimal bounded long-poll and idle-cycle floor. Use monotonic elapsed time/deadline reasoning where practical; do not build a new queue/broker or add dependencies. Avoid sleeping inside `withHostFence` or a DB transaction.
- [x] Existing command-state tests that intentionally request an immediate empty result should explicitly set waitMs0. Do not weaken timing, security or protocol assertions merely to accommodate the fix.
- [x] Run focused API/runner tests, appropriate DB+runner typechecks, and full server+runner package suites. Keep DB-dependent test files serial. Full root suite can be root-owned to avoid duplicate runs. Ensure stop/disconnect does not leave long-polls hanging in teardown.
- [x] Update relevant existing READMEs with the wait/cancel/guard behavior. Report exact changed files, RED/GREEN logs/commands/results, timing evidence, any limitations and what root must restart at `.superpowers/sdd/2026-11-04-connector-polling-fix/task-1-report.md`. No installation, commit, paid/native run or live service operations.

## Verification

Implemented in the current worktree with an incremental disconnect fix after independent review. Behavioral RED/GREEN covers mounted real-app PostgreSQL polling and bounded runner cadence/observation tests. Final root Node 22 suite: 1,149 passed (DB 159, dashboard 153, runner 321, API 516), 5/5 Turbo tasks successful, zero cached; 3 existing optional legacy-SQL tests skipped. Independent task review approved the final changes; unrelated test-fixture log noise is deferred. Live local verification reused the saved enrollment/journal: two successful idle polls each waited 25,004 ms over a 55.6-second sample; heartbeat age was under 0.4 seconds, all observed connector requests returned 200, and host/run/task/command counts were unchanged. A 2.5-second total-database sample fell from 4,037 commits to 44 (other application activity is included). API and dashboard both returned 200 after restart. No demo reset or new AI task was needed. No new user-facing errors, schema changes or dependency changes.
