# Collaborative Kanban acceptance

[Documentation](../README.md) · [Specification](2026-10-19-collaborative-spec.md) · [Contracts](2026-10-19-collaborative-contracts.md) · [Implementation](2026-10-19-collaborative-implementation.md)

The collaboration backend, dashboard and outbound Paseo connector are implemented in `feat/collaborative-kanban-paseo`. Local acceptance uses the actual application, PostgreSQL, NextAuth, browser and installed Paseo daemon. Changes are being prepared for the user-requested pull request; production deployment and Mac installation remain separate. Existing GitHub review/remediation remains separate from human acceptance of collaborative tasks.

All nine scenarios passed within the local acceptance scope below. Final readback also verified historical Git recovery after confirmed archival and immutable human decision records. No production or Mac deployment is claimed.

## Nine acceptance scenarios

| # | UAT action | Observed result | Status |
| --- | --- | --- | --- |
| 1 | Use Client A/A1-only, A workspace operator/reviewer, and invited Client B identities. Try search, foreign task/artifact URLs, API/MCP, transcript/commands, legacy lists and stream revocation. | Actual browsers expose only authorized projects. Missing/foreign resources are indistinguishable404; transcript/command/pending request is403 for the collaborator. Legacy agents/pipelines return empty lists. An open SSE stream closes on revocation and does not deliver a later event. Mounted real-app MCP tests enforce the same scope and agent-only reporting powers. | PASS |
| 2 | Invite a non-GitHub client while connector is stopped; create/edit/assign a backlog task, add criteria/comments, reload. | Invited Client B task `dcbe0355-0011-43cd-ad34-da44163f9c99` retains version2, named assignee, criterion and two comments after reload; zero runs. A1 discussion refresh and live edits preserve unsaved drafts. | PASS |
| 3 | Explicitly Start while intended PC is offline; replay identical request; move another task to Ready. | Real browser Start returns202 then200 for one run and one session with no native workspace. Selected host/last-seen/offline is visible. Separate A2 task moves to Ready/version2 with zero runs. | PASS |
| 4 | Connect the real PC; run bounded code task; lose successful create, accepted and send responses, restart and reconcile. | Stable native workspace/agent/message IDs are reused. Lost accepted response sends zero prompts; lost send response leaves exactly one original native message. Operator retries delivery of that same command. A linked Haiku Coder run performs actual RED→GREEN Node tests in its own Paseo worktree; source checkout remains clean. | PASS |
| 5 | Send a selected-session follow-up; answer native question and tool approval; cancel a real turn; try collaborator access. | Real question becomes needs-input, radio answer reaches native request, then Approve releases the native Node test command. Scoped CLI cancellation reaches the same agent. Fresh regression retest preserves cancelled session state despite late cancellation intent; explicit continuation retains its IDs. Clients receive no transcript/control data. | PASS |
| 6 | Exercise plans, multiple sessions/runs, summaries, artifacts, ideas, usage and history. | Native todos persist in transcript/workpad. Two work sessions plus configured summary share one workspace; earlier runs remain linked. One configured summary retains model/source cursor, disabled request creates none. Actual agent check/file and human input artifacts persist; safe host preview renders test output. Explicit local client visibility permits A but denies B. Idea→backlog creates zero runs. Idea→existing session delivers one prompt with the same session/workspace IDs; actual question and answer complete. Actual native session usage/cost reaches insights without snapshot/turn double-counting. Fresh native pwd output is retained as [workspace], with the actual absolute path absent. | PASS |
| 7 | Submit actual tested code to Review; review stale, failed, unrun and open items as distinct human; try unsafe and safe cleanup. | Actual fixture code/tests and human input are preserved in local-only commit `7585efa38e01fa9a004c062456fe7081ec47d7a7` and local bare archive. Idle leaves task open. Delivery changes task to Review; unacknowledged acceptance422. A real late native question adds a safe reviewer item, resets acknowledgments and invalidates the old snapshot409. After resolution, the distinct reviewer acknowledges four current open items and accepts Done. Dirty/untracked/no-upstream cleanup fails and preserves input bytes. Fresh clean preflight permits actual owned-workspace archival: three native sessions archived, worktree removed, human-input hash retained; earlier dirty attempt remains. Two real connector restarts recover the exact historical clean commit from the durable native archive receipt. Explicit reopen/resubmit/reaccept ends Done/version7 with the validated review snapshot, note and four acknowledgments stored and shown in private decision history. Ordinary client history access is403. | PASS |
| 8 | Disconnect/restart connector/control plane; replay observations; cancel and explicitly resume; submit stale concurrent edit. | Actual IDs/history survive restarts and transport faults; strict real-app tests cover replay, fencing and >100 events. Fresh cancellation no longer regresses to cancellation-pending. A stale browser edit receives409, preserves draft and leaves accepted remote text intact. Actual control-plane outage/recovery retains session/follow-up drafts and observed output, displays a temporary-unavailable banner, recovers and adds no uncaught errors. Real-component HTTP-fault browser regressions also cover500/network/401/403/404, recovery and paginated attention. | PASS |
| 9 | Run existing GitHub/onboarding/webhook/review/claim/pipeline and old runner regressions; build dashboard; check docs/migrations. | Full existing server/runner/dashboard suites pass with external GitHub replaced at its boundary. Three legacy atomic-claim cases independently pass real SQL. Dashboard production build passes, including legacy authenticated pages. All new DDL targets new `collab_` tables; journal matches. Live external GitHub OAuth/App operations were not performed. | PASS (local regression scope) |

