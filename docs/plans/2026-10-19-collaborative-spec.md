# Collaborative Kanban with Paseo execution

[Documentation](../README.md) | [Contracts](2026-10-19-collaborative-contracts.md) | [Implementation](2026-10-19-collaborative-implementation.md) | [Acceptance ledger](2026-10-19-collaborative-status.md)

Approved implementation scope, 2026-10-19. Audience: the Fluent Flow implementers and acceptance operator. This is the durable product specification from the complete collaborative-kanban-paseo handoff; the linked contract fixes shared names and integration boundaries. No feature below is optional unless expressly described as optional.

## Product decision

Fluent Flow becomes the canonical collaborative backlog and task-linked execution UI. It replaces the need to maintain separate Kaneo planning and Flowly execution cards. Paseo remains the execution engine. Existing Fluent Flow GitHub review/remediation and delivery controls stay operational.

User requirements:

> I want a kanban style dashboard that gives me a view of the current work, allows collaborators to create backlog items, then trigger AI work from there.
>
> And fluent flow retains the work from flowly.

This approval supersedes the older product positioning that excluded task-first collaboration. It does not approve generic workflow marketplaces, full Kaneo calendar/Gantt parity, installing software on the Mac, production changes, public listeners or PR publication.

## Deployment and trust boundaries

The always-on Mac Studio hosts web UI, backend and PostgreSQL. TLS/front door and backups remain deployment choices. No Mac Paseo daemon or model credentials are required. The Linux PC/laptop owns source files, worktrees, existing Paseo daemon, OMP/model tooling and the outbound connector. Model credentials stay on that host. Additional execution hosts require explicit enrollment and project mapping; the complete basic topology needs only one PC.

PC offline means usable backlog plus queued execution assigned to that PC, with last-seen/stale/offline state. Never fail over silently to the Mac or another host. Web roles do not sandbox the filesystem: a permitted execution operator controls a coding agent in the host's allowlisted checkout and its provider permission mode. The UI must explain that trust boundary.

## Canonical planning and collaboration

- Client/workspace contains projects; each project contains tasks. Task creation requires a title and authorized project, not a repository, PR, agent, run or online host.
- Kanban lanes: Backlog, Ready, In progress, Review, Done. Cancelled remains inspectable through a filter/history. Blocked and attention are visible indicators, not invented success states.
- All-authorized-projects current-work view and client/project filters. Cards show title, project, priority, assignee, truthful queue/execution/review/attention state and concise progress. Task detail provides description, acceptance criteria, discussion, run history, checks, artifacts and deliverables.
- Persist board ordering and edits. Concurrent stale edits/moves fail visibly with the draft preserved. Execution events update the board from actual state.
- Distinct capabilities for task creation/editing, discussion, reading internals, starting/steering/cancelling work, accepting delivery, and membership/settings administration. Useful role presets plus configurable capability subsets; do not grant all collaborators admin powers.
- Client-friendly invitation and password login alongside GitHub OAuth. Existing GitHub onboarding remains available to internal users. Invitations grant only their specified workspace/project/role; expired/replayed/revoked tokens fail safely.
- Authorize direct URLs, REST, MCP, search, counts, comments, notifications, artifacts and live streams on the server. Project-only contractors cannot infer sibling projects. Revoke access on active streams and pending commands.
- Explicit client/internal visibility. Private discussion, agent transcripts, questions, permission requests, host paths and provider errors never flow into client-visible delivery updates by accident. Publish selected delivery evidence intentionally.

## Task-linked execution

Start AI work is an explicit authorized action in Fluent Flow. Ready alone never spends tokens. Resolve the project's allowlisted repository/host/profile/model/instructions at launch, snapshot them, and support existing OMP profiles/provider credentials. Arbitrary cwd, shell executable, daemon URL, model credentials and host selection cannot come from client task text.

One task has multiple runs and each run can have multiple selectable agent sessions in its Paseo workspace. Persist canonical task/run/session IDs and Paseo workspace/agent/provider session IDs. Agents launched here remain visible in Paseo. Live status, output, errors, questions and approvals are integrated into Fluent Flow; an external link is supplemental, never a replacement for supported controls. Operators can follow up, steer/interrupt, answer supported questions/permissions, cancel and retry safely.

Queue, command and observation storage survives server/connector restart. Stable SDK idempotency keys and message IDs plus durable reconciliation protect against duplicate billable work after ambiguous acknowledgments. Unknown execution is held for reconciliation; it is never treated as dead solely because a lease expired. Host disconnect is distinct from run failure. Cancellation request is distinct from observed cancellation. A completed turn is distinct from accepted delivery.

## Flowly feature retention

