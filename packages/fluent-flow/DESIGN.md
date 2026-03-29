# Fluent Flow — Build Instructions

Read both design docs before building:
- This file (overview + config system)
- The state machine design is embedded below

## What To Build

A config-driven GitHub workflow orchestrator as a Node.js service.

**Repo structure:** `fluent-io/fluent-flow`

## Architecture

### Service API (Node.js + Express + pg)

```
POST /api/webhook/github       — single GitHub webhook endpoint (validates signature, routes by event type)
POST /api/transition           — validate + execute state transition
POST /api/pause                — record a pause, post checklist comment, notify
POST /api/resume               — process resume, determine next state, wake agent
GET  /api/state/:owner/:repo/:issue  — current state + transition history
GET  /api/config/:owner/:repo  — resolved config (defaults merged with repo overrides)
POST /api/review/dispatch      — trigger GitHub Actions reviewer workflow
POST /api/review/result        — receive review results, handle retry/merge/escalate
GET  /api/health               — health check
```

### Config System (Hybrid)

Global defaults in `config/defaults.yml`. Per-repo overrides fetched from client repos at `.github/fluent-flow.yml` via GitHub Contents API, cached with TTL.

```yaml
# config/defaults.yml
reviewer:
  enabled: true
  model: "claude-haiku"
  max_retries: 3
  diff_limit_kb: 65
  severity_tiers: true

states:
  - Backlog
  - Ready
  - In Progress
  - In Review
  - Awaiting Human
  - Done
  - Cancelled

transitions:
  "Backlog -> Ready": {}
  "Ready -> In Progress":
    require: [assignee]
  "Ready -> Backlog": {}
  "In Progress -> In Review":
    require: [linked_pr]
  "In Progress -> Awaiting Human": {}
  "In Progress -> Ready": {}
  "In Review -> Done":
    require: [merged_pr]
  "In Review -> In Progress":
    auto: true
    on: review_rejected
  "In Review -> Awaiting Human": {}
  "Awaiting Human -> In Progress": {}
  "Awaiting Human -> In Review":
    require: [open_pr]
  "* -> Cancelled": {}
  "Cancelled -> Backlog": {}

pause:
  reminder_hours: 24
  reasons:
    - decision
    - ui-review
    - external-action
    - agent-stuck
    - review-escalation

notifications:
  stale_days: 3
  daily_summary: true
  daily_summary_cron: "0 12 * * *"
```

Minimal client repo config (`.github/fluent-flow.yml`):
```yaml
project_id: "PVT_xxx"
default_agent: "getonit"    # references an agent in config/agents.yml
```

Legacy `agent_id` is still supported and normalized to `default_agent` at validation time.

### State Machine

States: Backlog, Ready, In Progress, In Review, Awaiting Human, Done, Cancelled

Valid transitions:
```
Backlog       → Ready, Cancelled
Ready         → In Progress, Backlog, Cancelled
In Progress   → In Review, Awaiting Human, Ready, Cancelled
In Review     → In Progress, Awaiting Human, Done, Cancelled
Awaiting Human→ In Progress, In Review, Cancelled
Done          → (terminal)
Cancelled     → Backlog (reopen)
```

Done requires a merged PR. Manual drag to Done without merged PR → revert + comment.

### Pause/Resume

Pause triggers: `needs-human` label, agent structured comment (`<!-- agent-pause: {...} -->`), review escalation (3x failures)

Resume triggers:
- `/resume` comment → back to previous_state
- `/resume to:review` → to In Review
- `/resume to:progress` → to In Progress
- Remove `needs-human` label → back to previous_state
- Drag card on board → validate transition

On resume, wake the agent via its configured transport (see Agent Notification System below).

### Agent Notification System

Fluent Flow is **agent-agnostic**. It notifies any build agent (OpenClaw, Claude Code, Cursor, Aider, etc.) via pluggable transports.

**Agent Registry** (`config/agents.yml`):
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

**Multi-agent per repo**: Multiple agents can work on the same repo simultaneously. Each PR identifies its originating agent via an HTML comment marker:
```
<!-- fluent-flow-agent: cursor-agent-1 -->
```