## Execution evidence

The controlled source repository is disposable; no application commit or external Git push was made. The local bare archive preserves the fixture commit and human input for the archival test.

| Resource | Persistent identity |
| --- | --- |
| Canonical bounded task | `4ef42767-1c48-43f9-bc03-a71e796f805a` |
| First pre-execution contract failure | Run `c9634dfe-d1f9-43c6-a507-5a38e7a03217`; failed before native creation; fixed native ID schema is regression-tested |
| Transport-fault/cancellation run | `36ed7cb9-a2ae-4129-a3e8-dcf9a3f563b8` |
| Reused fault-test workspace / native agent | `wks_03e8a493221f6cae` / `e3f2a3d1-ee9f-57fe-9cb5-d5d9be484a0c` |
| One original native message | `7ca7b426-a210-4e04-ab8c-ffa658b5da92` |
| Tested delivery run | `efadd11d-2b3d-4958-8b8d-f436a2582a9e` |
| Delivery workspace | `wks_67b64488394fc5e0` |
| Primary task session / native agent | `860b67cf-957c-4cb5-9bb9-a715c8809642` / `df624164-335b-5938-b8b6-a7e4154a17e5` |
| Summary session / native agent | `967cc6ea-1f9f-4848-afce-69e9de4a2cfc` / `918d6de4-147e-5f4c-9fae-034137020f33` |
| Second work session / native agent | `195f0c0a-2364-4bf2-abb6-a53e94925360` / `5f535578-bdf5-56d8-9af3-ce1526d52e1d` |
| Generated summary | `be34856e-be06-4192-8653-4aebc4582520`; configured Haiku model and exact source cursor retained |
| Agent output artifact | `b202cb36-c0c8-4cc2-b052-99c153c4dcf4`; actual `test-output.log` preview |
| Idea converted to backlog | `8dd4be57-b22d-4ca6-b7fc-b540fa97fdd9` → `de9ec855-3c32-4dbd-a3c4-00e82fb1fece`; zero runs |
| Human input integrity | SHA256 `482b72720ee43edfdc27c2786faf70e53f71c7c57ce22df5d129705c731ab39f` |
| Idea continued in existing session | `9865bef2-f308-4cf0-b190-feadb9c8bc67`; command `ce63a60e-2810-4bd9-8ece-382ec83207e6`; same second work session, one added native message |
| Confirmed owned archival | Command `3691a18f-461a-4a92-8899-7423a683953c`; three native archive timestamps, removed worktree and preserved local archive |
| Final immutable human acceptance | Decision `77cb2d06-a1bc-4686-984d-f947b6fdcd4e`; delivery `b4605a75-fa84-40b1-b591-a0accd35c406`; exact commit above, dirty=false, four acknowledgments and stored reviewer note |

