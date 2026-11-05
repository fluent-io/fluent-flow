# fluent-flow-runner

CLI runner for [Fluent Flow](../fluent-flow/README.md). Connects to a Fluent Flow server, picks up fix claims (work assignments created when a code review fails), spawns the configured AI coding agent, and reports results.

## Collaborative board execution

### Local browser testing

For the seeded project-local demo, use two terminals at the repository root:

```bash
npm run dev
```

```bash
npm run runner
```

The runner command uses the real connector. It authenticates the saved demo owner, enrolls one persistent `Local demo runner` host, creates a disposable Git repository and maps Project A1 to the execution profiles you wrote in `.local/runner/profiles.json` (the generated `.local/runner/README.md` documents the format and the one-time sign-in). The first start needs `--profile <id>` to choose the project default; later starts reuse it. Nothing picks a tool, model or policy for you. No software or provider credentials are installed. AI work starts only when you click Start on a task.

Paseo is optional. `npm run runner -- --enable-integration paseo` connects to the local Paseo daemon and also offers the saved Paseo profiles. Without the flag, no Paseo call is made; saved Paseo profiles and a saved Paseo project default are kept unchanged but not offered. Choosing a different project default always requires `--profile`.

Private credentials, connector config and journal live under `.local/runner/`; keep them across restarts. The original offline fixture host stays offline. Existing repository edits, passwords, project instructions and unrelated execution defaults are preserved. A revoked enrollment or conflicting project configuration needs explicit repair instead of an automatic reset. Ctrl+C stops the connector without deleting agents, worktrees or saved state.

This helper accepts the loopback `ff_demo` database by default and rejects production mode. To use another disposable `ff_*` database with its own matching fixture file, set `FF_LOCAL_RUNNER_DATABASE` to that database's exact name. Concurrent helpers targeting the same project are rejected even from different checkouts. Interrupted one-time enrollment stops for explicit recovery; see [startup errors and recovery](../../scripts/README.md).

In the board, choose Project A1, create a task asking to fix `add` so `npm test` passes, and open its Execution tab to Start. You should see the local host online, the selected profile, and live task output. The demo repository intentionally starts with failing tests. Review and human acceptance remain separate actions.

### Execution host configuration

Use the separate `fluent-flow-connector` command on the Linux execution host for task-linked work. It requires Node 22+ and the host-specific enrollment token from Fluent Flow. The review runner described below keeps its Node 20 support.

`@getpaseo/client@0.12.0` is an optional peer dependency. It is loaded only when the connector starts with `--enable-integration paseo`; then the existing local Paseo daemon/CLI is also required. Without the SDK the flag fails with "The Paseo integration is not installed on this host." A config with saved Paseo profiles and no complete execution profile fails without the flag: "Enable the saved integration explicitly or configure an available execution profile." With neither, it fails with "Configure a complete execution profile before starting the runner." Other startup errors print "Connector startup failed. Check the local configuration and Node 22 runtime." and log the detail to stderr.

