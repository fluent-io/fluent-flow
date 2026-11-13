# Task 2 runtime review fixes — round 1

## Outcome and scope

All six actionable findings in `/home/victor/.hermes/cache/scratch/chat-runtime-integration-review.md` are addressed in the Linux runtime and covered by executed regressions. This is implementation/self-verification, **not independent acceptance**. Runtime stays default-off behind the existing explicit local catalog opt-in. No UI, handoff, connector removal, authorization weakening, credential access, commits, push, deployment, agents, or shared database changes.

Worktree: `/home/victor/work/fluent-io/worktrees/chat-claim-spec`, branch `chat-claim-execution-spec`. Binding spec, prior implementation/report and progress ledger were read; existing dirty/untracked work was preserved. This report supplements, rather than rewrites, the earlier integration report.

## Findings, root causes and regressions

| Review finding | Root cause / actual change | Executed regression |
| --- | --- | --- |
| 1 — close rejection leaks task lease | The runtime's cached close rejects after reaping when cancellation persistence fails. Runner now logs/degrades cleanup health but schedules workspace release in a nested `finally`, regardless of close rejection; it still reconciles authoritative ownership. Workspace preparation's error-record write also has an independent unlock `finally`. | Real ACP child opens a permission request, cancellation upload rejects with ownership conflict, heartbeat becomes authoritative null, child exits, receipt becomes inactive, and a second claim prepares/releases the same task within a bounded deadline. |
| 2 — idle/acceptance-ack Stop race | An outstanding prompt/ack promise was mistaken for foreground work. `runtime.cancel()` captures/rechecks the foreground identity and returns `{ accepted: false }` for already-ended work. Chat uses the returned boolean. A next-prompt barrier is installed **before Cancel lease renewal**, held through cancellation/ack, and rechecked after asynchronous waits. | Real runtime reaches idle with the first acceptance ack held: Stop is acked `applied:false`, the next turn completes and End remains user cancellation. Separate delayed-Cancel-renewal test proves the queued next prompt does not overtake the cancel. Its first run caught the intermediate implementation installing the barrier too late. |
| 3 — final probe/flush discards intended end | Final heartbeat exceptions bypassed reporting; final flush exceptions overwrote an already-returned outcome. Authoritative null/410 still relinquish ownership. Other final-probe failures are logged and reconciled by the existing ownership-aware/idempotent result endpoint with its bounded retries. An already-computed outcome survives final transcript errors. | Final heartbeat fails once with 503, healthy result delivery still receives cancelled/user. Explicitly buffered final transcript fails upload after End and result remains cancelled/user. Existing mounted authoritative expiry/idempotent result-loss tests remain green. |
| 4 — catalog registration mismatch | Backend treated `profiles` as unknown metadata, activating its 4096-byte fallback. Add it to known keys and explicitly validate the strict, bounded public projection. Local programmatic validation also enforces the file-size bound and rejects a default model absent from its allowlist. | Mounted HTTP/PostgreSQL registration accepts the local public projection at **32 profiles × 100 models**, above 4096 bytes; DB read-back equals that projection. Mounted tests reject excess profiles/models/bytes, invalid IDs/defaults/duplicates and private `env` fields. Local tests cover safe projection, invalid empty-model default and oversized programmatic input. |
| 5 — redirected storage ancestry | Leaf-only `lstat` followed symlinked parents. Walk/check every existing ancestor, create directories one component at a time, reject symlinks and pin directory device/inode identities for the manager lifetime. Check scratch release as well as Git paths/receipts/leases. Recursive scratch/lease deletion is anchored to an opened, identity-checked parent fd on Linux. Forget identities only after owned removal/movement. Receipt temp writes are exclusive; failed preparation cannot bypass local unlock. | Real filesystem tests replace the **scratch task parent** with a symlink before prepare/release/discard, and replace it with a different real directory before discard. Each operation refuses; outside data survives; no outside next-claim directory appears; original safe receipts are inactive. A redirected state-root ancestor is refused before creating receipts. Existing real Git retention/resumption/discard/startup/concurrency tests pass. |
| 6 — background bridge failure leaves chat alive | Chat never observed the runner's interaction-failure promise. Pass it into the chat loop; resolution/rejection immediately stops the loop, aborts its held poll, prevents subsequent command application and starts child teardown without needing another ACP event. Runner reports terminal failure using the existing bounded result path. | Background event flush rejects after a normal turn has gone idle, with no later ACP event. Reporting begins, its first 503 is retried, child exits, failed/terminal/host_lost is delivered and a subsequent prompt is not acknowledged/applied. |