**Agent ID resolution order** (per notification):
1. PR body marker: `<!-- fluent-flow-agent: {id} -->`
2. `config.default_agent` (per-repo config)
3. `config.agent_id` (legacy backward compat)
4. `null` → skip notification, log warning

**Standardized wake payload** (all transports receive the same shape):
```json
{
  "agentId": "getonit",
  "event": "review_failed",
  "message": "Review FAILED: owner/repo#7 (attempt 2) — 2 blocking issue(s)",
  "wakeMode": "now",
  "repo": "owner/repo",
  "prNumber": 7,
  "attempt": 2,
  "issues": [{ "file": "...", "line": 10, "issue": "...", "severity": "blocking" }]
}
```

**Transports**:
- `webhook` — HTTP POST to `url`, `Authorization: Bearer {token from token_env}`
- `workflow_dispatch` — GitHub Actions workflow_dispatch via GitHub API

### GitHub Projects v2 Integration

Use GitHub GraphQL API for all Projects v2 operations:
- Move items between columns (update Status field)
- Query project items and their status
- Need: project ID, Status field ID, and option IDs for each state

The service must query these IDs on first use and cache them. Use the `project_id` from repo config.

### Review Pipeline (migrated from existing n8n workflows)

On PR opened:
1. Fetch repo config
2. If reviewer.enabled, dispatch GitHub Actions workflow (`workflow_dispatch`)
3. Track retry count in `review_retries` table

On review result:
1. Parse machine-readable comment: `<!-- reviewer-result: {status, blocking[], advisory[], attempt} -->`
2. If PASS: enable auto-merge via GraphQL (`enablePullRequestAutoMerge`, squash)
3. If FAIL: increment retry, notify originating agent via configured transport
4. If FAIL and attempt >= max_retries: add `needs-human` label → triggers pause

### Postgres Schema

```sql
CREATE TABLE state_transitions (
    id SERIAL PRIMARY KEY,
    repo TEXT NOT NULL,
    issue_number INT NOT NULL,
    from_state TEXT,
    to_state TEXT NOT NULL,
    trigger_type TEXT NOT NULL,
    trigger_detail TEXT,
    actor TEXT,
    metadata JSONB,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE project_items (
    id SERIAL PRIMARY KEY,
    project_id TEXT NOT NULL,
    item_node_id TEXT NOT NULL,
    repo TEXT NOT NULL,
    issue_number INT,
    pr_number INT,
    current_state TEXT NOT NULL DEFAULT 'Backlog',
    assignee TEXT,
    last_activity TIMESTAMPTZ DEFAULT NOW(),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(project_id, item_node_id)
);

CREATE TABLE pauses (
    id SERIAL PRIMARY KEY,
    repo TEXT NOT NULL,
    issue_number INT NOT NULL,
    pr_number INT,
    previous_state TEXT NOT NULL,
    reason TEXT NOT NULL,
    context TEXT,
    checklist JSONB,
    resume_target TEXT,
    agent_id TEXT,
    paused_at TIMESTAMPTZ DEFAULT NOW(),
    resumed_at TIMESTAMPTZ,
    resumed_by TEXT,
    resume_instructions TEXT,
    resume_to_state TEXT
);

CREATE TABLE review_retries (
    id SERIAL PRIMARY KEY,
    repo TEXT NOT NULL,
    pr_number INT NOT NULL,
    retry_count INT DEFAULT 0,
    last_issues JSONB,
    last_review_sha TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(repo, pr_number)
);

CREATE TABLE config_cache (
    id SERIAL PRIMARY KEY,
    repo TEXT NOT NULL UNIQUE,
    config JSONB NOT NULL,
    fetched_at TIMESTAMPTZ DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL
);
```

### Docker

