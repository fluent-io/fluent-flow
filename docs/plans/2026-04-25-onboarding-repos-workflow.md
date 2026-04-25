# Onboarding: Repos + Workflow Initiation

> **Goal:** After installing the GitHub App, a user can see their repos, connect a runner, and initiate work — all from the dashboard.

## Problem

After connecting the GitHub App, the dashboard shows nothing useful:
- No repos page — repos exist in the DB but are invisible
- No way to initiate work from the dashboard
- Agents default to `repos: []` — they never pick up claims even if dispatched
- Pipelines page is empty until work exists — no starting point

## UX Flow

1. **Install App** → repos materialize in DB → dashboard shows repos
2. **Connect runner** → agent is live, auto-scoped to all org repos
3. **Start work** — two paths:
   - *Reactive:* PR events auto-dispatch review claims (existing webhook loop)
   - *Proactive:* User picks a repo, describes a task, Fluent Flow creates a claim and dispatches an agent

The **repos page** is the missing action surface. Pipelines shows state of work; repos shows where to start work.

## Architecture

### 1. Repos page

**Route:** `/repos`
**Data:** `listRepos(orgIds)` — new query in `@fluent-flow/db`

Each repo shows:
- Repo name (links to GitHub)
- Connection status (active / installation suspended)
- Active pipelines count (link to filtered pipelines view)
- **Actions:** Start review / Start build / Start fix / Start test

### 2. Repo list API

**Route:** `GET /api/repos`
**Query:** `listRepos(orgIds)` — returns repos with basic stats

### 3. Workflow initiation

**Route:** `POST /api/repos/{repoId}/claims`
**Body:** `{ claim_type: 'review' | 'build' | 'fix' | 'test', description: string, pr_number?: number }`

Creates an `agent_claim` row for the repo. The claim dispatcher matches it to an available agent (one that's online and belongs to the same org). No repo-scoping filter on the agent — agents work for all repos in their org by default.

### 4. Agent auto-scoping

**Change:** `agents.repos` defaults to `[]` → treat empty array as "all repos in org" for claim matching.

**Claim dispatch logic:** When matching claims to agents, if `agents.repos` is empty, the agent is eligible for any claim in the same org. Non-empty `agents.repos` continues to work as an explicit allowlist.

This is a semantics change, not a migration: `repos: []` goes from "no repos" to "all repos." Any existing agents with empty repos arrays were already broken (never matching), so there's no backward-compat concern.

### 5. Claim creation from dashboard

New dialog on the repos page: "Start workflow." Fields:
- **Claim type** — review / build / fix / test
- **Description** — what to do (required for build/fix, optional for review)
- **PR number** — for review claims targeting a specific PR

On submit → `POST /api/repos/{repoId}/claims` → claim created → agent picks it up → pipeline appears.

## DB changes

### `listRepos(orgIds)` query

```sql
SELECT r.id, r.org_id, r.repo_full_name, r.provider, r.created_at,
  r.installation_id,
  pi.suspended_at IS NULL AS is_active,
  COUNT(DISTINCT c.id) FILTER (WHERE c.status IN ('pending', 'claimed')) AS active_claims
FROM repos r
LEFT JOIN provider_installations pi ON r.installation_id = pi.id
LEFT JOIN agent_claims c ON c.repo = r.id
WHERE r.org_id = ANY($1)
GROUP BY r.id, pi.suspended_at
ORDER BY r.repo_full_name
```

### `createClaim` query

Insert into `agent_claims` with:
- `org_id` from repo
- `repo` = repo full name
- `claim_type` from request
- `payload` = `{ description, pr_number }`
- `status` = 'pending'

Existing claim dispatcher handles matching to an online agent.

## Files to create/modify

**New:**
- `packages/db/src/queries/repos.ts` — `listRepos`, `createClaim`
- `packages/dashboard/src/app/repos/page.tsx` — repos page
- `packages/dashboard/src/app/api/repos/route.ts` — GET handler
- `packages/dashboard/src/app/api/repos/[repoId]/claims/route.ts` — POST handler
- `packages/dashboard/src/components/repos/repo-card.tsx` — repo card with actions
- `packages/dashboard/src/components/repos/start-workflow-dialog.tsx` — claim creation dialog

**Modify:**
- `packages/db/src/queries/index.ts` — export new queries
- `packages/fluent-flow/src/agents/claim-manager.js` — empty `repos` → match all repos in org
- Navigation component — add Repos link
- `README.md` — update data flow, API paths, onboarding section
- `packages/fluent-flow/DESIGN.md` — update architecture to reflect current claim-dispatch + GitHub App + dashboard

## 6. Doc refresh

Root `README.md` and `packages/fluent-flow/DESIGN.md` are stale — they reference the old Express API paths and the Actions-based review flow. Update to reflect the current claim-dispatch architecture, GitHub App integration, and dashboard-driven agent registration.

Also add the repos page + workflow initiation to the architecture docs.

**Files to update:**
- `README.md` — update data flow diagram, API paths, onboarding section
- `packages/fluent-flow/DESIGN.md` — update architecture to reflect claim-dispatch, GitHub App, MCP server, dashboard

## Out of scope

- Repo config management (enable/disable repos, per-repo settings) — future
- Agent repo picker in agent creation dialog — not needed with auto-scoping
- "All Repositories" truncation fix (backfill for >100 repos) — separate issue
- Server-side reviews — not doing (BYOK model)

## Acceptance criteria

1. After GitHub App install, `/repos` shows all repos from the installation
2. An agent with `repos: []` matches claims for any repo in its org
3. From the repos page, a user can start a workflow (review/build/fix/test) on any repo
4. Started workflows appear on the pipelines page
5. Existing tests pass (≥410 green)
