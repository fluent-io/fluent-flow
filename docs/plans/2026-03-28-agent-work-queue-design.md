# Agent Work Queue — Design Spec

**Date:** 2026-03-28
**Status:** Draft

## Problem

When Fluent Flow's reviewer finds issues in a PR, the review feedback must reach an agent that can fix it. Today, notifications are fire-and-forget (webhook POST or workflow_dispatch) with no tracking, no claim management, and no support for multi-agent pools. Agents that run on developer machines (Claude Code, Codex, Aider) have no deterministic trigger — they'd need to poll, which is unreliable for non-deterministic LLM agents.

## Goals

1. **Deterministic agent triggering** — agents receive work via push, never rely on proactive polling
2. **Per-attempt claim system** — exactly one agent session works on each review attempt, with lease timeout and revocation to prevent duplicate work
3. **Multi-agent pools** — multiple agent instances can serve the same repo; work is distributed across available sessions
4. **Agent-agnostic** — works with Claude Code, Codex, Devin, Aider, OpenClaw, GitHub Copilot, or any future agent
5. **Tenant owns AI costs** — Fluent Flow orchestrates; tenants configure and pay for their own models and compute
6. **Multi-tenant aware** — `org_id` on all tables from day one; self-hosted runs as a single implicit org
7. **Low-friction onboarding** — `npx fluent-flow-runner` is the only thing customers install locally

## Non-Goals

- Admin dashboard UI (future, will consume the same API)
- Billing / usage metering
- Agent-to-agent communication
- Real-time status streaming to dashboards

---

## Architecture Overview

```
GitHub webhook (PR review fails)
        │
        ▼
┌─────────────────────────┐
│   Fluent Flow Server    │
│                         │
│  ┌───────────────────┐  │
│  │  Review Manager   │  │  ── review fails → create claim
│  └────────┬──────────┘  │
│           ▼             │
│  ┌───────────────────┐  │
│  │  Claim Manager    │  │  ── resolve agent → pick session → set claimed
│  └────────┬──────────┘  │
│           ▼             │
│  ┌───────────────────┐  │
│  │  Dispatcher       │  │  ── push via transport
│  └────────┬──────────┘  │
│           │             │
│  ┌────────┴──────────┐  │
│  │  Transport Layer  │  │
│  │  ┌─────────────┐  │  │
│  │  │ webhook     │──┼──┼──→ OpenClaw, custom agents
│  │  │ workflow    │──┼──┼──→ GitHub Actions agents
│  │  │ long-poll   │──┼──┼──→ fluent-flow-runner (Claude Code, Codex, Aider)
│  │  │ api         │──┼──┼──→ Devin, OpenAI Agents API
│  │  └─────────────┘  │  │
│  └───────────────────┘  │
└─────────────────────────┘
```

---

## Data Model

All tables include `org_id` for multi-tenant scoping. Self-hosted deployments auto-create a default org.

### `orgs`

```sql
CREATE TABLE orgs (
  id            TEXT PRIMARY KEY,              -- "fluent-io", "acme-corp"
  name          TEXT NOT NULL,
  settings      JSONB DEFAULT '{}',            -- org-level defaults
  created_at    TIMESTAMPTZ DEFAULT now()
);
```

### `agents` — Admin-managed agent identities

```sql
CREATE TABLE agents (
  id            TEXT NOT NULL,                 -- "openclaw-prod", "claude-team"
  org_id        TEXT NOT NULL REFERENCES orgs(id),
  agent_type    TEXT NOT NULL,                 -- "claude-code", "codex", "devin", "openclaw", "aider", "custom"
  transport     TEXT NOT NULL,                 -- "webhook", "workflow_dispatch", "long_poll", "api"
  transport_meta JSONB DEFAULT '{}',           -- transport-specific config
  repos         TEXT[] DEFAULT '{}',           -- allowed repos (empty = all org repos)
  created_at    TIMESTAMPTZ DEFAULT now(),
  updated_at    TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (org_id, id)
);
```

**`transport_meta` by transport type:**

| Transport | `transport_meta` fields |
|---|---|
| `webhook` | `{ "url": "https://...", "token_env": "OPENCLAW_TOKEN" }` |
| `workflow_dispatch` | `{ "workflow": "agent-run.yml", "ref": "main" }` |
| `long_poll` | `{ "command": "custom-cmd -p \"{prompt}\"", "timeout_s": 300 }` — `command` is optional, defaults derived from `agent_type` |
| `api` | `{ "url": "https://api.devin.ai/v1/sessions", "auth_env": "DEVIN_TOKEN", "body_template": {...} }` |

