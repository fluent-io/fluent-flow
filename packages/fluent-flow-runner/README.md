# fluent-flow-runner

CLI runner for [Fluent Flow](../fluent-flow/README.md). Connects to a Fluent Flow server, picks up fix claims (work assignments created when a code review fails), spawns the configured AI coding agent, and reports results.

## Collaborative board execution through Paseo

### Local browser testing

For the seeded project-local demo, use two terminals at the repository root:

```bash
npm run dev
```

```bash
npm run runner
```

The runner command uses the existing local Paseo daemon and real connector. It authenticates the saved demo owner, enrolls one persistent `Local demo runner` host, creates a disposable Git repository and maps Project A1 to an existing coding profile. It prefers your configured OMP AI3 `ai3/qwen38-flash` Coder profile; pass `--profile <id>` to choose another existing profile. No software or provider credentials are installed. AI work starts only when you click Start on a task.

Private credentials, connector config and journal live under `.local/runner/`; keep them across restarts. The original offline fixture host stays offline. Existing repository edits, passwords, project instructions and unrelated execution defaults are preserved. A revoked enrollment or conflicting project configuration needs explicit repair instead of an automatic reset. Ctrl+C stops the connector without deleting agents, worktrees or saved state.

This helper accepts the loopback `ff_demo` database by default and rejects production mode. To use another disposable `ff_*` database with its own matching fixture file, set `FF_LOCAL_RUNNER_DATABASE` to that database's exact name. Concurrent helpers targeting the same project are rejected even from different checkouts. Interrupted one-time enrollment stops for explicit recovery; see [startup errors and recovery](../../scripts/README.md).

In the board, choose Project A1, create a task asking to fix `add` so `npm test` passes, and open its Execution tab to Start. You should see the local host online, the selected profile, and live task output. The demo repository intentionally starts with failing tests. Review and human acceptance remain separate actions.

### Execution host configuration

Use the separate `fluent-flow-connector` command on the Linux execution host for task-linked Paseo work. It requires Node 22+ with native WebSocket support, the existing local Paseo daemon/CLI, and the host-specific enrollment token from Fluent Flow. The review runner described below keeps its Node 20 support.

Copy [connector.example.json](connector.example.json) to a private local config file. Set the Fluent Flow server URL, a private host-token file, a stable instance ID, repository-key to checkout-path mappings, and existing Paseo profile IDs. Only those mappings and profiles can execute. Keep the same instance ID and generated journal directory across restarts; losing the journal removes cleanup authority. A second instance cannot replace an active host lease. Choose profiles in the local Paseo configuration; no provider or model is silently selected.

```bash
node packages/fluent-flow-runner/bin/fluent-flow-connector.js --config /private/path/connector.json
```

Installed packages also expose `fluent-flow-connector --config /private/path/connector.json`. The connector discovers the local daemon from `paseo.pid` and `local-credential` under the configured Paseo home. Those credentials never go to Fluent Flow. For an AppImage where FUSE is unavailable, set `paseo.cliPath` to an already extracted `resources/bin/paseo`, or allow the connector to extract the installed AppImage into its private state cache. This does not install or upgrade Paseo.

Observation text replaces known workspace/source/Paseo-home paths and exact known credentials with display placeholders before local journal persistence and upload. Native SDK inputs keep their original values. New session reporting credentials are retained in the private state directory's `redaction-context.json` (0600; directory 0700), separately from the intent journal. For older sessions, optional config `"redactionSecretsFile": "/private/path/redaction-secrets.json"` loads a private 0600 JSON array of credential strings at startup. This file stays local. Redaction covers known values only; it does not detect unknown or encoded secrets, and it does not rewrite acknowledged history. See the [module reference](src/connector/README.md) for seed-file requirements.

The connector polls outbound; the PC needs no public listener. Backlog capture works while it is offline, and a Ready card starts no work. Explicit Start queues execution for the enrolled host. Accepted IDs, a confirmed server grant, and a ready/backfilled observer precede the first prompt. Disconnects retain history and stable bindings; missing history and unconfirmed delivery require reconciliation. Cancellation requests stop only the selected owned agent and await native confirmation. Cleanup preflight refuses uncommitted, untracked, unpushed, foreign or unknown work. Human delivery acceptance remains separate from turn completion.

See [connector modules and limits](src/connector/README.md) and [test/UAT evidence](tests/unit/connector/README.md). The executable reports generic startup/authorization errors locally; command failures use structured codes such as `request_inactive`, `observer_not_ready`, `reporting_unavailable`, and cleanup blockers. These do not expose provider credentials in browser errors.

## Preferred: register via the dashboard

For typical users, don't use the Admin API below — it requires the server's `MCP_AUTH_TOKEN`, which is a server-admin secret. Instead:

