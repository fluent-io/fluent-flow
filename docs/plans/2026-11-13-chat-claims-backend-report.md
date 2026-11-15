# Chat claim backend slice — implementation report

## Outcome

Implemented task 1 at the HTTP/service/PostgreSQL boundary on `chat-claim-execution-spec`, in `/home/victor/work/fluent-io/worktrees/chat-claim-spec`. The approved Draft v3 spec was read completely and not edited. This is **not** completion of the overall chat execution spec or an operational interactive runner.

- Forward migration `0029_chat_claims.sql`: task/org validation, nullable chat repository, task-scoped attempts and active uniqueness, target agent FK, independent activity/deadline clocks and terminal reasons, project routing/attended rollout settings, chat slot limit, command originator metadata and `end_session` support. Existing work uniqueness retained; no history/table deletion.
- Existing-task chat creation requires expected version, Idempotency-Key, `run.start` and `internal.read`; atomically creates the claim/link and does not move the task.
- New-session HTTP endpoint `POST /api/collab/v1/projects/:id/chat-sessions` atomically creates one minimal Backlog task plus chat/link, with concurrent replay and rollback coverage. Uses actual repository capability `task.write`, not nonexistent speculative `task.create`.
- Target routing honors org, target identity, repo allowlists for repository-linked rows, repo-null exception only for chat, explicit runner chat support and bounded capacity. Simultaneous polls cannot exceed the chat limit. Offline targets stay pending; pending TTL ends them without fallback.
- Heartbeats and polling do not refresh activity; new events, queued commands, acknowledgements and answers do. Event replay does not keep an abandoned session alive. Claim-owner mutations take an exclusive lock before activity triggers can update the row.
- Pending TTL/idle/host-loss expiry terminates chat without redispatch. Transient failure/shutdown reports terminate without follow-on work. Completed chat results are rejected. Natural work lookups/attempt allocation/finalization exclude task-local chats.
- Chat cancel is turn-only at the API boundary; End session is distinct. Pending end is immediate; claimed end queues a runner command. Idempotent ends preserve the first terminal reason, including a real reproduced expiry/finalization lock race and reused-key conflict checks.
- Delivery revalidates chat command originator principal/session and current capabilities. Revoked prompts/permission answers fail closed; rejected answers reopen the request. Unexpected infrastructure failures propagate.

## Changed-query/path audit

- `packages/db/src/queries/claims.ts`: `insertAtAttempt` persists chat identity/routing/deadline; automatic attempt allocation locks and queries by task for chat, by existing repository key for work.
- `packages/db/src/collaboration/claim-executions.ts`: scoped creation/link/idempotency, optional caller-owned transaction, new-session composition, chat detail lifecycle fields, end/cancel boundary and originator persistence.
- `packages/db/src/queries/claim-interactions.ts`: chat-only delivery authorization and allowed-ID leasing filter. Activity persistence is implemented by migration triggers, not passive reads.
- `packages/fluent-flow/src/routes/agent-server.js`: target/repo-null/admission/TTL polling; authoritative task identity in delivered chat payload; repo-null result validation, terminal reason persistence, no chat transient redispatch, repeated-end reconciliation.
- `resolveGitHubContext` was inspected and already returns null for a missing repository. Repo-null HTTP poll proves no GitHub credential is delivered; no speculative token resolver rewrite was needed.
- `packages/fluent-flow/src/agents/claim-manager.js`: ID-based chat finalization and reasons; natural-key work finalization, active lookup, attempt lookup and chain allocator exclude chat; expiry treats work unchanged and chat terminally; generic redispatch also refuses chat.
- `packages/fluent-flow/src/workers/claim-expiry.js`: excludes chat before retry/check-run work. Audit/result handling accepts repository-null chat reports without splitting a null repository.

## Files

Created:
- `docs/plans/2026-11-13-chat-claims-implementation.md`
- `docs/plans/2026-11-13-chat-claims-progress.md`
- `docs/plans/2026-11-13-chat-claims-backend-report.md`
- `packages/db/src/migrations/0029_chat_claims.sql`