### `agent_tokens` — Authentication for runners and API access

```sql
CREATE TABLE agent_tokens (
  id            SERIAL PRIMARY KEY,
  org_id        TEXT NOT NULL REFERENCES orgs(id),
  agent_id      TEXT NOT NULL,
  token_hash    TEXT NOT NULL,                 -- bcrypt/argon2 hash, never store plaintext
  label         TEXT,                          -- "victor-laptop", "ci-runner-3"
  created_at    TIMESTAMPTZ DEFAULT now(),
  expires_at    TIMESTAMPTZ,                   -- null = no expiry
  revoked_at    TIMESTAMPTZ,                   -- soft revoke
  FOREIGN KEY (org_id, agent_id) REFERENCES agents(org_id, id)
);
```

### `agent_sessions` — Ephemeral live instances

```sql
CREATE TABLE agent_sessions (
  id            SERIAL PRIMARY KEY,
  org_id        TEXT NOT NULL REFERENCES orgs(id),
  agent_id      TEXT NOT NULL,
  session_meta  JSONB DEFAULT '{}',            -- { hostname, cwd, os, capabilities }
  status        TEXT DEFAULT 'online',         -- online, busy, offline
  registered_at TIMESTAMPTZ DEFAULT now(),
  last_seen_at  TIMESTAMPTZ DEFAULT now(),
  expires_at    TIMESTAMPTZ NOT NULL,          -- lease TTL
  FOREIGN KEY (org_id, agent_id) REFERENCES agents(org_id, id)
);
```

### `agent_claims` — Per-attempt work assignments

```sql
CREATE TABLE agent_claims (
  id            SERIAL PRIMARY KEY,
  org_id        TEXT NOT NULL REFERENCES orgs(id),
  repo          TEXT NOT NULL,
  pr_number     INT NOT NULL,
  attempt       INT NOT NULL,                  -- review attempt number
  session_id    INT REFERENCES agent_sessions(id),
  claim_type    TEXT DEFAULT 'review_fix',     -- "review_fix" (fix review issues) | "issue_work" (work on issue spec)
  status        TEXT DEFAULT 'pending',        -- pending, claimed, completed, failed, expired, revoked
  payload       JSONB DEFAULT '{}',            -- full context sent to agent
  claimed_at    TIMESTAMPTZ,
  completed_at  TIMESTAMPTZ,
  expires_at    TIMESTAMPTZ,                   -- claim lease TTL
  created_at    TIMESTAMPTZ DEFAULT now(),
  UNIQUE(org_id, repo, pr_number, attempt)
);
```

---

## Core Flows

### Flow 1: Review Fails → Agent Receives Work

```
1. PR review completes with status FAIL
2. Review Manager calls Claim Manager:
   a. INSERT into agent_claims (status: pending)
   b. Resolve agent: PR body marker → repo default_agent → org default
   c. Pick session:
      - Prefer session that worked previous attempt for this PR
      - Else: first online session for this agent (ORDER BY last_seen_at DESC)
      - Else: no session (fire transport anyway for webhook/workflow/api agents)
   d. If session found: UPDATE claim SET status='claimed', session_id, expires_at
3. Dispatcher pushes payload via agent's transport
4. Agent receives work and begins fixing
```

### Flow 2: Claim Timeout → Work Re-queued

```
1. Background sweep (or on next webhook): find claims WHERE status='claimed' AND expires_at < now()
2. For each expired claim:
   a. UPDATE claim SET status='expired'
   b. UPDATE session SET status='offline' (liveness check failed)
   c. Liveness check: ping session (if transport supports it)
      - If alive: restore session to 'online', re-assign claim
      - If dead: invalidate session
   d. Re-enter dispatch flow: find next available session, create new claim attempt
      (same review attempt number, new claim — the agent_claims UNIQUE constraint
       is on (org_id, repo, pr_number, attempt), so we UPDATE rather than INSERT)
```

### Flow 3: Agent Pushes Fix → Claim Completed

