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
| `GITHUB_TOKEN` | Yes | GitHub personal access token (PAT) |
| `GITHUB_WEBHOOK_SECRET` | No | Webhook signature verification secret |
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
