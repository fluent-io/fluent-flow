# GitHub App + Runner — Spec

**Goal:** Eliminate per-repo `pr-review.yml` and manual webhook setup. Replace with a GitHub App (auto-installs, handles events) and a long-poll runner (handles review execution server-side).

---

## Problem Statement

Current setup requires per-repo:
1. `pr-review.yml` — runs Claude review as a GitHub Action
2. Manual webhook config — point repo at `flow.getonit.io`
3. `ANTHROPIC_API_KEY` + `FLUENT_FLOW_URL` secrets per repo

This is friction for every new repo. It also means the review result callback is optional (`FLUENT_FLOW_URL` not set → silent failure, as seen in PR #38).

---

## Target Architecture

```
GitHub                        G10 Server
──────                        ──────────
repos ──events──▶ GitHub App ──▶ fluent-flow server
                               ◀── fluent-flow-runner (long-poll)
                                     │
                                     ▼
                               Claude API (review execution)
                               │
                               ▼
                               POST /api/review/result ──▶ fluent-flow server
```

### What changes
- **No more `pr-review.yml`** in client repos — runner handles review execution
- **No more manual webhooks** — GitHub App delivers events to all installed repos
- **No more per-repo secrets** — API keys live on the server

### What stays the same
- All fluent-flow server logic (review-manager, check-run-handler, etc.)
- MCP interface
- Config system (`.github/fluent-flow.yml` still used for per-repo overrides)

---

## Package: `fluent-flow-app`

New Turborepo package. Thin layer on top of `fluent-flow` server.

### Responsibilities
- Receive GitHub App webhook events (validated with app secret)
- Translate to same format as current webhook handler
- Forward to `fluent-flow` server handlers
- Handle app installation/uninstall events (auto-onboard repos)
- Provide GitHub App auth (JWT + installation tokens) for API calls

### GitHub App permissions required
| Permission | Level | Reason |
|---|---|---|
| Pull requests | Read & write | Post reviews, dismiss reviews |
| Issues | Read & write | Add labels, post comments |
| Contents | Read | Fetch `.github/fluent-flow.yml` |
| Checks | Read | Receive check_run events |
| Metadata | Read | Required by all apps |
| Actions | Write | Trigger workflows (optional, for fallback) |

### Webhook events to subscribe
- `check_run`
- `pull_request`
- `pull_request_review`
- `issues`
- `issue_comment`
- `push`
- `installation`
- `installation_repositories`

### Key files
```
packages/fluent-flow-app/
  src/
    app.js              — Octokit App instance (shared, singleton)
    webhooks.js         — receives + routes GitHub App webhook events
    auth.js             — getInstallationToken(repoFullName) helper
    installation.js     — handles install/uninstall, auto-onboards repos
    index.js            — Express router, mounts at /api/app
  tests/
    webhooks.test.js
    installation.test.js
  package.json
```

### Installation flow
1. User visits `github.com/apps/fluent-flow`
2. Clicks Install → selects repos
3. GitHub sends `installation.created` event to `flow.getonit.io/api/app/webhook`
4. `installation.js` calls `onboard_repo` for each repo in the installation
5. Done — Fluent Flow is now monitoring those repos

### Auth flow (replaces GITHUB_TOKEN)
Current: `GITHUB_TOKEN` env var used for all API calls
New: `getInstallationToken(repoFullName)` returns scoped JWT token per repo
- Tokens auto-rotate (1hr TTL, generated from app private key)
- `rest.js` and `graphql.js` will call `getInstallationToken` when available

---

## Package: `fluent-flow-runner` (complete)

Already partially built. Complete it to handle review execution.

### Responsibilities
- Long-poll `fluent-flow` server for pending claims
- Execute Claude review when a claim is received
- Post review to PR via GitHub API (using installation token)
- Report result back to `fluent-flow` server

### Key files
```
packages/fluent-flow-runner/
  src/
    runner.js           — main loop: poll → execute → report
    review-executor.js  — calls Claude API, formats result
    github-client.js    — posts review to PR
    config.js           — env var config (FF_URL, FF_TOKEN, ANTHROPIC_KEY)
  bin/
    fluent-flow-runner  — CLI entry point
```

### Runner loop
```
1. POST /api/runner/register  → get session_id
2. loop:
   POST /api/runner/poll       → wait for claim (30s timeout)
   if claim received:
     execute review (Claude API)
     POST /api/runner/claims/:id/result  → complete claim
     POST /api/review/result             → notify server
```

### Config
```env
FF_URL=https://flow.getonit.io
FF_TOKEN=ff_xxx                  # runner auth token (created via admin API)
ANTHROPIC_API_KEY=sk-...
```

### Deployment
Runs as a Docker container alongside `fluent-flow` server on G10:
```yaml
# docker-compose.yml
services:
  fluent-flow:
    ...
  fluent-flow-runner:
    build: ./packages/fluent-flow-runner
    environment:
      - FF_URL=https://flow.getonit.io
      - FF_TOKEN=${FF_RUNNER_TOKEN}
      - ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}
    restart: unless-stopped
```

---

## Migration Path

### Step 1: Complete `fluent-flow-runner` (Days 1-3)
- Review executor (calls Claude, formats result)
- GitHub client (posts review to PR)
- Result reporter (POST /api/review/result)
- Docker setup

### Step 2: Build `fluent-flow-app` (Days 4-7)
- Register GitHub App (manual step, one-time)
- App webhook handler
- Installation handler (auto-onboard)
- Auth helper (installation tokens)

### Step 3: Update `fluent-flow` server (Day 8)
- Accept installation tokens in addition to GITHUB_TOKEN
- Handle `installation` events
- Register runner agent automatically on startup

### Step 4: Deploy + test (Days 9-10)
- Update docker-compose
- Install GitHub App on `fluent-io/fluent-flow`
- Verify end-to-end (push → CI → runner review → result back)
- Remove `pr-review.yml` from repo

---

## Immediate Bug Fix (separate from this plan)

Add `FLUENT_FLOW_URL=https://flow.getonit.io` to `fluent-io/fluent-flow` repo secrets so the current `pr-review.yml` flow completes the loop while the runner is being built.

---

## Acceptance Criteria

- [ ] New PR opened on any installed repo → review appears without `pr-review.yml`
- [ ] New repo installed via GitHub App → auto-onboarded (no manual webhook)
- [ ] Runner handles review execution entirely server-side
- [ ] Review result always posted back to Fluent Flow (no silent failure)
- [ ] `pr-review.yml` can be safely removed from all repos
- [ ] All existing tests still pass (322+)
