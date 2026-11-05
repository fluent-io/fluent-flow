# Projects overview and shared selection

[Plans](README.md) | [Implementation](2026-11-03-projects-implementation.md)

The user requested a Projects menu, a current-project selector at the top right, and a place to understand and manage each project. They explicitly approved editable overviews explaining what a project is and how to run and test it.

## Behavior

- Projects is visible to all authenticated collaboration users. Its list contains only their authorized projects, grouped by client/workspace. Members can read a project's name, overview, run instructions and test instructions. Project administrators can edit those fields. Workspace administrators can create projects through the existing authorized creation service.
- Project details provide Board and capability-appropriate Settings links; reuse existing settings for members and execution configuration. Do not duplicate those panels or expose internal configuration in the shared overview.
- The header has an accessible Current project selector with workspace labels and an All projects option. Selection survives navigation/reload, is isolated by signed-in principal/session, and is validated against current memberships. Invalid, revoked or cross-account saved selections cannot expose data or leave stale project content.
- Board and task creation use that selection. Existing Board project deep links and project/task detail routes take precedence over remembered state. Switching projects while viewing a task navigates to the selected board rather than labeling the old task as another project's. Legacy Agents/Repos/Pipelines stay organization-scoped.
- A creation dialog must not silently submit a stale project draft after a header selection change. Scope changes clear obsolete view data and ignore late responses.
- Preserve existing Board search/workspace filtering and aggregate All projects behavior. Existing execution defaults and host configuration retain their authorization boundaries.
- Retain the current dark dashboard style. Header and project pages must work at desktop and narrow viewport widths, with accessible labels, visible loading/empty/error states and no horizontal overflow.

## Persistence and API

Add only a new `collab_project_overviews` table (forward-only migration 0021). Existing projects with no row read as empty overview/instructions. Do not alter live schema columns or populate fixture text through a generic migration.

Use the existing project version for optimistic edits: lock the project, reject stale expectedVersion with 409, atomically save name and overview fields and increment version. Board version and execution defaults remain unchanged.

Add `GET /projects/:id` and `PATCH /projects/:id/overview`. Both return a safe DTO with id, workspaceId, workspaceName, name, version, boardVersion, description, runInstructions and testInstructions; no host, execution defaults, profiles or session identifiers. Read requires current project membership; edit requires project.admin. Foreign projects return 404, insufficient privileges 403, malformed bodies 400, stale version 409. Name follows existing constraints; each text field is at most 20,000 characters.

Keep `/me` a lightweight selection catalog. Reuse its scoped projects and capabilities. Existing execution-defaults PATCH stays unchanged.

## Demo context

The guarded local fixture may insert missing overview rows without overwriting edited rows or changing existing credentials:

- Project A1 is a disposable Node.js arithmetic demo, with no web server. `npm test` runs Node's tests; the demo intentionally begins with a broken add function for execution testing.
- Project A2 is a permission-isolation example with no repository/host configured.
- Project B1 belongs to the separate client and demonstrates client isolation; no application is configured.

`fixture-org-a` is the seeded legacy organization ID. `fixture-owner-a` is the seeded owner's username. These remain authoritative org/user labels, separate from project selection.

## Constraints and verification

Preserve all existing uncommitted local startup/runner work. Do not commit, push, publish a PR, reset ff_demo, modify production, launch AI task execution, or change credentials. New directories need linked READMEs. Red-green-refactor tests must fail for the expected behavior before implementation. Use isolated ff_*_test databases for destructive tests; keep the user's running app and runner usable.

Acceptance covers owner list/create/edit/reload; read-only collaborator scope; foreign-project 404; stale update with no partial mutation; header/Board/task consistency; persistence and deep links; revocation/account switching; stale fetch/draft isolation; and actual authenticated browser checks at desktop and narrow widths with no page errors. Record checks and remaining limitations in the implementation ledger.
