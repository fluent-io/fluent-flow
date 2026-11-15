# Task 1 backend review fixes

## Outcome and scope

Both findings in `/home/victor/.hermes/cache/scratch/chat-claims-backend-review.md` are fixed in the existing `chat-claim-execution-spec` worktree. No commit/push/deploy, UI change, connector deletion, runtime advertisement, or approved-spec edit. All pre-existing task-1 changes, including untracked migration `0029_chat_claims.sql`, remain present. This fixes a task-1 acceptance gate; it does not complete tasks 2–7.

## Finding 1 — transaction-local authorization and dependent reads

- `authorize`, `resolveScopeCapabilities`, project/workspace capability reads, `requireCurrentPrincipal`, and `getCollabPrincipal` accept an optional query executor. Omitted executors retain their existing pool behavior.
- Chat command delivery supplies its already-held owner transaction client. Current principal/session version and current capabilities are still checked for each pending command at delivery. Only explicit authorization failures are reconciled; infrastructure errors still propagate and roll back.
- Traced every database read in the New-session composition and its reusable task/start helpers. Besides principal/auth reads, fixed task-assignee capability validation, repository ownership validation, and claim response capability projection to use the caller client. These sibling reads would otherwise leave the same nested-checkout defect after fixing the first auth call.
- Noncomposed task/start calls retain their existing authorization and transaction semantics. `task.write` remains the actual New-session task-creation capability.

Deterministic PostgreSQL regressions constrain the shared pool to one connection and shorten acquisition timeout to 150ms. A held owner/caller client therefore leaves **no** second connection available; success cannot depend on ordinary scheduling. New-session coverage includes two concurrent same-project creations, repository validation, response projection, and replay. Assigned-task creation covers its extra capability lookup. Additional real-DB invariants prove in-transaction session revocation fails closed and a missing principal relation propagates SQLSTATE `42P01`, leaving the queued command pending after rollback. The latter uses transactional DDL, not a mocked authorization implementation.

## Finding 2 — protected deletion of direct targets

`deleteAgentIfNoCollaborationClaims` now checks organization-scoped direct `target_agent_id` references before its existing session-linked cleanup. Any direct reference returns the existing `protected` result, regardless of claim status or whether a session was ever allocated. No claim/link/history is removed in that outcome; dashboard DELETE already maps it to HTTP 409.

The existing agent `FOR UPDATE` lock is intentionally retained **before** this new read. PostgreSQL's target FK takes a conflicting `KEY SHARE` lock: a reference insertion already in progress must finish before deletion obtains its lock, after which the next READ COMMITTED statement sees the reference; an insertion starting after deletion's lock cannot slip between the guard and DELETE. No broad FK-error catch or database-error suppression was added. A deterministic real-DB race observes the actual agent lock wait through `pg_stat_activity`, commits the target insertion, then asserts deletion returns `protected` rather than throwing a foreign-key error. Separate tests preserve both pending and ended sessionless chat history, including execution links and the agent itself.

## Exact RED/GREEN evidence

All logs are new, under `/home/victor/.hermes/cache/scratch/`; previous `chat-claims-*` evidence was not overwritten. Commands redirected full output and returned the saved npm exit status, not the exit status of a display command.