Modified:
- `packages/db/src/collaboration/claim-executions.ts`
- `packages/db/src/collaboration/index.ts`
- `packages/db/src/collaboration/tasks.ts`
- `packages/db/src/collaboration/tx.ts`
- `packages/db/src/migrations/meta/_journal.json`
- `packages/db/src/queries/claim-interactions.ts`
- `packages/db/src/queries/claims.ts`
- `packages/db/src/queries/repos.ts`
- `packages/db/src/schema/agents.ts`
- `packages/db/tests/collaboration/claim-executions.test.ts`
- `packages/fluent-flow/src/agents/claim-manager.js`
- `packages/fluent-flow/src/collab/README.md`
- `packages/fluent-flow/src/collab/routes-claim-executions.js`
- `packages/fluent-flow/src/routes/agent-server.js`
- `packages/fluent-flow/src/workers/claim-expiry.js`
- `packages/fluent-flow/tests/agents/chain-attempt.test.js`
- `packages/fluent-flow/tests/agents/claim-manager-id-ops.test.js`
- `packages/fluent-flow/tests/routes/collab-claim-executions.test.js`
- `packages/fluent-flow/tests/workers/claim-expiry.test.js`
- `packages/fluent-flow/tests/workers/expire-claims-sql.test.js`

The pre-existing modified `docs/specs/2026-11-13-chat-claim-attended-execution.md` belongs to the user and was not changed by this implementation.

## Real verification

| Gate | Result | Full log |
| --- | --- | --- |
| DB full suite | exit 0; 23 files / 319 passed | `/home/victor/.hermes/cache/scratch/chat-claims-db-full.log` |
| Server full suite, real integration DB enabled | exit 0; 76 files / 777 passed; no skips | `/home/victor/.hermes/cache/scratch/chat-claims-server-full.log` |
| Agent-server full suite, real connector app enabled | exit 0; 46 files / 866 passed | `/home/victor/.hermes/cache/scratch/chat-claims-agent-full.log` |
| Dashboard full suite | exit 0; 25 files / 430 passed | `/home/victor/.hermes/cache/scratch/chat-claims-dashboard-full.log` |
| DB build | exit 0 | `/home/victor/.hermes/cache/scratch/chat-claims-db-build.log` |
| Agent-server typecheck | exit 0 | `/home/victor/.hermes/cache/scratch/chat-claims-agent-typecheck.log` |
| Dashboard production build without DATABASE_URL | exit 0 | `/home/victor/.hermes/cache/scratch/chat-claims-dashboard-build.log` |
| npm ci | exit 0 | `/home/victor/.hermes/cache/scratch/chat-claims-npm-ci.log` |
| git diff --check | exit 0 | actual terminal output |

TDD failure evidence is retained at these exact paths:
- `/home/victor/.hermes/cache/scratch/chat-claims-red-creation.log`
- `/home/victor/.hermes/cache/scratch/chat-claims-red-end.log`
- `/home/victor/.hermes/cache/scratch/chat-claims-red-expiry.log`
- `/home/victor/.hermes/cache/scratch/chat-claims-red-routing.log`
- `/home/victor/.hermes/cache/scratch/chat-claims-red-activity.log`
- `/home/victor/.hermes/cache/scratch/chat-claims-red-new-session.log`
- `/home/victor/.hermes/cache/scratch/chat-claims-red-end-race.log`
- `/home/victor/.hermes/cache/scratch/chat-claims-red-new-api.log`
- `/home/victor/.hermes/cache/scratch/chat-claims-red-delivery-auth.log`
- `/home/victor/.hermes/cache/scratch/chat-claims-red-detail.log`
- `/home/victor/.hermes/cache/scratch/chat-claims-red-natural-key.log`
- `/home/victor/.hermes/cache/scratch/chat-claims-red-terminal-key.log`
- `/home/victor/.hermes/cache/scratch/chat-claims-red-finalize-race.log`
- `/home/victor/.hermes/cache/scratch/chat-claims-red-rollout.log`