Errors are not converted to success: command/upload uncertainty still stops the session; cleanup failures explicitly log and degrade health while retaining evidence; bounded report exhaustion still propagates. The valid user outcome is distinct from transcript delivery health. Originator authorization and GitHub credential delivery/environment code are unchanged by this round.

## Exact interfaces and bounds

- Internal `createAcpRuntime().cancel()` still returns `{ accepted: boolean }`; the new explicit idle outcome is `false` rather than throwing `ACP foreground work is not active`. Active notification failure remains terminal, and pending request persistence errors propagate. No automatic replay/reconnect was added.
- Internal `runChatSession(...)` adds optional `failurePromise`, carrying the bridge error. Public prompt/cancel/end command shapes, routes, acknowledgements and result identities are unchanged. Cancel is never a session-end intent.
- Registration `meta.profiles` is now an explicitly validated known field: `{ id: string, models: string[], default_model?: string }[]`, strict objects; 1–32 distinct profiles, at most 100 distinct model IDs per profile; identifiers 1–128 chars matching `[A-Za-z0-9][A-Za-z0-9._:/-]*`; nonempty models require an allowlisted default, empty models prohibit a default. Serialized public projection is at most **64 KiB**. Local parsed catalog is also at most 64 KiB in addition to the existing source-file limit; its public projection removes permission/model selectors and is smaller. Unknown session metadata retains its existing conservative whole-metadata fallback limit. No process/permission config is accepted inside the public projection.
- Workspace manager exports and durable receipt fields are unchanged. Directory identities are local in-memory guards, not new public receipt fields. Recursive scratch/lease removal requires Linux `/proc/self/fd`; workspace-manager construction fails closed on other platforms, before session registration/preparation can acquire an unreleasable lease. The platform-guard regression was first observed failing in `chat-runtime-fixes-red-5-platform.log`, then passes in the final agent suite. This Linux-specific safety mechanism is **not a Windows/macOS compatibility claim**. Platform enablement needs a corresponding anchored-removal implementation/validation; do not advertise preview chat there on this evidence.
- Git cleanup remains non-force ordinarily; force is still restricted to explicit local discard. Ancestry/path guards are not an OS sandbox against an actively malicious same-user process. The existing dedicated trusted state-root / one-server-process / same-user ACP trust model remains binding.
- Final heartbeat failure is not an infinite heartbeat retry loop. It enters the bounded ownership-aware result path, retaining the end intent. Sustained result/control-plane outage still ultimately relies on backend host-loss expiry; no durable outbox was invented.

## Files changed by this round

Paths below are relative to the worktree; all prior task files remain uncommitted.

**Implementation**

- `packages/fluent-flow-agent-server/src/runner.js`
- `packages/fluent-flow-agent-server/src/chat-loop.js`
- `packages/fluent-flow-agent-server/src/acp/runtime.js`
- `packages/fluent-flow-agent-server/src/chat-profiles.js`
- `packages/fluent-flow-agent-server/src/chat-workspace.js`
- `packages/fluent-flow/src/routes/agent-server.js`

**Tests**