```
1. Agent pushes commits to PR branch
2. CI runs → check_run.completed webhook
3. Existing claimDispatch() gates review dispatch (dedup — prevents duplicate dispatch for same SHA)
4. New review dispatched → reviewer runs
5. If PASS: UPDATE claim SET status='completed', completed_at=now()
6. If FAIL: New attempt → Flow 1 with attempt+1
```

**Relationship between `claimDispatch` and `agent_claims`:**
- `claimDispatch` (existing) prevents duplicate review *dispatches* for the same SHA — it guards the review trigger
- `agent_claims` (new) tracks who is *working on the fix* — it guards the work assignment
- They are complementary: `claimDispatch` fires first (on `check_run.completed`), then `agent_claims` manages the response to the review result

**Claim completion for non-runner agents (webhook, workflow_dispatch, api):**
These transports have no backchannel for the agent to report "I'm done." Claim completion for these agents happens implicitly: when the agent pushes a fix, CI runs, and the next review result arrives. If the review passes → claim completed. If it fails → new attempt. The claim's `expires_at` is the timeout safety net if the agent never pushes.

### Flow 4: Multi-Agent Pool Distribution

```
Repo config: default_agent = "codex-pool"
Agent "codex-pool" has 3 sessions (VM-1, VM-2, VM-3)

Review fails on PR #7 (attempt 1):
  → Claim created, session VM-2 picked (least recently used or first available)
  → VM-2 receives work, starts fixing

Review fails on PR #12 (attempt 1), while VM-2 is busy:
  → Claim created, session VM-1 picked (VM-2 status=busy)
  → VM-1 receives work

VM-3 goes offline (session expires):
  → Only VM-1 and VM-2 in pool
  → New work distributed between them
```

---

## Session Resolution Algorithm

When assigning a claim to a session:

```
resolveSession(orgId, agentId, repo, prNumber):
  1. Previous session affinity:
     SELECT session_id FROM agent_claims
     WHERE org_id = $orgId AND repo = $repo AND pr_number = $prNumber
       AND status IN ('completed', 'expired')
     ORDER BY attempt DESC LIMIT 1
     → if that session is still 'online', use it

  2. First available:
     SELECT id FROM agent_sessions
     WHERE org_id = $orgId AND agent_id = $agentId
       AND status = 'online' AND expires_at > now()
     ORDER BY last_seen_at DESC LIMIT 1

  3. No session available:
     → return null (dispatcher falls back to transport-level fire-and-forget)
```

---

## Transport Layer

### Existing transports (modified)

**`webhook`** — unchanged. HTTP POST with payload. Used by agents with their own HTTP endpoints (OpenClaw, custom).

**`workflow_dispatch`** — unchanged. Triggers GitHub Actions workflow. Used by CI-hosted agents.

### New transports

**`long_poll`** — for `fluent-flow-runner` instances.

The runner connects to Fluent Flow via outbound HTTPS long-poll. Fluent Flow holds the connection until work is available (or timeout at ~30s, then reconnect). When work arrives:

1. Fluent Flow responds with the claim payload
2. Runner executes the configured agent command locally
3. Runner reports claim result back to Fluent Flow

Server-side implementation: a `/api/runner/poll` endpoint that blocks until a claimed payload is ready for the requesting session, or times out.

```
Runner                          Fluent Flow
  │                                  │
  │── POST /api/runner/poll ────────→│  (blocks, waiting for work)
  │                                  │
  │      ... review fails ...        │
  │                                  │
  │←── 200 { claim_id, payload } ───│
  │                                  │
  │  (executes: claude -p "...")     │
  │                                  │
  │── POST /api/runner/claim/:id ──→│  { status: "completed" | "failed" }
  │                                  │
  │── POST /api/runner/poll ────────→│  (reconnect, wait for next)
```

**`api`** — for cloud-hosted agents with REST APIs.

```
Fluent Flow                     Agent API
  │                                  │
  │── POST {url} ──────────────────→│  body from body_template + payload
  │←── 200 { session_id, ... } ────│
  │                                  │
  │  (claim tracked server-side)     │
```

### Transport registry

```javascript
// transports/index.js
const registry = new Map([
  ['webhook',           webhook],
  ['workflow_dispatch',  workflow],
  ['long_poll',         longPoll],
  ['api',              api],
]);
```

---

## `fluent-flow-runner` — Standalone npm Package

### What it is

