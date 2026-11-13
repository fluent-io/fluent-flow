# Task 3 — production drawer/UI/settings verification recovery

## Outcome / acceptance boundary

**The existing production drawer, chat controls and project settings slice is freshly verified. Task 3 as a whole remains PARTIAL, not overall initiative completion.** The previously unrun structured permission/elicitation and overview needs-input browser additions now pass against the current code. Recovery also added and executed actual delayed-response navigation and post-revocation network assertions. No production UI was rewritten or redesigned.

Worktree: `/home/victor/work/fluent-io/worktrees/chat-claim-spec`; branch: `chat-claim-execution-spec`. Binding spec, task-3 plan, runtime integration/fix reports, latest ledger, UI brief, approved HTML and both approved reference screenshots were read. Prior dirty/untracked backend/runtime/UI/spec work was preserved. This is implementation verification/self-review; parent independent review and PR flow are still required. User authorized PR flow; **parent owns review/fixes/commit/push/PR/CI, no merge**. This worker did not commit, push, deploy, rekey, remove connector/history configuration, or run a destructive/shared migration.

## Implemented slice recovered from the prior worker

- Board remains mounted under a right-side Radix drawer. Task/session selection uses `taskId`/`claimId` query keys without including selection in the board scope. The old `/tasks/:id` entry redirects to the board drawer. Close replaces with a clean same-board URL preserving filters rather than guessing browser-history ownership.
- One vertical task flow: context/criteria, latest progress and needs-input action, compact sessions, expandable Workpad & artifacts / Ideas / Run history, separate human Discussion. No Overview / Execution / Workpad / Ideas tab strip or four replacement tabs.
- Explicit Open on an existing task, atomic project New session, and Ready-only Start have separate intents. Reading/navigation/comments/Ready movement enqueue no AI work. Start queues an unattended `spec` claim, not a chat; complete orchestration/board progression is **not** proved by that receipt.
- Selected session has Back to task, bounded literal transcript rendering, persisted operator prompt history, reachable bottom agent composer, Jump to latest, distinct Stop response and End session, authoritative pending countdown, fresh-context terminal copy, and the real runtime transcript-truncation notice reducer.
- Project settings expose versioned attended mode/default-agent/profile/model/instructions backed by public advertised runner metadata. Additive migration 0030 stores chat defaults without overwriting connector defaults or summary policy. Legacy settings/history stay configured until their separate migration/drain gates.
- Task/board query has a latest safe claim badge and boolean needs-input projection, not private event text or per-card transcript requests. The projection is only the latest linked claim; it is not a complete cross-claim attention/unread/current-phase model.
- Private controls intersect task and `/me` project authority. Selected claims must belong to the task list before private reads. Parent task content keys include task/principal/session-version/capabilities; request guards abort/reject late data. Safe badge access does not restore private transcript after revocation.

## Exact mounted contracts

Paths below are relative to `/api/collab/v1`; dashboard calls use `collabFetch` through the normal NextAuth/HMAC proxy, never browser runner tokens. Successful responses use `{data: ...}`, with `nextCursor` for collections.

