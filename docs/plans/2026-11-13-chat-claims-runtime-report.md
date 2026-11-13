# Chat claims task 2 — runtime protocol slice report

## Status: PARTIAL, not a runnable chat feature

Task 2 is **not complete**. This pass leaves a tested, isolated ACP chat protocol core. It deliberately does **not** connect that core to claim dispatch or advertise `chat` in runner session metadata: workspace/credential/permission/catalog/transcript and ownership integration gates are still open. Task 1's accepted dirty changes and the approved spec are preserved. No UI, handoff or connector implementation changed; no commits, push or deployment.

## Files / interfaces changed in this pass

| File | Change |
| --- | --- |
| `packages/fluent-flow-agent-server/src/acp/runtime.js` | Add `openSession() -> { sessionId }`, opening ACP without an initial prompt. Sessions opened this way never reconnect/resume after live-context loss. Existing `runInitialPrompt` unattended recovery stays unchanged. |
| `packages/fluent-flow-agent-server/src/chat-loop.js` (new) | Separate protocol core with sticky idle command polling, serialized prompts, acceptance acknowledgements, queued lease renewal and pre-apply renewal, turn-only cancel, permission/elicitation answer relay, explicit session end, child-exit supervision, bounded clocks, shutdown abort and child reap. No workspace deletion, claim heartbeat or claim-result persistence. |
| `packages/fluent-flow-agent-server/tests/unit/acp-runtime.test.js` | Real-child coverage of prompt-free opening/sticky turns and attended loss without recovery. |
| `packages/fluent-flow-agent-server/tests/unit/chat-loop.test.js` (new) | Real deterministic ACP child tests with an in-memory command transport seam; no provider invocation or spend. |
| `docs/plans/2026-11-13-chat-claims-progress.md` | Rulings, partial status, evidence and remaining gates. |
| This report (new) | Inventory and exact verification handoff. |

Inspected actual definitions/usages before editing: runner, server, ACP runtime/process/command, worktree, environment, client, config, package scripts, backend command lease semantics and prior task-1 report/ledger. No speculative connector rewrite or shared DB access.

### Protocol core contract

`runChatSession({ runtime, client, sessionId, claimId, repo, githubTokenExpiresAt, maxSessionDurationMs, commandPollMs, commandLeaseRenewMs, maxQueuedPrompts, signal })`:

- Caller supplies an already constructed ACP runtime, prepared workspace/environment, and the existing claim-command client. This is **not yet** called by `runner.js`.
- Defaults: 1 s command poll, 30 s queued lease renewal, 8 h absolute duration maximum. Tests shorten clocks only at the injected seam.
- Repository-linked sessions require a valid ISO credential expiry. Deadline is the earlier of credential expiry and duration; expired credentials start no child. Repo-null core sessions need no GitHub expiry, but production environment credential stripping remains a caller integration gate.
- Prompts apply only between turns and only with a renewed command lease; acknowledgement occurs on ACP acceptance. Lost acceptance is acknowledged `uncertain` once and never replayed. Repeated command IDs fail closed.
- Pending/active prompt tasks are bounded at 64 (configurable downward); overflow prompts get an explicit failed acknowledgement while End/Cancel remain serviceable. Duplicate-detection memory is bounded by an 8192-command lifetime ceiling, after which the core terminates instead of forgetting IDs and risking replay.
- `cancel` affects the active response only. Idle cancellation acknowledges `applied: false`. `end_session` reaps the child, acknowledges the command and returns `{ status: 'cancelled', end_reason: 'user' }`.
- Session deadline returns cancelled/max_duration. Idle child loss or caller shutdown signal returns failed/terminal/host_lost. Infrastructure/uncertain-command/cleanup failures propagate to the caller; their detail is not suitable for API responses.
- The future runner adapter must reconcile an authoritative idle/expiry/user end rather than overwriting it with this core's generic shutdown outcome.

## Rulings

