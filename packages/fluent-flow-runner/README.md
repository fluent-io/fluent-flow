# fluent-flow-runner

CLI runner for [Fluent Flow](../fluent-flow/README.md). Connects to a Fluent Flow server, picks up fix claims (work assignments created when a code review fails), spawns the configured AI coding agent, and reports results.

## Preferred: register via the dashboard

For typical users, don't use the Admin API below — it requires the server's `MCP_AUTH_TOKEN`, which is a server-admin secret. Instead:

1. Sign in to the dashboard and install the Fluent Flow GitHub App on your org.
2. Click **+ New agent** on the Agents page. Name the agent, pick a harness.
3. Copy the displayed `npx fluent-flow-runner …` command (token pre-filled) and run it on the machine where your AI CLI lives.
4. Modal auto-confirms when the runner connects.

The rest of this README covers the **ops/CI path** — registering agents directly against the server without going through the dashboard. Use this when provisioning from CI, from scripts, or when acting as the server admin.

## Prerequisites

### Git Authentication

The runner needs access to clone repositories. **SSH is preferred** (keys don't expire, no token rotation):

- Mount an SSH key into the container: `~/.ssh/id_ed25519` or `~/.ssh/id_rsa`
- Add GitHub's SSH host keys to `known_hosts` to prevent TOFU prompts:
  ```bash
  ssh-keyscan -t ed25519,rsa github.com >> ~/.ssh/known_hosts
  ```
- The runner auto-detects SSH keys and tries `git@github.com:` URLs first

Alternatively, use HTTPS with a GitHub token:

- Set `GITHUB_TOKEN` in the container environment
- The runner authenticates via `x-access-token` URL embedding so the token works reliably in Docker/container environments
- After cloning, the remote URL is set with the token for subsequent fetch/pull operations

If neither is available, cloning public repos still works via plain HTTPS.

### AI Agent Authentication

The runner spawns AI coding agents (claude-code, codex, aider, etc.) as subprocesses. These agents need their own API keys:

- Set `ANTHROPIC_API_KEY` for Claude Code
- Set `OPENAI_API_KEY` for Codex/OpenAI-based agents
- Any other keys your chosen agent requires

The runner passes all environment variables through to spawned agents.

### Admin API Authentication

In production, Admin API calls require `MCP_AUTH_TOKEN` — the shared secret configured on the Fluent Flow server. In development (when `MCP_AUTH_TOKEN` is not set on the server), the Admin API allows unauthenticated access. For production, find the token in your server's environment (e.g. `docker-compose.yml` or `.env`), then export it locally:

```bash
export MCP_AUTH_TOKEN=<your-server-token>
```

## Quick Start

### 1. Register an Agent

Create an agent on the Fluent Flow server using the Admin API:

```bash
curl -X POST http://flow.fluenthive.io/api/agents \
  -H "Authorization: Bearer $MCP_AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "id": "my-runner",
    "agent_type": "claude-code",
    "transport": "long_poll",
    "repos": ["owner/repo"]
  }'
```

**Fields:**

| Field | Required | Description |
|-------|----------|-------------|
| `id` | Yes | Unique agent identifier |
| `agent_type` | Yes | `claude-code`, `codex`, `devin`, `openclaw`, `aider`, or `custom` |
| `transport` | Yes | Must be `long_poll` for runner usage |
| `transport_meta` | No | Transport-specific config (see below) |
| `repos` | No | Repos this agent can work on (e.g. `["fluent-io/fluent-hive", "fluent-io/api"]`). Omit or `[]` for all repos |

**`transport_meta`** is a JSON object with transport-specific settings. For `long_poll`:

| Key | Description |
|-----|-------------|
| `command` | Custom command template. Use `{prompt}` as placeholder for the review feedback. Overrides the default command for the `agent_type` |

#### Examples

Minimal — uses the default `claude-code` command, all repos:

```bash
curl -X POST http://flow.fluenthive.io/api/agents \
  -H "Authorization: Bearer $MCP_AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "id": "my-runner",
    "agent_type": "claude-code",
    "transport": "long_poll"
  }'
```

Scoped to specific repos:

```bash
curl -X POST http://flow.fluenthive.io/api/agents \
  -H "Authorization: Bearer $MCP_AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "id": "hive-runner",
    "agent_type": "claude-code",
    "transport": "long_poll",
    "repos": ["fluent-io/fluent-hive"]
  }'
```

Custom command template (e.g. wrapping codex with extra flags):

```bash
curl -X POST http://flow.fluenthive.io/api/agents \
  -H "Authorization: Bearer $MCP_AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "id": "codex-runner",
    "agent_type": "custom",
    "transport": "long_poll",
    "transport_meta": {
      "command": "codex --approval full-auto -q \"{prompt}\""
    },
    "repos": ["fluent-io/api"]
  }'
```

Alternatively, use the `create_agent` MCP tool if connected via MCP. See [MCP tools docs](../fluent-flow/src/mcp/README.md).

### 2. Generate a Token

```bash
curl -X POST http://flow.fluenthive.io/api/agents/my-runner/tokens \
  -H "Authorization: Bearer $MCP_AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"label": "my-laptop"}'
```

Response includes a `token` field (`ff_...`). Save it — it is only shown once.

### 3. Install

```bash
npm install -g fluent-flow-runner
```

Or from the repo:

```bash
cd packages/fluent-flow-runner
npm install
npm link
```

### 4. Run

```bash
fluent-flow-runner \
  --token ff_<your-token> \
  --server http://flow.fluenthive.io \
  --verbose
```

Or run directly without installing:

```bash
node packages/fluent-flow-runner/bin/fluent-flow-runner.js \
  --token ff_<your-token> \
  --server http://flow.fluenthive.io \
  --verbose
```

## CLI Flags

| Flag | Required | Description |
|------|----------|-------------|
| `--token` | Yes | Agent token from step 2 |
| `--server` | Yes | Fluent Flow server URL |
| `--command` | No | Override the default agent command template |
| `--cwd` | No | Working directory for spawned agent processes |
| `--verbose` | No | Enable debug-level JSON logging to stdout |

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `FLUENT_FLOW_ALERT_WEBHOOK_URL` | unset | Webhook (Slack/Discord-style) that receives **runner cannot run** alerts — failed startup health checks, harness error results (e.g. claude "Not logged in"), health-state changes. Always paired with an error-level log; delivery is best-effort. |
| `FLUENT_FLOW_HEALTH_INTERVAL_MS` | `300000` | How often the runner re-checks that it can actually run (harness present + authenticated, `gh` usable). While unhealthy the runner **stops claiming work** — its session expires and the server marks it offline instead of routing claims it would silently no-op. `0` disables the periodic check (startup gate always runs). |
| `FLUENT_FLOW_HEARTBEAT_MS` | `60000` | Claim heartbeat interval while an agent executes — extends the session TTL and the claim's expiry server-side so long runs aren't re-dispatched mid-flight. |
| `FLUENT_FLOW_AGENT_TIMEOUT_MS` | `3600000` | Hard cap on a single agent execution: SIGTERM, then SIGKILL after 10s; the claim is reported as a transient failure and re-dispatched. |

## How It Works

Once started, the runner is fully automatic — no user interaction needed. It runs a continuous loop until you stop it with `Ctrl+C`.

```mermaid
sequenceDiagram
    participant GH as GitHub
    participant FF as Fluent Flow Server
    participant R as Runner (your PC)
    participant A as Agent (e.g. claude-code)

    R->>FF: Register session
    FF-->>R: session_id

    loop Continuous polling
        R->>FF: Poll for work
        FF-->>R: (no work)
    end

    GH->>FF: PR pushed / updated
    FF->>FF: Automated review
    FF->>FF: Review fails → create claim

    R->>FF: Poll for work
    FF-->>R: Claim (fix prompt + PR details)
    R->>A: Spawn agent with fix prompt
    A->>GH: Push fix commit
    A-->>R: Exit (success/failure)
    R->>FF: Report result

    FF->>FF: Re-review triggered
    alt Review passes
        FF->>GH: Auto-merge PR
    else Review fails again
        Note over FF,R: New claim created → runner picks it up
    end
```

1. **Register** — Connects to the server and registers an ephemeral session (5min TTL)
2. **Poll** — Continuously checks the server for pending fix claims (~1s interval, extends session TTL on each poll)
3. **Execute** — When a review fails and work is assigned, automatically spawns the agent (e.g. `claude-code`) with the fix prompt
4. **Report** — After the agent finishes, reports the result (completed or failed) back to the server
5. **Repeat** — Returns to polling for the next claim

On shutdown (`Ctrl+C`), the runner reports any active claim as failed before exiting.

### Resilience

- **Exponential backoff** — on poll failures, retries with increasing delay (2s → 4s → 8s → ... up to 60s)
- **Watchdog timer** — if total time spent in consecutive backoff exceeds 10 minutes, the runner force-exits (`process.exit(1)`). This lets the container orchestrator (Docker, systemd) restart it.
- **Max failure limit** — after 30 consecutive poll failures, the runner stops (prevents infinite retry loops against a down server)
- **Stale session detection** — if the session expires or goes offline, the server returns 410 and the runner re-registers

Built-in agent types (`claude-code`, `codex`, `aider`) spawn with `shell: false` — the prompt is passed as a discrete argument with no injection risk. Custom commands (`--command`) use `shell: true` with shell-character escaping.

## Docker Deployment

The runner is designed to run inside Docker alongside the Fluent Flow server. This section documents the production deployment architecture.

### Architecture Overview

```
Host (G10)
├── ~/fluent-flow/          # Fluent Flow server (docker compose)
│   ├── fluent-flow         # API server (port 3847)
│   ├── dashboard           # Next.js dashboard (port 3000)
│   └── postgres            # Database
├── ~/fluent-flow-runner/   # Runner (separate docker compose)
│   ├── Dockerfile
│   ├── docker-compose.yml
│   ├── .env                # GITHUB_TOKEN + FLUENT_FLOW_RUNNER_TOKEN
│   └── work/               # Agent worktrees
└── Host home dir mounted read-only into runner container
```

The runner runs as a **separate docker-compose project** on the same Docker host. It joins the server's network (`fluent-flow_fluent-flow-net`) to communicate with the API.

### Dockerfile

The runner image lives at [`Dockerfile`](./Dockerfile) and the deployment
compose at [`docker-compose.yml`](./docker-compose.yml). Notable, reliability-critical choices:

- **`gh` CLI is installed** — the review agent prompt depends on it
  (`gh pr diff`, `gh api .../reviews`). Images without `gh` produce reviews
  that are never posted: silent no-op pipelines.
- **`init: true` in compose** — the harness CLIs spawn grandchildren
  (git/gh/ripgrep); Node as PID 1 does not reap them. Without an init,
  long-lived runner containers accumulate zombie processes.
- **Writable `~/.claude` and `~/.config/gh`** (named volumes) — claude-code
  persists session state under `~/.claude`, and the runner re-runs
  `gh auth login --with-token` per claim, writing `~/.config/gh`. Mounting the
  host home read-only breaks both.

**Key decisions:**
- Runs as `USER node` (uid 1000) to match host user for volume permissions. The `node:24-bookworm` image already has uid 1000 as the `node` user.
- Installs `openssh-client` so SSH git auth works.
- All host config (`.claude`, `.ssh`, `.gitconfig`) must be mounted at `/home/node/` — **not** `/home/runner/` — because that's the `node` user's actual home directory.

### docker-compose.yml

```yaml
services:
  runner:
    build:
      context: /path/to/fluent-flow   # Server repo (for runner source)
      dockerfile: /path/to/fluent-flow-runner/Dockerfile
    container_name: fluent-flow-runner
    env_file: .env
    environment:
      HOME: /home/node
    command:
      - --token
      - ${FLUENT_FLOW_RUNNER_TOKEN}
      - --server
      - http://fluent-flow:3847    # Service name on the shared network
      - --cwd
      - /work
      - --verbose
    volumes:
      - ./work:/work                                    # Agent worktrees
      - ~/.claude:/home/node/.claude                    # Claude Code auth
      - ~/.claude.json:/home/node/.claude.json          # Claude Code config
      - ~/.codex:/home/node/.codex:ro                   # Codex config
      - ~/.gitconfig:/home/node/.gitconfig:ro           # Git identity
      - ~/.ssh:/home/node/.ssh:ro                       # SSH keys for git clone
    networks:
      - fluent-flow_fluent-flow-net
    restart: unless-stopped

networks:
  fluent-flow_fluent-flow-net:
    external: true
```

### Environment Variables (.env)

```bash
# Runner token (from dashboard "New Agent" flow or Admin API)
FLUENT_FLOW_RUNNER_TOKEN=ff_xxxx

# GitHub PAT with repo scope — used as HTTPS fallback when SSH key
# doesn't have access to the target org. The runner tries SSH first,
# then HTTPS with this token via x-access-token URL auth.
GITHUB_TOKEN=ghp_xxxx

# AI agent API keys are also passed through
ANTHROPIC_API_KEY=sk-ant-xxxx
```

### Git Auth Flow

The runner tries three methods in order when cloning a repo:

1. **SSH** — if `~/.ssh/id_ed25519` or `id_rsa` exists. Fast and doesn't expire, but the SSH key must be for a GitHub account with repo access.
2. **HTTPS + token** — if `GITHUB_TOKEN` is set. Uses `x-access-token` URL embedding (`https://x-access-token:$TOKEN@github.com/...`). After clone, the remote URL is set with the token for subsequent fetch operations.
3. **Plain HTTPS** — fallback for public repos only.

Each attempt cleans up the partial clone directory before trying the next.

> **⚠️ Security note:** The HTTPS + token auth method writes the `GITHUB_TOKEN` in plaintext to `.git/config` inside the worktree directory via `git remote set-url`. The runner container is a controlled environment and worktrees are cleaned up after each claim, but anyone with filesystem access to the worktree directory can read the token. Do not persist worktrees to shared volumes or log `git remote -v` output.

### Common Issues

| Issue | Cause | Fix |
|-------|-------|-----|
| `Permission denied` on work dirs | Old container ran as root, new one as `node` | `sudo chown -R 1000:1000 ~/fluent-flow-runner/work/` |
| `Host key verification failed` | Missing GitHub host keys in `known_hosts` | `ssh-keyscan -t ed25519,rsa github.com >> ~/.ssh/known_hosts` before building |
| SSH authenticates but `Repository not found` | SSH key is for a GitHub account without org access | Add `GITHUB_TOKEN` for an account with access, or use a different SSH key |
| Claims stuck in `claimed` status | Pre-fix: session was pre-assigned at creation | Post-fix: claims are always `pending` — runners claim atomically. Expired claims auto-re-dispatch at `attempt + 1` |
| Runner registered but not picking up claims | Pre-fix: claims pre-assigned to dead sessions | Post-fix: `claimPendingWork()` picks up any `pending` claim regardless of session history |

### Rebuilding After Changes

```bash
cd ~/fluent-flow-runner
docker compose up -d --build --force-recreate
```

Always use `--force-recreate` to ensure the running container uses the new image.

## Token Management

You can create multiple tokens per agent — e.g. one per machine or team member. Use **list** to audit active tokens, and **revoke** to rotate credentials or decommission a machine.

```bash
# List tokens (shows labels and expiry, not the token values)
curl http://flow.fluenthive.io/api/agents/my-runner/tokens \
  -H "Authorization: Bearer $MCP_AUTH_TOKEN"

# Revoke a token (the runner using it will stop authenticating)
curl -X DELETE http://flow.fluenthive.io/api/agents/my-runner/tokens/1 \
  -H "Authorization: Bearer $MCP_AUTH_TOKEN"
```

## Agent Management

Use these to check which agents are registered, verify a runner is connected, or clean up agents you no longer need.

```bash
# List all agents — see what's registered
curl http://flow.fluenthive.io/api/agents \
  -H "Authorization: Bearer $MCP_AUTH_TOKEN"

# Get agent details — check transport, repos, and config
curl http://flow.fluenthive.io/api/agents/my-runner \
  -H "Authorization: Bearer $MCP_AUTH_TOKEN"

# View active sessions — verify a runner is connected and online
curl http://flow.fluenthive.io/api/agents/my-runner/sessions \
  -H "Authorization: Bearer $MCP_AUTH_TOKEN"

# Delete an agent — removes the agent and cascades to all its tokens and sessions
curl -X DELETE http://flow.fluenthive.io/api/agents/my-runner \
  -H "Authorization: Bearer $MCP_AUTH_TOKEN"
```
