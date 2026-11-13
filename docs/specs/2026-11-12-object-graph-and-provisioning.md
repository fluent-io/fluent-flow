# Object graph and provisioning model

[Documentation](../README.md)

Status: describes the repository behavior including default workspace provisioning; production schema was inspected before this feature on 2026-11-12. Written because the object graph isn't self-evident from the UI or from reading one package in isolation: two largely independent layers were built a release apart and only connect at a few explicit, optional seams.

## The two layers, in one sentence each

1. **The internal/execution layer** (`orgs`, `repos`, `agents`, `agent_claims`, pipelines): everything needed to actually run claim-based work against a GitHub repo. Provisioned automatically by installing the Fluent Flow GitHub App — zero human action beyond that.
2. **The collaboration layer** (`collab_workspaces`, `collab_projects`, `collab_tasks`, board/run/host entities): the client-facing planning surface (Projects, Board, Settings). A default workspace is created for an installed org when none exists, on installation or GitHub sign-in. Org administrators receive manager membership in that default workspace on GitHub sign-in; other org members are not enrolled. Projects and execution host mappings remain explicit admin actions.

That's the direct answer to "how can I have repos without projects": repos belong entirely to layer 1 and exist the moment a GitHub App installation webhook lands. Projects belong entirely to layer 2 and are created manually, either standalone in Settings or from a repo card. Repo creation never creates a project. A project created from Repos stores a descriptive repo link; execution authorization still checks the workspace org and the repo requested at run time. A repo can be fully operational (agents claiming PRs, pipelines running) with zero projects ever created, because the two layers were designed to be independently functional: layer 1 predates layer 2 and had to keep working unmodified while layer 2 was added on top (see `docs/plans/2026-10-19-collaborative-contracts.md`: "No ALTER/DROP on existing production tables... new tables have `collab_` prefixes").

## Layer 1 — internal/execution graph

```
orgs ──< user_orgs >── users              (who can administer which org; role: member|admin)
  │
  ├──< provider_installations >── provider_installation_repos   (GitHub App install + the repos it covers)
  │
  ├──< repos                      (shell record per repo Fluent Flow knows about)
  │     └── repo_configs / repo_config_history   (per-repo execution defaults)
  │
  ├──< agents >── agent_sessions, agent_tokens   (registered claim-executing workers)
  │
  └──< agent_claims                (a unit of work: "run against repo R, PR #N")
        └── verification_results   (1:1 — red/green test verification for a claim)
```