1. **8 h vs token TTL:** duration is an upper bound, never a promise of 8 h repository access. Require delivered credential expiry and cap at it; do not invent refresh. Cost: shorter repository-linked sessions until a separately designed refresh protocol exists.
2. **Immutable transcript budget:** do not rewrite/delete persisted events. Bound future verbose emissions and reserve terminal/security budget in the future bridge. Cost: omit later verbose output instead of retroactively compacting old output. **Ruling recorded; bridge not implemented here.**
3. **Capacity:** preserve capacity-1 and the reserved work slot, including capacity=1 disabling chats despite explicit larger max_chat_slots. No admission weakening to make a smoke pass. Aggregate/resize policy is still open.
4. **Local command resource ceiling:** conservatively bound queued prompt tasks and remembered delivery IDs instead of allowing an 8 h session to accumulate unbounded local command state. Hitting the lifetime command ceiling terminates the session rather than silently forgetting old intents. Cost: extremely command-heavy sessions may need a new explicit session.

## Actual RED -> GREEN evidence

All paths below are under `/home/victor/.hermes/cache/scratch/`. Commands were run with complete output redirected and the underlying exit code preserved. Red logs are intentionally failures, not final gate results.

| Behavior | RED log (exit 1) | Observed failure | GREEN evidence |
| --- | --- | --- | --- |
| Prompt-free session opening | `chat-runtime-red-open.log` | `openSession is not a function` | `chat-runtime-green-open.log`, exit 0 |
| No attended reconnect | `chat-runtime-red-reconnect.log` | accepted-loss fixture resumed and resolved instead of failing | `chat-runtime-green-reconnect.log`, exit 0 |
| Separate idle loop | `chat-runtime-red-loop.log` | missing chat-loop module | `chat-runtime-green-loop.log`, exit 0 |
| Turn-only cancellation | `chat-runtime-red-cancel.log` | no cancellation idle transition | `chat-runtime-green-cancel.log`, exit 0 |
| Idle child supervision | `chat-runtime-red-idle-exit.log` | loop timed out after child exit | `chat-runtime-green-idle-exit.log`, exit 0 |
| Credential lifetime | `chat-runtime-red-token-cap.log` | loop outlived credential deadline | `chat-runtime-green-token-cap.log`, exit 0 |
| Clock/expiry validation | `chat-runtime-red-clock-validation.log` | unsafe timers accepted; expired credentials started a child | `chat-runtime-green-clock-validation.log`, exit 0 |
| Shutdown/setup interruption | `chat-runtime-red-shutdown.log` | held poll hung; setup failure replaced deadline result | `chat-runtime-green-shutdown.log`, exit 0 |
| Uncertain prompt delivery | `chat-runtime-red-uncertain.log` | no uncertain acknowledgement | `chat-runtime-green-uncertain.log`, exit 0 |
| Queued lease renewal | `chat-runtime-red-queued-lease.log` | queued lease never renewed | `chat-runtime-green-queued-lease.log`, exit 0 |
| Permission relay | `chat-runtime-red-permission.log` | answer never reached ACP child | `chat-runtime-green-permission.log`, exit 0 |
| Renewal clock validation | `chat-runtime-red-renew-validation.log` | unsafe renewal clocks accepted | final fixture suite below, exit 0 |
| Duplicate/queue bounds | `chat-runtime-red-queue-bound.log` | duplicate not terminated; overflow not rejected | final fixture suite below, exit 0 |

Some deliberately failing tests also exposed teardown/unhandled-rejection symptoms before their implementations existed. Final runs have no unhandled-error or timer-warning output.

## Final verification