```yaml
services:
  fluent-flow:
    build: .
    container_name: fluent-flow
    ports:
      - "3847:3847"
    environment:
      DATABASE_URL: ${DATABASE_URL:-postgres://fluentflow:password@postgres:5432/fluentflow}
      GITHUB_TOKEN: ${GITHUB_TOKEN}
      GITHUB_WEBHOOK_SECRET: ${GITHUB_WEBHOOK_SECRET}
      PORT: 3847
      CONFIG_CACHE_TTL_MS: 300000
      OPENCLAW_WEBHOOK_TOKEN: ${OPENCLAW_WEBHOOK_TOKEN:-}
    volumes:
      - ./config:/app/config:ro  # agent registry mounted read-only
    networks:
      - fluent-flow-net
    restart: unless-stopped

  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: fluentflow
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:-password}
      POSTGRES_DB: fluentflow
    volumes:
      - pgdata:/var/lib/postgresql/data
    networks:
      - fluent-flow-net
    restart: unless-stopped

volumes:
  pgdata:

networks:
  fluent-flow-net:
    driver: bridge
```

The `config/` directory is mounted read-only so `agents.yml` can be updated without rebuilding the image. Agent transport tokens are passed as environment variables (referenced by `token_env` in `agents.yml`).

### Reusable GitHub Action

Create `.github/workflows/pr-review.yml` as a reusable workflow (callable via `workflow_call`). It should:
1. Accept inputs: pr_number, attempt, prior_issues
2. Fetch the PR diff (raw, not description — prevents prompt injection)
3. Call Claude API (Anthropic) with the diff + reviewer prompt
4. Post review as `github-actions[bot]`
5. Include machine-readable HTML comment with result
6. Use severity tiers: BLOCKING → REQUEST_CHANGES, ADVISORY → APPROVE with notes

### Project Structure

```
fluent-flow/
├── src/
│   ├── index.js              # Express app entry
│   ├── config/
│   │   ├── loader.js         # Config resolver (defaults + repo overrides)
│   │   ├── schema.js         # Config validation (zod)
│   │   ├── agents.js         # Agent registry loader
│   │   └── env.js            # Startup env var validation
│   ├── db/
│   │   ├── client.js         # pg pool
│   │   └── migrations/
│   │       └── 001_initial.sql
│   ├── routes/
│   │   ├── webhook.js        # POST /api/webhook/github
│   │   ├── transition.js     # POST /api/transition
│   │   ├── pause.js          # POST /api/pause, POST /api/resume
│   │   ├── state.js          # GET /api/state/:owner/:repo/:issue
│   │   ├── review.js         # POST /api/review/dispatch, POST /api/review/result
│   │   ├── config.js         # GET /api/config/:owner/:repo
│   │   └── health.js         # GET /api/health
│   ├── engine/
│   │   ├── state-machine.js  # Transition validation + execution
│   │   ├── pause-manager.js  # Pause/resume logic
│   │   └── review-manager.js # Review dispatch + result handling
│   ├── github/
│   │   ├── graphql.js        # GitHub GraphQL client (Projects v2)
│   │   ├── rest.js           # GitHub REST client
│   │   └── webhook-verify.js # Webhook signature verification
│   └── notifications/
│       ├── dispatcher.js     # Agent-agnostic notification dispatcher
│       └── transports/
│           ├── index.js      # Transport registry
│           ├── webhook.js    # HTTP POST transport
│           └── workflow.js   # GitHub Actions workflow_dispatch transport
├── config/
│   ├── defaults.yml          # Global default config
│   └── agents.yml            # Agent wake transport registry
├── prompts/
│   └── review.md             # PR reviewer prompt (externalised)
├── .github/
│   └── workflows/
│       └── pr-review.yml     # Reusable reviewer workflow
├── docker-compose.yml
├── Dockerfile
├── package.json
├── .env.example
└── README.md
```

## Important Notes

- Use ESM (import/export), not CommonJS
- Use `pg` (node-postgres) directly, no ORM
- Use `express` for HTTP
- Use `js-yaml` for YAML config parsing
- Use `zod` for config validation
- Webhook signature verification with `crypto.timingSafeEqual`
- Structured logging (console.log with JSON objects is fine for now)
- Graceful shutdown (SIGTERM handler, close pg pool)
- Health check endpoint that verifies DB connection
- All environment variables documented in .env.example