| Required behavior | Fluent Flow implementation intent |
| --- | --- |
| Task-linked workspaces and multiple sessions | Task > runs > sessions, selection, follow-up, recorded external IDs and ownership |
| Output, questions, approvals, errors, unread and attention | Normalized persisted timeline, capability-aware controls, per-user read cursors and scoped Needs attention view |
| Design/Development/Test/In review stages | Execution-stage field independent of business lanes and human acceptance |
| Summaries and history | Configurable or disabled summary profile/model; explicit source sessions/cursors, history and errors; no hidden provider/cost fallback |
| Workpad | Acceptance criteria, named passed/failed/not-run checks, exact command, commit/dirty association, source/provenance, stale evidence and acknowledged open items |
| Artifacts | Input/output references, safe previews, task/session provenance, human ownership and explicit publication; access checks at retrieval |
| Ideas | Source-task/run/session inbox, approve to backlog task or explicitly authorized continued session; idempotent conversion and retained source link |
| Progress, tokens, project insights | Provider-reported progress/usage only, coverage/unknown indicators; aggregate supported values without double-counting or inventing costs |
| Human Done/Cancelled and safe wrap-up | Explicit acceptance/cancellation decision; read-only preflight; block dirty/untracked/unpushed/unknown/shared-resource cleanup; retain history |
| Existing work and session associations | Discover actual data first; if present, nondestructive import with stable source mappings, no replayed prompts or resource recreation |

Workpad also retains open questions/confusions and available native agent plan/todo progress. Unsupported provider plan/progress data displays unavailable rather than an invented percentage. Summary sessions have a separate role and are excluded from human work-session activity/attention calculations where appropriate. Summary disabled means no summarizer calls; an explicit configured opt-in may coalesce completed turns. Summary text is never evidence that a check passed.

## Preserve delivery controls

Keep GitHub App onboarding, installation events, existing claims/runners, reactive reviews/remediation, proactive workflows, pipelines and audit paths. New task runs must not enter legacy claim-expiry automatic redispatch. Link existing PRs/claims through additive association rows and scoped projections. GitHub review/CI evidence can populate a task delivery view without permitting a task member to invoke legacy global admin endpoints.

A human accepts task delivery, even if a PR merged or every agent turn completed. Acceptance does not itself merge a PR or weaken existing merge policy. Existing configured GitHub auto-merge behavior is preserved on the old review path; new work must not introduce additional automatic merge/completion. Inspect the implementation before advertising deterministic red/green verification or reviewer/verifier separation: current docs include targets that are not shipped.

## Upstream references inspected and pinned

Use exact revisions below when adapting code. Keep each adapted file's source/revision comment and full applicable copyright/license text in a repository notice. The planning files copy no upstream application code. Do not vendor entire apps or replace the repository's Next.js/Express/pg runtime with upstream React Native/Hono/Bun runtimes.

### Flowly

