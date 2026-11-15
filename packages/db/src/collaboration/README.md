# Collaboration services

[Shared database package](../../README.md) · [Contract](../../../../docs/plans/2026-10-19-collaborative-contracts.md) · [Database regressions](../../tests/collaboration/README.md)

These server-only raw PostgreSQL services own the canonical client/project/task
model. Never import them into a browser bundle. `index.ts` exports the supported
surface; `identity.ts` preserves the shared import facade.

- `principals.ts`, `passwords.ts`, `auth.ts`, `rate-limit.ts`: additive identities,
  password login, short-lived dashboard assertions and throttling.
- `workspaces.ts`, `memberships.ts`, `invitations.ts`, `authorize.ts`,
  `capabilities.ts`: current scoped roles, invitations, assignment choices and
  administrative controls. No implicit empty-scope administrator access.
- `project-overviews.ts`: member-readable project overview (name, description,
  run and test instructions) and project.admin edits. Rows live in
  `collab_project_overviews` (migration 0021); a missing row reads as empty.
  Edits lock the project row and share `collab_projects.version` with
  execution defaults.
- `tasks.ts`, `comments.ts`, `events.ts`, `schemas.ts`: independent backlog,
  versioned edits/moves, client/internal discussion, safe execution cards,
  current attention and monotonic read cursors. Event cursors preserve database
  timestamp precision for resumable live delivery.
  Task detail keeps generic execution status separate from internal
  `publishedProgress` (source claim, text and reported percentage). Current
  internal-read authority is required; cached private progress must also be
  masked against the dashboard's current identity and capabilities.
- `hosts.ts`, `runs.ts`, `connector.ts`: explicit run requests, frozen execution
  context, task-level continuation reservation, host leases, same-command
  redelivery, accepted grants and truthful uncertainty/failure projections.
  Native observations and trusted evidence projections share one transaction.
  `pollConnectorCommands` is a long-poll: with no deliverable work it rechecks
  every 500 ms until work arrives, `waitMs` (0–25000, default 25000) expires or
  the optional internal `signal` aborts. `waitMs: 0` is one non-blocking
  attempt. Each recheck is its own short fenced transaction (token, session
  and epoch re-checked), so no connection, transaction or lock is held while
  waiting and a revoked or superseded host fails on the next recheck.
- `claim-executions.ts`: task-linked claim start and history projections,
  capability-checked event/request readers, and transactional idempotent ACP
  prompts, request answers and cancellation.
- `chat-settings.ts`: versioned project chat defaults and the public runner
  profile/model catalog. Runtime process configuration is never browser input.
- `summary-settings.ts`: separate versioned native summary defaults, requiring
  project administration and internal-read access. It reuses the validated
  runner profile catalog but uses ordinary capacity, not chat-slot limits.
  Known offline selections and disabled stale identities are preserved.
  Saving settings does not queue model work or rewrite legacy host defaults.
- `summary-claims.ts`: explicit summary requests freeze bounded native or
  legacy/archive history and current configured profile/model. Immutable request
  records link ordinary retry attempts, preserving the actual producing claim.
  Only summary-role credentials publish internal results; completion requires
  that canonical result, not an idle session. Display history and generation
  metadata are filtered by current reader capabilities.
- `claim-handoffs.ts`: protected handoff preview and explicit confirmation.
  A current principal with `internal.read`, `run.start` and `run.steer`
  confirms a validated digest and published task-branch snapshot. One command
  can create one work claim even under concurrent retries; optional destination
  task creation additionally requires `task.write`. Task content and claim
  creation commit together, with the chat left open.
  Confirmation locks the task before the source claim, matching accepted-event
  accounting; destination creation takes the board and project locks first.
  Same-task handoffs keep the chat parent/root only when the confirming
  principal and session snapshot match. Another initiator or destination gets
  a genuine new spec root; `handed_off_from` preserves the explicit transfer.
  A destination gets its own task branch seeded from the published design SHA.
- `claim-reporting.ts`, `claim-workspace-state.ts`: acquisition-bound reporting
  authority and signed owner observations. Writers recheck current principal,
  originating token, runner session and lease; exact acquisition timestamps
  stay in PostgreSQL. Native evidence never borrows another run's workspace.
- `claim-pull-requests.ts`: verified GitHub identity and signed owner origin,
  assigned branch and remote head bind native PRs to genuine task roots. Generic
  repository claims cannot inherit that authority. Early CI work remains
  reserved to its exact producer acquisition until proof; lost sources cancel
  reserved work rather than releasing it unproved.
  CI sources follow the current producer's actual parent chain, not merely a
  shared root. A later build cannot borrow an older fix's verification history.
- `claim-review-results.ts`: an owning review claim publishes one immutable
  verdict and findings. Public GitHub markers sign that publication and digest,
  not reporting credentials. Current actor authority, acquisition and actual
  reviewed head are rechecked; acceptance, retry accounting and follow-on claims
  commit together. Redelivery cannot spend another retry or create another job.
