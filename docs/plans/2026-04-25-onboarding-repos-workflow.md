# Onboarding: Repos + Workflow Initiation

> **Goal:** After installing the GitHub App, a user can see their repos, connect a runner, and initiate work — all from the dashboard.


## Status — shipped in PR #89

Merged to `main` on 2026-04-25. The PR delivered the repos page, repo list API, dashboard claim creation route, DB queries, Repos navigation, README refresh, and deletion of stale `packages/fluent-flow/DESIGN.md`.

Verification performed after merge:
- Local `main` fast-forwarded to `8e6b720`
- Feature branch `feat/onboarding-repos-workflow` deleted locally
- Full Vitest suite passed: 58 files passed, 1 skipped; 469 tests passed, 3 skipped
- Production `fluent-flow` container was manually force-recreated after CI built a new image but did not replace the old running container
- Health endpoint returned healthy after restart

Important operational notes:
- Runner 502s observed around 19:55 UTC were expected during the manual container restart; the runner backs off and retries.
- The check-run completion auth bug was fixed by passing webhook installation context through commit→PR, check-run, and annotation GitHub REST calls.
- A separate `pull_request.closed` review-dismissal path still emitted a GitHub 401 after restart; track this under GitHub App auth hardening, not as a blocker for new check-run-triggered review claims.

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
- Active claims count (links to `/pipelines` — repo filtering is a future enhancement)
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
LEFT JOIN agent_claims c ON c.org_id = r.org_id AND c.repo = r.repo_full_name
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

1. ✅ After GitHub App install, `/repos` shows repos from the installation
2. ✅ An agent with `repos: []` matches claims for any repo in its org
3. ✅ From the repos page, a user can start a workflow (review/build/fix/test) on any repo with a PR number
4. ✅ Started workflows appear on the pipelines page
5. ✅ Existing tests pass (469 passed, 3 skipped after merge)

## Follow-up candidates

- Add route/query tests for `GET /api/repos`, `POST /api/repos/{repoId}/claims`, `listRepos()`, and `createClaim()`.
- Support non-PR proactive work by making `agent_claims.pr_number` nullable and teaching runners/pipelines how to display non-PR claims.
- Add repo filtering to `/pipelines` if repo cards need a direct “active claims for this repo” drill-down.
- Harden remaining webhook GitHub REST calls to always use GitHub App installation context.
- Fix deploy so a newly built app image always recreates the running container.
