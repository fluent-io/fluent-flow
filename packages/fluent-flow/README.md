# Fluent Flow

Config-driven GitHub workflow orchestrator. A deterministic state machine manages the review-fix loop for AI coding agents — agents only read and write code, they never decide what step comes next.

## The Review Loop

When a PR is pushed or updated, Fluent Flow runs an automated code review. If the review passes, the PR is auto-merged. If it fails, the server creates a **claim** — a work assignment containing the review feedback — and notifies the responsible agent. The agent pushes a fix, which triggers a re-review. This loop repeats up to a configurable retry limit before escalating to a human.

```
PR pushed → review → PASS → auto-merge
                   → FAIL → claim created → agent notified → agent pushes fix → re-review → ...
                   → max retries exceeded → escalate to human
```

## Key Concepts

### Claims

A claim is a unit of work assigned to an agent. When a review fails, the server creates a claim with the review feedback and PR details. Claims are tracked per review attempt and have a TTL — if the assigned agent doesn't respond, the claim expires and can be reassigned.

### Agents

An agent is a registered identity (e.g. `claude-code`, `codex`, `aider`) with a transport configuration. Agents are stored in the database and authenticated via tokens. Each agent can be scoped to specific repos.

The agent that created a PR is resolved in this order:
1. PR body marker: `<!-- fluent-flow-agent: agent-id -->`
2. `config.default_agent` (per-repo)
3. `config.agent_id` (legacy)

### Transports

Transports define how agents receive work:

| Transport | Description | Use case |
|-----------|-------------|----------|
| `long_poll` | Agent polls the server for claims | Self-hosted runners ([fluent-flow-runner](../fluent-flow-runner/README.md)) |
| `webhook` | Server POSTs to agent's URL | External agents with HTTP endpoints |
| `workflow_dispatch` | Server triggers a GitHub Actions workflow | CI-based agents |
| `api` | Server calls an external API | Cloud agents (Devin, OpenAI Agents) |

### MCP (Model Context Protocol)

MCP is a stateless HTTP protocol that AI agents (Claude Code, Cursor) use to interact with Fluent Flow. The server exposes an MCP endpoint at `POST /mcp` with tools for querying state, executing transitions, dispatching reviews, and managing agents. See [MCP docs](src/mcp/README.md).

## Quick Start

### Requirements

- Node.js 20+
- PostgreSQL

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `DATABASE_URL` | Yes | PostgreSQL connection string |
| `FF_GITHUB_APP_ID` | Yes | GitHub App ID |
| `FF_GITHUB_APP_PRIVATE_KEY` | Yes | Base64-encoded GitHub App private key (PEM) |
| `FF_GITHUB_APP_WEBHOOK_SECRET` | Yes | Webhook signature verification secret |
| `MCP_AUTH_TOKEN` | No | Bearer token for MCP and Admin API auth (required in production) |
| `PORT` | No | Server port (default: `3847`) |
| `LOG_LEVEL` | No | Pino log level (default: `info`) |

### Run Locally

```bash
cd packages/fluent-flow
npm install
npm run dev
```

### Run with Docker

```bash
docker compose up -d --build
```

### Run Tests

```bash
npm test              # 366 tests, runs sequentially
npm run test:watch    # watch mode
```

## Configuration

Two-layer config system:

1. **Global defaults** (`config/defaults.yml`) — states, transitions, reviewer settings, pause reasons
2. **Per-repo overrides** (`.github/fluent-flow.yml` in client repos) — `project_id`, `default_agent`, reviewer overrides

Config is fetched from GitHub, cached in the database, and validated with Zod. See [config docs](config/README.md).

## Architecture

```
src/
  engine/          State machine, review pipeline, pause/resume
  mcp/             MCP server, tools, auth
  notifications/   Agent notification dispatcher, transports
  agents/          Agent registry, tokens, sessions, claims
  config/          Config loader, defaults, validation
  db/              PostgreSQL client, migrations
  github/          GitHub API client (REST + webhooks)
  routes/          Express API routes (agents, runner, webhook)
```

See the README in each directory for details:

- [Engine](src/engine/README.md) — state machine and review pipeline
- [MCP](src/mcp/README.md) — MCP server and tools
- [Notifications](src/notifications/README.md) — transport dispatch
- [Agents](src/agents/README.md) — registry, tokens, sessions, claims
- [Config](config/README.md) — config system

## GitHub App install lifecycle

Webhooks land at `POST /webhooks/github-app` (not `/api/...` — matches the App's configured Webhook URL). Signature is verified via `FF_GITHUB_APP_WEBHOOK_SECRET`. Each event handler is idempotent so redeliveries are safe.

| Event | DB writes |
|-------|-----------|
| `installation.created` | Upserts `orgs` (id = GitHub login), `provider_installations`, and a shell row in `repos` for each entry in `payload.repositories`. Upserts the `sender` as a `users` row and links them to the org as `admin` via `user_orgs`. |
| `installation_repositories.added` | Inserts `provider_installation_repos` links and ensures `repos` shell rows exist (re-linking `installation_id` if a repo was previously under a different installation). |
| `installation_repositories.removed` | Soft-deletes the matching `provider_installation_repos` rows (`removed_at = NOW()`). |
| `installation.suspend` | Sets `provider_installations.suspended_at`, cancels in-flight `agent_claims`, parks the outbound queue. Leaves `provider_installation_repos` intact so `unsuspend` can resume without re-syncing. |
| `installation.unsuspend` | Clears `suspended_at`, unparks outbound queue rows created in the last 24 hours. |
| `installation.deleted` | Everything `suspend` does, **plus** soft-deletes every still-active `provider_installation_repos` row for the installation. `repos.installation_id` is left pointing at the (now-deleted) installation as a historical breadcrumb; a future reinstall re-links via `ensureRepo`. |

Known limits:
- When an org installs with `repository_selection: "all"` and has more repos than fit in `installation.created`'s `repositories[]` (cap ~100), only the first page gets shell rows at install time. Later events fill in the rest. There's no initial API-sync backfill yet — see [ROADMAP](../../ROADMAP.md).

## Database

7 migrations in `src/db/migrations/`:

| Migration | Tables |
|-----------|--------|
| 001 | `transitions` — issue workflow state changes |
| 002 | `review_state` — PR review attempts and results |
| 003 | `pauses` — paused issues with reason and agent |
| 004 | `config_cache` — GitHub config fetch cache |
| 005 | `orgs`, `agents`, `agent_tokens` — agent registry and auth |
| 006 | `agent_sessions` — ephemeral runner sessions with TTL |
| 007 | `agent_claims` — per-attempt work assignments |

Migrations run automatically on server startup. See [DESIGN.md](DESIGN.md) for full schema.