A lightweight CLI that connects a local machine to Fluent Flow as an agent runner. It long-polls for work, executes agent commands locally, and reports results. One command to start:

```bash
npx fluent-flow-runner --token <token> --server https://flow.example.com
```

### What it does

1. **Authenticates** with the token (validates against `agent_tokens` table, resolves org + agent)
2. **Registers a session** (inserts into `agent_sessions` with TTL)
3. **Long-polls** `POST /api/runner/poll` with session ID
4. **Receives claim payload** when work is assigned
5. **Executes agent command** — determined by agent_type from registry (see Agent Permission Bypass table below):
   - `claude-code`: `claude -p "{prompt}" --allowedTools "Read,Edit,Bash,Write,Glob,Grep" --output-format json`
   - `codex`: `codex --quiet --approval-mode full-auto -p "{prompt}"`
   - `aider`: `aider --yes --message "{prompt}"`
   - `custom`: uses `command` from `transport_meta`
6. **Reports result** back to Fluent Flow (`POST /api/runner/claim/:id`)
7. **Reconnects** and waits for next work item
8. **Graceful shutdown** on SIGTERM — deregisters session, marks any active claim as `failed`

### Agent Permission Bypass

Most AI coding agents default to interactive mode with human-in-the-loop confirmations. When running autonomously via the runner, these must be bypassed. **The runner handles this, not the agent** — the agent is invoked with the right flags and never needs to "remember" to be autonomous.

| Agent Type | Default Behavior | Autonomous Flag | What It Enables |
|---|---|---|---|
| `claude-code` | Prompts for tool approval | `--allowedTools "Read,Edit,Bash,Write,Glob,Grep"` | Whitelist specific tools for auto-approval |
| `codex` | Prompts for file writes + shell | `--approval-mode full-auto` | Blanket auto-approve all actions |
| `aider` | Prompts before applying changes | `--yes` | Auto-confirm all file changes |
| `devin` | Cloud-hosted, fully autonomous | N/A | No local permissions needed |
| `openclaw` | Autonomous by design | N/A | No restrictions |

**Important considerations:**
- `claude-code` uses a whitelist (`--allowedTools`) rather than blanket approval — this is safer. The runner should include all tools needed for code fixes but exclude destructive operations. The default set (`Read,Edit,Bash,Write,Glob,Grep`) covers reading, editing, running tests, and searching.
- `transport_meta.command` can override the default for any agent type — if a team wants to restrict or expand the tool whitelist, they configure it per-agent in the admin API.
- The runner should log the exact command it executes for audit/debugging purposes.

### What it does NOT do

- No AI logic — it's a dumb pipe
- No API keys — the agent's environment provides those
- No inbound networking — outbound HTTPS only
- No config files — token + server URL is everything

### CLI options

```
fluent-flow-runner
  --token <token>          Agent token (required)
  --server <url>           Fluent Flow server URL (required)
  --command <cmd>          Override agent command template
  --concurrency <n>        Max parallel claims (default: 1)
  --cwd <path>             Working directory for agent commands
  --verbose                Debug logging
```

### Cluster deployment

Same token, multiple instances. Each registers its own session:

```bash
# 3 runners on separate machines, same agent pool
fluent-flow-runner --token $TOKEN --server https://flow.example.com  # VM-1
fluent-flow-runner --token $TOKEN --server https://flow.example.com  # VM-2
fluent-flow-runner --token $TOKEN --server https://flow.example.com  # VM-3
```

Docker:
```yaml
services:
  review-runner:
    image: ghcr.io/fluent-io/fluent-flow-runner
    environment:
      FLUENT_FLOW_TOKEN: ${TOKEN}
      FLUENT_FLOW_SERVER: https://flow.example.com
      ANTHROPIC_API_KEY: ${ANTHROPIC_API_KEY}    # tenant's own key
    deploy:
      replicas: 5
```

---

## Agent Management API

REST endpoints consumed by the future admin dashboard. Same operations exposed as MCP tools.

### REST Endpoints

