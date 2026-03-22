# Fluent Flow

Config-driven GitHub workflow orchestrator. Manages the full lifecycle of code changes: PR review, project board automation, state machine enforcement, human-in-the-loop pauses, and agent coordination.

**Deploy once. Serve any number of repos.**

## How It Works

```
GitHub Webhook → Fluent Flow API → State Machine → GitHub Projects v2
                                  → Review Pipeline → Auto-merge / Escalate
                                  → Pause/Resume → Agent Wake (any agent)
```

### State Machine

Items flow through states with enforced transitions:

```
Backlog → Ready → In Progress ⇄ In Review
                      ↕              ↕
                  Awaiting Human ─────┘
                       │
              (Done only via merged PR)
```

Cycles are expected — items bounce between In Progress, In Review, and Awaiting Human as needed.

### Human-in-the-Loop

When work needs human attention (UI review, architecture decision, API setup), items enter **Awaiting Human**:

- Triggered by `needs-human` label, agent comments, or review escalation (3x failures)
- Fluent Flow posts a checklist comment and notifies the agent
- Resume with `/resume`, `/resume to:review`, or remove the label
- On resume, the originating agent is woken via its configured transport

## Quick Start

### 1. Deploy

Fluent Flow runs as a Docker service with its own PostgreSQL database.

```bash
git clone https://github.com/fluent-io/fluent-flow.git
cd fluent-flow
cp .env.example .env
# Edit .env — set GITHUB_TOKEN and GITHUB_WEBHOOK_SECRET

docker compose up -d
```

This starts Fluent Flow on port 3847 with a Postgres container for state persistence.

### 2. Register Agents

Define your build agents in `config/agents.yml`:

```yaml
agents:
  getonit:
    transport: webhook
    url: http://openclaw:18789/hooks/agent
    token_env: OPENCLAW_WEBHOOK_TOKEN

  claude-local:
    transport: webhook
    url: http://localhost:8080/wake
    token_env: CLAUDE_LOCAL_TOKEN

  claude-actions:
    transport: workflow_dispatch
    workflow: agent-wake.yml
    ref: main
```

### 3. Onboard a Repo

Drop `.github/fluent-flow.yml` in your repo:

```yaml
project_id: "PVT_your_project_id"
default_agent: "getonit"
```

That's it. Everything else uses [default config](config/defaults.yml).

### 4. Set Up Webhook

Add an org-level webhook pointing to your Fluent Flow instance:

- **URL:** `https://your-domain/api/webhook/github`
- **Content type:** `application/json`
- **Secret:** Must match `GITHUB_WEBHOOK_SECRET`
- **Events:** `pull_request`, `pull_request_review`, `issues`, `issue_comment`, `projects_v2_item`, `push`

### 5. Add Reusable Review Workflow

In your client repo, create `.github/workflows/pr-review.yml`:

```yaml
name: PR Review
on:
  workflow_dispatch:
    inputs:
      pr_number:
        required: true
        type: number
      attempt:
        required: false
        type: number
        default: 1
      prior_issues:
        required: false
        type: string
        default: "[]"

jobs:
  review:
    uses: fluent-io/fluent-flow/.github/workflows/pr-review.yml@main
    with:
      pr_number: ${{ inputs.pr_number }}
      attempt: ${{ inputs.attempt }}
      prior_issues: ${{ inputs.prior_issues }}
    secrets:
      ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
      FLUENT_FLOW_URL: ${{ secrets.FLUENT_FLOW_URL }}
```

## MCP Server

Fluent Flow exposes an MCP endpoint for AI agents (Claude Code, Cursor, etc.) at `POST /mcp`.

### Connect from Claude Code

```bash
claude mcp add --transport http fluent-flow https://flow.getonit.io/mcp \
  --header "Authorization: Bearer $FLUENT_FLOW_MCP_TOKEN"
```

### Available tools

| Tool | Type | Description |
|------|------|-------------|
| `get_pending_actions` | Query | Poll for unresolved work items (review failures, pauses, resumes) |
| `get_current_state` | Query | Get workflow state of an issue |
| `get_transition_history` | Query | Full state transition history |
| `get_retry_record` | Query | Review retry record for a PR |
| `get_active_pause` | Query | Active pause for an issue |
| `get_config` | Query | Resolved config for a repo |
| `execute_transition` | Command | Execute a state transition |
| `dispatch_review` | Command | Trigger automated code review |
| `record_pause` | Command | Pause an issue (needs human attention) |
| `process_resume` | Command | Resume a paused issue |

