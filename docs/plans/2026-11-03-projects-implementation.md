# Projects overview and shared selection implementation plan

> **For agentic workers:** Use superpowers:subagent-driven-development for serial implementation and scoped review. Leave changes uncommitted.

**Goal:** Make projects discoverable, understandable and manageable, with one shared current-project selection.

**Architecture:** Safe project overview services/API backed by a new metadata table; shared current-project context in the existing dashboard shell; project pages reuse scoped catalog and Settings controls.

**Tech Stack:** Node 22, PostgreSQL, TypeScript, Express, Next.js/React, Vitest and Playwright.

**Spec:** [Approved feature](2026-11-03-projects-spec.md)

## Global Constraints

Preserve unrelated WIP; no commits, pushes, production changes, credential changes, ff_demo reset or automatic AI task execution. Only forward-only DDL on the new metadata table. Service-layer authorization is mandatory. New directories need linked READMEs. Observe expected RED before each behavior change and verify GREEN. Keep incumbent dark UI and existing execution/privacy controls.

## Review Focus

- Cross-client or revoked selections must never display stale project details.
- A project rename races execution-default changes: shared version must conflict without overwriting either change.
- A selected project with no task.write permission cannot become a writable sibling's task silently.
- Opening a direct link must win over persisted state, without UI/URL update loops.
- Narrow headers, long names, empty memberships and slow responses must remain usable.

### Task 1: Authorized project overviews and fixture context

**Files:** new DB collaboration/project-overviews.ts, migration 0021 plus journal, collaboration/index.ts exports, existing routes-identity.js, guarded collab-fixture.mjs, mounted route tests and relevant READMEs.

**Interfaces:** `getCollabProjectOverview({actor,projectId})` and `updateCollabProjectOverview({actor,projectId,expectedVersion,name,description,runInstructions,testInstructions})` return the safe DTO specified in the spec. GET `/projects/:id`, PATCH `/projects/:id/overview`; old execution PATCH unchanged.

- [x] Read the spec and applicable instructions. Use Node 22. Do not spawn subagents or commit.
- [x] Write mounted real-app/database regression tests for blank existing project read, safe fields, authorized edit/reload, task.read-only refusal, foreign project 404, invalid and oversized fields, missing expectedVersion, optimistic conflict/no partial effects and unchanged execution/board state. Run and retain expected RED.
- [x] Implement additive migration/table, parameterized scoped services and routes with standard envelopes. Keep `/me` lightweight.
- [x] Seed only absent demo overview rows in guarded fixture; preserve existing rows/credentials. Explain A1/A2/B1 honestly as in spec.
- [x] Run focused mounted regressions, DB tests/typecheck/build, migration journal check and relevant existing Settings regressions. Record exact results and RED/GREEN log paths in task report. Test only isolated databases, never reset ff_demo.
- [x] Update READMEs for new files/API and fixture behavior, preserving prior WIP sections. Report safe DTO and any deviations for Task 2.

### Task 2: Projects pages and shared current-project UI

**Files:** dashboard PRODUCT.md; existing layout shell/sidebar/topbar, use-me.ts, board-view.tsx, create-task-dialog.tsx, task-detail/settings entry points; new project context, projects views/routes and tests; linked READMEs. Use Task 1 services without adding a competing metadata model.

**Interfaces:** read safe overview GET and PATCH; keep `useMe()` return shape compatible while sharing resources if needed. `useCurrentProject()` provides validated project ID/object, workspace, selection callback. Existing scoped `/me` catalog supplies membership/capability data.

- [x] Read the approved spec and Task 1 report. Read Impeccable craft-floor immediately before UI edits. Context launcher already ran: incumbent dashboard is authoritative, no redesign. Capture only confirmed product facts in PRODUCT.md. Do not spawn subagents or commit.
- [x] Add regression tests first for Projects nav and owner/collaborator read/edit behavior; shared scope, board deep-link precedence, task-creation default/refusal, saved selection validation/account isolation, stale responses and header switching from task detail. Observe behavioral RED.
- [x] Implement project list/detail with overview/run/test sections, admin editing, existing project creation and authorized Settings/Board links. Accessible controls, normal pending/empty/conflict/error states.
- [x] Add top-right Current project selector, workspace labels, All projects and safe per-principal/session persistence. Integrate Board/create/task routes and Settings links. Avoid Next useSearchParams without Suspense. Clear stale data and unsaved scope-dependent draft on switch. Legacy org-scoped screens retain their meaning.
- [x] Existing `/tasks/[id]` currently has no DashboardShell layout: add a linked `tasks/layout.tsx` so the header is present on task detail, and synchronize from the authorized loaded task. `/attention` already accepts `projectId` server-side; filter it with shared selection and clear stale items on switch. Existing individual route layouts each mount DashboardShell, so persistence must survive remounts without treating the first render's loading state as permission revocation.
- [x] Update auth-parity/nav tests and browser scripts where old nav/selectors changed. Add linked README to every new directory. Preserve startup/runner documentation WIP.
- [x] Run dashboard suite, tsc, production build and actual authenticated browser coverage using isolated ff_projects_browser_test DB and real API. Cover owner/collaborator isolation, create/edit/reload, header/board/create alignment, direct links, account switch and narrow layout. Record screenshot paths without secrets. Never queue real AI work.
- [x] Browser/build checks must not share `.next` output or `.env.local` with the live user dashboard. Use a disposable copy of dashboard source under `/tmp` with root node_modules linked, a separate API/dashboard port pair and explicitly supplied synthetic env. Do not copy `.local`, real env files or real credentials. Root handles live-app integration only after validation.
- [x] Run Impeccable detector once on final UI targets and inspect rendered screenshots. Record RED/GREEN, commands, results, remaining limitations and changed errors in report. Root integrates migration and missing fixture metadata into existing local demo without reset after tests pass.