Revision [`13213f4e7a39eeefb887bf2d26843873a6c777f3`](https://github.com/JasprW/flowly/tree/13213f4e7a39eeefb887bf2d26843873a6c777f3), current main resolved during planning. [MIT license, Copyright (c) 2026 Bofan Wang](https://github.com/JasprW/flowly/blob/13213f4e7a39eeefb887bf2d26843873a6c777f3/LICENSE). Local read-only reference: `/tmp/fluent-flow-reference-flowly`.

Source inspected:
- [shared/model.ts](https://github.com/JasprW/flowly/blob/13213f4e7a39eeefb887bf2d26843873a6c777f3/shared/model.ts): stages, task/workspace association, revisions, artifact ownership, ideas and evidence fields.
- [server/store.ts](https://github.com/JasprW/flowly/blob/13213f4e7a39eeefb887bf2d26843873a6c777f3/server/store.ts): CAS edits, neighbor ordering, preserved invalid files/backups. Its in-process promise queue is not multi-process SQL concurrency protection.
- [server/service.ts](https://github.com/JasprW/flowly/blob/13213f4e7a39eeefb887bf2d26843873a6c777f3/server/service.ts): deterministic workspace idempotency key, data-root selection and retained workspace IDs.
- [server/workpad.ts](https://github.com/JasprW/flowly/blob/13213f4e7a39eeefb887bf2d26843873a6c777f3/server/workpad.ts), [session-reads.ts](https://github.com/JasprW/flowly/blob/13213f4e7a39eeefb887bf2d26843873a6c777f3/server/session-reads.ts), [summaries.ts](https://github.com/JasprW/flowly/blob/13213f4e7a39eeefb887bf2d26843873a6c777f3/server/summaries.ts): command/commit evidence, native plans, attention receipts, versioned/coalesced summaries and summary children.
- [server/wrapup.ts](https://github.com/JasprW/flowly/blob/13213f4e7a39eeefb887bf2d26843873a6c777f3/server/wrapup.ts): resource preflight/ownership. Fluent Flow must be stricter: upstream warning acknowledgment can permit worktree deletion; uncommitted/unpushed/unknown work blocks our destructive cleanup. Do not copy swallowed-error paths.

Flowly source package version is still 1.0.0 and pins `@getpaseo/client` 0.11.2. That does not establish equivalence to the earlier published plugin revision. Feature retention follows the pinned current source and this approved scope.

### Kaneo

Revision [`83ce56066a2ce1c2dbfa77d8bc8a8cd99afd8d66`](https://github.com/usekaneo/kaneo/tree/83ce56066a2ce1c2dbfa77d8bc8a8cd99afd8d66), current main resolved during planning. [MIT license, Copyright (c) 2024 Andrej Acevski](https://github.com/usekaneo/kaneo/blob/83ce56066a2ce1c2dbfa77d8bc8a8cd99afd8d66/LICENSE).

Source inspected: [reorder-tasks.ts](https://github.com/usekaneo/kaneo/blob/83ce56066a2ce1c2dbfa77d8bc8a8cd99afd8d66/apps/api/src/task/controllers/reorder-tasks.ts) locks the project and affected tasks, validates expected board state and returns 409 on concurrent change; [role-permissions.ts](https://github.com/usekaneo/kaneo/blob/83ce56066a2ce1c2dbfa77d8bc8a8cd99afd8d66/apps/api/src/utils/role-permissions.ts) evaluates built-in/stored resource-action permissions; [apply-invitation-project-access.ts](https://github.com/usekaneo/kaneo/blob/83ce56066a2ce1c2dbfa77d8bc8a8cd99afd8d66/apps/api/src/project-access/apply-invitation-project-access.ts) applies selected-project access transactionally; [require-task-permission.ts](https://github.com/usekaneo/kaneo/blob/83ce56066a2ce1c2dbfa77d8bc8a8cd99afd8d66/apps/api/src/task/controllers/require-task-permission.ts) distinguishes task assignment, update and deletion permissions. Adapt the transactional/scoping patterns to the smaller capability set in our contract.

### Paseo

Current published [`@getpaseo/client@0.12.0`](https://registry.npmjs.org/@getpaseo/client/0.12.0), gitHead `cafe4b01c8522ff39560241c5deb01427dc8dc5b`; tarball integrity `sha512-FrszuQkG73mbU5nJcaWKjW2K1mDt6k1veCa2acV9V8HphPD7BtQLPiiUnXsSUdYeP8S54duGbuYfZgaVyUvd5g==`. Pin this exact package for connector implementation, then record actual daemon compatibility from the smoke. Do not upgrade the installed daemon without authority.

Public contract inspected: [SDK](https://paseo.sh/docs/sdk.md), [agents](https://paseo.sh/docs/sdk/agents.md), [workspaces](https://paseo.sh/docs/sdk/workspaces.md), [events](https://paseo.sh/docs/sdk/events.md), [reference](https://paseo.sh/docs/sdk/reference.md), [CLI](https://paseo.sh/docs/cli.md) and [published public declarations](https://unpkg.com/@getpaseo/client@0.12.0/dist/index.d.ts). Documentation is mutable, so public declarations/package integrity are the implementation pin. Create workspace and idle agents with stable idempotency keys; use `send` messageId, timeline epoch/sequence recovery, `respondToPermission`, config profile discovery and provider capability/usage APIs. High-level handle has no cancel method; supported local `paseo stop` covers cancellation. SDK connection close does not stop agents. Timeline subscription reconnect does not replay missed events. A wait timeout is not a failed or cancelled agent.

## Existing data finding and migration rule

Planner inspected the accessible default Paseo home directory and the upstream data-root resolver. Default Flowly storage would be `~/.paseo/plugin-data/flowly/`, with older data under `paseo-ultra-kanban`; project copies can live in `.flowly/project.json`. The accessible default home has no `plugin-data` directory, the original Fluent Flow checkout has no `.flowly` files, and the planner process has no FLOWLY_DATA_DIR/ULTRA_KANBAN_DATA_DIR override. A broad recursive scan timed out and is not evidence of absence. Daemon-specific custom environment and remote Mac/other hosts were not inspected. Therefore: no real legacy cards discovered locally; absence everywhere is unproven, and no migration has run.

C's import discovery must inspect only named data files at an explicitly chosen local root, never credentials/config dumps. If real data is found: read-only inventory and backup hashes; schema/version validation; admin mapping to client/project/host; dry-run conflict report; transactional, repeatable import preserving old IDs in source mappings plus exact Paseo workspace/session IDs. Retain comments/events/workpads/artifacts/ideas/summaries/usage/read receipts and archived records where present. Existing external resources remain non-owned and read-only until explicitly adopted; import never launches or archives them. Keep source files untouched and report counts/unresolved associations. If no data is found, record searched locations and unknown custom/remote roots without claiming a migration or building speculative older-version import machinery. Feature retention remains mandatory.
