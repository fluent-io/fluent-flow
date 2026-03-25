# SaaS Architecture: GitHub App + Server-Side Reviews

## Problem

Currently, every client repo needs:
- `.github/fluent-flow.yml` — config file
- `.github/workflows/pr-review.yml` — caller workflow
- `ANTHROPIC_API_KEY` secret (org or repo level)
- `FLUENT_FLOW_URL` secret

This is friction for onboarding and leaks implementation details into client repos.

## Goal

Install a GitHub App on the org → done. No workflow files, no secrets, no per-repo setup beyond an optional config file.

## Architecture

### Current (GitHub Actions)

```
check_run.completed webhook → Fluent Flow server
  → dispatch workflow_dispatch on client repo
  → GitHub Actions runner checks out code, fetches diff
  → Runner calls Claude API (client's ANTHROPIC_API_KEY)
  → Runner posts review via gh CLI (GITHUB_TOKEN)
  → Runner notifies Fluent Flow with result
```

### Target (Server-Side)

```
check_run.completed webhook → Fluent Flow server
  → fetch PR diff via GitHub API (App installation token)
  → call Claude API (server's ANTHROPIC_API_KEY)
  → post review via GitHub API (App installation token)
  → store result in DB
```

## What Changes

### 1. GitHub App replaces PAT + org webhook

- App provides: webhook delivery, per-repo installation tokens, scoped permissions
- Permissions needed: `pull_requests: write`, `checks: read`, `contents: read`
- Webhook events: configured on the App, not per-org
- Installation flow: org admin installs App → selects repos → done

### 2. Server-side reviewer replaces GitHub Actions workflow

Move review logic (`scripts/review.js`, diff fetching, review posting) into the Fluent Flow server:

| Component | Current (Actions) | Target (Server) |
|-----------|-------------------|-----------------|
| Diff fetch | `gh pr diff` in runner | `GET /repos/{owner}/{repo}/pulls/{pr}.diff` with App token |
| PR metadata | `gh pr view --json` in runner | `GET /repos/{owner}/{repo}/pulls/{pr}` with App token |
| Claude call | `review.js` in runner | Same logic, runs in Fluent Flow process |
| Post review | `post-review.mjs` in runner | `POST /repos/{owner}/{repo}/pulls/{pr}/reviews` with App token |
| Result storage | HTTP POST to Fluent Flow | Direct DB write |

### 3. Onboarding simplifies

| Step | Current | Target |
|------|---------|--------|
| Install | Org webhook + PAT | Install GitHub App on org |
| Per-repo config | `.github/fluent-flow.yml` + workflow file + secrets | `.github/fluent-flow.yml` only (optional — can use defaults or dashboard) |
| Secrets | `ANTHROPIC_API_KEY` + `FLUENT_FLOW_URL` per org | None — all on server |

### 4. Config without files (optional, future)

With a GitHub App, config could live in the Fluent Flow DB instead of `.github/fluent-flow.yml`:
- Dashboard UI for repo settings
- API endpoint for config management
- Fall back to `.github/fluent-flow.yml` if present (file overrides dashboard)

## GitHub App Setup

### App manifest

```yaml
name: Fluent Flow
url: https://flow.getonit.io
description: Automated code review and workflow orchestration
permissions:
  contents: read        # checkout code, read config files
  pull_requests: write  # post reviews, dismiss reviews, enable auto-merge
  checks: read          # read check run status
  issues: write         # manage labels (needs-human)
  metadata: read        # required base permission
events:
  - check_run
  - pull_request
  - pull_request_review
  - issues
  - issue_comment
  - push
```

### Authentication flow

1. App installed on org → GitHub sends `installation` webhook
2. Fluent Flow stores `installation_id` per org
3. Per request: exchange `installation_id` for short-lived token via `POST /app/installations/{id}/access_tokens`
4. Use token for all GitHub API calls scoped to that installation

### Token management

- Installation tokens expire after 1 hour
- Cache tokens with TTL, refresh on expiry
- Each API call uses the installation token for the target repo's org

## Server-Side Reviewer

New module: `src/engine/reviewer.js`

```
reviewPR({ owner, repo, prNumber, attempt, priorIssues })
  → getInstallationToken(owner)
  → fetchPRDiff(owner, repo, prNumber, token)
  → fetchPRMetadata(owner, repo, prNumber, token)
  → callClaude(diff, metadata, attempt, priorIssues)
  → postReview(owner, repo, prNumber, result, token)
  → handleReviewResult(owner, repo, prNumber, result)
```

### Diff size handling

GitHub API returns full diff. Current limit: 65KB (`diff_limit_kb` config). Truncate server-side same as the Actions workflow does.

### Concurrency

Multiple reviews can be in flight. Use a job queue (Bull/BullMQ with Redis, or pg-boss with existing Postgres) to:
- Limit concurrent Claude API calls
- Retry on transient failures
- Prevent duplicate reviews for the same PR

## Migration Path

### Phase 1: GitHub App (parallel with current system)

- Create GitHub App with required permissions
- Add App authentication module (`src/github/app-auth.js`)
- Accept webhooks from both org webhook (legacy) and App (new)
- Existing repos continue using workflow-based reviews
- New repos can use either

### Phase 2: Server-side reviewer

- Implement `src/engine/reviewer.js`
- Add job queue for review processing
- `check_run.completed` handler dispatches server-side review instead of workflow
- Config flag: `reviewer.mode: "server"` (default) vs `"actions"` (legacy)

### Phase 3: Deprecate Actions workflow

- Remove `dispatchWorkflow` path
- Remove `onboard_repo` workflow file creation
- Onboarding becomes: install App + optional config file
- Existing workflow files in client repos become no-ops (they'll never be dispatched)

## Open Questions

- **Multi-tenant API keys**: Should each org bring their own Anthropic API key, or does Fluent Flow provide one (usage-based billing)?
- **Rate limits**: Claude API rate limits with many repos reviewing simultaneously
- **Review queue priority**: Should some repos/PRs get priority?
- **Dashboard**: Web UI for config, review history, retry management — or MCP-only?
- **Pricing model**: Per-repo, per-review, or flat rate?