Copy [connector.example.json](connector.example.json) to a private local config file. Set the Fluent Flow server URL, a private host-token file, a stable instance ID and repository-key to checkout-path mappings. Execution profiles go in `profiles` as objects (same format as the local runner's `profiles.json`, plus optional `capacity`); saved Paseo profile IDs go in `integrations.paseo.profiles`, with optional `home` and `cliPath`. The older format, a `profiles` list of Paseo IDs plus a `paseo` section, still loads as the saved Paseo list and is not rewritten. Only those mappings and profiles can execute. Keep the same instance ID and generated journal directory across restarts; losing the journal removes cleanup authority. A second instance cannot replace an active host lease. Choose profiles in the local Paseo configuration; no provider or model is silently selected.

```bash
node packages/fluent-flow-runner/bin/fluent-flow-connector.js --config /private/path/connector.json --enable-integration paseo
```

Installed packages also expose `fluent-flow-connector --config /private/path/connector.json [--enable-integration paseo]`. With Paseo enabled, the connector discovers the local daemon from `paseo.pid` and `local-credential` under the configured Paseo home. Those credentials never go to Fluent Flow. For an AppImage where FUSE is unavailable, set the Paseo `cliPath` to an already extracted `resources/bin/paseo`, or allow the connector to extract the installed AppImage into its private state cache. This does not install or upgrade Paseo.

Observation text replaces known workspace/source/Paseo-home paths and exact known credentials with display placeholders before local journal persistence and upload. Native SDK inputs keep their original values. New session reporting credentials are retained in the private state directory's `redaction-context.json` (0600; directory 0700), separately from the intent journal. For older sessions, optional config `"redactionSecretsFile": "/private/path/redaction-secrets.json"` loads a private 0600 JSON array of credential strings at startup. This file stays local. Redaction covers known values only; it does not detect unknown or encoded secrets, and it does not rewrite acknowledged history. See the [module reference](src/connector/README.md) for seed-file requirements.

The connector polls outbound; the PC needs no public listener. Backlog capture works while it is offline, and a Ready card starts no work. Explicit Start queues execution for the enrolled host. Accepted IDs, a confirmed server grant, and a ready/backfilled observer precede the first prompt. Disconnects retain history and stable bindings; missing history and unconfirmed delivery require reconciliation. Cancellation requests stop only the selected owned agent and await native confirmation. Cleanup preflight refuses uncommitted, untracked, unpushed, foreign or unknown work. Human delivery acceptance remains separate from turn completion.

**Capacity and the executable (Task 10).** `capacity` (`{ "claude-code": n, "codex": n }`, integers of at least 1, default 1) is the number of sessions per standalone backend that may hold an execution slot at once; primary and summary sessions share it, and it is published read-only. A session frees its slot when its turn ends, nothing waits for a person and its containment holds only the worker process itself. The worker process is the profile's exact `executable`, which FF always runs as configured. If that is a launcher that keeps the real tool as a child process (the npm `codex` launcher, a Node script, runs the platform binary as its child), the idle worker always shows a second process and keeps its slot until the session is closed (for example by wrap-up). To let idle Codex sessions free their slot, set `executable` to the platform binary itself: resolve the launcher (`readlink -f "$(command -v codex)"`, then `node_modules/@openai/codex-<platform>/vendor/<target>/bin/codex` beside it, for example `codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex`) and check that `<path> --version` prints `codex-cli 0.162.1`, the pinned version; readiness rejects any other version. The pinned Claude Code `claude` is already a single binary.

See [connector modules and limits](src/connector/README.md) and [test/UAT evidence](tests/unit/connector/README.md). The executable reports generic startup/authorization errors locally; command failures use structured codes such as `request_inactive`, `observer_not_ready`, `reporting_unavailable`, and cleanup blockers. These do not expose provider credentials in browser errors.

### Standalone native execution

[`src/native/`](src/native/README.md) runs Claude Code `2.1.317` and Codex CLI `0.162.1` directly, without Paseo: JSONL framing, the Claude control protocol, the Codex app-server RPC, the native child environment and the pinned argv. The connector composes these backends through the standalone supervisor. Native execution requires a supported Linux host with verified delegated cgroup v2 containment, the exact supported binary and a complete execution profile.

`npm test` covers them with [unit tests](tests/unit/native/README.md) and never spawns a native. `npm run test:native --workspace=@fluent-flow/runner` runs the [pinned protocol probes](tests/native/README.md) against the real binaries. They run inside an unprivileged loopback-only network namespace and fail with `network_isolation_unavailable` if one cannot be created. Results are in the [evidence README](tests/native/evidence/README.md).

### Answering on the execution host (Task 9)

A pending question of a standalone session can be answered on the execution host instead of in the browser. A Codex question the model marked secret can only be answered here.

```bash
npm run runner -- answer --local [--request <id>]                                 # local demo runner
fluent-flow-connector answer --local --config <private-local-config.json> [--request <id>]
```

It needs an interactive terminal (`Local answers require an interactive terminal.`), uses the saved instance's private supervisor IPC and starts nothing. The request id is the one the dashboard shows; without `--request` the only pending question is used. It prints `Your answer is sent to the selected tool and model and may be stored in their conversation history.` before input and reads every value masked. FF stores no answer value or hash; the native tool keeps its own history. See [supervisor answers](src/supervisor/README.md#answers-task-9).

### Status, stop and recovery (Task 11)

```bash
npm run runner -- status | list | stop                                  # local demo runner
fluent-flow-connector status | list | stop --config <private-local-config.json>
```

These use only the saved instance's private supervisor IPC and start nothing. `status` prints the instance, whether its supervisor runs, containment, admission, capacity per backend (`used/limit`) and one line per recorded worker (backend, run, session, state, start time). `list` prints only the worker lines. Neither prints prompts, answers, model output, native ids or paths. Worker states: `active`, `idle`, `running` (an earlier lifetime's worker whose leaf is still populated), `stopped`, `unconfirmed` (cannot be proven empty) and `escaped`. `stop` stops only this instance's standalone workers; it never touches other native sessions, connectors or Paseo.

The supervisor runs detached in its own session, so Ctrl+C reaches only the connector. Its handler sends `stop { scope: 'all', timeoutMs: 30000 }`: active turns are interrupted with receipts, each worker gets SIGTERM (only when its recorded identity still matches) and then `cgroup.kill` on its exact leaf, journals and worktrees stay, and the exit code is 0. A timeout, a leaf still populated or a descendant that left its cgroup prints `Shutdown could not be confirmed. Check the runner's status before continuing.` and exits 1; `status` then shows it.

On start the supervisor recovers before it listens: each recorded worker of the current boot whose exact owned leaf is still populated is stopped the same way; anything it cannot prove (another boot, a foreign or missing leaf with a live process) stays `reconciling` and is never signalled. Uncertain barriers become `reconciling`; FF's own no-write evidence resolves exactly its barrier. Nothing is respawned or replayed. A lost worker expires its requests and its session reconciles. An authorized Cancel on such a session closes it only after its recorded workers are proven quiescent (`closure: operator`); a later explicit prompt can then reopen the exact native session (`--resume <uuid>`, `thread/resume`) without resending earlier prompts. See [supervisor lifecycle](src/supervisor/README.md#lifecycle-and-recovery-task-11).

[`src/supervisor/`](src/supervisor/README.md) provides the `flock` owner lock, durable ledger, owner-only IPC and cgroup v2 containment. Its production entry composes both native backends with their subscription-auth policies; synthetic auth and process-group containment exist only in the test harness. [Unit tests](tests/unit/supervisor/README.md) run in `npm test`. `npm run test:containment --workspace=@fluent-flow/runner` runs the [real-kernel containment tests](tests/native/containment/README.md), which fail with `containment_unavailable` unless a delegated scope is verified. Synthetic protocol and namespace tests do not prove subscription login or ordinary-host worktree cleanup.

## Preferred: register via the dashboard

For typical users, don't use the Admin API below — it requires the server's `MCP_AUTH_TOKEN`, which is a server-admin secret. Instead:

1. Sign in to the dashboard and install the Fluent Flow GitHub App on your org.
2. Click **+ New agent** on the Agents page. Name the agent, pick a harness.
3. Copy the displayed `npx @fluent-flow/runner@latest …` command (token pre-filled) and run it on the machine where your AI CLI lives.
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