Initial native model output was never taken as proof by itself. The actual timeline records failing tests before implementation and passing tests afterward; checks retain agent provenance, exact command/commit/dirty metadata and staleness. A second model session ran verification commands despite its read-only instruction and supplied an invented check ID; the API rejected that ID404. Host routing and roles are not a filesystem sandbox or a guarantee of model instruction-following.

## Flowly retention

| Feature | Verification |
| --- | --- |
| Task workspaces, multiple sessions/runs, selection/follow-up | Actual native IDs above, same workspace and selected-agent messages |
| Live output, questions, approvals, errors, unread/attention | Real provider question/tool approval/cancellation; scoped resumable streams; read cursors and current request projections |
| Design/development/test/in review | Browser stage change to test does not mark business Done |
| Configured/disabled summaries and history | One actual configured summary, disabled422/no job, prior history retained |
| Workpad plan/questions/criteria/checks | Actual sourced native todo and agent check; real human stale/failed/not-run review; mounted source/provenance/late-item regressions |
| Input/output artifacts and ownership | Human input, actual agent file read/preview, explicit local publication, denied foreign client, traversal/symlink/credential-file regressions |
| Idea inbox and conversions | Real backlog conversion without execution; actual continuation to selected existing session, one added prompt and no new run/session |
| Progress/usage/insights | Actual native counters and reported cost; raw cached/context counters retained; null/zero/partial coverage and cumulative dedupe tests |
| Human Done/Cancelled, safe wrap-up | Real blocked dirty cleanup, current human acknowledgment/late-question guard, accepted Done, actual clean owned archival, durable historical Git recovery and immutable acceptance audit |
| Existing history/data | Accessible default Flowly roots inventoried with no cards found. Import records preserve source/workspace/session identities when supplied. Custom roots and other hosts are unverified; no migration success is claimed. |

## Validation and reproduction

| Final independent check | Result |
| --- | --- |
| Database | 159 tests pass |
| Server | 473 tests pass |
| Dashboard | 112 tests pass |
| Runner | 311 tests pass, including seven actual-app/PostgreSQL cases |
| Existing claim SQL | Three cases pass separately against real PostgreSQL |
| Dashboard production build | Pass: 15/15 generated entries, compile, types and traces |
| Runner typecheck, migration journal, diff | Pass |
| Local documentation links | 173 checked; none broken; all 20 new directories have READMEs |

The publication test run passes 1,055 tests, with all five Turbo tasks successful and zero cached tasks. Its three legacy integration skips were independently exercised as the SQL cases above. Connector integration tests control the external SDK boundary; the separate native evidence above uses the installed real daemon. A race regression was corrected to assert the actual winning write rather than assume which competing request wins. Full evidence and RED/GREEN diagnostics are in `/tmp/fluent-flow-{A3,B3,C3}-report.md`, `/tmp/fluent-flow-root-report.md` and `/tmp/fluent-flow-pr-full-tests.log`; the earlier chronological ledger is preserved at `/tmp/fluent-flow-collaborative-ledger-history.md`.