| Phase | Actual result | Full log basename |
| --- | --- | --- |
| RED: held-owner chat delivery | exit 1; 1 failed; nested principal read times out acquiring a connection | `chat-fixes-red-delivery.log` |
| GREEN: held-owner chat delivery | exit 0; 1 passed | `chat-fixes-green-delivery.log` |
| RED: New session + assigned-task composition | exit 1; 2 failed; nested authorization principal reads time out | `chat-fixes-red-composition.log` |
| GREEN: delivery + composed creation/assignment | exit 0; 3 passed | `chat-fixes-green-composition.log` |
| RED: pending/terminal target protection + insert/deletion race | exit 1; 3 failed; SQLSTATE `23503`, `agent_claims_target_agent_fk` | `chat-fixes-red-deletion.log` |
| GREEN: target protection + race | exit 0; 3 passed | `chat-fixes-green-deletion.log` |
| Final DB full suite, including strengthened concurrency and two auth-invariant tests | exit 0; 23 files / 327 passed | `chat-fixes-db-full.log` |
| DB TypeScript build | exit 0 | `chat-fixes-db-build.log` |
| Server full suite, all real integration prerequisites enabled | exit 0; 76 files / 777 passed, no skips | `chat-fixes-server-full-retry.log` |
| Affected dashboard API suites (`agent-detail`, `agents`) | exit 0; 2 files / 118 passed | `chat-fixes-dashboard-routes.log` |
| Whitespace validation | exit 0 | `chat-fixes-diff-check.log` |

Commands from worktree root:

```bash
COLLAB_DB_TEST_DATABASE_URL=postgres://fluentflow@127.0.0.1:32768/ff_chat_test npm test -w @fluent-flow/db
npm run build -w @fluent-flow/db
DATABASE_URL=postgres://fluentflow@127.0.0.1:32768/ff_auth_test COLLAB_ROUTES_TEST_DATABASE_URL=postgres://fluentflow@127.0.0.1:32768/ff_server_test TEST_DATABASE_URL=postgres://fluentflow@127.0.0.1:32768/ff_auth_test npm test -w fluent-flow
npm test -w @fluent-flow/dashboard -- --run tests/api/agent-detail.test.ts tests/api/agents.test.ts
```

Focused RED/GREEN commands used `npm test -w @fluent-flow/db -- --run tests/collaboration/claim-executions.test.ts -t <pattern>`, with patterns respectively `pool fully occupied`, `only one pool connection|saturated caller`, and `sessionless targeted|concurrent target reference`. The combined composition GREEN also included `pool fully occupied`.

## Environment issue and cleanup

Created a fresh `postgres:16-alpine` container `ff-chat-fixes-pg`, bound only to `127.0.0.1:32768`, with fresh `ff_chat_test`, `ff_server_test`, and `ff_auth_test` databases. Migrations ran only on these new databases (`chat-fixes-legacy-migrate.log` for the legacy integration database).

The first server run (`chat-fixes-server-full.log`, exit 1) passed 75 files / 767 tests but failed the legacy integration file before reset: its probe uses `TEST_DATABASE_URL`, while its imported Drizzle client uses `DATABASE_URL`. The inherited latter configuration produced an authentication rejection. Rerunning with **both** explicitly set to the disposable database passed all 777 tests; no credentials or existing database contents were read or changed successfully by that rejected connection. Do not mistake the first run for a passing gate.

Stopped the disposable container. The immediate listing briefly showed Docker's `Dead` cleanup state (`chat-fixes-postgres-cleanup.log`); a subsequent exact filtered listing is empty, exit 0 (`chat-fixes-postgres-cleanup-verify.log`), confirming removal.

## Fix-scoped changed paths

- `packages/db/src/collaboration/authorize.ts`
- `packages/db/src/collaboration/principals.ts`
- `packages/db/src/collaboration/claim-executions.ts`
- `packages/db/src/collaboration/tasks.ts`
- `packages/db/src/queries/claim-interactions.ts`
- `packages/db/src/queries/agents.ts`
- `packages/db/tests/collaboration/claim-executions.test.ts`
- `docs/plans/2026-11-13-chat-claims-backend-report.md`
- `docs/plans/2026-11-13-chat-claims-progress.md`
- `docs/plans/2026-11-13-chat-claims-backend-fixes.md` (new)

All other existing dirty/untracked paths belong to the prior implementation/spec and were preserved. No migration SQL or dashboard implementation changed in this fix pass. Agent-server and full dashboard/build evidence from the original task-1 report remain separate historical gates, not fresh reruns. Runtime/resource supervision, UI, release migration review, and other later initiative gates remain outstanding.