- `claim-event-reports.ts`: accepted ACP usage, typed item plans and progress
  share the owning transaction with their canonical projections. Only newly
  inserted events can project. Plan/progress receipts use the existing
  acquisition-scoped idempotency store; late or replayed events do not replace
  newer reports. Empty plans clear the canonical plan. Unsupported raw shapes
  remain transcript data, not fabricated reports. Summary roles cannot publish
  work plans/progress. Canonical report timestamps follow application order,
  not an older transaction start.
  Cumulative USD costs are partitioned by reporting acquisition and provider
  session; late events, omitted costs and explicit clears retain protocol ordering.
  Context occupancy is not billed token consumption. Unreported input/output
  tokens and non-USD costs remain unknown, never zero or estimated conversions.
- `tokens.ts`: hashed human project tokens and session-bound agent context;
  reporting credentials never grant membership, Start or acceptance powers.
- `evidence.ts`: workpad criteria/checks/plans/questions, artifacts, ideas,
  configured summaries, honest usage and reviewed human delivery decisions.
  Insights use known cumulative native session snapshots in place of that
  session's turn samples. Unavailable snapshots fall back to turn samples;
  missing metrics stay null. Raw samples and observations remain stored.
  Delivery acknowledgments include ACP permission/elicitation requests as well
  as retained connector attention. Each ACP request has a stable UUID for human
  acknowledgment; queued or uncertain answers remain open items. Request changes
  or resolutions invalidate an older review snapshot. Reviewers see generic
  labels; internal readers see bounded prompt text, never the raw request.
  Human acceptance stores its validated review snapshot on the decision row;
  later workspace changes never rewrite it. Old snapshots are not backfilled.
  Native idea follow-ups require an explicitly selected same-task active chat and
  current task-write, internal-read and steering authority. Conversion, the
  acquisition's prompt command and its idempotency receipt commit together.
  Original idea provenance is separate from its native follow-up destination;
  legacy command/session UUIDs are never replaced with invented identities.
  Task conversion creates a backlog item only. Overlong follow-ups are refused
  without truncating the idea or starting work.
  Check evidence, artifacts, plans and questions expose their genuine nullable
  claim ID alongside preserved legacy run/session IDs. Reporting credentials and
  binding identifiers never enter these views.
- `delivery-workspace.ts`: delivery freshness uses the newest repository-bearing
  execution on the task and its own acquisition-bound workspace witness.
  Unknown, reacquired or unfinalized terminal work stays unknown; it cannot borrow
  a clean head from another execution. Repository-free chats and summaries do
  not replace a worktree witness. Native review snapshots identify the actual
  claim without exposing reporting-binding identifiers.
  A retired legacy source uses its verified sealed run snapshot with the original
  run ID, head and dirty state. Storage cutover alone does not change the human
  review fingerprint or rewrite a past decision. Unsealed/corrupt snapshots
  cannot supply workspace proof.
- `delivery-links.ts`: existing claim/PR references require current access in
  both permission domains. Linking never launches old claims or changes merge
  controls, claim state or human delivery acceptance.
- `claim-workspaces.ts`: owning-runner cleanup receipts and a scoped retained-work
  list. Unreported cleanup stays unknown. Reports contain lifecycle metadata
  only, never local paths, process IDs or file contents.
- `execution-archives.ts`: workspace-scoped historical snapshots with original
  run/session/command/observation IDs, exact JSON text and microsecond cursor
  boundaries. Capture uses a bounded repeatable-read transaction. SHA-256 covers
  each record and the ordered manifest; verification distinguishes corruption
  from subsequent source changes. Raw exports are trusted operator operations,
  never browser APIs. Browser metadata and timelines require current task and
  internal-read access. Sealed snapshots reject changes, including concurrent
  record writes. Capture alone does not freeze writers, capture artifact files,
  revoke credentials, authorize sealing or permit legacy-table removal.
  The drawer reads live historical records or their sealed archive through the
  same original run/session links. Permission loss clears private transcripts.
  Read-only history does not resume a model or certify completion.
  Legacy run counts include sealed archives only when their live source is gone;
  live rows and unsealed snapshots cannot double-count that history.
  Already-applied artifact reads can preserve file bytes inside command records.
  Operator inventory reports missing declared hashes, missing captures and invalid
  captures, including superseded versions. Authorized exact-ID preview reads use
  only sealed, verified captures matching the original run/session/artifact and
  reference, strict base64, declared size and SHA, within 512 KiB. An applicable
  archive never queues a fresh host read for unavailable bytes. Canonical artifact
  metadata remains separate from the raw dump and must also survive cutover.
  Historical summaries likewise retain their canonical row and original run ID;
  an authorized source lookup may resolve the sealed archive without another model
  turn or rewriting summary attribution.
  A task-scoped session/command reference lookup resolves original navigation IDs,
  including follow-up commands whose destination differs from the idea's origin.
  It requires current internal-read access and verifies sealed archive integrity;
  it does not expose command payloads or resume execution.
  The operator `artifacts` command reports required/captured counts and blockers.
  Exit 2 means bytes or declared hashes are missing/invalid; exit 0 means this
  inventory is complete, not that retirement is authorized.