1. Sign in to the dashboard and install the Fluent Flow GitHub App on your org.
2. Click **+ New agent** on the Agents page. Name the agent and choose `claude-code`, `codex`, or `opencode`.
3. Install and authenticate the matching ACP adapter locally, then run the displayed `npx @fluent-flow/runner@latest …` command.
4. The modal confirms when the runner connects.

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

The review runner starts a local ACP v2 adapter. Install and authenticate the adapter for the registered agent type on the runner machine. Adapter credentials and configuration stay local; the server never supplies an executable, arguments, or environment values.

The runner uses the official `@agentclientprotocol/sdk@2.4.0` v2 API. It requires the adapter to support ACP v2 sessions and the baseline session methods; incompatible adapters fail before a claim prompt is submitted.

### Deterministic verification claims

Current runners advertise `verify` capability when registering. Red verification uses the same locally configured ACP adapter as other claims to author requirement tests at the reviewed commit. The runner then proves those tests fail by assertion twice, records their hashes, and publishes the red artifact commit. Green verification starts no model process: it checks the server-owned hashes, runs the pinned tests, then runs the full suite.

Each phase is an independent claim. Any current runner may claim it and prepare the required repository ref. Heartbeats, event streaming, permission requests, cancellation, shutdown, and direct-child reaping remain the normal ACP runner behavior during red authoring. Deterministic subprocesses use argv execution without a shell and phase-specific timeouts.

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
| `agent_type` | Yes | Local ACP adapter mapping: `claude-code` or `claude-agent-acp`, `codex` or `codex-acp`, or `opencode`. Other values require a local `--acp-command` |
| `transport` | Yes | Must be `long_poll` for runner usage |
| `repos` | No | Repos this agent can work on (e.g. `["fluent-io/fluent-hive", "fluent-io/api"]`). Omit or `[]` for all repos |

#### Examples

Minimal — uses the local `claude-agent-acp` mapping, all repos:

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
npx @fluent-flow/runner@latest --server <url> --token ff_<token>
```

Or globally:

```bash
npm install -g @fluent-flow/runner
```

Or from the repo (workspace-linked, pre-publish):

```bash
cd packages/fluent-flow-runner
npm install
npm link
```

### Install an ACP adapter

Use Node.js 20 or newer for the review runner. Install one adapter on every runner machine:

```bash
npm install -g @agentclientprotocol/claude-agent-acp
npm install -g @agentclientprotocol/codex-acp
npm install -g opencode-ai
```

The named mappings are `claude-code` or `claude-agent-acp` → `claude-agent-acp`, `codex` or `codex-acp` → `codex-acp`, and `opencode` → `opencode acp`. Install only the adapter you use and complete its local authentication setup.

On Windows, the runner does not execute npm `.cmd` shims. For these known packages it resolves the adjacent package's declared JavaScript bin and launches it with Node. Native `.exe` and extensionless executables run directly; arbitrary `.cmd` wrappers are rejected.

For another ACP v2 adapter, configure one executable locally:

```bash
fluent-flow-runner \
  --token ff_<your-token> \
  --server http://flow.fluenthive.io \
  --acp-command /absolute/path/to/adapter \
  --acp-arg first-value \
  --acp-arg second-value
```

`--acp-command` is a single executable name or path, not shell text. Each `--acp-arg` adds one literal argument. The former `--command` prompt-template option is unsupported.

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
| `--acp-command` | No | Local ACP v2 adapter executable for an agent type without a named mapping |
| `--acp-arg` | No | Literal adapter argument; repeat the flag for multiple arguments |
| `--cwd` | No | Working directory for the claim worktree |
| `--verbose` | No | Enable debug-level JSON logging to stdout |

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `FLUENT_FLOW_ALERT_WEBHOOK_URL` | unset | Webhook (Slack/Discord-style) that receives **runner cannot run** alerts — failed startup health checks, ACP adapter error results (for example, "Not logged in"), health-state changes. Always paired with an error-level log; delivery is best-effort. |
| `FLUENT_FLOW_HEALTH_INTERVAL_MS` | `300000` | How often the runner re-checks that it can actually run (ACP adapter present and authenticated, `gh` usable). While unhealthy the runner **stops claiming work** — its session expires and the server marks it offline instead of routing claims it would silently no-op. `0` disables the periodic check (startup gate always runs). |
| `FLUENT_FLOW_HEARTBEAT_MS` | `60000` | Claim heartbeat interval while an agent executes — extends the session TTL and the claim's expiry server-side so long runs aren't re-dispatched mid-flight. |
| `FLUENT_FLOW_AGENT_TIMEOUT_MS` | `3600000` | Hard cap on a single agent execution: SIGTERM, then SIGKILL after 10s; the claim is reported as a transient failure and re-dispatched. |

## How It Works

Once started, the runner is fully automatic — no user interaction needed. It runs a continuous loop until you stop it with `Ctrl+C`.

```mermaid
sequenceDiagram
    participant GH as GitHub
    participant FF as Fluent Flow Server
    participant R as Runner (your PC)
    participant A as Local ACP v2 adapter

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
    FF-->>R: Claim (prompt + repository details)
    R->>A: Start one direct child and one ACP session
    A-->>R: Stream updates and requests
    R->>FF: Persist events and permission or elicitation requests
    FF-->>R: Forward prompt, cancel, or request-answer commands
    A-->>R: Return to idle or fail
    R->>FF: Report result

    FF->>FF: Re-review triggered
    alt Review passes
        FF->>GH: Auto-merge PR
    else Review fails again
        Note over FF,R: New claim created → runner picks it up
    end