- `packages/fluent-flow-agent-server/tests/unit/runner-chat.test.js`
- `packages/fluent-flow-agent-server/tests/unit/chat-loop.test.js`
- `packages/fluent-flow-agent-server/tests/unit/fake-acp-agent.js` — explicit permission fixture option combined with advertised chat policy; no provider behavior guessed.
- `packages/fluent-flow-agent-server/tests/unit/chat-profiles.test.js`
- `packages/fluent-flow-agent-server/tests/unit/chat-workspace.test.js`
- `packages/fluent-flow/tests/routes/agent-chat-runner.test.js`

**Documentation**

- This new report.
- `docs/plans/2026-11-13-chat-claims-progress.md` — appended round-1 evidence/status.
- Default-profile `fluent-flow-dev/references/test-matrix.md` — reusable, exercised sticky-chat failure matrix. No other profile modified.

No DB source, migration, approved spec, dashboard or connector implementation edits in this round. DB build was nevertheless executed because the server's validation schema changed and the affected suites use the shared built package.

## RED → GREEN and preserved evidence

Every substantive review scenario was reproduced before its fix; all logs use the new `chat-runtime-fixes-*` namespace under `/home/victor/.hermes/cache/scratch/`. No prior evidence was overwritten.

| RED log | Observed failure | GREEN evidence |
| --- | --- | --- |
| `chat-runtime-fixes-red-1-actual.log` | inactive-receipt deadline after authoritative expiry/open-request cancellation conflict | `chat-runtime-fixes-green-1-actual.log`, exit 0; final full suite |
| `chat-runtime-fixes-red-2.log` | missing Stop ack / terminal cleanup after idle during delayed acceptance ack | `chat-runtime-fixes-green-1-3.log`, exit 0; final full suite |
| `chat-runtime-fixes-red-2-barrier.log` | queued next prompt reached ACP while Cancel lease renewal remained held (2 prompts rather than 1) | final full agent suite, including both real-runtime races |
| `chat-runtime-fixes-red-3.log` | no result delivered after one failed final heartbeat | `chat-runtime-fixes-green-3.log`, exit 0; final full suite |
| `chat-runtime-fixes-red-3-transcript-actual.log` | buffered final transcript upload converted user cancellation to host_lost failure | `chat-runtime-fixes-green-1-3.log`, exit 0; final full suite |
| `chat-runtime-fixes-red-4.log` | mounted valid large catalog registration returned 400 instead of 200 | `chat-runtime-fixes-green-4.log`, exit 0; final server suite |
| `chat-runtime-fixes-red-4-local.log` | local validation accepted invalid empty-model default | `chat-runtime-fixes-green-4-5.log`, exit 0; final agent suite additionally checks oversized input |
| `chat-runtime-fixes-red-5.log` | 4 failures: redirected prepare/release/discard and replaced-real-parent discard all resolved instead of refusing | `chat-runtime-fixes-green-4-5.log`, exit 0; final full agent suite includes root-ancestor refusal too |
| `chat-runtime-fixes-red-6.log` | background failure never initiated terminal reporting without another event | `chat-runtime-fixes-green-6.log`, exit 0, including result retry; final full suite |

Fixture corrections are preserved rather than concealed: initial finding-1 probe used a permission scenario without advertised chat policy and failed before the target boundary (`red-1.log` / `green-1.log`); combined fixture option then produced the actual lifecycle RED above. Initial transcript test passed because it had no buffered event (`red-3-transcript.log`); explicitly buffering output produced the actual RED. Intermediate runtime typechecks found inference-only issues for the path accumulator and deferred Cancel-release callback; those were corrected, not waived (`runtime-typecheck.log`, `runtime-final.log`). An intermediate green-2 test ended a second active turn too early and counted End's legitimate cancellation; it now waits for the second idle before asserting no turn-cancel notification. A later full run caught a separate mounted-test race: Cancel ack precedes the provider idle event upload, which could refresh activity after the test backdated it (`chat-runtime-fixes-server-final-verified.log`, 1/784 failed). The test now waits for the second persisted idle event before backdating/expiry; no product expiry logic or timeout was weakened. Three consecutive mounted runs passed (`chat-runtime-fixes-mounted-repeat-{1,2,3}.log`, each exit 0 / 4 tests), then the complete server rerun passed. All corrected tests pass in the definitive full gates.

