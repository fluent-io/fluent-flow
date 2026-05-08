# Fluent Flow — Project State Summary

**Generated:** 2026-05-08
**Last commit:** `db8a829` — feat: post PR status comments when Fluent Flow starts reviewing/fixing (#113)
**Total commits:** ~204
**Live URL:** https://flow.fluenthive.io
**Repository:** `fluent-io/fluent-flow`

---

## 1. What Was Built

Fluent Flow is an agent orchestration service for autonomous development workflows. It receives GitHub events (PRs, CI completions, reviews, pushes), dispatches coding agents to implement or review code, and closes the review → build → verify loop autonomously.

### Core Services

| Package | Purpose |
|---------|---------|
| `fluent-flow` (server) | Express.js server — claim dispatch, agent registry, webhook handler, MCP server, review pipeline, check-run lifecycle |
| `fluent-flow-runner` | CLI runner — connects to server via long-poll, claims work, spawns AI harnesses locally (claude-code, codex, aider), reports results |
| `dashboard` | Next.js 15 admin UI — agent management, pipeline status, repo onboarding, workflow initiation |
| `db` | Shared data access — pg pool, Drizzle ORM schemas, Zod schemas, org-scoped query functions |

### Implemented Features

**GitHub App Integration**
- GitHub App webhook handler with HMAC signature verification
- Installation lifecycle (create, delete, suspend, repos changed)
- Installation token cache with automatic refresh
- Provider abstraction layer (`ProviderClient` interface)
- Org auto-creation on App install, user-to-org linking
- Per-repo installation context resolution

**Agent System**
- Agent registry (DB-backed, not file-based)
- Token-based authentication with hashed storage
- Session management with heartbeat and TTL-based expiry
- Multi-agent routing via PR body markers or repo config
- Agent types: `claude-code`, `codex`, `aider`, `custom`

**Claim Pipeline**
- Claim types: `spec`, `build`, `review`, `review_fix`, `test_verify`
- Atomic claim pickup via `FOR UPDATE SKIP LOCKED`
- Auto-chain: review FAIL → review_fix, spec → build, test_verify → re-review
- Claim expiry worker with automatic re-dispatch at attempt+1 (cap 10)
- Claim dismiss/archive with bulk operations and UI filters
- Pending-only claim creation (no session pre-assignment)

**Review Pipeline**
- Automated PR review dispatch on CI completion (`check_run.completed`)
- Review agent prompt with inline comment instructions
- Review verdict parsing from `<!-- reviewer-result: {...} -->` marker
- Stale review dismissal before re-dispatch
- Retry tracking with configurable max retries and escalation to human
- Advisory fix dispatch even on PASS
- Auto-merge enablement on review PASS

**Check Runs**
- GitHub Check Run creation on claim dispatch
- Check Run updates: queued → in_progress → completed
- Config snapshot in check run output

**State Machine**
- Config-driven state transitions with requirement validation
- Terminal states (`Done`) and wildcard transitions (`* → Cancelled`)
- GitHub Projects integration (card movement on transitions)
- Pause/resume with agent notification and human-in-the-loop

**Dashboard**
- GitHub OAuth login via NextAuth.js
- Multi-tenant with roles: superadmin, admin, member
- Agent list with status badges and detail view
- Pipeline list and detail with stage timeline
- Repos page showing connected repos after App install
- Start Workflow dialog (Feature/Fix/Review/Spec types)
- New Agent registration stepper (Name → Run → Connect)
- Dismiss/archive controls for claims

**Runner**
- Long-poll client with exponential backoff and watchdog
- Git worktree management per claim (isolated checkout)
- SSH key detection with HTTPS+token fallback for cloning
- `gh` CLI auto-authentication with GitHub App token
- Environment pass-through to agent subprocesses
- Graceful shutdown with claim failure reporting
- Session re-registration on expiry (410)

**MCP Server**
- Streamable HTTP transport at `POST /mcp`
- Tools: queries (pending actions, state, config), commands (transitions, review dispatch, pause/resume), agent management
- Bearer token auth

**Notifications**
- Agent-agnostic notification dispatcher
- Transports: webhook, workflow_dispatch, long-poll (in-memory queue)
- Notification types: review failure, pause, resume, PR merged

**Outbound Queue**
- `provider_outbound_queue` table for async GitHub API writes
- In-process worker with `FOR UPDATE SKIP LOCKED`
- Retry with rate-limit awareness
- Queueable actions: comment, review, create_check_run, update_check_run

### Test Coverage

- Server: ~381 tests (Vitest, sequential)
- DB package: ~15 tests
- Dashboard: ~14 tests
- **Total: ~410 tests**

---

## 2. Architecture

### Monorepo Structure

```
fluent-flow/
├── packages/
│   ├── fluent-flow/          # Express server (port 3847)
│   │   ├── src/
│   │   │   ├── agents/       # Agent registry, tokens, sessions, claims
│   │   │   ├── config/       # Config loading, env validation, provider schema
│   │   │   ├── db/           # Server-specific DB helpers (audit, repo-configs)
│   │   │   ├── engine/       # State machine, review manager, check-run, pause, test manager
│   │   │   ├── mcp/          # MCP server (handler, auth, tools)
│   │   │   ├── notifications/ # Dispatcher + transports (webhook, workflow, long-poll)
│   │   │   ├── providers/    # Provider abstraction, GitHub REST/GraphQL, token cache
│   │   │   ├── routes/       # Express routes (webhook, agents, runner, config, health)
│   │   │   ├── workers/      # Background workers (outbound, session-expiry, claim-expiry)
│   │   │   ├── work-queue/   # Generic work queue abstraction
│   │   │   ├── app.js        # Express app factory
│   │   │   └── index.js      # Entry point
│   │   └── Dockerfile         # Multi-stage build (db-builder → runtime)
│   ├── fluent-flow-runner/   # CLI runner
│   │   ├── src/
│   │   │   ├── runner.js     # Main runner loop (poll → execute → report)
│   │   │   ├── client.js     # HTTP client (register, poll, reportClaim)
│   │   │   ├── commands.js   # Agent command resolution (claude, codex, aider)
│   │   │   ├── prompts.js    # Prompt templates by claim_type
│   │   │   ├── worktree.js   # Git worktree management
│   │   │   └── credentials.js # Token resolution
│   │   └── bin/              # CLI entry point
│   ├── dashboard/            # Next.js 15 app (port 3000)
│   │   └── src/app/
│   │       ├── agents/       # Agent list + detail pages
│   │       ├── api/          # API routes (agents, pipelines, repos, auth)
│   │       ├── pipelines/    # Pipeline list + detail pages
│   │       ├── repos/        # Repos page
│   │       └── login/        # Auth page
│   └── db/                   # Shared data access
│       └── src/
│           ├── schema/       # Drizzle ORM table definitions
│           └── migrations/   # SQL migrations (0000–0009)
├── docs/
│   ├── specs/                # Design specs (6 documents)
│   ├── plans/                # Implementation plans (10 documents)
│   └── superpowers/          # Agent capability specs
├── docker-compose.yml        # Server + dashboard + Postgres
├── docker-compose.observability.yml  # Signoz/OpenTelemetry overlay
├── turbo.json                # Turborepo config
└── .github/workflows/        # CI (test) + Deploy (self-hosted G10)
```

### Tech Stack

| Layer | Technology |
|-------|-----------|
| Server | Express.js, ESM, raw pg + Drizzle ORM, Zod validation |
| Runner | Node.js CLI, no external deps beyond Vitest for tests |
| Dashboard | Next.js 15 (App Router), React 19, TypeScript, Tailwind CSS, shadcn/ui, Radix UI |
| Database | PostgreSQL 16, Drizzle ORM for schema, raw SQL for complex queries |
| Auth | GitHub OAuth (NextAuth.js) for dashboard, Bearer tokens for runner/MCP |
| Logging | Pino with OpenTelemetry transport (optional Signoz integration) |
| Build | Turborepo monorepo, npm workspaces |
| Containerization | Docker multi-stage builds, Docker Compose |
| CI/CD | GitHub Actions — CI on push/PR, deploy on main (self-hosted runner on G10) |

### Database Schema Highlights

**10 migrations (0000–0009)** covering:

| Table | Purpose |
|-------|---------|
| `orgs` | Organizations (auto-created on GitHub App install) |
| `users` | GitHub OAuth users |
| `user_orgs` | User-to-org membership with roles (admin/member) |
| `agents` | Registered agents with type, transport, repo scope |
| `agent_sessions` | Runner sessions with status, heartbeat, TTL |
| `agent_tokens` | Hashed API tokens for runner auth |
| `agent_claims` | Work claims with type, status, payload, attempt tracking, archived_at |
| `repos` | Connected repositories with installation_id FK |
| `org_config` / `repo_configs` | Per-org and per-repo configuration |
| `config_cache` | Cached repo config with TTL |
| `provider_installations` | GitHub App installations |
| `provider_installation_repos` | Repos visible to each installation |
| `provider_outbound_queue` | Async outbound GitHub API writes |
| `pauses` | Human-in-the-loop pause records |
| `project_items` / `state_transitions` | GitHub Projects state tracking |
| `review_retries` | Per-PR review retry counter and issue tracking |
| `test_failures` | Test failure tracking for retry logic |

Key design: `agent_claims` uses partial unique indexes (`NULL` pr_number support), `FOR UPDATE SKIP LOCKED` for atomic claim pickup, and `archived_at` for soft deletion.

---

## 3. What Was Working

As of the last deployed state, these features were functional in production:

1. **GitHub App webhook handling** — installation lifecycle events, repository sync, check-run completions
2. **Automated PR review dispatch** — triggered on CI completion, creates review claim, runner picks up
3. **Review → fix → re-review loop** — auto-chains on FAIL verdict, re-dispatches after fix push
4. **Agent registration from dashboard** — 3-step modal, token generation, auto-confirm on connection
5. **Runner long-poll cycle** — register session, poll for work, execute agent, report result
6. **Git worktree isolation** — per-claim worktree on PR branch, automatic cleanup
7. **Dashboard authentication** — GitHub OAuth, multi-tenant with role-based access
8. **Pipeline monitoring** — list and detail views showing claim stages and status
9. **Repos page** — shows connected repos after App install, allows starting workflows
10. **Claim dismiss/archive** — bulk dismiss stale claims, UI filters for active/archived
11. **Outbound queue worker** — async comment/review/check-run posting with retry
12. **Session expiry worker** — marks stale sessions offline
13. **Claim expiry worker** — reclaims orphaned claims, re-dispatches
14. **Post-deploy smoke checks** — verify webhook route, dashboard login, auth gating
15. **PR status comments** — posts "reviewing" / "fixing" comments on PRs

---

## 4. What Was In Progress

No PRs were actively in-flight at the time of this summary. The last merged work was:
- **PR #113** — PR status comments
- **PR #112** — Advisory fix on PASS + scoped re-review chain
- **PR #111** — Migration 0009 fix
- **PR #110** — Missing migration journal entries + CI check
- **PR #108** — claim_type in unique constraint, test_verify pipeline fix
- **PR #107** — Pending-only claims, auto-retry on expiry, runner watchdog
- **PR #105** — Org-level install repo backfill + fail-fast audit

### Draft Plans (Not Yet Implemented)

- `docs/plans/fix-claim-dispatch-reliability.md` — Fix claim dispatch reliability (draft, 2026-05-05)
- `docs/plans/review-cycle-fixes.md` — Review cycle fixes (draft, 2026-05-07)
- `docs/plans/test-verify-claim-pipeline-fixes.md` — test_verify claim pipeline bugs (ready for review)
- `docs/plans/2026-04-25-onboarding-repos-workflow.md` — Onboarding repos + workflow (shipped via PR #89, plan may need closing)

---

## 5. Key Design Decisions

### 5.1 BYOK / Bring Your Own Subscription
Fluent Flow never holds API keys for AI models. The runner invokes the model locally with whatever credentials it already has. This was a foundational choice: no per-user billing, no server-side model calls, no key management overhead.

### 5.2 Runner-Claim Architecture (Not Webhook-Dispatch)
Early versions used `workflow_dispatch` to trigger GitHub Actions for reviews. This was replaced by the runner-claim path: the server creates a `pending` claim, and an online runner picks it up via `FOR UPDATE SKIP LOCKED`. This eliminates per-repo workflow files and allows any runner to claim any matching work.

### 5.3 Direct DB Access for Dashboard (No Express Proxy)
The dashboard reads directly from the same Postgres database as the server. No API proxy through the Express server. Write paths don't overlap (dashboard writes auth tables, server writes engine tables). This simplifies the architecture and removes a network hop.

### 5.4 Deterministic State Machine
Agents never decide what step comes next. The engine's state machine enforces transitions based on config rules. This prevents agents from skipping steps or entering invalid states.

### 5.5 GitHub App Auth (Not PAT)
PAT-based auth was fully replaced by GitHub App installation tokens. Every GitHub API call requires an installation context resolved from the DB. There is no PAT fallback — if context resolution fails, the operation is skipped or throws.

### 5.6 Atomic Claim Pickup
Claims are always created as `pending` (no session pre-assignment). Runners claim via `UPDATE ... WHERE id = (SELECT ... FOR UPDATE SKIP LOCKED)`. This prevents race conditions and session coupling — if a server restarts, unclaimed claims remain available for any runner.

### 5.7 Outbound Queue Pattern
All GitHub API writes go through `provider_outbound_queue` with an in-process worker. This provides retry, rate-limit handling, and durability — if the GitHub API is down, writes queue up rather than failing the request.

### 5.8 Self-Hosted First
A `self-hosted` org is bootstrapped on first startup. This supports single-org deployments without complex multi-tenancy setup. The multi-tenancy layer (users, user_orgs, roles) exists but the self-hosted org is the default target.

### 5.9 Config-Driven with DB Override
Repo config starts from YAML files (`.github/fluent-flow.yml`) cached in the DB with TTL. Per-repo and per-org config in the database can override file-based config. This supports both developer-self-service (commit a config file) and admin control (dashboard config).

### 5.10 Security: No Secret Leakage
Error messages returned to clients never include env var names, stack traces, DB error codes, or internal details. Full details go to server-side logs only. This was codified after PR #80 and enforced via CLAUDE.md rules.

---

## 6. Infrastructure

### Docker Deployment (G10 — 192.168.68.140)

```
┌─────────────────────────────────────────────────┐
│  G10 (self-hosted GitHub Actions runner)        │
│  ├── fluent-flow        (port 3847)             │
│  ├── fluent-flow-dashboard (port 3000)          │
│  ├── postgres:16-alpine (port 5432)             │
│  └── fluent-flow-runner (on host or container)  │
└─────────────────────────────────────────────────┘
         │
         ├── Cloudflare Tunnel → flow.fluenthive.io
         └── GitHub Actions deploy workflow (self-hosted runner)
```

### Docker Compose

- **fluent-flow**: Multi-stage Dockerfile (db-builder → runtime). Node 20-alpine. Port 3847. Reads config volume.
- **dashboard**: Multi-stage Dockerfile (db-builder → dashboard-builder → runtime). Node 20-alpine. Port 3000. Next.js production build.
- **postgres**: postgres:16-alpine with persistent volume (`pgdata`). Default credentials in compose, overridden in deploy.

### CI/CD

- **CI** (`ci.yml`): Runs on push/PR to main. Checks out, installs deps, verifies migration journal consistency, runs all tests via Turborepo fan-out.
- **Deploy** (`deploy.yml`): Runs on push to main. Self-hosted on G10. Validates secrets, writes env file, `docker compose up -d --build`, waits for health endpoint, runs smoke tests (webhook route 401, dashboard 200 + CTA content, auth gating).

### Networking

- Internal: `fluent-flow-net` bridge network between containers
- External: Cloudflare tunnel exposes `flow.fluenthive.io` → server port 3847 + dashboard port 3000
- Observability: Optional Signoz overlay (`docker-compose.observability.yml`) connects to external `signoz-net` for OpenTelemetry traces

### Environment Variables

**Required for server:**
- `DATABASE_URL`, `FF_GITHUB_APP_ID`, `FF_GITHUB_APP_PRIVATE_KEY` (base64), `FF_GITHUB_APP_WEBHOOK_SECRET`

**Required for dashboard:**
- `DATABASE_URL`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `NEXTAUTH_SECRET`, `NEXTAUTH_URL`

**Optional:**
- `MCP_AUTH_TOKEN` (MCP/admin API auth)
- `NEXT_PUBLIC_FLUENT_FLOW_URL` (dashboard → server URL for client-side API calls)

---

## 7. Lessons Learned

### What Worked Well

1. **Turborepo monorepo with shared db package** — Clean separation of concerns while allowing shared types and queries. Dashboard and server both import from `@fluent-flow/db`.

2. **FOR UPDATE SKIP LOCKED for claim pickup** — Eliminated race conditions entirely. No distributed locks, no Redis dependency, just Postgres advisory locking.

3. **Self-hosted GitHub Actions deploy** — Fast deploys (no queue time), access to local Docker daemon, post-deploy smoke checks on the actual running service.

4. **PR template with "How did you verify end-to-end?" field** — Forced verification discipline. Every PR documents how it was tested beyond unit tests.

5. **Post-deploy smoke checks** — Caught multiple deployment issues that would have been silent (wrong route mount, stale build, missing auth).

6. **Fail-fast audit of catch blocks** — After PR #105, all ~35 catch blocks were annotated with explicit "safe to continue" reasoning. This discipline caught real bugs.

7. **Runner worktree isolation** — Each claim gets its own git worktree. Agents can't interfere with each other or the runner's state.

### What Was Challenging

1. **GitHub App token resolution bugs** — A recurring class of bug: passing internal FK IDs where external installation IDs were expected. Multiple PRs (#86, #92, #96, #99, #104) fixed variants of this. The root cause was the DB storing both internal and external IDs with confusing naming.

2. **Deploy reliability** — Docker `up -d --build` doesn't always recreate running containers. Required `DEPLOY_SHA` label and sometimes `--force-recreate`. Runners saw transient 502s during restarts.

3. **Org-level install repo truncation** — GitHub caps `installation.created` payloads at ~100 repos. Required a backfill mechanism and lazy onboarding for repos beyond the cap.

4. **Review verdict parsing fragility** — Depending on agents echoing `<!-- reviewer-result -->` to stdout works for Claude Code but is fragile for other agents that post reviews via `gh api` directly.

5. **Session coupling** — Early versions pre-assigned claims to sessions. Server restarts lost these assignments. Moving to pending-only claims with `claimPendingWork` resolved this.

6. **Drizzle schema drift** — The Drizzle schema declaration diverged from the actual DB (missing FK, wrong column types). A migration journal consistency check was added to CI to prevent future drift.

7. **Runner npm publish blocking** — The runner package name is `fluent-flow-runner` (unscoped) but the dashboard generates `npx @fluent-flow/runner@latest` commands. Not published to npm yet, so new users hit 404.

---

## 8. Future Possibilities

### Immediate Next Steps (Known Gaps from ROADMAP.md)

1. **Publish runner to npm** — Rename to `@fluent-flow/runner`, set up release workflow, cut v0.1.0. This unblocks the dashboard's generated `npx` commands.

2. **Fix non-check-run webhook auth** — `pull_request.closed` and review-dismissal paths still lack installation context. Audit all GitHub REST helpers to require token context.

3. **Fix outbound worker token bug** — The outbound worker passes internal FK to `getInstallationToken` which expects external ID. Join to `provider_installations` for the correct ID.

4. **Verdict parsing from GitHub API** — After agent exits, fetch the latest review from GitHub API instead of relying on stdout marker. Makes multi-agent review reliable.

5. **Auto-backfill large installs** — When `installation.created` payload hits the repo cap, automatically fire the backfill logic instead of requiring a manual script.

6. **Dashboard key regeneration** — Session-authed endpoint for org admins to re-issue tokens without MCP access.

### Medium-Term

7. **Rename `agent_type` to `harness`** — Disambiguate from `claim_type`. Migration + schema + UI + docs update.

8. **Fix Drizzle schema drift** — Add `.references()` to `repos.installation_id`, regenerate snapshot to match production.

9. **Add `expires_at > NOW()` guard to `touchSession`** — Prevent dead sessions from being silently revived on heartbeat.

10. **Consolidate webhook routers** — Merge `webhook.js` and `github-app-webhook.js` into one module now that PAT-era paths are retired.

11. **Schema cleanup** — Several legacy tables (`pauses`, `project_items`, `state_transitions`, `review_retries`, `test_failures`) predate the claim system and may need consolidation.

### Longer-Horizon (from docs/plans/)

12. **VSCode extension** — `packages/fluent-flow/docs/plans/vscode-extension.md`
13. **Agent work queue redesign** — `packages/fluent-flow/docs/plans/2026-03-28-agent-work-queue-plan.md`
14. **Admin dashboard phase 2** — Claim history, audit log viewer, notification preferences
15. **Multi-org dashboard support** — The schema supports it; the UI doesn't expose org switching yet
16. **Runner Docker image publication** — Reference Dockerfile exists but isn't published to a registry

### Dependency / Maintenance

17. **17 Dependabot vulnerabilities** — Flagged on default branch (4 critical, 2 high, 11 moderate). Needs triage and patching.
18. **Node.js version alignment** — Server Dockerfile uses node:20, runner engines reference node:24. Align versions.
19. **Test coverage gaps** — Dashboard API routes (`/api/repos`, `/api/repos/{id}/claims`) and DB queries (`listRepos`, `createClaim`) lack unit tests.

---

*This document is an archival snapshot of the Fluent Flow project state as of 2026-05-08. For the latest status, check ROADMAP.md and recent git history.*