| Gate / command | Actual result | Full log |
| --- | --- | --- |
| `COLLAB_CONNECTOR_TEST_DATABASE_URL=postgres://fluentflow@127.0.0.1:32770/ff_connector_runtime npm test -w @fluent-flow/agent-server` | exit 0; 47 files / 889 tests passed | `chat-runtime-agent-full-final2.log` |
| `npm test -w @fluent-flow/agent-server -- tests/unit/chat-loop.test.js tests/unit/acp-runtime.test.js` | exit 0; 2 files / 46 tests passed | `chat-runtime-acp-smoke-final2.log` |
| `npm run typecheck -w @fluent-flow/agent-server` | exit 0 | `chat-runtime-agent-typecheck-final.log` |
| `npm run smoke -w @fluent-flow/agent-server` | **exit 1**, timed out waiting for overlapping ACP running states | `chat-runtime-agent-smoke.log` |
| Same smoke from a scratch `git archive HEAD` of the package, using the same installed dependencies | **exit 1**, same overlapping-state timeout | `chat-runtime-baseline-smoke.log` |

The 46-test fixture suite is a **real ACP v2 stdio protocol smoke**, not synthesized output: it spawns the checked-in deterministic child with `process.execPath`, opens without prompting, waits idle, follows up, cancels, relays permissions, ends and observes child exit. It also asserts a real pre-existing workspace file survives closure. **That file assertion is not proof of Git worktree safe teardown or durable GC retention**, which is still unimplemented.

The existing package smoke failure is also reproduced on HEAD; this establishes the same baseline symptom, **not its root cause**. Its gate remains missing and must be diagnosed before task-2 acceptance.

`jsconfig.json` includes only `src/connector/**/*.js`: package typecheck passes but does not cover the new protocol core. A direct targeted `tsc --allowJs --checkJs --noEmit --module nodenext --target es2022 --skipLibCheck .../src/chat-loop.js` was blocked **before execution** by the tool lifecycle guard because TypeScript's `_tsc.js` exceeds its 1 MiB scan cap. No successful targeted runtime typecheck is claimed.

Only fresh disposable loopback PostgreSQL containers were used: `ff-chat-runtime-pg` on 32769 (intermediate gates) and `ff-chat-runtime-final-pg` on 32770 (final gate), each with a new `ff_connector_runtime` database. Connector composition tests ran migrations only there. No DB/server implementation was modified in this pass, so their standalone full suites were not rerun. Cleanup verification is recorded in the ledger after actual exact-name read-back.

## Remaining task-2 sub-boundaries / acceptance blockers

1. **Runner integration and ownership reconciliation:** connect the core to actual chat claim handling, bridge lifecycle, heartbeat ownership loss, authoritative expiry/end status, terminal result retry/idempotency and shutdown. Reap/free slot independently of filesystem deletion. Preserve unattended and deterministic verification behavior. Do not advertise chat yet.
2. **Credential delivery/environment:** deliver actual GitHub token expiry from the owning resolver/API, enforce the cap end-to-end, force repo-null credential stripping even for malformed delivered input, and test credentials never reach repo-null children. This core validates the supplied deadline only; it does not resolve or refresh credentials.
3. **Provider policy/catalog:** force validated provider ask/confirm modes; advertise a locally validated profile/model catalog; validate project defaults and selected payload model/profile without allowing remote executable/argv/environment injection. Configuration mutation UI remains task 3.
4. **Workspace lifecycle:** per-task checked-out `ff/task-<task_id>` resumption, safe per-claim repository workspace, separate repo-null scratch root, dirty/unpushed retention, task-scoped durable GC evidence, explicit discard and safe startup cleanup. The current legacy `worktree.js` still has force removal/recursive cleanup and must never receive chat workspaces until replaced or bypassed safely.
5. **Transcript safety:** compatible future-emission budgets/backpressure with explicit truncation marker and reserved terminal/security allowance. No persisted-history rewrite. The current event bridge is unchanged.
6. **Capacity/resize:** real races for reserved work admission, heterogeneous instances and capacity shrink behavior at idle/duration boundaries. Existing conservative backend admission is unchanged.
7. **Remaining hardening/gates:** definitive command rejection/invalid answer behavior, transport/ack failures and lease/expiry races through actual HTTP/PG, long-duration command resource boundaries, runtime static typing, end-to-end runner smoke and existing package smoke root-cause diagnosis. No fresh independent review was dispatched (forbidden in this task).

This pass is useful groundwork, **not task-2 acceptance and not overall approved-spec completion**.