## Final full gates (actual commands/results)

Logs below are under the scratch prefix above. `chat-runtime-fixes-final-statuses.json` preserves the first final-gate commands/environment overrides and statuses, including the initial runtime inference exit 2. `chat-runtime-fixes-verified-statuses.json` records the next parallel gates: agent/runtime/connector/smoke/DB build passed; server had the mounted-test timing failure explained below. The definitive subsequent full server pass is `chat-runtime-fixes-server-release.log`. Full final gate logs include `COMMAND_EXIT_STATUS`.

| Gate | Result | Full log |
| --- | --- | --- |
| `COLLAB_CONNECTOR_TEST_DATABASE_URL=postgres://fluentflow@127.0.0.1:32772/ff_connector_fixes npm test -w packages/fluent-flow-agent-server` | exit 0; **52 files / 927 tests** | `chat-runtime-fixes-agent-final-verified.log` |
| `DATABASE_URL=postgres://fluentflow@127.0.0.1:32772/ff_legacy_fixes TEST_DATABASE_URL=postgres://fluentflow@127.0.0.1:32772/ff_legacy_fixes COLLAB_ROUTES_TEST_DATABASE_URL=postgres://fluentflow@127.0.0.1:32772/ff_chat_fixes AUTH_TEST_DATABASE_URL=postgres://fluentflow@127.0.0.1:32772/ff_auth_fixes npm test -w packages/fluent-flow` | exit 0; **78 files / 784 tests** | `chat-runtime-fixes-server-release.log` |
| `npm run typecheck:runtime -w packages/fluent-flow-agent-server` | exit 0; runner/chat/ACP runtime checkJs scope | `chat-runtime-fixes-runtime-final-verified.log` |
| `npm run typecheck -w packages/fluent-flow-agent-server` | exit 0; connector scope, separate from runtime | `chat-runtime-fixes-connector-final-verified.log` |
| `npm run smoke -w packages/fluent-flow-agent-server` | exit 0; `Portable agent server smoke passed.` | `chat-runtime-fixes-smoke-final-verified.log` |
| `npm run build -w packages/db` | exit 0 | `chat-runtime-fixes-db-build-final-verified.log` |
| `git diff --check` | exit 0 after documentation | `chat-runtime-fixes-diff-check-final.log` |

Only the newly created `ff-chat-runtime-fixes-pg` container on loopback `127.0.0.1:32772`, with disposable `ff_chat_fixes`, `ff_connector_fixes`, `ff_legacy_fixes`, `ff_auth_fixes` databases, was used/migrated/reset. Initialization logs: `chat-runtime-fixes-postgres-create.log`, `chat-runtime-fixes-legacy-migrate.log`. No existing/shared DB was used. Cleanup exit 0 is recorded in `chat-runtime-fixes-postgres-cleanup.log`; exact-name `docker ps --all` read-back returned no rows with exit 0 (`chat-runtime-fixes-postgres-cleanup-verified.log`). Final tracked/untracked inventory is preserved in `chat-runtime-fixes-final-inventory.log`.

## Remaining gates / rulings

- No remaining failing gate for the six concrete Linux review findings. Independent re-review remains required; this report does not replace it.
- Real-provider/GitHub combined smoke, image release, non-Linux anchored cleanup/platform enablement and long wall-clock soak remain unestablished. Existing report's paid/live-provider limitations still apply. Do not interpret deterministic ACP fixtures as real-provider compatibility.
- Task 3 UI/settings/catalog-default APIs/progress/retention projections and measured UI latency are untouched. Handoff, re-key, freeze/removal remain later work. No end-user operational/UI completion is claimed.
