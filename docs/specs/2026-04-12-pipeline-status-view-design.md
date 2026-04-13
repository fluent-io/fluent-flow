# Pipeline Status View — Design Spec

**Date:** 2026-04-12
**Scope:** Dashboard Phase 2a — Pipeline status view
**Depends on:** Dashboard Phase 1 (PR #51)

## Context

The task pipeline (spec → build → review_fix → test_verify) is working end-to-end, but operators have no visibility into pipeline progress. Claims exist in the database but are only visible through the agent detail page's claims tab, scoped per-agent. There's no way to see all pipelines across agents, monitor active work, or diagnose failures at the PR level.

This feature adds a top-level Pipelines page to the dashboard showing pipeline status per PR with drill-down into individual stage details.

## Architecture

**Query-only approach.** No new tables or migrations. Pipeline state is derived from existing `agent_claims` rows grouped by `(org_id, repo, pr_number)`. Each unique `(repo, pr_number)` combination represents a pipeline. The four claim types (spec, build, review_fix, test_verify) are the pipeline stages.

New queries go in `packages/db`. New API routes and pages go in `packages/dashboard`. The sidebar gets a new "Pipelines" nav item.

**Dynamic stages.** The UI does not hardcode the four current claim types. Stages are rendered dynamically from whatever claim types exist for a given PR, ordered by creation time. Adding a new claim type (e.g. `security_review`) requires only adding the type to the engine's claim creation logic and a color/label entry in the stage component — no dashboard query or layout changes.

## Data Model

Pipeline state is derived, not stored. A pipeline is the set of claims for a given `(org_id, repo, pr_number)`. Each claim type is a stage. Current types:

| Claim Type | Label | Description |
|-----------|-------|-------------|
| `spec` | Spec | Generate implementation spec |
| `build` | Build | Implement the spec |
| `review_fix` | Review Fix | Fix issues found in review |
| `test_verify` | Test Verify | Verify tests pass |

New claim types (e.g. `security_review`) are supported without code changes — the pipeline view renders whatever types exist for the PR. The stage label and color are resolved from a lookup map in `pipeline-stage.tsx`; unknown types fall back to a neutral style with the raw claim_type as the label.

Not all stages are present for every PR. A PR that only gets a code review will have `review_fix` but no `spec` or `build`. The UI only renders stages that exist — no placeholder slots for missing types.

### Pipeline overall status

Derived from the individual claim statuses:
- **in progress** — any claim is `pending` or `claimed`
- **completed** — all present claims are `completed`
- **failed** — any claim is `failed` or `expired`, and no claim is `pending`/`claimed`

### Attempt tracking

Claims have an `attempt` column. Multiple attempts for the same PR create separate pipeline runs. The detail view shows the latest attempt by default.

## Queries

### listPipelines(orgIds)

Returns pipelines grouped by PR, newest activity first.

```sql
SELECT
  c.org_id,
  c.repo,
  c.pr_number,
  MAX(c.attempt) AS latest_attempt,
  MAX(c.created_at) AS last_activity,
  json_agg(
    json_build_object(
      'claim_type', c.claim_type,
      'status', c.status,
      'created_at', c.created_at,
      'claimed_at', c.claimed_at,
      'completed_at', c.completed_at
    ) ORDER BY c.created_at
  ) AS stages
FROM agent_claims c
WHERE c.org_id = ANY($1)                    -- omit WHERE for superadmin
  AND c.attempt = (
    SELECT MAX(c2.attempt)
    FROM agent_claims c2
    WHERE c2.org_id = c.org_id AND c2.repo = c.repo AND c2.pr_number = c.pr_number
  )
GROUP BY c.org_id, c.repo, c.pr_number
ORDER BY last_activity DESC
LIMIT 100
```

Returns: `{ org_id, repo, pr_number, latest_attempt, last_activity, stages: [{ claim_type, status, created_at, claimed_at, completed_at }] }`

### getPipelineDetail(orgIds, repo, prNumber)

Returns all claims for a specific PR pipeline, including session/agent info.

```sql
SELECT
  c.*,
  s.agent_id,
  s.session_meta
FROM agent_claims c
LEFT JOIN agent_sessions s ON c.session_id = s.id
WHERE c.org_id = ANY($1)
  AND c.repo = $2
  AND c.pr_number = $3
  AND c.attempt = (
    SELECT MAX(c2.attempt)
    FROM agent_claims c2
    WHERE c2.org_id = c.org_id AND c2.repo = c.repo AND c2.pr_number = c.pr_number
  )
ORDER BY c.created_at ASC
```

Returns: array of claim records with agent_id and session_meta joined.

## API Routes

All routes require NextAuth session. Org scoping from session.

| Route | Method | Auth | Description |
|-------|--------|------|-------------|
| `/api/pipelines` | GET | any | List pipelines for user's org(s), newest first |
| `/api/pipelines/[...slug]` | GET | any | Pipeline detail for a specific repo/PR. Slug is `owner/repo/prNumber`. |

### Org scoping

Same pattern as agents routes — `getOrgScope(session)` returns `orgIds` from the authenticated session. Superadmin sees all.

## Pages

### Pipeline List (`/pipelines`)

- Page heading: "Pipelines" with subtitle "Task pipeline status per PR"
- List of pipeline cards, newest activity first, limit 100
- Each card shows:
  - Repo and PR number (links to GitHub)
  - PR title from claim payload (if available)
  - Overall pipeline status badge (in progress / completed / failed)
  - Last activity timestamp
  - Horizontal stage flow rendered dynamically from the pipeline's stages array (variable number of stages)
  - Per-stage: status icon, label, duration (if completed)
  - Only present stages are shown — no placeholder slots for missing types
- Card click navigates to pipeline detail
- Empty state when no pipelines exist

### Pipeline Detail (`/pipelines/[...slug]`)

- Breadcrumb: Pipelines / owner/repo #N
- PR header card: repo/PR, title, overall status, agent, attempt, started, total duration, link to GitHub
- Vertical timeline with connected nodes per stage:
  - Completed: green checkmark, duration, start → end timestamps, agent/session
  - Active: amber spinner, elapsed time, agent/session
  - Waiting: dimmed with stage number
  - Failed: red X, duration, agent/session
  - Stages rendered dynamically — only stages with claims are shown

## Sidebar Update

Add "Pipelines" nav item to the sidebar between Agents and Settings. Uses the `GitBranch` icon from lucide-react.

## Project Structure (new files only)

```
packages/db/src/queries/
  pipelines.ts                              # listPipelines, getPipelineDetail

packages/dashboard/src/
  app/
    pipelines/
      page.tsx                              # Pipeline list page
      [...slug]/page.tsx                    # Pipeline detail page
    api/pipelines/
      route.ts                              # GET list
      [...slug]/route.ts                    # GET detail
  components/
    pipelines/
      pipeline-card.tsx                     # Horizontal stage flow card
      pipeline-stage.tsx                    # Single stage indicator
      pipeline-timeline.tsx                 # Vertical timeline for detail
```

## Testing

- **Unit tests (Vitest):** API route handlers — mock DB, verify org scoping, response shapes. Query functions in packages/db tested with mocked pg.
- Tests run via Turborepo `npm test` from repo root.

## Verification

1. `npm test` — all packages pass
2. `npm run dev` in packages/dashboard — navigate to /pipelines, verify list renders, click into detail, verify timeline renders
3. Org scoping: non-superadmin user only sees pipelines for their org's repos