- [Database guide](../../packages/db/README.md) and [fixture CLI](../../packages/db/scripts/README.md): create two clients/three projects and separate password/GitHub principals in a disposable database; credentials are written mode0600.
- [Backend tests](../../packages/fluent-flow/src/collab/README.md): actual `createApp()` and SQL, current identity/RBAC, ordering, scoped MCP/events, command leases, evidence and delivery.
- [Connector guide](../../packages/fluent-flow-runner/src/connector/README.md): Node22+, private host config, local repo/profile allowlist, existing public SDK/CLI, durable journal and supported runtime limits.
- [Dashboard guide](../../packages/dashboard/README.md): GitHub/password entry, invitations, project roles and same-origin proxy configuration.
- CI uses independent database/server/connector/legacy databases, tests Node20 and22, checks migration journal and runner types. Collaboration test resets never target the browser fixture or production.

Screenshots from the real isolated browser are retained under `/tmp/fluent-flow-root-browser/`: `invited-client-offline.png`, `native-question.png`, `native-approval.png`, `cancellation-fixed.png`, `reviewer-open-items.png`, `owned-workspace-archived.png`, and `decision-history-final.png`. No credential is included. All listeners used for this acceptance are loopback-only, with no production workers.

The root-owned test dashboard, API, connector and four browser sessions were stopped after readback. Evidence, private connector journal and disposable database files are retained.

## Publication review hardening

Independent reviews used OMP Anthropic Claude Opus 4.5 for testing/workflows and OMP OpenAI GPT 5.6 for security/correctness. Findings were delegated for regression-first fixes; passing baseline tests alone were not taken as evidence that a finding was resolved.

- Human artifact creation cannot register a retrievable file reference. Trusted reporting requires a canonical task/run/session, keeps files internal until human publication, and rechecks provenance during retrieval and connector delivery. Retained human file rows and previously queued untrusted reads cannot expose bytes.
- Delivery submission requires both task.write and internal.read plus the current task version. Stale, missing-version and forbidden requests have no task, board, event or delivery effects; competing current submissions produce one success and one conflict.
- Internal execution defaults are redacted without internal.read. Defaults validate the same-project host mapping, catalog profiles and model choices, including a distinct summary profile/model and cached offline catalogs. Project-only membership administrators cannot enumerate inherited workspace staff.
- Settings use supported scoped project/role routes and independently load only permitted sections. Actual NextAuth, signed proxy, mounted application and PostgreSQL browser checks cover workspace/project administration, invitations, offline settings and custom roles.
- Start-only roles use private configured defaults without selectors, instructions, host/model data or session IDs in fresh/replayed responses. Mapping resolution and connector delivery remain project-bound; launch retains current run.start authority while other internal execution controls retain their existing gates.
- Every valid, unthrottled password attempt performs one fixed-cost scrypt derivation. Missing, disabled and malformed stored credentials reject uniformly; corrupt encodings cannot select KDF parameters or authenticate through an empty comparison. The regression spies on the real crypto implementation.
- Host creation and Settings share a required one-time token DTO, separate from token-free host lists. An actual authenticated browser checks the returned token against the prompt without logging it, confirms no DOM/storage/list persistence, displays the API's real heartbeat timestamp and revokes its synthetic enrollment afterward.

Focused RED/GREEN evidence is retained in `/tmp/fluent-flow-pr-{A,B,C}-security-fixes.md`. The final seven-scenario settings browser run made 77 actual requests with no page errors, including the safe Start response without a session ID. Root independently checked real workspace/project Settings with the existing disposable fixture, restored its temporary role change through the API, observed no browser errors and stopped those services. The screenshot is `/tmp/fluent-flow-root-browser/pr-settings-project.png`. No additional model execution was needed for these permission and request-boundary checks.

Both independent reviewers approved the implementation after re-reviewing all material fixes, including the later host token/timestamp contract regressions. Reviews were read-only; root and implementers executed the tests, browsers and native acceptance recorded here. The separate host browser check passed token-prompt equality, token-free DOM/storage/list responses and real heartbeat rendering, then revoked its synthetic enrollment.

## User-facing errors

