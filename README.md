# Fluent Flow

Config-driven GitHub workflow orchestrator. Manages the full lifecycle of code changes: PR review, project board automation, state machine enforcement, human-in-the-loop pauses, and agent coordination.

**Deploy once. Serve any number of repos.**

## How It Works

```
GitHub Webhook → Fluent Flow API → State Machine → GitHub Projects v2
                                  → Review Pipeline → Auto-merge / Escalate
                                  → Pause/Resume → Agent Wake via OpenClaw
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
- Fluent Flow posts a checklist comment and notifies via WhatsApp
- Resume with `/resume`, `/resume to:review`, or remove the label
- On resume, the agent is woken via OpenClaw webhook with context

## Quick Start

### 1. Deploy

```bash
# Clone and configure
git clone https://github.com/fluent-io/fluent-flow.git
cd fluent-flow
cp .env.example .env
# Edit .env with your tokens

# Start (connects to existing Postgres + openclaw-net)
docker compose up -d
```

### 2. Onboard a Repo

Drop `.github/fluent-flow.yml` in your repo:

```yaml
project_id: "PVT_your_project_id"
agent_id: "your-openclaw-agent"
```

That's it. Everything else uses [default config](config/defaults.yml).

### 3. Set Up Webhook

Add an org-level webhook pointing to your Fluent Flow instance:

- **URL:** `https://your-domain/api/webhook/github`
- **Content type:** `application/json`
- **Secret:** Must match `GITHUB_WEBHOOK_SECRET`
- **Events:** `pull_request`, `pull_request_review`, `issues`, `issue_comment`, `projects_v2_item`, `push`

### 4. Add Reusable Review Workflow

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

## API Reference

| Endpoint | Method | Description |
|---|---|---|
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

### Per-Repo Override (`.github/fluent-flow.yml`)

Repos override only what they need:

```yaml
project_id: "PVT_xxx"           # Required: GitHub Project v2 ID
agent_id: "getonit"              # Required: OpenClaw agent ID

# Optional overrides
reviewer:
  enabled: false                 # Disable auto-review
  max_retries: 5                 # Custom retry limit
states:
  - Backlog
  - In Progress
  - Done                         # Simpler pipeline
notifications:
  stale_days: 7                  # More lenient
```

Config is fetched from GitHub on first event, cached with TTL (default 5 min), and invalidated on push to `.github/fluent-flow.yml`.

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
| `OPENCLAW_WEBHOOK_URL` | No | OpenClaw agent webhook URL |
| `PORT` | No | HTTP port (default: 3847) |
| `CONFIG_CACHE_TTL_MS` | No | Config cache TTL in ms (default: 300000) |

## Architecture

```
src/
├── index.js              # Express app entry
├── config/
│   ├── loader.js         # Config resolver (defaults + repo overrides)
│   └── schema.js         # Zod validation schemas
├── db/
│   ├── client.js         # pg pool + migrations
│   └── migrations/
│       └── 001_initial.sql
├── engine/
│   ├── state-machine.js  # Transition validation + execution
│   ├── pause-manager.js  # Pause/resume logic
│   └── review-manager.js # Review dispatch + result handling
├── github/
│   ├── graphql.js        # GitHub Projects v2 GraphQL client
│   ├── rest.js           # GitHub REST API client
│   └── webhook-verify.js # Webhook signature verification
├── notifications/
│   └── openclaw.js       # OpenClaw webhook client
└── routes/
    ├── webhook.js        # POST /api/webhook/github
    ├── transition.js     # POST /api/transition
    ├── pause.js          # POST /api/pause + /api/resume
    ├── state.js          # GET /api/state
    ├── review.js         # Review dispatch + result routes
    ├── config.js         # GET /api/config
    └── health.js         # GET /api/health
```

## License

Private — Fluent IO