- `orgs.id` is the GitHub org/user login — the root of this whole layer.
- `repos`, `agents`, `agent_claims`, `provider_installations`, `agent_sessions`, `agent_tokens` all FK directly to `orgs.id`. None of them reference any collaboration-layer table.
- **"Pipelines"** (the dashboard's Pipelines nav item) is not a stored entity at all. It's a view synthesized at request time from `agent_claims` + `state_transitions` + `review_retries` + `test_failures` + `pauses`, all loosely keyed by `(repo, pr_number)` as plain text columns — not FK'd to `repos.id`.
- **`project_items`** is a different, unrelated "project": it's the GitHub Projects v2 sync table (`packages/fluent-flow/src/work-queue/adapters/github-projects.js`), keyed by a GitHub Projects board ID and `repo`. It has nothing to do with `collab_projects`. The word "project" is overloaded across this codebase — this table, `collab_projects`, and GitHub's own native Projects feature are three separate things that happen to share a name.

**Provisioning path:** install the GitHub App on an org → `handleInstallationCreated` webhook → `orgs`/`provider_installations`/`repos` rows created unconditionally, and the installer is linked into `user_orgs` as admin (best-effort, self-healed on sign-in as of PR #146). Nothing past this point requires any further action for repos/agents/pipelines to work.

## Layer 2 — collaboration graph

```
collab_principals (an identity: GitHub-linked via user_id, OR invited email+password)
  │
  ├──< collab_memberships >── collab_roles        (principal × role, scoped to a workspace or one project within it)
  │
  collab_workspaces ── org_id ──> orgs            (automatic default or explicit bootstrap)
     │
     └──< collab_projects                          (explicit "Create project" only)
           │
           ├──< collab_tasks                        (board cards — exist with no repo/run/agent until "Start")
           │     └──< collab_runs ── collab_sessions  (the actual execution once a task is run)
           │
           └──< collab_project_host_mappings ── collab_hosts   (self-hosted connector allowlist: project ↔ repo)
```

- `collab_workspaces.org_id` is the **only** structural link from layer 2 back to layer 1, and it is set during default provisioning or explicit admin bootstrap (`getCollabBootstrapEligibility` / `bootstrapCollaborationWorkspace`).
- A `collab_project` connects to an actual repo in **one of two independent ways**, both optional:
  1. **Legacy bridge** (`claim-executions.ts`): when a task's run resolves to the legacy GitHub-App execution path, it requires a `repos` row matching the workspace's `org_id` + the requested `repo_full_name`. This reuses layer 1's `repos`/`agent_claims` machinery directly — there's no `collab_repos` table.
  2. **Connector/host bridge** (`collab_project_host_mappings` + `collab_hosts`): the newer self-hosted "portable agent server" model, where a project is explicitly mapped to `(host, repository_key)` pairs. This is a parallel execution path, not a replacement for the legacy bridge — both can coexist.
- `collab_tasks` have **no FK to any repo at all**. A task is pure backlog (title/description/status/priority) until someone clicks "Start," at which point the run resolves a repo through one of the two bridges above. This is explicit in the design contract: "A task exists with no PR, run, agent or online worker: repository/host prerequisites resolve before execution, not backlog capture."
- Everything else in layer 2 (`collab_workpad`, `collab_discussion`, `collab_evidence*`, `collab_decision_review`, `collab_project_overviews`, `collab_idea_provenance`) hangs off `collab_tasks` or `collab_projects` and is pure collaboration metadata — comments, evidence snapshots, human accept/cancel decisions, run summaries.

## Why the graph feels disconnected

It isn't a bug or an accident — it's two layers built to the explicit constraint that layer 2 must add onto layer 1 without ever modifying it (see the collaborative-contracts doc: "No ALTER/DROP on existing production tables... new tables have `collab_` prefixes"). The tradeoff of that constraint is that there is no single "create an org and everything cascades" flow. Workspace provisioning now fills the gap automatically; project creation and execution setup remain separate:

| Step | Trigger | Automatic? |
| --- | --- | --- |
| `orgs` / `repos` / `provider_installations` exist | GitHub App installed | Yes |
| Installer becomes `user_orgs` admin | Install webhook | Yes; sign-in repairs missing org links as member, preserving existing roles |
| `collab_workspaces` row exists for that org | Install or GitHub sign-in fills the gap when none exists | Yes; additional workspaces remain manual |
| `collab_projects` row exists in that workspace | A workspace admin clicks "Create project" | **No** — manual |
| A project can actually run work against a repo | Project-host mapping (connector) or matching `repos` row (legacy bridge) | **No** — manual |

Nothing upstream fails if a downstream step never happens — which is exactly why a user can have 6 repos and 0 projects indefinitely, as happened in this org.

## Related reading

- [`docs/plans/2026-10-19-collaborative-contracts.md`](../plans/2026-10-19-collaborative-contracts.md) — the authoritative API/schema contract for layer 2, written before implementation.
- [`packages/db/src/migrations/0000_baseline.sql`](../../packages/db/src/migrations/0000_baseline.sql) — layer 1's full schema as a single snapshot.
- [`packages/db/src/migrations/0011_collab_workspaces_identity.sql`](../../packages/db/src/migrations/0011_collab_workspaces_identity.sql), [`0012_collab_tasks.sql`](../../packages/db/src/migrations/0012_collab_tasks.sql), [`0013_collab_execution_queue.sql`](../../packages/db/src/migrations/0013_collab_execution_queue.sql) — layer 2's core tables, in the order they were introduced.
- [`packages/db/src/collaboration/claim-executions.ts`](../../packages/db/src/collaboration/claim-executions.ts) — the legacy-bridge code path (project → org → repo).

## Default workspaces and project creation

`ensureDefaultWorkspace` returns an existing workspace for the org unchanged. It returns null when the org is not locally provisioned, because GitHub sign-in can enumerate visible installations outside the local org registry; it never creates org records from that signal. If none exists, it creates one named after the org with system roles and a deterministic unique idempotency key. Both default provisioning and manual bootstrap lock the org row so manual-first creation cannot race a second default. Manual bootstrap rejects the reserved `default-workspace:` key namespace with 422 `invalid_idempotency_key`; a preexisting foreign-key collision returns 409 `workspace_conflict` without returning another org's workspace. Sign-in repairs the union of established local org memberships and discovered installations, so a GitHub discovery failure or missing token cannot skip an already-linked org. Only discovered installations can add an org membership, always through the existing atomic member-only link. Installation and sign-in invoke workspace provisioning independently of org-link repair; logged failures leave authentication and installation intact for a later retry. Sign-in enrolls only existing org admins as managers of automatically created defaults, preserving any existing workspace membership role and all manual workspace boundaries.

`POST /workspaces/:id/projects` requires workspace `project.admin`. Optional `repoFullName` must exist in that workspace's org; unknown or foreign repos return 422 `invalid_repo`. Missing access returns 404 and insufficient capabilities on an accessible workspace return 403. Omission creates an unlinked project. Migration `0028` adds nullable `linked_repo_full_name`; collaboration tables continue to use SQL services and TypeScript DTOs rather than Drizzle table declarations.

Repos matches `/me` workspace `orgId` and workspace capabilities before offering creation. Projects lists and details show `linkedRepoFullName`. The field describes the project and does not constrain its execution targets or replace host mappings.

## GitHub onboarding in PR previews

The session exposes only public App onboarding metadata: the install URL and whether the trusted runtime auth origin is a PR preview. The production fallback is `fluent-flow`; canonical `pr-N-preview.fluentflow.tech` auth origins use `fluent-flow-preview`. The server resolves this at runtime from `NEXTAUTH_URL`, so the client does not depend on a public environment variable being present during the Docker build. Explicit `GITHUB_APP_SLUG` or legacy `NEXT_PUBLIC_GITHUB_APP_SLUG` configuration overrides the fallback.

Previews use a separate GitHub App and database. A production installation does not populate a preview. Sign-in repairs membership only for an org already provisioned locally; it does not copy production records or grant admin from installation visibility. A newly registered preview receives the router's saved signed `installation.created` baseline only when one exists. Without that baseline or a subsequent installation event, an existing Preview App installation can still be absent from the preview database.

For real GitHub UAT, use the Preview App on controlled sandbox repositories. If it is already installed, an App administrator can redeliver its existing `installation.created` delivery to the stable preview webhook router only while GitHub still retains it — the redelivery window is about 3 days, and the 2026-11-07 preview installation delivery has already expired past it. When the delivery is no longer retained, arrange a controlled, verified preview provisioning fixture or import performed by an administrator instead; no uninstall/reinstall is needed and the production App installation link must not be used. Do not treat demo/password UAT as proof of real installation provisioning. Do not change the production webhook or App permissions for preview testing.
