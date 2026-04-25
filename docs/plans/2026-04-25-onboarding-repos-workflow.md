# Onboarding: Repos + Workflow Initiation

> **Goal:** After installing the GitHub App, a user can see their repos, connect a runner, and initiate work — all from the dashboard.

## Problem

After connecting the GitHub App, the dashboard shows nothing useful:
- No repos page — repos exist in the DB but are invisible
- No way to initiate work from the dashboard
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
**Body:** `{ claim_type: 'review' | 'build' | 'fix' | 'test', description: string, pr_number: number }`

The API maps dashboard types to runner claim types: `fix` → `review_fix`, `test` → `test_verify`.

Creates an `agent_claim` row for the repo. The claim dispatcher matches it to an available agent (one that's online and belongs to the same org). No repo-scoping filter on the agent — agents work for all repos in their org by default.

### 4. Agent auto-scoping

**Already implemented:** The server's `session-manager.js` already treats `agents.repos = '{}'` (empty array) as matching all repos in the org. The claim matching SQL uses `a.repos = '{}' OR repo = ANY(a.repos)`, so agents with no explicit repo list are eligible for any claim in their org. No code change needed.

### 5. Claim creation from dashboard

New dialog on the repos page: "Start workflow." Fields:
- **Claim type** — Review / Build / Fix / Test (mapped to runner types: `review_fix`, `test_verify`)
- **PR number** — required (the runner pipeline ties claims to PRs)
- **Description** — optional context passed to the runner as `payload.message`

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
- `claim_type` = mapped runner type (e.g. `review_fix`, `test_verify`)
- `payload` = `{ message: description }` (keyed as `message` to match runner prompt templates)
- `pr_number` = required positive integer
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
- Navigation component — add Repos link
- `README.md` — update data flow, API paths, onboarding section

## 6. Doc refresh

Root `README.md` was updated to describe Fluent Flow as BYOK agent orchestration. `packages/fluent-flow/DESIGN.md` was deleted (100% stale — referenced old Express routes, per-repo config, Actions-based flow).

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
5. Existing tests pass (≥469 green)