- `project-execution-migration.ts`: explicit operator mapping of stored legacy
  defaults to advertised native agent/profile/model identities. Preview does not
  write. Apply copies instructions exactly and changes chat/summary defaults
  atomically with one version bump. Source host/mapping locks precede the project
  lock; authority and source identity are rechecked after waiting. Legacy JSON,
  host/mapping records and project run/test instructions remain unchanged.
- `tx.ts`, `errors.ts`: shared transaction lifecycle and safe typed errors.

## Operator defaults mapping

Build the DB package first. From the repository root, inspect one authorized
project using its current principal/session version:

```sh
node packages/db/scripts/project-execution-migration.mjs inspect \
  --workspace-id "$WORKSPACE_ID" --project-id "$PROJECT_ID" \
  --principal-id "$PRINCIPAL_ID" --session-version "$SESSION_VERSION"
```

Set `DATABASE_URL` through the operator's environment. Inspection returns only
version, source identity/hash and mapping requirements, not instructions or host
catalogs. A private JSON input contains `actor`, `workspaceId`, `projectId`,
`expectedVersion`, `sourceHash`, `chat` and `summary`. Each target contains
`agentId`, `profileId` and an explicit nullable `model`; `summary` is null only
when the stored source needs no summary mapping. Do not include `apply`.
`actor` contains `principalId` and `sessionVersion` from the same authorized
session used for inspection. Copy `expectedVersion` and `sourceHash` from that
inspection; select targets from advertised native catalogs, not host-name guesses.

The current safety gate requires an org-registered linked repository matching
the legacy repository key exactly, with legacy base ref `origin/HEAD`. Unlinked
projects, aliases, mismatched repositories and other base refs are refused
without changing mode or version. Other refs remain unsupported; retain unresolved
sources rather than guessing an equivalent native checkout.

```sh
node packages/db/scripts/project-execution-migration.mjs preview --input "$MAPPING_FILE"
node packages/db/scripts/project-execution-migration.mjs apply --input "$MAPPING_FILE"
```

The input requires POSIX no-follow/non-blocking descriptor support and must be a
regular file owned by the current operator with no group or other permissions,
such as mode 0600. Symlinks and repeated flags are refused.
Only the explicit `apply` command authorizes writes. Conflicts and invalid
targets fail without partial changes; an unchanged replay returns
`already_mapped` without another version bump.

This maps defaults only. It does not transfer repository/base-ref bindings,
capture all dependent data, freeze admissions, revoke credentials or authorize
connector removal. Establish native repository context before switching a
repository-backed legacy project; unmapped context remains a retirement blocker.

Mapping remains available after the legacy admission freeze. Its write set is
`execution_mode` to `chat`, `default_agent_id`, `chat_execution_defaults` and
`summary_execution_defaults`, with one project version/timestamp update.
Legacy `execution_defaults`, hosts and mappings stay unchanged; mapping cannot
reopen admissions or queue legacy work. Native summary settings also remain
editable after freeze.

## Legacy admission fence and drain inventory

Build `packages/db` first and provide `DATABASE_URL` through the trusted
operator's environment:

```sh
node packages/db/scripts/execution-retirement.mjs inventory
```

This is a global server-record inventory, not a readiness certificate. Counts
are decimal strings. Idle/resumable runs and sessions remain unsettled, as do
pending, claimed, accepted and ambiguous commands. Unrevoked hosts and legacy
reporting tokens are counted separately. Zero counts do not prove remote child
exit, absence of retained work, configuration backup or artifact-byte integrity.

Deploy the admission-fence code to every legacy producer before activating it.
An older server that does not consult the control row invalidates the fence.
Only after separate operational authorization, use:

```sh
node packages/db/scripts/execution-retirement.mjs freeze --confirm-all-legacy-execution
```

Freeze is global because host enrollment has no workspace scope. It blocks new
legacy host/mapping/default writes and legacy execution/model-turn intents;
admitted work, acknowledgements, observations, permissions, cancellation and
artifact retrieval remain available to drain. Here, legacy defaults means
`execution_defaults`; native settings and the explicit mapper remain available.
There is no unfreeze command, automatic activation, retry, migration, credential
revocation or deletion in this launcher.

A busy admission transaction makes freeze fail immediately with no change by
that invocation. Let admissions settle and explicitly retry; do not treat a
busy refusal as success. A successful freeze serializes against admitted
transactions and returns its persisted timestamp; repeated success returns the
same timestamp. Missing control state fails closed.

After successful activation, recount and disposition every source. Inspect host
processes and retained storage, preserve configuration and verified artifact
bytes, rehearse private restore, and revoke host and reporting credentials as
separate steps. Neither freeze nor archive seal metadata authorizes removal.

Migrations move forward and preserve execution history. Tests reset
only dedicated local `ff_*` databases; package ownership prevents parallel
Turbo test suites from resetting each other's databases.