| Operation | Request and authority | Actual response / semantics |
| --- | --- | --- |
| Settings/catalog read | GET `/projects/:id/execution-settings`; `project.admin` + `internal.read` | `{version, executionMode:'chat'|'connector', defaultAgentId:string|null, defaults:{profileId:string|null,model:string|null,instructions:string}, agents:[{id,available,profiles:[{id,models,default_model?}],busyChat,busyWork,maxChatSlots}]}`. Org-scoped long-poll agents; latest session catalog, validated public shape, no permission selectors/process/env/path/secret fields. Busy counts come from claimed rows joined to owning sessions, not recent/paginated UI history. |
| Settings mutation | PATCH same path; `{expectedVersion,executionMode,defaultAgentId,defaults}`; same authority | Locks project, validates saved profile/model against advertised target catalog, increments version; returns updated settings. 409 preserves draft/base version, explicit Reload discards it; 401/403/404 clear private draft. Offline identity stays explicit, no automatic failover. No max-chat-slot mutation or summary mutation here. |
| Existing-task Open | POST `/tasks/:id/claim-executions`; Idempotency-Key; `{expectedVersion,claimType:'chat',repo:null}` from this UI | `run.start` + `internal.read`; `{claim,created}`; 202 new / 200 replay. Existing open chat is reused in UI; server enforces active uniqueness and mode. Defaults snapshot into payload `profile`, `model`, `instructions`; runtime independently validates/sets profile/model/ask policy. No lane change/new task. |
| Project New | POST `/projects/:id/chat-sessions`; key; `{title,repo?:string|null}` from this UI | `task.write` + `run.start` + `internal.read` (approved actual permission ruling; spec's `task.create` is not a repository capability). `{taskId,claim,created}`. Task+claim+link atomic and idempotent. |
| Ready Start | POST `/tasks/:id/claim-executions`; key; `{expectedVersion,claimType:'spec',repo,instructions}` | UI requires Ready + `run.start`; independent of attended mode. Queues an ordinary work claim. Repository explicit when project unlinked. This is not task-4 handoff or proof of full spec→build→verification board updates. |
| Prompt / Stop / End | POST `/claim-executions/:id/commands`; key; `{kind:'prompt',payload:{text}}`, `{kind:'cancel',payload:{}}`, `{kind:'end_session',payload:{}}` | Prompt requires `internal.read` + `run.steer`; Stop/End require `internal.read` + `run.cancel`. Queue receipt is not acceptance; Stop interrupts only a turn. End terminates; pending End can return null commandId. Existing delivery-time originator authorization remains enforced. |
| Command receipt read | GET `/claim-executions/:claimId/commands/:commandId`; `task.read` + `internal.read` | `{commandId,kind,status}` only; command must belong to the claim/org. UI shows Accepted only after authoritative acked status. No raw result/diagnostic/prompt data in this receipt. |
| Persisted operator prompts | GET `/claim-executions/:id/prompts?limit=100&cursor=...`; `task.read` + `internal.read` | `{commandId,text,status,createdAt,messageId}` collection, numeric positive command-id cursor (distinct from event cursor), bounded page bytes. Used to render real operator turns after refresh; no model context reconstruction. |
| Events / structured requests | GET `/claim-executions/:id/events` and `/requests`; protected existing cursor APIs | Permission answer remains `{kind:'permission',requestKey,payload:{answer:{outcome:{outcome:'selected',optionId:'allow-once'}}}}`; fixture elicitation uses `{kind:'elicitation',requestKey,payload:{answer:{action:'accept',content:{choice:'Approved option'}}}}`. Human Comment stays `/tasks/:id/comments`, never a command. |

## Fresh final verification

All paths in this section use scratch prefix `/home/victor/.hermes/cache/scratch/`. Commands ran from the exact worktree (browser from `packages/dashboard`) with full redirected logs and appended `COMMAND_EXIT_STATUS`. `chat-ui-recovery-statuses.json` records actual command vectors, nonsecret database overrides and exit codes. Database variables were cleared from inherited environment before selecting the dedicated fixtures. These are **four package passes**, not a claim that root `npm test`/Turborepo was invoked.

| Gate / exact command | Actual result | Full log |
| --- | --- | --- |
| `npm run build -w packages/db` | exit 0 | `chat-ui-recovery-db-build.log` |
| `npm run migrate -w packages/fluent-flow` (fresh legacy fixture only) | exit 0 | `chat-ui-recovery-legacy-migrate.log` |
| `npm test -w packages/dashboard` | exit 0; **31 files / 451 tests** passed | `chat-ui-recovery-dashboard-full.log` |
| `npm test -w packages/db` | exit 0; **23 files / 328 tests** passed | `chat-ui-recovery-db-full.log` |
| `npm test -w packages/fluent-flow` | exit 0; **78 files / 784 tests** passed | `chat-ui-recovery-server-full.log` |
| `npm test -w packages/fluent-flow-agent-server` | exit 0; **52 files / 928 tests** passed | `chat-ui-recovery-agent-full.log` |
| `npm run typecheck:runtime -w packages/fluent-flow-agent-server` | exit 0; runtime checkJs scope, not strict typing | `chat-ui-recovery-runtime-typecheck.log` |
| `npm run typecheck -w packages/fluent-flow-agent-server` | exit 0; separate connector scope | `chat-ui-recovery-connector-typecheck.log` |
| `npm run smoke -w packages/fluent-flow-agent-server` | exit 0; Portable agent server smoke passed | `chat-ui-recovery-smoke.log` |
| `npm run build -w packages/dashboard`, with DATABASE_URL explicitly absent | exit 0; production build/type validation/static generation | `chat-ui-recovery-dashboard-build.log` |
| `node tests/collab/chat-drawer-actual.browser.mjs` | exit 0; actual production-browser PASS | `chat-ui-recovery-browser.log` |
| `git diff --check` after final documentation | exit 0 | `chat-ui-recovery-diff-check-final.log` |

The server/DB reruns include the latest needs-input SQL projection; the agent/runtime reruns include the current fixture/instruction changes. This supersedes the previous server/typecheck runs that preceded those final edits. Existing RED→GREEN logs (`chat-ui-*`) were inspected and preserved; this recovery did not claim newly implemented production behavior or invent a TDD failure for already-working code.

### Browser acceptance actually exercised

Actual production Next build + `next start` on loopback 3194, mounted app on 3195, fresh disposable PostgreSQL, real normal password session and authenticated proxy, real agent-server CLI capacity 2 with explicit local catalog opt-in, deterministic ACP child. No product HTTP success mocks, paid model, real GitHub token or remote repository.

- Desktop task drawer has no old section navigation; opening sends zero mutations. Comment sends only the comments request.
- Open attaches a repo-null chat to the existing Backlog task; row target/profile/model and unchanged lane are checked. Five consecutive idle-follow-up turns survive on the same chat. ACP trace confirms selected `large` model and default instructions.
- POST queue receipt is followed by authoritative command-ack read before Accepted. Holding an active response then Stop produces acknowledged cancel while the claim stays claimed.
- Back to task, browser Back/Forward, Escape, pasted session deep link, standalone task redirect, board search, actual board/main scroll positions and Done expansion are preserved. Closing leaves the claim claimed.
- 390×844 mobile: prompt visible, document has no horizontal overflow, return/close and Back to task remain available; a Tab assertion keeps focus in dialog. Scrolling away exposes Jump to latest, which resumes following. Full keyboard-only workflow, soft-keyboard/IME and 200% zoom are **not** claimed.
- End yields durable cancelled/user. New session creates a different Backlog task exactly once in this browser path. Transaction rollback/idempotent retries have DB/component tests, not an injected lost-New-response browser scenario.
- A real permission request becomes the overview Needs your input action; selecting it returns to the structured controls. Allow once and elicitation Accept send exact structured payloads and yield an agent response.
- Settings saves model `small` through the real mounted API and reads persistence back. Concurrent version increment returns 409, preserves draft, and explicit Reload restores saved instructions. Profile/default-agent/mode validation and defaults payload propagation are covered by real DB tests; this browser path does not toggle every selector.
- A real authorized event response is fetched then held across navigation to another task. Releasing it cannot restore the previous transcript in the new task. No response content is fabricated.
- Actual membership downgrade while transcript expanded removes private output and controls. After authority settles, a 2.2-second network observation asserts zero private events/requests/prompts reads. Safe badge/task navigation remains available. Initial race-time 403s are expected and listed in the log, alongside the intentional settings 409; no page errors/unexpected error statuses occurred.
- Moving Ready queues no claim. Explicit Start queues `spec`, not chat. Runner is stopped for this final assertion: no complete unattended execution/board progression claim.

### Latency — limited sample, no p95 claim

Fresh click-to-new-visible-response samples: **1908, 1896, 1900, 1918, 896 ms**; n=5; median **1900 ms**, range **896–1918 ms**. Raw values and computed count/min/median/mean/max: `chat-ui-recovery-latency.json`; source: browser log. These include UI click, runner command/flush and dashboard visible-text polling for the deterministic local child. Five turns cannot establish a statistical p95≤5s acceptance gate or real-provider performance. Prior fourth-run samples (2002/2004/2029/1997/1906 ms) remain in their original log, not combined into a misleading percentile.

## Production screenshot evidence / visual inspection

Fresh screenshots (not prototype) are in `/home/victor/.hermes/cache/scratch/chat-ui-recovery-screenshots/`:

1. `01-task-desktop.png`
2. `02-session-desktop.png`
3. `03-session-mobile.png`
4. `04-task-mobile.png`
5. `05-settings-desktop.png`
6. `06-revoked-session.png`
7. `07-structured-session.png`

All seven were loaded and visually inspected against the approved task/chat reference images and HTML. Desktop keeps the board visible behind the right 510px drawer; task context→progress→sessions→supporting disclosures→discussion hierarchy is preserved with no four tabs. Chat keeps Back to task, transcript and bottom composer, with separately labelled Stop/End. Mobile is full-width with return-to-board, reachable composer and no horizontal overflow; task Discussion continues below the vertical scroll viewport. The settings screenshot uses public fixture identities/catalog IDs, not secrets; revoked screenshot contains only safe lifecycle text/denial, no transcript or prompt composer. No credential/raw local path was seen. This is hierarchy/composition parity, not pixel-identical prototype rendering; generic factual session labels replace sample profile/title prose, and the session header repeats identity more than the prototype. Build this is correctly absent because task 4 is unimplemented.

Prior screenshots remain untouched in scratch `chat-ui-screenshots/`; fresh PR evidence should use the recovery directory above. Screenshot content is synthetic authorized fixture data from the actual production UI.

## Files for review

Existing task-3 work verified and preserved (paths relative to worktree; some shared files also contain accepted task-1/task-2 edits):

- Dashboard modified: `src/app/tasks/[id]/page.tsx`; `src/components/collab/{board-view,settings-view,task-detail,task-claim-execution-tab}.tsx`; `src/lib/collab/{types,claim-events}.ts`; `tests/collab/claim-execution.test.tsx`.
- Dashboard new/untracked: `src/components/collab/{task-drawer,task-sessions,new-session-dialog,start-task-work,chat-execution-settings}.tsx`; `src/lib/collab/task-navigation.ts`; `tests/collab/{task-drawer,chat-session,new-session,start-work,chat-settings}.test.tsx`; `tests/collab/task-navigation.test.ts`; `tests/collab/chat-drawer-actual.browser.mjs`.
- DB task-3 boundary: new `src/collaboration/chat-settings.ts`, additive `src/migrations/0030_chat_execution_defaults.sql`; settings exports, project execution-mode projection, claim/defaults/receipt/prompt-history services, safe task claim activity and accompanying tests in `src/collaboration/{index,workspaces,claim-executions,tasks}.ts`, migration journal, `tests/collaboration/claim-executions.test.ts`.
- Server mounted settings/prompt/command-read routes: `src/collab/{routes-identity,routes-claim-executions}.js`, corresponding mounted claim tests. Runtime uses the existing selected profile/model contract; the prior task-3 default-instruction/fixture changes remain in runner/tests.

**Only recovery edits:** extended `packages/dashboard/tests/collab/chat-drawer-actual.browser.mjs` with delayed-real-response and post-revocation query assertions/result labels; documented it in `packages/dashboard/tests/collab/README.md`; created this report; appended progress ledger. No production implementation changes in recovery. Scratch orchestration scripts/logs/statuses/screenshots were created outside the repository. Full tracked diff and complete tracked/untracked inventory are saved in `chat-ui-recovery-tracked-diff.log` and `chat-ui-recovery-inventory-final.log`. Untracked code/migrations must be included in review and eventual commit, not lost from a tracked-only diff.

## Test fixture ownership, failures and cleanup

The original worker's owned disposable `ff-chat-ui-pg`, postgres:17-alpine, loopback `127.0.0.1:32773`, creation timestamp and existing databases matched the ledger; controller explicitly confirmed ownership. Unrelated Docker/Next processes were left alone. The prior 3194 Next server was already stopped. Recovery created fresh, separate databases: `ff_db_ui_recovery_test`, `ff_auth_ui_recovery_test`, `ff_server_ui_recovery_test`, `ff_legacy_ui_recovery_test`, `ff_auth_server_ui_recovery_test`, `ff_connector_ui_recovery_test`, `ff_browser_ui_recovery_test`. All migrations/resets stayed there; no shared DB or credential file was inspected. Legacy server tests explicitly received both DATABASE_URL and TEST_DATABASE_URL; collaboration/auth/connector suites got their separate URLs (recorded in statuses JSON).

One recovery infrastructure failure was honest and retained: initial Next launch used nonexistent package-local `node_modules/next/dist/bin/next`; Next is hoisted at repository root. The full package/build gates had already passed; no browser run was claimed from that attempt. `chat-ui-recovery-next.log` contains MODULE_NOT_FOUND and the initial orchestration returned exit 1. Corrected absolute hoisted entry then ran the full browser harness successfully (`chat-ui-recovery-next-browser.log`, `chat-ui-recovery-browser.log`). No product fix was needed. Initial diff check caught one added README blank line at EOF (`chat-ui-recovery-diff-check.log`, exit 2); removed it and final check passed. Earlier UI logs include missing disposable server DB and a changed `/me` projection key expectation before their final green runs; those logs are preserved, not substituted for current results.

Harness cleanup closed browser/API/runner/pool and removed its temporary directories; the dedicated production Next subprocess was terminated and waited. Owned PostgreSQL container was stopped (exit 0, `chat-ui-recovery-postgres-cleanup.log`); exact-name readback returned no rows (exit 0, `chat-ui-recovery-postgres-cleanup-verified.log`). Final listener check shows ports 3194/3195/3867 free (`chat-ui-recovery-listeners-final.log`). Previous nonsensitive evidence is retained; no other container/service was stopped.

## Remaining task-3 and release gates — explicit, not silently implemented

1. **Remote retained-work projection and safe actions:** runtime receipts/discard remain operator-local. No mounted scoped retained-work read/ack/push/discard contract or UI notice is implemented. Do not render actionable push/discard controls from private paths/PIDs or force-delete work.
2. **Unread / richer progress:** no claim-specific per-reader read cursor/unread model; generic session cards lack truthful profile/title/unread metadata. Current latest-claim safe badge/needs-input boolean can miss attention in other concurrent claims; no complete unattended phase/progress summary aggregation or published-progress pipeline.
3. **Global Agents busy split / max-chat administration:** project settings have real busyChat/busyWork counts, but the global agent table/detail still uses legacy active-slot presentation; no authorized maxChatSlots mutation, effective capacity=1 disabled display, or aggregate multi-instance resize management. Runtime admission/reserved work regression tests pass; that is not UI/admin acceptance.
4. **Ready Start full pipeline/board progression:** verified creation of an unattended spec claim only. Need end-to-end spec→build→verification, failure/retry and task board phase updates before claiming the user-level Start success criterion complete. Existing work lifecycle was not rewritten here.
5. **Broader settings/authority UAT:** add full selector mode/default-agent/profile browser edits, stale/offline catalog refresh behavior, transient 503 drafts, late denied saves, full principal-switch/private discussion draft isolation, denied late-response races and 200% zoom/keyboard/IME coverage as appropriate. Existing guards and tests pass only at their stated scope.
6. **Latency/statistical/provider release:** sufficient repeated visible-token sampling and real-provider compatibility/latency, linked-repository combined credential/worktree/browser smoke, transcript-budget and retained-work UI end-to-end scenarios, image/platform/long-duration gates. Linux/procfs-only chat safety and default-off `--chat-profiles-file` opt-in remain binding.
7. **Later tasks:** task 4 Build this/digest/artifact/lineage handoff is absent, not emulated by a prompt. Tasks 5–6 rekey/defaults/summary parity, history archive, connector freeze/drain/removal remain unimplemented. No connector/history configuration removal before those gates.
8. **Parent review/publish:** independent scoped/security review, fix findings, then authorized commit/push/PR and CI; no merge. This report supplies a coherent freshly tested slice, not permission to bypass these unfinished acceptance criteria.