```

1. **Register** — Connects to the server and registers an ephemeral session.
2. **Poll** — Claims one pending phase of work and keeps its ownership alive with heartbeats.
3. **Execute** — Prepares the worktree, starts one direct ACP child, opens one ACP v2 session, and submits the claim prompt.
4. **Interact** — Streams updates through Web streams and forwards claim-scoped prompts, cancellation, permission answers, and elicitation answers.
5. **Report** — Reports the claim only after the session returns to idle or reaches a classified failure, then closes and awaits the owned direct child.
6. **Repeat** — Polls for another claim. Each pipeline phase is a separate claim, so any compatible runner may execute the next phase.

On shutdown (`Ctrl+C`), the runner cancels active work, closes the ACP session within bounded deadlines, awaits or terminates only its direct child, and reports unfinished work as a transient failure. If the runner crashes, the server relies on claim expiry and redispatch; the runner does not manage descendants or host-wide processes.

### Resilience and troubleshooting

- Poll failures use bounded exponential backoff, and sustained failure stops the runner so its service manager can restart it.
- A setup failure may start one fresh child before a prompt is submitted. After an accepted prompt, one child replacement may resume the ACP session without replaying the prompt. Liveness checks and a rolling restart budget prevent spawn loops.
- Recovery never treats an ambiguous prompt submission as safe to replay. If the runner cannot prove continuation, it reports a transient failure and claim expiry provides the scheduling fallback.
- Once the server leases a dashboard command, it is never delivered a second time. The runner renews queued prompts every 30 seconds and validates each command immediately before applying it. Commands not acknowledged or renewed within 90 seconds become `uncertain`. Prompt commands are acknowledged when ACP accepts them, before the turn completes. In-flight acknowledgements use the bounded 35-second HTTP transport deadline rather than the short command-poll wait.
- A runner handles one claim and one direct child at a time. Completion of one phase does not reserve the next phase for the same runner.
- If startup fails, verify the local adapter is installed, authenticated, on `PATH`, and supports ACP v2 sessions. If execution stops, check the runner's structured logs and adapter diagnostics locally. User-facing responses intentionally remain generic; contact the operator when local logs are unavailable.

All adapter processes use `shell: false`. Prompts and service data are protocol messages, never command text.

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
- **`init: true` in compose** — adapters can leave tool processes behind when
  they exit. The container init process reaps those orphaned descendants without
  requiring the runner to inspect or manage host processes.
- **Claude Agent ACP is the default adapter** — the image installs
  `@agentclientprotocol/claude-agent-acp`, which is the adapter selected by a
  `claude-code` registration. Authenticate Claude on the host before starting
  compose; the shipped compose file mounts that local state into the container.

**Key decisions:**
- Runs as `USER node` (uid 1000) to match host user for volume permissions. The `node:24-bookworm` image already has uid 1000 as the `node` user.
- Installs `openssh-client` so SSH git auth works.
- Mount only the local adapter state and Git credentials the selected adapter needs under `/home/node/`.

Before `docker compose up`, authenticate Claude Code and run `gh auth login` on
the host. Confirm that `~/.claude`, `~/.claude.json`, and `~/.config/gh` exist;
Docker otherwise creates missing bind sources with the wrong ownership or type.

### docker-compose.yml

```yaml
services:
  runner:
    build:
      context: /path/to/fluent-flow   # Server repo (for runner source)
      dockerfile: packages/fluent-flow-runner/Dockerfile
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
      - ~/.claude:/home/node/.claude                    # Claude Agent ACP auth
      - ~/.claude.json:/home/node/.claude.json          # Claude Agent ACP config
      - ~/.config/gh:/home/node/.config/gh
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
```

The default image supports `claude-code` and `claude-agent-acp`. To use
`codex`, `codex-acp`, or `opencode`, extend the image to install the matching
adapter described in [Install an ACP adapter](#install-an-acp-adapter), then
mount that adapter's local authentication state. The server never sends AI
provider credentials to the runner. The adapter uses its local login state and
inherits the runner process environment.

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