All tools require an `agent_id` parameter. Set `MCP_AUTH_TOKEN` to secure the endpoint.

## API Reference

| Endpoint | Method | Description |
|---|---|---|
| `/mcp` | POST | MCP server (AI agent interface) |
| `/api/webhook/github` | POST | GitHub webhook receiver |
| `/api/transition` | POST | Execute a state transition |
| `/api/pause` | POST | Record a pause |
| `/api/resume` | POST | Resume from a pause |
| `/api/state/:owner/:repo/:issue` | GET | Get current state + history |
| `/api/config/:owner/:repo` | GET | Get resolved config |
| `/api/config/:owner/:repo/cache` | DELETE | Invalidate config cache |
| `/api/review/dispatch` | POST | Trigger a review |
| `/api/review/result` | POST | Submit review results |
| `/api/review/retries/:owner/:repo/:pr` | GET | Get retry record |
| `/api/health` | GET | Health check |

## Config

### Global Defaults (`config/defaults.yml`)

Defines default states, transitions, reviewer settings, pause rules, and notification preferences.

### Agent Registry (`config/agents.yml`)

Maps agent IDs to their wake transport. Loaded at startup.

```yaml
agents:
  getonit:
    transport: webhook              # HTTP POST
    url: http://openclaw:18789/hooks/agent
    token_env: OPENCLAW_WEBHOOK_TOKEN
  claude-actions:
    transport: workflow_dispatch    # GitHub Actions
    workflow: agent-wake.yml
    ref: main
```

### Per-Repo Override (`.github/fluent-flow.yml`)

Repos override only what they need:

```yaml
project_id: "PVT_xxx"           # Required: GitHub Project v2 ID
default_agent: "getonit"         # Required: default agent for this repo

# Optional overrides
reviewer:
  enabled: false                 # Disable auto-review
  max_retries: 5                 # Custom retry limit
```

Config is fetched from GitHub on first event, cached with TTL (default 5 min), and invalidated on push to `.github/fluent-flow.yml`.

### Multi-Agent Support

Multiple agents can work on the same repo simultaneously. Each PR identifies its originating agent via an HTML comment marker in the PR body:

```
<!-- fluent-flow-agent: cursor-agent-1 -->
```

When a review fails or a PR is merged, Fluent Flow notifies the **specific agent that created that PR**, not just the repo's default agent.

**Resolution order:** PR body marker → `default_agent` (repo config) → `agent_id` (legacy) → skip.

## Transition Rules

| From | To | Requirement |
|---|---|---|
| Ready | In Progress | Must have assignee |
| In Progress | In Review | Must have linked PR |
| * | Done | Must have merged PR |
| Awaiting Human | In Review | Must have open PR |
| * | Cancelled | Always allowed |

Invalid transitions are **reverted** with a comment explaining why.

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `DATABASE_URL` | Yes | PostgreSQL connection string |
| `GITHUB_TOKEN` | Yes | GitHub PAT (scopes: `repo`, `read:org`, `project`) |
| `GITHUB_WEBHOOK_SECRET` | Yes | Webhook signature secret |
| `MCP_AUTH_TOKEN` | No | Bearer token for MCP endpoint auth |
| `OPENCLAW_WEBHOOK_TOKEN` | No | Agent transport token (referenced in agents.yml) |
| `PORT` | No | HTTP port (default: 3847) |
| `CONFIG_CACHE_TTL_MS` | No | Config cache TTL in ms (default: 300000) |

Agent-specific tokens (referenced via `token_env` in `config/agents.yml`) should also be set.

## Architecture

| Directory | Purpose | Docs |
|-----------|---------|------|
| [config/](config/README.md) | Global defaults, agent registry, per-repo config | [config/README.md](config/README.md) |
| [src/engine/](src/engine/README.md) | State machine, review pipeline, pause/resume | [src/engine/README.md](src/engine/README.md) |
| [src/mcp/](src/mcp/README.md) | MCP server for AI agent integration | [src/mcp/README.md](src/mcp/README.md) |
| [src/notifications/](src/notifications/README.md) | Agent-agnostic notification dispatcher + transports | [src/notifications/README.md](src/notifications/README.md) |
| src/github/ | GitHub REST + GraphQL API clients, webhook verification | |
| src/routes/ | Express route handlers (webhook, transition, pause, state, review, config, health) | |
| src/db/ | PostgreSQL pool, migrations, audit logging | |

## License

[MIT](LICENSE)