```
# Agents (admin CRUD)
POST   /api/agents                    Create agent
GET    /api/agents                    List agents (org-scoped)
GET    /api/agents/:id                Get agent
PATCH  /api/agents/:id                Update agent
DELETE /api/agents/:id                Delete agent

# Tokens
POST   /api/agents/:id/tokens         Create token for agent
GET    /api/agents/:id/tokens          List tokens (hashes redacted)
DELETE /api/agents/:id/tokens/:tokenId Revoke token

# Sessions (read-only, managed by runners)
GET    /api/agents/:id/sessions        List active sessions

# Claims (read-only, managed by claim system)
GET    /api/claims                     List claims (filterable by repo, status, agent)
GET    /api/claims/:id                 Get claim details

# Runner endpoints (used by fluent-flow-runner)
POST   /api/runner/register            Register session (auth via token)
POST   /api/runner/poll                Long-poll for work (auth via token)
POST   /api/runner/claim/:id           Report claim result
```

### MCP Tools (additions)

```
# Admin tools
create_agent        { id, agent_type, transport, transport_meta, repos }
update_agent        { id, ...fields }
delete_agent        { id }
list_agents         {}

# Existing tool (modified)
get_pending_actions { agent_id }   — now returns claims assigned to caller's session (recovery path)
```

---

## Multi-Tenancy

### Scoping

Every query includes `org_id`. The org is resolved from:
- **REST API**: auth token → org
- **MCP**: session token → agent → org
- **Runner**: agent token → org
- **Webhooks**: repo → org mapping (from GitHub App installation)

### Self-Hosted Mode

On first boot with `SELF_HOSTED=true`:
1. Auto-create a default org (id: `self-hosted`, name from env or hostname)
2. All operations scoped to this org
3. Admin API still works — dashboard connects to localhost
4. No org selection UI needed

### SaaS Mode

- Orgs created via onboarding flow (future)
- GitHub App installation maps to org
- Tokens scoped to org
- Full tenant isolation on all queries

---

## Migration from `agents.yml`

`config/agents.yml` is deprecated. Existing deployments migrate by:

1. Running a one-time migration script that reads `agents.yml` and inserts into `agents` table
2. Generating tokens for each agent
3. Updating runner/webhook configs with new tokens
4. Deleting `agents.yml`

The `loadAgents()` function in `src/config/agents.js` will check DB first, fall back to YAML during transition, and log a deprecation warning.

---

## Claim Timeout and Liveness

### Timeout values (configurable per-agent)

| Setting | Default | Description |
|---|---|---|
| `session_ttl` | 5 minutes | Session expires if no poll/activity |
| `claim_ttl` | 15 minutes | Claim expires if agent hasn't completed |
| `liveness_grace` | 30 seconds | Grace period after timeout before revocation |

### Liveness check on timeout

When a claim's `expires_at` passes:

1. Mark claim as `expired`
2. Check session: is `last_seen_at` recent (within `liveness_grace`)?
   - Yes: session is alive but slow. Extend claim lease once.
   - No: mark session `offline`
3. Re-enter dispatch flow for the same review attempt

### Stale agent prevention

The claim status is the **source of truth** for who owns work. A stale agent that pushes code after its claim expired:
- The push triggers `check_run.completed`
- `claimDispatch` checks for an active claim on this PR
- If claim is `expired`/`revoked` and a new claim exists for another session → skip dispatch
- Stale work is harmlessly ignored

---

## What Changes in Existing Code

| File | Change |
|---|---|
| `src/config/agents.js` | Check DB first, YAML fallback with deprecation warning |
| `src/notifications/dispatcher.js` | Integrate with claim manager for session resolution |
| `src/notifications/transports/index.js` | Add `long_poll` and `api` transports |
| `src/engine/review-manager.js` | Create claims on review failure, complete claims on review pass |
| `src/mcp/tools.js` | Add agent management tools, modify `get_pending_actions` |
| `src/routes/` | New runner endpoints, agent management REST API |
| `src/db/migrations/` | New migration for orgs, agents, agent_tokens, agent_sessions, agent_claims tables |

### New code

| Path | Purpose |
|---|---|
| `src/agents/claim-manager.js` | Claim creation, resolution, timeout, revocation |
| `src/agents/session-manager.js` | Session registration, heartbeat, cleanup |
| `src/notifications/transports/long-poll.js` | Long-poll transport for runners |
| `src/notifications/transports/api.js` | REST API transport for cloud agents |
| `src/routes/runner.js` | Runner endpoints (register, poll, claim result) |
| `src/routes/agents.js` | Agent management REST API |
| `packages/fluent-flow-runner/` | Standalone npm package (separate repo or monorepo package) |