Tests used a newly created disposable PostgreSQL container bound to `127.0.0.1:55439`, with isolated `ff_chat_test`, `ff_server_test`, `ff_connector_test` and `ff_auth_test` databases. The container was stopped and its removal verified with an empty filtered `docker ps --all` result. Cleanup output: `/home/victor/.hermes/cache/scratch/chat-claims-postgres-cleanup.log`.

## Issues / remaining risks

- Intermediate regressions were SQL-shape test expectations, not hidden production exceptions. Assertions were updated to require the intended chat exclusion/CASE/exclusive lock; all full suites subsequently passed. Passing suites still intentionally log negative-case errors from their fixtures.
- **Do not advertise chat support on runners yet.** Sticky `openSession`/idle command service, child supervision, token/max-duration caps, provider ask mode, safe worktree/scratch retention and GC remain task 2. No live ACP/Paseo smoke was run or claimed.
- Capacity uses the polling instance's validated capacity, conservatively capped at capacity-1, rather than aggregating heterogeneous instances sharing an agent. Settle aggregate/resize semantics before runtime rollout.
- Agent/profile/model catalog and project/agent settings mutation surfaces, transcript backpressure, UI drawer/latency, handoff, evidence/token/history re-key, connector freeze/drain/removal and final security/UAT remain gated in the implementation plan. UI and connector code were not changed.
- Migration is forward-only and was exercised only on disposable test databases. Live upgrade/DDL operational review remains a release gate; no shared or production migration/deployment occurred.
- No credential files read. No commit, push, merge or deploy performed.

## Review-fix follow-up (task 1 gate)

Both findings in the backend review are fixed; scoped implementation/race analysis and exact commands are in `2026-11-13-chat-claims-backend-fixes.md`. Current-principal and capability reads reuse the held delivery/composition client; sibling assignee/repository/projection reads do likewise. Delivery authorization still fails closed and propagates infrastructure failures. Direct target-agent references now return the existing protected-delete outcome for pending and terminal sessionless history, with an observed FK-lock race regression.

Fresh evidence (all paths below use `/home/victor/.hermes/cache/scratch/`; original logs above are preserved):

- RED delivery: `chat-fixes-red-delivery.log`, exit 1 / 1 failure, second-checkout principal-read timeout; GREEN `chat-fixes-green-delivery.log`, exit 0 / 1 pass.
- RED composition/assigned task: `chat-fixes-red-composition.log`, exit 1 / 2 failures, nested authorization checkout timeouts; GREEN combined with delivery `chat-fixes-green-composition.log`, exit 0 / 3 passes.
- RED pending/terminal target protection and concurrent insertion: `chat-fixes-red-deletion.log`, exit 1 / 3 failures, target FK SQLSTATE 23503; GREEN `chat-fixes-green-deletion.log`, exit 0 / 3 passes.
- Final DB full suite: `chat-fixes-db-full.log`, exit 0 / 23 files / 327 tests, including concurrent same-project New sessions with one pool connection, revocation, and propagated database-failure/rollback invariants.
- DB build: `chat-fixes-db-build.log`, exit 0.
- Server full suite: `chat-fixes-server-full-retry.log`, exit 0 / 76 files / 777 tests, no skips.
- Affected dashboard API suites: `chat-fixes-dashboard-routes.log`, exit 0 / 2 files / 118 tests.
- `git diff --check`: `chat-fixes-diff-check.log`, exit 0.

Fresh disposable `ff-chat-fixes-pg` container used only loopback port 32768 and new `ff_chat_test`, `ff_server_test`, `ff_auth_test` databases. Initial server run `chat-fixes-server-full.log` exited 1 because the legacy Drizzle client used inherited DATABASE_URL rather than TEST_DATABASE_URL; authentication was rejected before schema reset. Explicitly setting both to the disposable database fixed the test setup, and the full rerun passed. Cleanup verified by empty exact-name container listing in `chat-fixes-postgres-cleanup-verify.log` (exit 0); immediate stop output is in `chat-fixes-postgres-cleanup.log`.

No approved-spec, migration SQL, UI, connector, runtime-advertisement, commit/push/deploy changes in this pass. Existing dirty/untracked task-1 work is preserved. Tasks 2–7 remain outstanding; these fixes are not overall initiative completion.

