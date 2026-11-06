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
- `tokens.ts`: hashed human project tokens and session-bound agent context;
  reporting credentials never grant membership, Start or acceptance powers.
- `evidence.ts`: workpad criteria/checks/plans/questions, artifacts, ideas,
  configured summaries, honest usage and reviewed human delivery decisions.
  Insights use known cumulative native session snapshots in place of that
  session's turn samples. Unavailable snapshots fall back to turn samples;
  missing metrics stay null. Raw samples and observations remain stored.
  Delivery acknowledgments include current native questions and approvals;
  request changes or resolutions invalidate an older review snapshot.
  Reviewers see generic labels, while internal readers see bounded prompt text.
  Human acceptance stores its validated review snapshot on the decision row;
  later run changes never rewrite it. Older decisions and cancel/reopen have
  no captured acceptance snapshot.
- `delivery-links.ts`: existing claim/PR references require current access in
  both permission domains. Linking never launches old claims or changes merge
  controls, claim state or human delivery acceptance.
- `tx.ts`, `errors.ts`: shared transaction lifecycle and safe typed errors.

All migrations use the new `collab_` schema only and move forward. Tests reset
only dedicated local `ff_*` databases; package ownership prevents parallel
Turbo test suites from resetting each other's databases.