| Message or result | Trigger |
| --- | --- |
| Sign-in failed. Check your details and try again. | Invalid credentials, uniformly for unknown identity |
| This invitation is invalid or no longer available. | Invalid, expired, revoked or consumed invitation |
| Not found. | Missing or inaccessible project/task/artifact/session |
| You do not have permission to perform this action. | Missing action capability on an otherwise visible object |
| This item changed. Refresh before saving. | Optimistic version conflict; draft retained with explicit retry option |
| Execution is not configured for this project. | No valid authorized host/repository/profile mapping |
| Queued for host / host offline | Execution remains on its selected offline PC; Ready alone never launches |
| The host could not confirm the outcome. | Ambiguous native operation; same-request reconciliation controls shown |
| This request is no longer active. | Stale or wrong-session question/approval response |
| Summary generation is disabled or unavailable. | Summary not configured/enabled/allowed; no model job |
| Preview pending / unavailable | Host file read queued, offline, missing or disallowed; no host path exposed |
| Review the remaining delivery items before accepting. | Current open items not acknowledged; older review409 after evidence/request changes |
| Workspace cleanup is blocked to protect your work. | Dirty/untracked/unpushed/unknown/non-owned/shared state; fresh host preflight enforced |
| Configuration error. Contact support. | Safe generic configuration/service error; details remain server-side |
| Task updates are temporarily unavailable. | Transient task refresh failure; mounted detail and drafts remain |
| Execution updates are temporarily unavailable. Showing last observed runs. | Transient execution read failure; observed runs and drafts remain; session reads use the corresponding sessions message |
| Summary updates are temporarily unavailable. Showing last observed summaries. | Transient summary-history failure; observed summaries remain |
| Live output or current request state is temporarily unavailable. Showing last observed output. | A session read fails; current request authority is cleared until revalidated |
| Attention access is no longer available. | Current access denied; private attention items clear |
| Some attention items could not be loaded. Refresh to try again. | Repeated pagination cursor; partial results remain visible without claiming an empty inbox |
| File references cannot be added here. | Browser/human creation attempts to select a retrievable workspace file; supplied text input remains supported |
| A file artifact needs a bound execution session. | Trusted file reporting omits its canonical execution session |
| Invalid request. | Delivery submission omits its required current task version or has malformed fields |
| The selected execution mapping is not available. | Defaults select a foreign, revoked or invalid host/repository mapping |
| The selected execution profile is not available. / The selected summary profile is not available. | Defaults select a profile outside the project's mapping/catalog |
| The selected model is not allowed for this profile. | Defaults select an unsupported model for the configured profile |
| Choose an available summary profile. | Enabled/model-specific summaries omit their required profile |
| Some workspace settings are unavailable. / Some project settings are unavailable. | A scoped settings request fails; other successful sections remain visible |
| Some members exceed the display limit. | The bounded member list is incomplete |

## Limits and release boundary

The Mac/PC topology is implemented; acceptance ran a loopback control plane on the PC. Mac installation, production migrations/deployment and live external GitHub operations were outside implementation authorization. The user subsequently authorized pull-request publication. No package publication was performed or verified. The original checkout's user-owned `design-proposals/` remains untouched.

Long/incomplete native history is held as unknown rather than silently inventing completion or resending a prompt. Summary generation requires a complete bounded source window. Provider usage is only what the native API reports; SQL cost projection has six decimal places, raw observations retain the reported precision. Existing Flowly data on inaccessible hosts/custom roots is not verified.

Historical Git survives only a confirmed, journal-owned clean archival receipt; unexpected missing workspaces remain unknown. File artifact references and code history remain after archive, but a new host preview reports unavailable once its workspace is removed; previews are not permanent copies of files. Older human decisions without captured snapshots/notes remain honestly uncaptured. Known-context output redaction preserves already acknowledged history and covers configured paths and credentials, rather than unknown secrets or general data-loss prevention.

Before PR publication, obtain independent final-diff reviews from different underlying model families, delegate resolution of findings and re-review materially changed areas. Include UAT, exact validation, these limitations and changed user-facing errors. Publication does not authorize a merge or production deployment.
