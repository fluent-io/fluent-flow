# Chat claims progress ledger

## Scope / rulings

- Worktree verified: `/home/victor/work/fluent-io/worktrees/chat-claim-spec`, branch `chat-claim-execution-spec`. Initial git status: only binding Draft v3 spec modified; preserve it.
- Full spec read (246 lines). Entire rollout gated in adjacent implementation plan. This execution covers task 1 only; runtime, UI, re-key, connector retirement are not claimed complete.
- Existing repo actually uses raw pg and Drizzle; preserve owning boundary style rather than invent new speculative services.
- Runtime must explicitly advertise chat support before polling chat claims; old runners must never consume the newly accepted type.
- Spec `task.create` is not an actual repository capability. New session uses existing `task.write` (the owning task creation service's permission), plus `run.start` and `internal.read`; no speculative capability added.
- Capacity admission is conservative per polling instance's validated advertised capacity (1..16), capped at capacity-1 even if configured max is higher. Missing/invalid capacity admits no chats. A VOLATILE PostgreSQL admission function takes the agent row lock before counting to avoid simultaneous-slot oversubscription.
- Pending deadline and idle duration are snapshotted from project settings when the chat is created. Existing projects retain connector attended mode; new projects default chat. New chat creation is server-gated by `execution_mode`; replay/ending existing chats remains possible after a mode change. Unattended starts ignore this attended rollout flag.
- Parent-row activity triggers require an exclusive owner lock before interaction mutation; `withClaimOwner` now acquires UPDATE rather than SHARE to prevent concurrent lock-upgrade deadlocks. Real concurrent streamed event + permission-ack requests pass.
- Delivery-time authorization is implemented for chat commands in this slice (not deferred): persist submitting principal/session version; recheck current `internal.read` and steer/cancel capability before leasing. Revoked prompts and permission answers fail closed; rejected answers reopen their request. Unexpected database/auth infrastructure failures propagate.
- Terminal end replay checks idempotency conflicts before returning success. A real PostgreSQL lock-wait test reproduced expiry committing between owner validation and finalization (409 before fix); handler now returns the already-cancelled state and preserves the first end reason.

## Implemented / in progress

- Additive 0029 migration, existing-task chat service/HTTP creation, repo-null handling, task-scoped allocator and active uniqueness, target routing, TTL/idle expiry and retry exclusion implemented.
- New session composes owning task creation and claim creation with one pg transaction and project/principal/key-scoped replay; rollback tested. Work task creation keeps existing default transaction behavior.
- Command boundary distinguishes cancel versus end_session; pending end directly cancels with user reason, active end queues command for runtime. Chat completed result rejected; failed/transient shutdown remains terminal.

## Verification

- RED -> GREEN captured for creation, end semantics, pending expiry, routing/capacity concurrency, activity/result boundary, New session. Initial failures were actual missing behavior (logs in scratch `chat-claims-red-*.log`).
- `npm ci`: exit 0, `/home/victor/.hermes/cache/scratch/chat-claims-npm-ci.log`.
- Full db package suite: exit 0, `/home/victor/.hermes/cache/scratch/chat-claims-db-full.log` (counts recorded in final report after remaining checks).
- Focused mounted route suite: exit 0 through activity/result tracer, `/home/victor/.hermes/cache/scratch/chat-claims-green-activity.log`.
- Dedicated disposable Docker Postgres: `ff-chat-claims-test`, loopback port 55439, databases `ff_chat_test`, `ff_server_test`, `ff_connector_test`, and `ff_auth_test`, trust auth only for these test fixtures. No credential files read. No existing/shared DB migration executed.

## Final gate results

All commands below actually executed with full output redirected to scratch and preserved exit statuses:

| Gate | Actual result | Full output |
| --- | --- | --- |
| DB full suite | exit 0; 23 files / 319 tests passed | `/home/victor/.hermes/cache/scratch/chat-claims-db-full.log` |
| Server full suite (including real poll integration) | exit 0; 76 files / 777 tests passed; no skips | `/home/victor/.hermes/cache/scratch/chat-claims-server-full.log` |
| Agent-server full suite (including real connector app) | exit 0; 46 files / 866 tests passed | `/home/victor/.hermes/cache/scratch/chat-claims-agent-full.log` |
| Dashboard full suite | exit 0; 25 files / 430 tests passed | `/home/victor/.hermes/cache/scratch/chat-claims-dashboard-full.log` |
| DB TypeScript build | exit 0 | `/home/victor/.hermes/cache/scratch/chat-claims-db-build.log` |
| Agent-server typecheck | exit 0 | `/home/victor/.hermes/cache/scratch/chat-claims-agent-typecheck.log` |
| Dashboard production build without DATABASE_URL | exit 0; compiled/static pages generated | `/home/victor/.hermes/cache/scratch/chat-claims-dashboard-build.log` |
| git diff --check | exit 0 | final command output |

Intermediate suite failures were obsolete SQL-shape assertions (work-only chain allocation now explicitly excludes chat; ownership locking is exclusive; expiry uses CASE) and were changed to assert the new contract, not suppressed. Intentional failure-case logger messages remain in passing suites.

## Handoff / remaining gates

- Task 1 API/database boundary is implemented and regression-tested. Tasks 2–7 remain gated: sticky ACP runtime/idle command service, duration/token caps/ask mode, safe workspace retention and GC, catalog/config write surfaces, transcript backpressure, UI drawer, handoff, data re-key, freeze/removal, end-to-end latency/security acceptance.
- No runner advertises chat yet. This is not an end-user-operational chat feature. Do not advertise/enable chat execution until runtime/resource/security gates pass.
- Capacity accounting deliberately uses the polling instance's bounded capacity, not a sum across multiple agent-server instances sharing one agent. Conservative under-admission on heterogeneous instances is possible; settle aggregate/resize policy in task 2.
- No live ACP/Paseo smoke was run because runtime was not modified; all API/DB tests and package gates above are real.
- No UI/connector implementation changed, no migration ran against a pre-existing/shared DB, no credential files read, and no commit/push/merge/deploy was performed. Approved spec remains untouched by this task.
- Final report: `docs/plans/2026-11-13-chat-claims-backend-report.md`.
- Disposable container stopped; subsequent filtered `docker ps --all` returned no rows, confirming removal. Cleanup log: `/home/victor/.hermes/cache/scratch/chat-claims-postgres-cleanup.log`.

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

## Controller acceptance / task 2

- Task 1: complete at the API/database boundary, uncommitted. Independent scoped re-review approved both fixes with no fix-induced regressions: `/home/victor/.hermes/cache/scratch/chat-claims-backend-fixes-review.md`. Controller read actual final logs confirming DB 327, server 777, affected dashboard 118, and successful DB build; `git diff --check` passed.
- Task 2: in progress — interactive runtime, lease and resource safety. No runtime advertisement or user-facing operational-chat claim until task 2 passes tests and independent review.

### Task 2 runtime protocol slice (in progress)

- Ruling: the 8 h duration is an absolute maximum, not a promise of 8 h repository access. Repo-linked sessions require a valid delivered credential expiry and end at the earlier deadline. No refresh or reconnect is invented; expired credentials must not start a child. Cost if wrong: sessions may be conservatively shorter until a separately designed refresh path exists.
- Ruling: immutable persisted events cannot be replaced with truncated stubs. The eventual bridge must bound future verbose emissions and reserve space for terminal/security events, without rewriting or deleting persisted history. Cost if wrong: later verbose transcript content is omitted rather than retroactively compacting the earliest content. This bridge work is still outstanding.
- Capacity ruling carried unchanged: capacity-1 reserves one work slot; capacity=1 disables chats even with an explicit larger max_chat_slots. Do not change admission merely to get a smoke running. Aggregate/resize acceptance remains outstanding.
- Actual definitions/usages inspected in runner, server, ACP runtime/process/command, worktree, environment, client and config before edits. `jsconfig.json` currently typechecks only connector code, so a successful package typecheck alone is not proof of runtime type coverage.
- Added unadvertised `runtime.openSession()` and isolated protocol-loop groundwork. Runner registration remains unchanged and does not advertise chat; no production chat dispatch is enabled. The module is not yet connected to workspace preparation, permission-profile validation or runner ownership/reporting.
- RED observed: open API missing; attended accepted-child-loss incorrectly resumed; idle loop absent; cancel failed to stop a response; idle child exit hung; token/session deadline absent; malformed clocks started children. Full output under scratch `chat-runtime-red-*.log`; exact final results are in the runtime report.
- Ruling: bound local pending/active prompt tasks at 64 (configurable downward) and remembered delivery IDs at an 8192-command lifetime ceiling. Reject overflow prompts explicitly without blocking Cancel/End; terminate rather than forget old IDs and risk replay. Cost: extremely command-heavy sessions may require a new explicit session.

### Task 2 protocol-slice final verification / handoff

**PARTIAL: task 2 remains incomplete. No runner advertises chat.** No production runner adapter was wired to this core because the credential/ask-mode/workspace-retention/transcript gates are not implemented.

All log names here are relative to `/home/victor/.hermes/cache/scratch/`:

- `COLLAB_CONNECTOR_TEST_DATABASE_URL=postgres://fluentflow@127.0.0.1:32770/ff_connector_runtime npm test -w @fluent-flow/agent-server`: exit 0; **47 files / 889 tests** passed, `chat-runtime-agent-full-final2.log`.
- `npm test -w @fluent-flow/agent-server -- tests/unit/chat-loop.test.js tests/unit/acp-runtime.test.js`: exit 0; **2 files / 46 tests** passed, `chat-runtime-acp-smoke-final2.log`. These tests run real local ACP child processes, including prompt-free opening/idle/follow-up/cancel/end, permissions, uncertain delivery, queued renewal/loss, duplicate/queue bounds, idle child exit, shutdown, credential/session deadlines and actual workspace-file preservation. Command HTTP transport is an injected test seam; this is not a full production runner or durable Git-retention smoke.
- `npm run typecheck -w @fluent-flow/agent-server`: exit 0, `chat-runtime-agent-typecheck-final.log`. Scope warning: existing jsconfig only includes connector code. Targeted direct TypeScript invocation for new core was blocked before execution by tool lifecycle scanning of the oversized `_tsc.js`; no targeted runtime typing pass claimed.
- Existing `npm run smoke -w @fluent-flow/agent-server`: **exit 1**, overlapping ACP running-state timeout, `chat-runtime-agent-smoke.log`. Same package from scratch `git archive HEAD` reproduces **exit 1 / same timeout**, `chat-runtime-baseline-smoke.log`. Root cause remains unproven; this gate is not waived or reported green.
- `git diff --check`: exit 0, `chat-runtime-diff-check-final.log`.
- Disposable containers only: `ff-chat-runtime-pg` / loopback 32769 and `ff-chat-runtime-final-pg` / loopback 32770, fresh `ff_connector_runtime` DB each. Both stopped. Immediate --rm read-back briefly still listed the stopped container; later exact-name listings are the authoritative removal check (`chat-runtime-postgres-cleanup-confirmed.log` and `chat-runtime-postgres-final-cleanup-confirmed.log`). No shared/pre-existing DB migrations or credential files accessed.
- Self-review only (no reviewers dispatched): verified attended recovery guard is isolated from unattended runInitialPrompt; command/cleanup errors propagate; held-poll cancellation is explicit; runtime process release is independent of filesystem deletion in this protocol module. This is not independent task acceptance.
- Report and complete remaining-sub-boundary inventory: `docs/plans/2026-11-13-chat-claims-runtime-report.md`. Remaining: runner ownership/result/shutdown wiring; actual token-expiry transport/repo-null environment; provider ask mode/local profile/model catalogs and project-default validation; task-branch/scratch preparation and durable retention/GC/discard/startup safety; transcript future-emission budget; aggregate capacity/resize races; command edge/HTTP integration/static-type and existing smoke diagnosis gates.
- Backend/UI/handoff/connector/spec edits from earlier work preserved; only ACP runtime, new isolated chat loop and their tests plus this ledger/report changed in this pass. No commit/push/deploy.

## Task 2 production integration continuation

- Actual production runner now calls `runChatSession` for explicitly opted-in chat claims. RED mounted HTTP/PG runner test: `chat-integration-red-runner-http.log` (no claimed chat); GREEN `chat-integration-green-runner-http.log`, exit 0 / 3 tests. Real deterministic ACP child + actual app routes + disposable PostgreSQL exercise idle/no initial prompt, prompt acceptance, turn-only cancel, user end with lost-result-response retry, authoritative idle/host expiry and no redispatch. This is an integration tracer, not final task acceptance.
- Credential resolver returns provider-issued expiry atomically paired with its cached token; linked chat poll transport overwrites payload expiry; repo-null gets neither token nor expiry. RED/GREEN scratch `chat-integration-{red-expiry,red-delivery,green-expiry}.log` (13 final tests).
- Separate `chat-workspace.js` roots bypass legacy destructive startup GC. Task branch, per-claim checked-out worktree, dirty/unpushed retention, inactive retained-worktree move/resumption, durable local receipts, separate repo-null scratch, local explicit discard tested with real Git. RED/GREEN `chat-integration-{red,green}-workspace.log` (3 green tests).
- Ruling: startup reconciliation retains all chat work and only reclaims dead-process lease metadata; no opportunistic clean-work/aged-scratch deletion — conservative retention avoids silent data loss; cost: local disk accumulates until operator discard or ordinary clean/pushed release.
- Ruling: operator-local profile catalog pins ACP v2 configId plus explicit ask/confirm value and allowlisted models; runtime validates provider-advertised selectors and confirms settings before user prompts. Unsupported adapters fail closed rather than guessing flags — cost: adapters lacking matching ACP v2 configuration cannot run chats. RED/GREEN `chat-integration-{red,green}-policy.log` (3 green tests).
- Ruling: finite future transcript budget reserves 4 MiB for state/user/config/notice events; persisted events remain immutable. If reserved emissions also exhaust the bound, suppress further transcript output rather than kill the session; commands/permission requests/answers/terminal results use separate persistence — cost: extreme sessions lose later transcript detail. Bridge/full gates remain in progress.
- Chat remains default-off. Settings/UI APIs and retained-work projections belong to the following task; exact emitted/catalog/receipt contracts go in integration report. No commits/push/deploy, no connector changes, approved spec and previous dirty work preserved.

### Task 2 integrated runtime gate / handoff

- **Integrated runtime slice ready for independent controller review; not production-enabled or overall-spec complete.** `runner.js` calls `runChatSession` through actual claimed HTTP work. The new `--chat-profiles-file` is explicit operator-local preview opt-in; absent still advertises no chat. No UI/handoff/re-key/connector removal was performed.
- Final actual gates, scratch prefix `/home/victor/.hermes/cache/scratch/`: agent full **52 files / 914 tests**, exit 0 (`chat-integration-agent-release-gate.log`); server full **78 files / 783 tests**, exit 0 (`chat-integration-server-release-gate.log`); DB full **23 files / 327 tests**, exit 0 (`chat-integration-db-full.log`); DB build exit 0 (`chat-integration-db-build.log`); existing connector typecheck and new actual runtime checkJs typecheck both exit 0 (`chat-integration-{connector,runtime}-typecheck-release-gate.log`); package smoke exit 0 (`chat-integration-smoke-release-gate.log`); diff check exit 0 (`chat-integration-diff-check.log`). No root-monorepo/dashboard/image/real-provider/Windows pass is claimed.
- Mounted HTTP/PG/real ACP + capacity suite: **2 files / 39 tests**, exit 0 (`chat-integration-http-capacity-green.log`). Tests exercise prompt-free idle claim ownership, active response Cancel, multiple prompts, user End, response loss after result persistence and bounded retry/idempotency, authoritative idle/host expiry/no redispatch, real reserved work acquisition and non-killing admission shrink. Repo-null child credential absence is directly observed; repository workspace tests use real local Git.
- Safe workspace final coverage includes dirty/unpushed/ignored retention, refreshed remote reachability before clean deletion, per-task checked-out branch and per-claim retained-worktree move/resumption, receipt-before-preparation, concurrent tasks sharing a repo, immediate same-task reopen while prior release runs, dead-process startup retention, separate scratch, replaced-symlink rejection and real explicit local discard CLI. Slot/child release is tested with filesystem release held unresolved.
- Ruling: production chat storage uses the durable state volume (`chat-workspaces` / `chat-scratch`) outside the work root, not a potentially unwritable `/work` sibling — cost: retained work consumes durable state capacity. Standalone programmatic runners keep their sibling-root default. State/work roots must not be shared by multiple server processes.
- Ruling: existing capacity-minus-one, per-instance conservative admission stays. A shrink never kills live chats; sessions drain on ordinary inactivity/duration/explicit end, not immediate response-idle eviction — cost: transient excess after shrink and possible heterogeneous-instance under-admission. No aggregate live-resize feature claimed.
- Ruling: bounded result retries are not an infinite durable outbox. Exhausted transport retries propagate/log; local child/slot release and authoritative host-loss expiry remain the fallback, with no redispatch — cost: delayed terminal visibility/end-reason loss during a sustained outage.
- Existing smoke root cause proved: generated extensionless fake Git used ESM outside module scope and failed before ACP started (Node v26.9.0). Fixture module scope is now explicit and redacted diagnostics are available. RED `chat-integration-smoke-diagnosis.log`; final real package smoke green. No baseline waiver remains.
- Self-review (no agents allowed): found applied user End being mislabeled failed/host_lost on End-ack transport loss. RED `chat-integration-red-end-ack-loss.log`; preserved internal terminal intent while still propagating/logging failure; final full agent/server/typecheck/smoke gates rerun afterward. Repo-null guard breaking verification: removed only the guard, observed credential test fail (`chat-integration-mutation-repo-null.log`), restored it, reran final gates.
- Runtime compiler now actually checks runner/server/chat/ACP/config/transitive dependencies via npm script; it is incremental non-strict checkJs, not a fully strict type claim. Existing verification helper changes are JSDoc only. Initial connector DB naming guard failure (`ff_agent_*`) was corrected to a fresh `ff_connector_*` DB; complete final agent suite is green.
- Remaining acceptance/release gates: independent controller/security review and actual provider/image/platform compatibility; no paid/live provider invocation or live GitHub-token smoke. Mounted full-runner smoke is repo-null; linked workspace/token delivery/cap transitions have real Git/resolver/route/ACP fixtures but not one combined hosted/GitHub smoke. No 8-hour wall-clock soak. Task 3 explicitly owns mounted project-default/catalog/settings/progress/ack/retention projections, approved drawer UI and end-to-visible-token latency. Later tasks still own handoff/re-key/freeze/removal.
- Exact catalog/delivery/event/request/result/retention/CLI interfaces, file inventory, RED→GREEN logs, rulings and test scope: `docs/plans/2026-11-13-chat-claims-runtime-integration-report.md`. Parent-approved `task.write` New-session permission is not a blocker. No agents spawned or commits/push/deploy/shared migrations performed.
- Disposable `ff-chat-integration-pg` on loopback 32771 stopped, exact-name read-back empty; cleanup and verification exit 0 (`chat-integration-postgres-cleanup.log`, `chat-integration-postgres-cleanup-verified.log`). Final diff check exit 0. Saved the proven npm-script runtime typecheck and extensionless-ESM fixture diagnosis in the existing default-profile fluent-flow-dev reference; no other profile touched.

## Task 2 runtime review-fix round 1

- All six concrete Linux integration-review findings addressed: independent nested cleanup/release; idle-versus-delayed-acceptance Stop semantics and pre-renewal cancellation barrier; preserved user/duration end through final heartbeat/flush errors; strict public catalog registration contract; ancestor/replacement-safe storage checks; immediate background bridge failure teardown with bounded terminal reporting. No UI/handoff/removal, originator-auth or credential-policy change; default-off opt-in preserved.
- Actual RED evidence under scratch `chat-runtime-fixes-*`: `red-1-actual`, `red-2`, `red-2-barrier`, `red-3`, `red-3-transcript-actual`, `red-4`, `red-4-local`, `red-5`, `red-6`. Root causes, fixture corrections, exact interfaces/files and full commands are in `2026-11-13-chat-claims-runtime-fixes.md`; initial false/early probes remain preserved rather than replaced.
- Conservative safety ruling: Linux scratch/lease recursive deletion uses an opened identity-checked parent descriptor. Non-Linux preview chat now fails closed at workspace-manager construction, before registration/preparation can leak an unreleasable lease; an equivalent anchored-removal implementation is a platform release gate. Default-off/unattended execution does not construct this manager and is unaffected. Same-user ACP remains unsandboxed.
- Final gates: full agent **52 files / 927 tests**, full server **78 files / 784 tests**, runtime checkJs, connector typecheck, package smoke and DB build all exit 0. Definitive scratch logs: `chat-runtime-fixes-agent-final-verified.log`, `chat-runtime-fixes-server-release.log`, `chat-runtime-fixes-{runtime,connector,smoke,db-build}-final-verified.log`. Commands/environment/status records are preserved in `chat-runtime-fixes-{final,verified}-statuses.json`; the earlier records retain their actual failed inference/test attempts rather than being overwritten.
- One later full server run exposed an existing mounted-test activity race (Cancel ack precedes final idle-event persistence). Wait for the second persisted idle before backdating expiry; three consecutive mounted reruns each pass 4 tests and definitive full server rerun passes 784. No product expiry weakening. Initial fixture/setup/typing failures and their corrected boundaries are itemized in the fix report.
- No remaining failing Linux gate for the six review scenarios; independent re-review remains required. Real-provider/platform release/UI/latency gates remain distinct. Disposable `ff-chat-runtime-fixes-pg` stopped with exit 0 (`chat-runtime-fixes-postgres-cleanup.log`); exact-name removal verification returned no rows with exit 0 (`chat-runtime-fixes-postgres-cleanup-verified.log`); final post-documentation diff check exit 0 (`chat-runtime-fixes-diff-check-final.log`). No shared/pre-existing database, credentials, agents, commits/push/deploy or approved-spec edits.



## Task 2 controller acceptance / task 3 production UI

- Task 2 accepted by controller after independent scoped review of all six fixes (`/home/victor/.hermes/cache/scratch/chat-runtime-fixes-review.md`); controller verified actual agent 927/server 784/build/typecheck/smoke logs. Default-off local catalog opt-in and Linux/procfs safety restriction remain. This acceptance does not imply real-provider/platform rollout.
- Task 3 in progress, sole writer in the same explicitly requested worktree. Read binding spec/plan/runtime reports/UI brief and inspected both approved screenshots and HTML. Production BoardView now stays mounted under a Radix right-side drawer; task/session query selection, old-task redirect, one vertical task flow and separate discussion implemented. Existing event/request/command machinery reused with keyed authority cleanup and selected-claim membership validation.
- Ruling: close always replaces selection with a clean same-board URL, rather than guessing browser history ownership. Board filters and scroll remain mounted; browser Back/Forward selection is otherwise native. Cost: previous explicitly visited drawer entries can still be revisited with browser Back.
- Ruling: additive `chat_execution_defaults` column keeps connector defaults/summaries intact. Versioned project-admin + internal-read execution-settings API reads public runner session metadata, not host catalogs. Runtime independently revalidates selected profile/model; no process configuration is accepted. Offline targets retain explicit identity and no failover. Cost: legacy-to-agent defaults migration still belongs to task 5.
- Implemented safe latest claim badge in task/board SQL (single board query; no private transcript summary or per-card API fetch), and claim command receipt read endpoint returning ID/kind/status only. Project settings preserve draft/base version through 409/503; explicit Reload discards; denied access clears drafts. Build-this is intentionally absent pending task 4.
- Actual RED→GREEN evidence so far under scratch `chat-ui-*`: navigation 4 tests; task/drawer/session and legacy claim interaction 58 tests; new-session/settings draft panels 3 tests; real PG defaults/routing/authorization with one available pool connection 37 tests. Full dashboard first pass: 30 files / 446 tests, exit 0 (`chat-ui-dashboard-full-first.log`). DB build and initial env-less Next build exit 0. Browser acceptance and final regression gates still running; no task-3 completion claim.
- Fresh isolated `ff-chat-ui-pg` container, loopback 32773; only freshly created ff_*_ui_test databases used. No shared migration, commit/push/deploy or agent dispatch.

### Task 3 recovery — coherent verified slice, remaining scope explicit

- **Recovery finished; full task 3 remains PARTIAL.** Preserved existing substantial UI/API/runtime work and approved visual composition. No production implementation rewrite. Created `docs/plans/2026-11-13-chat-claims-ui-report.md` with mounted contracts, file inventory, actual checks, screenshots and missing acceptance boundaries. Independent review/remaining work and eventual authorized PR flow belong to incoming lead/parent; no commit/push/merge/deploy here.
- Fresh current-code full gates all exit 0, scratch prefix `/home/victor/.hermes/cache/scratch/`: dashboard **31 files / 451 tests** (`chat-ui-recovery-dashboard-full.log`), DB **23 / 328** (`chat-ui-recovery-db-full.log`), server **78 / 784** (`chat-ui-recovery-server-full.log`), agent **52 / 928** (`chat-ui-recovery-agent-full.log`). Server/DB include final needs-input projection, agent includes current fixture. DB build, env-less dashboard production build, runtime checkJs, separate connector typecheck and package smoke all exit 0 (`chat-ui-recovery-{db-build,dashboard-build,runtime-typecheck,connector-typecheck,smoke}.log`). Exact commands/nonsecret DB overrides/statuses: `chat-ui-recovery-statuses.json`. Four package runs, not a root-Turborepo claim.
- Expanded **actual production-browser harness PASS**, exit 0 (`chat-ui-recovery-browser.log`): original desktop/mobile/deeplink/back/Escape/scroll/Start-vs-Open/Stop/End/comment/defaults/settings-conflict/revocation scenarios plus previously unrun real permission/elicitation and overview needs-input additions. Recovery adds held **real** authorized transcript response across task navigation and zero private reads after revocation settles; both pass. No HTTP product-success mocks or paid provider. Production screenshots freshly captured and all seven visually inspected: `chat-ui-recovery-screenshots/{01-task-desktop,02-session-desktop,03-session-mobile,04-task-mobile,05-settings-desktop,06-revoked-session,07-structured-session}.png`; board-preserving hierarchy/no four tabs matches approved composition, not pixel-identical sample content.
- Fresh visible-response timing n=5: **1908,1896,1900,1918,896 ms**, median 1900, range 896–1918 (`chat-ui-recovery-latency.json`). No statistical p95 or provider-performance acceptance claim. No Build this control/handoff fabricated.
- Remaining gates explicitly handed back: remote retained-work projection/actions; per-reader unread and richer multi-claim progress; global Agents busy split/max-chat mutation/effective capacity display; full unattended spec→build→verification board progression; broader settings/late-denial/principal-switch/keyboard/IME/zoom/browser acceptance and statistically sufficient real-provider/linked-repo latency/resource cases. Task 4 handoff and later rekey/history/defaults-summary parity/freeze/drain/removal remain separate. Default-off local catalog opt-in and Linux/procfs safety stay unchanged.
- Recovery infrastructure failures retained honestly: initial Next entry assumed package-local node_modules (MODULE_NOT_FOUND, `chat-ui-recovery-next.log`), corrected to verified hoisted absolute entry; real browser then passed. README EOF blank line caused initial diff exit 2 (`chat-ui-recovery-diff-check.log`), removed; final diff check exit 0 (`chat-ui-recovery-diff-check-final.log`). No product fixes needed. Earlier worker evidence remains intact.
- Owned original `ff-chat-ui-pg` ownership established from ledger/container metadata and controller confirmation. Created separate fresh `ff_*_ui_recovery_test` DBs only. Harness/Next cleaned up; **owned container stopped/removed**: stop exit 0 `chat-ui-recovery-postgres-cleanup.log`, exact-name readback empty exit 0 `chat-ui-recovery-postgres-cleanup-verified.log`. Ports 3194/3195/3867 free (`chat-ui-recovery-listeners-final.log`). Process **588969 exited 1** after successful suites/build at the initial Next path mistake; corrected browser process **601228 exited 0**. Neither remains running; no process/container ownership handoff needed. No unrelated services stopped, secret/credential fixtures read, shared DB touched, agents/reviewers dispatched or publish actions taken.
- Ownership transfer acknowledged: incoming OMP/Paseo lead `f1e9da88-f978-42ab-9296-108b84c35c21` owns continuation. This worker stops after verification/report/ledger only; do not duplicate already completed gates.

## Incoming lead: UI review and task 4 continuation

- UI recovery ownership transferred; no prior Hermes workers remain. Independent task-3 quality review obtained from configured Anthropic reviewer profile through Paseo. Findings are under technical verification; the selected-claim wrapper already remounts on claim identity, so the claimed cross-claim receipt failure is not assumed proven.
- Task 4 is in progress, not user-operational. Added forward-only migration 0031 for handoff command admission/completion identity, repository-chat-only authorization and delivery revalidation, and atomic reviewed-digest-to-spec transaction. Concurrent same-command confirmation creates one ordinary work claim with source lineage, no pinned runner, and preserves the chat.
- Ruling: prepare the digest first, then explicitly confirm the reviewed digest before starting unattended work. This prevents unreviewed internal output from being copied into a task description and rechecks current authorization/task version at the spend boundary. Cost if wrong: one additional confirmation in the handoff flow.
- Ruling: handoff verifies that the task branch is clean and its exact HEAD is published; it never commits or pushes silently. The session can be used to commit/push before retrying preparation. Cost if wrong: Build this refuses uncommitted/unpublished artifacts rather than launching an incomplete build.
- Actual RED then GREEN: real-Git workspace handoff tests initially failed because handoff was absent; workspace checks now pass with existing workspace tests, 19 tests total. DB handoff tests initially rejected the command and lacked completion; latest focused real-PostgreSQL run passes 4 tests (admission/repo-null rejection, concurrent confirmation/lineage/artifacts, stale/revoked confirmation, explicit destination task).
- New owned disposable Postgres: ff-chat-handoff-pg, loopback 55441, database ff_handoff_test. No shared migrations, credentials, commit, push, PR, merge or deployment. Runtime summary generation, mounted handoff endpoints and UI controls remain to be integrated and verified. Existing task-3 missing requirements and tasks 5–7 remain open.

### Incoming lead: integrated handoff, progress and retained-work reporting

- Task 4 production paths now exist: the live ACP session produces a bounded structured digest; Git checks require a clean task branch whose exact HEAD is published; the drawer previews that digest before explicit confirmation; the confirmation transaction rechecks authority/version and creates an ordinary spec claim with source lineage. The chat stays open. A new destination task is optional and requires task-write authority.
- Actual mounted HTTP regression initially proved that spec-to-build chaining dropped the handoff branch/digest; chaining now preserves the collaboration payload. Current focused mounted suites pass **41 tests**, including real runner cleanup reports, authorization, handoff confirmation/replay and spec-to-build lineage. This is not a paid-provider/GitHub combined run or proof of subsequent PR verification.
- Real-Git regression initially failed on an absent task branch. Ready Start now generates `ff/task-<task-id>` for work without an explicit branch/PR, and the runner may create that branch from origin HEAD. A fresh build checkout receives the published spec. Existing explicitly supplied branches/PRs retain their semantics. The handoff/worktree test pair passes **48 tests**.
- Migration 0033 and authenticated owning-runner reports expose terminal cleanup metadata without machine paths. The drawer distinguishes retained work from missing cleanup reports; a never-assigned expired chat does not falsely imply retained files. Slot/child release still does not wait for cleanup/reporting. Current real-PostgreSQL handoff/retention suite passes **7 tests**.
- Task-3 projection/capacity slice returned from the configured ZAI coder: migration 0032 per-principal monotonic read cursors, uncapped live-claim metadata, private profile/model redaction, busy chat/work split, effective capacity and admin-only maximum-chat mutation. Parent integrated exports/routes and all-live attention/progress in the task view. Live cards absent from capped history remain visible. The drawer regression suite passes **6 tests**; the coder separately reported 35 focused DB tests and 377 dashboard tests, not a new parent full-suite result.
- Review dispositions: cross-claim receipt leakage is refuted by the keyed panel remount and inline-only receipt poll; settings reload rejection is refuted by the production `useMe.reload` catch. Fixed the actual successful-Start intent reuse, reducer exception swallowing and endless terminal receipt polling. Independent Anthropic handoff/retention review found no authorization/data-loss defect. Its prose-comment and discarded-error findings were fixed; operator CLI errors now use existing redaction. All-origin commit reachability remains intentional for safe cleanup; exact task-branch publication is a stricter handoff requirement.
- Ruling: retained-work notices provide recovery guidance; destructive discard remains an explicit, confirmed local operator action. No application claim-command or cancellation path requests retained-work deletion. This is not an OS security boundary: steered ACP code runs as the operator user and is not filesystem-sandboxed. Retention guards protect automatic cleanup and application control paths, not against deliberately authorized or malicious same-user code.
- Runtime typecheck and focused chat-loop/workspace/handoff/runner suites pass **57 tests** after comment removal; connector typecheck passed separately. DB build and the latest environment-less production dashboard build pass. A real-browser lost-confirmation-response regression exposed a stale failure alert after successful handoff recovery; the alert reset is fixed, with a fresh production-browser run in progress.
- Independent configured OpenAI testing review is active for the integrated task-3 UI, cursor/authority semantics and pipeline test coverage. Full-package regression, expanded browser/capacity UAT and final reviews remain outstanding. Task 5 re-key and task 6 operational freeze/drain/removal remain gated as specified; no shared database mutation, commit, push, PR, merge or deployment.

### Additive PR acceptance gate

- The configured OpenAI review's concrete defects are resolved: zero-capacity targets are not advertised as eligible, live/terminal progress uses one SQL snapshot, private event sequence metadata is redacted, and the read cursor advances only through actually rendered output. Returning to a visible tab resumes read marking without needing another event. A real regression also caught configured-zero capacity with an unknown advertised capacity; the formatter now reports disabled.
- Final root `npm test` passes all five Turbo tasks with **zero cached tasks**: DB **325**, dashboard **487**, server **785**, agent server **934** tests. Runtime and connector typechecks and the executable smoke pass afterward. Moving new JSX test environments out of comment directives initially exposed an overly broad jsdom classification; the configuration now explicitly lists only the six intended collaboration DOM suites, preserving existing node-only tests.
- The exact Linux/Node 20 CI selection passes **63 tests**, plus runtime typechecking. Runtime and connector typechecks pass on the primary runtime, the full agent suite passes **934 tests**, and the executable package smoke passes. New source comments and type-only JSDoc were removed without disabling checks: optional JS inputs have explicit defaults, promise callbacks are synchronously initialized, cancellation uses a native abort barrier, and repository serialization tracks the queued operation itself.
- The environment-less production dashboard build passes. Preview policy **61 tests**, release/workflow policy **24 tests**, and the migration journal check pass. CI now runs the actual production browser harness with dedicated PostgreSQL, authentication, mounted HTTP routes and an ACP child, plus the minimum-runtime chat selection.
- The production browser harness passed with screenshots disabled: board/drawer desktop and mobile navigation, separate human comments and prompts, sticky turns, permissions/elicitation, Stop versus End, settings conflicts, delayed-response task isolation, revocation, Ready Start, per-reader cursor persistence, live-agent capacity changes and retained-work notices. The handoff controls also recovered a lost successful confirmation response. Git/ACP handoff generation and mounted spec-to-build chaining are covered separately; this is not a combined paid-provider/GitHub execution proof.
- Five deterministic-adapter first-output samples were **1901, 1907, 1904, 1902 and 901 ms**. These samples do not establish p95 or a real-provider latency guarantee. Paid-provider/GitHub combined execution, soak testing and non-Linux attended execution are not established; chat remains an explicit Linux/procfs runner opt-in.
- The separate re-key PR must still preserve evidence, reporting, summaries, usage, artifacts and historic readers. Freeze/drain, backup/restore, credential revocation and destructive removal are not performed or implied by this additive gate. Retained-work discard is local operator guidance, not a same-user filesystem sandbox. Publication and remote CI are next; no merge or deployment is authorized.
- Final configured OpenAI re-review approves the scoped additive PR after direct source verification of deferred settlement, cancellation, repository locking, configured-zero capacity, comment removal, test DB guards and CI boundaries. The configured Hermes/ZAI security profile reports no blocking or major findings across authorization, runner ownership, secrets and filesystem boundaries. Its queue observation is retained as a limitation: privileged steering has runner-side queue/session bounds, not a separate server-side enqueue quota. The discard script is deliberately shipped for the documented `node .../bin/fluent-flow-chat-discard.js` invocation rather than a new npm command alias; all feature files must be included in the additive commit.

### PR 153: first remote CI pass

- Commit `dcf04f1` includes all 133 reviewed feature paths, including the new migrations, runtime modules, dashboard components and tests. Opened [PR 153](https://github.com/fluent-io/fluent-flow/pull/153); no merge or deployment.
- The initial remote CI run passed Linux ACP, Node 20 chat, the agent-server image and preview. Main browser setup failed because `ubuntu-latest` selected Ubuntu 26.04, which the locked Playwright 1.59.1 installer rejects. The browser-bearing job is pinned to Ubuntu 24.04 without changing dependencies.
- macOS/Windows exposed an added wiring-only unit that passed catalog data into fake runners but unconditionally constructed Linux-only chat storage. Removed that test and its dead imports rather than weakening the platform safety guard or adding broad skips. Supported chat startup remains covered by the mounted real-runner suite and production browser; the workspace suite still checks unsupported-platform rejection.
- After these two CI corrections, root `npm test` passes all five tasks: DB **325**, dashboard **487**, server **785**, agent server **933** tests. The agent suite ran fresh; four unchanged tasks were cached. Preview **61** and release/workflow **24** policy tests pass. Remote checks must be rerun for the correction commit before claiming CI green.

### Claim data parity: archive foundation

- PR 153 correction commit `9c32292` passed all eight remote checks, including
  the actual production browser, Node 20, Linux/macOS/Windows ACP, image and
  automatic PR preview. It remains unmerged; no production deployment was made.
  Subsequent work is isolated on stacked branch `chat-claim-data-parity`.
- The concrete [parity plan](2026-11-13-claim-data-parity.md) preserves canonical
  reporting rather than introducing a second collaboration stack. File reports
  will use a runner-local stdio MCP adapter and atomic metadata/byte capture.
- Archive acceptance tests failed on the absent implementation, then passed
  against real PostgreSQL: original UUIDs and provider sequence strings,
  microsecond boundaries, raw/private projection separation, current authority,
  changed-source detection, nullable org preservation and atomic rollback.
- A new concurrency regression proved that a non-locking sealed-record trigger
  allowed sealing during a pending record write. The record guard now holds a
  shared manifest lock; the sealer waits or fails rather than certifying mutable
  bytes. All nine archive tests pass. DB TypeScript build passes after explicit
  types resolve generator/cursor inference, without suppressing checks.
- Ruling: snapshots preserve original nullable organization ownership; current
  task access still determines browser authorization. Capture is not a seal or
  a cutover gate. No legacy source, host credential or production schema changed.
- Native-reporting acceptance tests are being prepared independently; their
  implementation waits for the parent to observe RED. Archive operator tooling,
  restore rehearsal, historical drawer access and the remaining parity gates
  are not yet complete.

### Native reporting authority and transport

- Repaired the initial native reporting implementation rather than weakening
  its tests: exact SQL microsecond/runner-session fencing, original principal
  snapshots, current authority, token/session expiry, fail-fast poll delivery
  and atomic file bytes. DB build, **23** real-PG authority tests and **17**
  mounted HTTP/MCP tests pass. Independent security review is in progress.
- The native stdio transport passed **12** actual SDK/HTTP/PG scenarios,
  including durable bytes after workspace removal/server restart, the 512 KiB
  boundary, secure-file rejection, changed files, generic upstream failures,
  ACP new/resume, protocol-only stdout and EOF/SIGTERM shutdown.
- The first teardown run reproduced a real hang: shutdown awaited an unfinished
  connection before it could close the client. The helper now owns the client
  before connecting and aborts it directly; both teardown regressions pass.
- An additional actual claim-runner scenario passes: a repo-less chat receives
  an explicit user prompt, the provider registers a real file through its
  injected helper, End releases the session, and authorized HTTP reads return
  identical bytes after the owned workspace is removed. This uses the existing
  fake provider boundary, not a paid model or GitHub integration.
- Runtime JavaScript typechecking passes. The SDK is a pinned direct runtime
  dependency; CI/Turbo use a separate guarded reporting database. Broader
  Node 20, package smoke, full suites and transport privacy regressions remain
  to run after final integration.
- Historical discovery now preserves original run/session deep links across
  sealed archival. **12** archive tests and **17** focused drawer/navigation
  tests pass; mounted HTTP tests cover microsecond run paging and archived
  transcript access with original identities after live rows are removed.
  The new historical drawer still needs actual production-browser verification.
- No archive was operationally sealed, no workspace was frozen, and no legacy
  connector, credential or production schema was removed. Native freshness,
  summaries, usage identity, decision/PR lineage and restore/drain gates remain.

### Native workspace, usage identity and historical drawer verification

- The native SDK/HTTP/PostgreSQL/ACP/Git transport suite passes **19 tests on
  Node 22 and Node 20**. Owner-signed workspace observations preserve exact
  sequence ordering, report unknown rather than inferred state, and finalize
  before workspace cleanup. Freshness stays within the original acquisition.
- A hanging Git-filter regression exposed that `execFile` does not forward
  `detached`; the secure reader now uses `spawn` and kills only its owned
  process group on deadline or shutdown. Protocol stdout and private-value
  redaction regressions pass.
- **8 PostgreSQL usage tests pass** after separating native samples by their
  reporting acquisition. Equal turn IDs no longer overwrite another claim,
  another acquisition or legacy usage. Accepted event-to-canonical projection
  and typed snapshot precedence were subsequently verified below.
- **13 archive tests pass**, including a failing-before/passing-after UUID
  casing regression. The database build, environment-less production dashboard
  build and **7 migration-journal tests** pass through migration `0037`.
- The actual production browser harness passes historical discovery, live
  transcript reading, fixture archival and deletion of the fixture's live
  rows, and the same original session deep link through the legacy task URL.
  The view remains read-only, hides private configuration, and clears the
  transcript without further private reads after authority is revoked.
  Existing chat, settings, unattended Start and reviewed handoff browser
  checks also pass. Screenshots were disabled; the owned Next service stopped.
- Historical retirement was simulated only in the dedicated browser fixture.
  No operational archive was sealed, no workspace was frozen and no production
  data or connector credential was changed. Full parity integration, summaries,
  delivery/PR lineage, export/restore and freeze/drain gates remain open.

### Accepted usage projection and private published progress

- **54 database tests and 58 mounted server tests pass** for usage, legacy
  reporting, accepted-event projection and claim ownership. The projection
  preserves cumulative cost, explicit null/non-USD cost, late sequence ordering,
  exact replays and acquisition identity. Typed provider snapshots do not add
  ordinary turn samples twice. Raw insertion and canonical projection roll back
  together. An actual task/claim lock inversion failed before the shared
  task-before-claim lock order and passes after it.
- Independent read-only review approved that usage and lock-order slice; it did
  not approve unfinished summary, lineage or retirement work.
- Published agent progress now has its own internal task-detail field, preserving
  generic public execution status. **22 mounted reporting tests pass**, including
  public-reader redaction. Database and environment-less production dashboard
  builds pass.
- The actual production browser caught stale authorized progress remaining
  visible after current permissions were downgraded. Separating the field and
  masking it with current intersected UI authority makes that same regression
  pass. The full browser harness also passes history, chat, settings, structured
  inputs, revocation, unattended Start and reviewed handoff. Screenshots were
  disabled and the owned Next service was stopped.
- The first archive-transfer run exposed pool shutdown, seal ordering and
  fixture-isolation failures. These were repaired; **31 transfer tests pass**,
  including all four actual operator CLI commands, storage-loss restore,
  original IDs/microseconds/large provider sequences, full replay validation,
  recomputed-hash tampering and import after a historical NULL-org workspace is
  linked. The wider archive/history/settings gate passed **62 tests**.
  Independent scoped review approved archive metadata coherence. This is a
  private four-record execution dump, not a complete artifact/dependency backup
  or operational production-backup evidence.
- Native summary defaults are separate from chat and preserved legacy defaults.
  Backend settings, source freezing and request/publication services now pass
  **24 real database tests**. The settings UI passes **10 interaction tests**,
  including late project responses and unavailable model identities; actual
  production summary UI verification remains pending.
- **25 mounted reporting tests pass**, including explicit/idempotent summary
  requests, capacity-one/chat-disabled runners, exact profile/model admission,
  internal-only publication with frozen attribution, completion proof rollback,
  terminal result replay and transient attempt linkage. A retry retains the
  original producing claim and avoids inventing a second result.
- **44 legacy evidence/protocol tests pass** after the report-source cutover.
  The real summary wire acceptance test passes. The full runtime gate exposed
  invalid local-profile fixtures before executing six scenarios. Runtime
  profile application, one-turn containment and fixture repair are in progress;
  summary execution is not approved. Summary display, delivery/PR lineage,
  canonical dependents and freeze/drain remain open.

### Native summaries: production browser and runtime gate

- The full database suite passes **426 tests**. The dashboard suite passes
  **510 tests**. The serialized complete agent-server suite passes **959 tests**;
  after the last cancellation tightening, its **8 real summary runner tests**,
  runtime/connector typechecks and package smoke pass again.
- The actual production Next/NextAuth/proxy/HTTP/PostgreSQL/CLI/ACP/MCP browser
  harness passes native summary configuration, shared-version conflict/draft
  retention, explicit native-source publication, archived-source publication
  after live-row retirement, original source identity/cursor, mobile layout,
  and private in-flight request cancellation on authority loss. Existing
  history, chat, structured answers, unattended Start and reviewed handoff
  browser assertions still pass, with no page errors. Screenshots were disabled,
  interrupted fixture directories removed and the owned Next service stopped.
- Browser failures exposed and repaired a transcript flex-height regression,
  duplicate sibling React keys in chat/summary settings, and a missing work root
  on the first real summary CLI job. Unit fixtures no longer pre-create that
  work root. An actual adapter regression caught the frozen model not being
  applied by `runInitialPrompt`; the policy-aware session startup now applies it.
- A real cancellation regression failed with `failed` instead of `cancelled`.
  The runner now preserves applied cancellation and flushes final buffered
  provider events before releasing the claim. A deliberately delayed flush
  reproduces the event-loss bug before the fix and passes afterward. Summary
  terminal-report errors propagate rather than being silently logged.
- OpenAI source review and independent GLM security review approved the summary
  snapshot. OpenAI also approved the final cancellation/event-flush delta.
  GLM approved the repaired settings keys and scratch initialization.
  Pending summary TTL was withdrawn as a defect: ordinary offline work remains
  queued and cancellable; target deletion protection is intentional. New files
  remain uncommitted and must be staged during PR assembly.
- This does not establish a paid-provider/GitHub run, new platform support,
  soak behavior or statistically supported latency. Delivery/PR lineage,
  canonical dependents, full artifact backup/default mappings and freeze/drain
  gates remain open. No production data, operational seals or credentials changed.

### Native delivery/review continuation

- Ruling: review freshness uses the newest repository-bearing execution on the
  task, not a convenient earlier head. Pending/unobserved or changed acquisitions
  remain unknown; repository-free chats and summaries cannot replace a worktree
  witness. A wrong ordering would falsely mark checks fresh, so native checks
  retain both their own acquisition fence and the current task-head comparison.
- Ruling: ACP request rows gain genuine stable UUID identities for the existing
  delivery acknowledgment contract. Compound provider request keys are not
  exposed as fabricated observation/session identities. Open, answer-queued and
  uncertain requests need human acknowledgment; resolved/cancelled ones do not.
- Five real-PostgreSQL regressions first reproduced stale native evidence,
  missing source identity and missing ACP acknowledgment items, then passed.
  Snapshot comparison is structural after schema parsing; binding identifiers
  remain private, and existing acceptance JSON is never reconstructed.
- Delivery/PR lineage remains in progress. Archive-backed review sources,
  mounted route/browser proof and the full affected-suite gates remain pending.

- Native delivery verification: database **431/431**, dashboard **511/511**,
  mounted reporting **26/26**, and the environment-less production build pass.
  The production Next/HTTP/MCP/PostgreSQL browser flow also passes: owner-bound
  source shown, acceptance disabled until explicit request acknowledgment,
  canonical decision stored, later dirty/head changes shown separately from
  the unchanged acceptance. No screenshots were written; the owned UI service
  was stopped after verification. Workspace acquisition is a protocol fixture,
  not a paid-provider/GitHub run.
- Ruling: PR lineage uses verified delivery links and pending-only reservations
  for early webhook work. Retrospective adoption of executed unlinked claims
  would fabricate reporting authority, so those rows remain unrelated. A signed
  PR event is not itself an owner-workspace witness; admission stays blocked
  until actual GitHub repository/branch/head match the bound producer proof.
  The detailed contract is under Task 4 in the parity plan. Its risk is held
  pending work if the producer never supplies valid proof, not unauthorized spend.

### Native pull-request association and review ancestry

- Mounted native PR coverage passes **20/20** against the owned disposable
  database. The path uses real registration, leasing, spec completion, build
  creation, MCP reporting, signed GitHub webhooks and canonical SQL; only the
  external GitHub network is controlled. A separate real-Git reporting suite
  passed **20/20**, including actual configured origin and remote task-ref
  observation; both agent-server typechecks passed.
- Original PR attribution is immutable. A later authorized start on the same
  task/PR adds its own genuine root/producer mapping and carries that initiating
  principal/session snapshot into subsequent claims. Early webhook reservations
  remain unleased until owner proof supplies authority; executed unrelated
  history is never adopted.
- Six review regressions reproduced unverified-marker retry mutation, stale
  acquisition/commit acceptance and premature runner completion, then passed.
  Native reviews now carry a public, domain-separated acquisition marker, not a
  reporting credential, capture key or binding ID. Webhooks use the review's
  actual `commit_id`; the marker, actual review lease, current actor authority
  and current PR head must agree before follow-up work. GitHub PASS does not
  finalize the active native runner.
- Owner-authenticated verification completion exposed two previously hidden
  production issues: raw PostgreSQL array encoding broke JSON verification
  hashes, and missing optional GitHub-App context broke transition effects.
  JSON serialization and the optional context boundary are repaired. Mounted
  regressions now prove spec→build and review→red-verifier→fixer parentage using
  genuine claims with preserved root and creator snapshots.
- Automatic owner PR linking, controller build completion proof, green/review
  ancestry, full real-Git pipeline and final independent review remain open.
  No paid-provider or live GitHub acceptance is claimed. Connector retirement
  and the wider parity task are not complete.

### Native review publication and runner completion proof

- Native review results are now immutable canonical publications. The public
  marker signs the exact verdict, findings, claim acquisition and reviewed head;
  the earlier nonce-only marker has been removed. Publication application,
  retry accounting and actual child insertion commit together. Copied or altered
  verdicts and redeliveries cannot create additional paid work.
- Early PR reservations pin their original producer binding, task, root and head.
  Revoked or abandoned sources are cancelled transactionally, not released into
  the ordinary queue. The real-PostgreSQL reservation suite passes **10/10**.
- Mounted native PR coverage passes **28/28**, including completion rejection
  without the owning final clean/pushed witness and current verified PR producer.
  A previous acquisition at the same commit cannot satisfy a new build.
- Runner-owned finalization publishes the final witness, calls the canonical
  PR-link tool and verifies the returned producer before cleanup and completion.
  Real Git plus actual ACP/runner/control-plane regressions prove successful
  completion and worktree removal, and failed completion when no PR exists.
  Both runner cases pass; the reporting-helper suite passes **27/27**.
- Full orchestration regression passes **827 tests** with **10 skipped**; runtime
  typechecking passes. Reviewers approved the scoped source-pin/publication
  boundaries read-only; their approval is not independent execution evidence.
- Remaining Task 4 gates include early-CI fixer/green ordering, avoiding stale
  ancestry after a later root, and a combined chat/handoff-to-native-review path.
  No paid-provider/live-GitHub, connector retirement or whole-initiative
  completion is claimed.

### Combined runner path and authority-isolated handoffs

- The permanent combined acceptance passes actual chat commands, Git design
  commit/push, explicit handoff, actual spec/build ACP runners, final workspace
  proof, automatic PR association and signed webhook review queuing. External
  provider/GitHub calls are controlled; no paid-provider/live-GitHub proof is
  implied. Actual red/green verifier subprocess execution in that same fixture
  remains a separate gate from the mounted verification-result protocol tests.
- Combined execution exposed a missing chat-to-spec parent. Same-task,
  same-principal/session handoffs now preserve that actual parent; another
  initiator/session or destination gets its own genuine spec root. The original
  transfer remains in `handed_off_from`; a destination gets its own task branch
  seeded by the published source commit. Destination creation acquires board
  and project locks before task/claim locks.
- Real-PostgreSQL handoff coverage passes **11/11**, including actual principal
  session rotation and a concurrent board/task lock test. Native PR coverage
  passes **32/32**; affected legacy regressions bring the scoped run to **70**.
  Current-producer ancestry excludes an older active fix even within the same
  root. Already accepted terminal result replay remains a no-mutation
  acknowledgement after reporting revocation or producer advancement.
- Full uncached workspace regression passes **444 DB**, **511 dashboard**,
  **970 agent-server** and **832 server** tests (**2,757 passed**, **10 skipped**).
  Package smoke passes. Scoped security re-review approves the handoff,
  recursive producer ancestry and source guard; no checks were run by the
  reviewer.
- Historical dependency audit is complete as read-only code research. It found
  surviving conversion-command/session references, usage sentinels, immutable
  delivery/decision JSON and arrays, mapping-based authorization and legacy
  attention/insights readers beyond the raw four-record archive. Artifact
  capture, complete source preservation/default mapping and freeze/drain remain
  unfinished. No connector deletion, production mutation, commit or push.

### Actual red/fix/green execution in the combined path

- The combined acceptance now executes the native review publication, signed
  review webhook, actual Node red tests, artifact commit/push, actual fixer ACP
  turn, signed CI, actual Node green tests and pending rereview. Original
  chat/spec/build/review/red/fix/green/rereview parentage and initiator snapshots
  remain intact. Green starts no additional model process.
- This exposed a stale-head defect: successful red verification pushes the test
  artifact, but the fixer was queued at the older reviewed head. Mounted cases
  failed with HTTP 500 when the GitHub boundary reflected the actual artifact
  head. The fixer now uses the returned artifact SHA, preserving the original
  red baseline separately. Native mounted plus transition coverage passes
  **53/53** after that RED-to-GREEN fix.
- The combined real-Git/ACP/MCP/control-plane/Node-verifier case passes in
  **9.53 seconds**. It checks committed test hashes, the fix's artifact parent,
  application-only fix changes, current verified PR producer, actual assertion
  failure/pass outcomes and the final pending rereview. GitHub/provider APIs
  remain controlled external boundaries, not a paid-provider/live-GitHub run.
- The earlier full **2,757-test** result predates this last transition fix and
  expanded fixture. Historical artifact preservation and canonical native
  plan/progress projection are the next parity gates; retirement remains blocked.

### Canonical native plans and progress

- Mounted regressions first showed accepted ACP plans missing from the canonical
  workpad and post-revocation plan events still accepted without reporting
  authority. Typed plans and state/tool progress now project in the same owner
  transaction as accepted events and usage, using the existing canonical writers
  and acquisition-scoped idempotency records. No synthetic run/session is added.
- Replays and older source sequences cannot replace newer reports; empty plans
  clear the workpad. Unsupported raw shapes remain raw data. Summary-role events
  cannot acquire work reporting powers; their usage still projects separately.
- An older transaction applying an explicit report after an event exposed stale
  canonical plan and progress reads. Both failures were observed. Report writes
  now use application-time database timestamps rather than transaction-start time.
- DB build and **50 mounted/interaction tests pass**, including visibility,
  source attribution, empty plans, rollback of raw events plus canonical writes,
  revocation, summary-role containment and report chronology. Full server
  regression is running; historical artifact work remains separate.

### Archived workspace freshness and historical counts

- Native plan/progress changes pass the full **845-server-test** suite and the
  full **970-agent-server-test** suite. Connector typechecking passes. The first
  agent-server invocation omitted its required connector DB environment and had
  one load failure; the corrected invocation exercised all 57 files successfully.
- Real PostgreSQL tests exposed loss of original workspace head/dirty and run
  counts after removing their fixture's live execution rows. Delivery freshness
  now verifies and reads the sealed original run snapshot. The actual human
  delivery-review fingerprint remains identical across that storage cutover;
  no historic decision is reconstructed or changed.
- Historical run counts include the sealed source only when the live run is
  absent. A fixture initially attempted two sealed snapshots, but the existing
  unique sealed-source index correctly rejected that setup. No history-dedup
  defect existed and no redundant DISTINCT/history rewrite was introduced.
- Archive reader/export/restore suites pass **46/46**, including current human
  review continuity, ignored unsealed snapshots and rejection of corrupt
  workspace data. This is a disposable rehearsal, not authorization to remove
  production runs or evidence of a complete canonical dependency backup.

### Historical artifacts, summaries and native idea follow-ups

- Runtime typechecking and the actual portable package smoke pass. These follow
  the earlier 970-agent-server result; they are not live-provider/platform proof.
- Historical run summaries resolve their original sealed source after disposable
  live-row retirement. Canonical body, author, model and provider cursor remain
  unchanged. Summary-source/archive/transfer coverage passed 54 tests before the
  artifact-reader additions.
- Actual artifact reads first failed after restore and for superseded exact IDs.
  Verified sealed command captures now supply the original bytes without a live
  host or a new retrieval command. Inventory checks every canonical agent/runner
  file version against its declared hash, exact source session/reference, strict
  base64, size and completeness. Missing or unverifiable bytes block archival.
- Three new test-fixture errors were repaired without weakening source constraints:
  the alternate session is real, noncanonical base64 retains identical decoded
  bytes, and corruption is introduced before sealing. The archive/artifact/raw
  transfer/summary-source suites pass 73 tests; the full DB suite passes 466.
  Disposable fixture FK retirement preserves original canonical artifact fields
  and restores constraints afterward. No production FK cutover has shipped.
- Native idea conversion creates one originator-scoped prompt in an explicitly
  selected active chat. Its integer claim/command destination is distinct from
  legacy UUID destinations and from the idea's original source claim. Idea,
  command and receipt roll back together. The first mounted API slice passed
  93 affected tests; further pending/ambiguous/oversized target coverage was added.
- The production drawer requires an explicit session choice, never auto-retargets
  a closed selection, and masks cached internal ideas on capability loss. Full
  dashboard coverage passes 513 tests. Production build and the UI detector pass.
- Actual NextAuth, HTTP, PostgreSQL and ACP browser flow passes: a native MCP idea
  is selected in the drawer, converted to its canonical prompt, consumed by the
  real child process and reopened through its genuine session link. The task
  stays Backlog; no unattended build starts. Existing history, summary, delivery,
  handoff, permission, revocation, mobile and navigation scenarios also pass.
  No page errors; expected conflict/denial responses remain deliberate fixtures.
- Independent scoped review found no blocking authority, identity or transaction
  defect. Public HTTP archived-artifact coverage is still being expanded; the
  wider canonical dependency/default mapping/freeze/drain/removal gates remain
  incomplete. No connector deletion, production mutation, commit or push.

### Execution-source navigation and protected default mapping

- Canonical check evidence, artifacts, plans and questions now expose genuine
  nullable claim IDs alongside unchanged legacy IDs. The mounted native
  reporting test failed on missing attribution, then passed after projection
  changes; no binding credentials enter the public views.
- The task-scoped session/command resolver preserves original destination IDs,
  including an idea follow-up in a different run. Two real-PG tests pass for
  live/archived resolution, unchanged conversion receipts and corrupt storage.
  A mounted HTTP test passes before and after fixture retirement, including
  anonymous, private-reader, outsider, foreign-task and malformed references.
- Drawer source links reject late task/authority responses. Twelve focused UI
  tests, production build and the UI detector pass. The actual production browser
  passes native evidence navigation and a legacy session-only lookup through HTTP.
  The latter preserves the cancelled original run, command rows and absence of
  native claims; viewing history does not start work. Summary, handoff, permission,
  revocation and mobile scenarios still pass, with no page errors. No screenshots
  or temporary verification outputs were created.
- The defaults operator CLI supports inspect/preview/apply and idempotent replay.
  It uses an owned private regular-file descriptor, rejects symlinks and
  input-controlled apply, and handles failures generically. A duplicate-flag
  overwrite was reproduced and repaired. The service and CLI suite passes 28
  real-PG cases after the DB build.
- Review found a real repository-transition defect: an unlinked or mismatched
  source could become scratch/wrong-repo work, and concrete base refs became
  origin/HEAD. The safety gate now requires exact org-registered linked-repo
  identity and origin/HEAD, leaving unsupported contexts unchanged. New regression
  fixtures initially leaked a shared host's catalog mutation/revocation; isolated
  fixtures repaired those errors without weakening assertions.
- Public artifact review was narrowed by HTTP evidence: outsiders already receive
  matching not-found responses; a custom role without task-read received 403 for
  an existing ID versus 404 for unknown. The by-ID reader now masks permission
  denial as not-found. The expanded HTTP test passes with archived/raw bytes,
  corruption refusal, restricted-role masking and current-session validation.
- Full regressions before the admission-fence slice passed on separate owned
  databases: DB 497 tests, server 852, dashboard 515. Independent source-link
  review found no blocking identity or stale-response defect.
- The serialized design review reached consensus: keep the strict mapper; do
  not add a profile/Git-ref engine for nonexistent identified production data.
  A read-only aggregate snapshot found one project, no stored legacy defaults,
  mappings, runs, sessions or commands, and two unrevoked hosts. This is not a
  decisive post-fence inventory or proof about either host's local storage.
- Credential/remote-process, canonical/config backup, post-deployment recount
  and destructive-removal gates remain unverified. No production freeze,
  revocation, deletion, deployment or merge has been performed.


### Global legacy admission fence and operator preflight

- Migration 0044 adds an initially-open global control row. Admission shares its
  lock inside producer transactions; freeze uses an exclusive NOWAIT lock.
  A blocking-freeze race was reproduced, then changed to an explicit busy
  refusal so the freezer cannot queue behind task/project-held admissions.
  Successful activation and idempotent receipts retain transactional semantics.
- The operator CLI exposes read-only inventory and explicitly confirmed global
  freeze only. The inventory counts idle/resumable and accepted/ambiguous work,
  unrevoked hosts and legacy reporting tokens without printing private values
  or claiming remote-child, backup or removal readiness.
- The missing CLI was observed failing its positive acceptance case before
  implementation. DB build and seven real-PG/actual-CLI cases then passed.
  A disabled-summary fixture was corrected to enable and bind a real source
  before testing rejection; the unchanged-state check now compares its actual
  baseline instead of assuming another test left defaults empty.
- Full regressions after the production fence edits passed: DB 508 tests across
  40 files, server 852 across 80 files, dashboard 515 across 35 files and agent
  server 970 across 57 files. Both runtime typechecks, the portable package smoke,
  migration journal check and dashboard production build without a database URL
  pass. The rebuilt actual production browser also passes, with no page errors.
- Ten focused retirement/operator cases pass, including byte retrieval,
  authoritative cancellation, legacy follow-up rollback and same-command
  ambiguous reconciliation after freeze. A native chat claim is actually
  persisted after freeze; the tests no longer prove only native settings edits.
- Independent security review approved the producer/fence/drain boundary.
  Testing review required per-case fixture reset, specific lock-owner probing
  and bounded CLI children. Both helpers now reject spawn errors and abnormal
  exits, so a timeout cannot satisfy an expected-failure assertion; the final
  focused CLI suites pass 31 cases and the reviewer approved these fixes.
- A second read-only production aggregate found zero legacy-source artifacts,
  checks, ideas, plans, questions, summaries, usage samples, deliveries,
  decisions, delivery links, idempotency records and source-linked task events.
  This remains a pre-fence snapshot. Preserve canonical rows, source constraints
  and private configuration until post-deployment backup/recount/host gates
  explicitly permit a later cutover; no dependency backfill is invented for
  absent sources.
- Final publication review approved the assembled diff after correcting release
  verification: the old missing reporting-DB prerequisite failed both native
  runner suites at load. Release now provisions pinned PostgreSQL, builds the
  canonical DB package and runs all four reporting suites. The equivalent local
  release command passes 963 tests; release-policy/workflow-pin tests pass 24.
- A mapper-after-freeze case proves native settings can migrate without changing
  legacy JSON, host/mapping rows or the frozen control. All 29 mapper cases pass.
  This exemption is explicit in the plan and operator runbook; native settings
  are not new legacy execution intent.
- The production browser passed again while capturing seven permanent
  [PR evidence images](2026-11-13-chat-claim-evidence/README.md). Desktop, mobile,
  settings, permission and revoked-session captures were visually inspected.
  No temporary screenshots or private production backup files were created.


### Stacked PR publication

- Committed the reviewed parity implementation and permanent evidence as
  `74c6de9`; opened [PR 154](https://github.com/fluent-io/fluent-flow/pull/154)
  against the still-open additive PR 153 branch, not main. Neither was merged
  or deployed.
- The initial check watch reported no checks. CI filtered pull requests to main,
  excluding the stacked base. The follow-up removes only that PR-base filter;
  main-only push behavior and read-only permissions remain unchanged.
  Release-policy/workflow-pin tests still pass 24 cases. Hosted checks must be
  observed on the follow-up head before publication is called verified.
- Actual production activation, host/configuration inspection, private backups,
  decisive post-fence recount, credential revocation and destructive connector
  removal remain blocked. The empty read-only snapshots do not waive them.

