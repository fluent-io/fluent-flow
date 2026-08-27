# Fluent Flow

Config-driven GitHub workflow orchestrator. A deterministic state machine manages review, red/green verification, and fix claims for AI coding agents — agents only read and write code, they never decide what step comes next.

## The Verification-backed Review Loop

When a PR is pushed or updated, Fluent Flow runs an automated code review. If the review passes, the PR can auto-merge. If it fails and verification is enabled, the server first creates a **verify:red** claim: the runner distills the blocking findings into executable red tests at the reviewed commit and publishes those verifier artifacts with `[skip ci]`. Only then does Fluent Flow create a **review_fix** claim. After the fix lands and external CI succeeds, a **verify:green** claim reruns the pinned verifier tests and the full suite before the server dispatches a re-review.

```
PR pushed → review → PASS → auto-merge
                   → FAIL → verify:red → review_fix → CI success → verify:green → re-review
                   → verify TAMPERED / iteration cap → escalate to human
                   → claim expires → auto-re-dispatch at attempt + 1
```

## Key Concepts

### Claims

A claim is a unit of work for an agent. Review claims produce a verdict. Verify claims run the deterministic red/green gate around blocking review findings. Review-fix claims change the PR code after red verifier artifacts are pinned. Claims are created as `pending` and runners claim them via `claimPendingWork()` (atomic `pending → claimed` transition). Claims are tracked per chain attempt and have a TTL. Expired claims are automatically re-dispatched at `attempt + 1` (capped at 10) so no PR stays orphaned.

Claim types used by the review loop:

| Claim type | Purpose |
|------------|---------|
| `review` | Produce the PR verdict and blocking findings. |
| `verify` | Run deterministic verification with `payload.phase` set to `red` or `green`. |
| `review_fix` | Change PR code after red verifier artifacts are pinned. |
| `test_verify` | Historical verifier claim type; accepted in stored config but not created for new automated verification. |

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
npm test              # package suite, runs sequentially
npm run test:watch    # watch mode
```

## Configuration

Two-layer config system:

1. **Global defaults** (`config/defaults.yml`) — states, transitions, reviewer settings, pause reasons
2. **Per-repo overrides** (`.github/fluent-flow.yml` in client repos) — `project_id`, `default_agent`, reviewer overrides

Config is fetched from GitHub, cached in the database, and validated with Zod. See [config docs](config/README.md).

### Verification config

Verification is on by default for new review failures. The repo YAML config supports the `verification` key and can keep framework auto-detection or pin an adapter explicitly. Separately, stored repo/org config can restrict `claim_types`; include `verify` there and leave `test_verify` only for historical compatibility.

```yaml
verification:
  enabled: true
  framework: auto      # auto, vitest, jest, node, or custom
  skip_policy: allow_ungated
  flake:
    retries: 2
    blocking: false
  authoring:
    retries: 2
    max_requirements: 25
    red_reproductions: 2
```

`verify` is the active verification claim type. Red claims author pinned verifier artifacts at the reviewed commit; green claims rerun those pinned tests and the full suite at the fixed head. `test_verify` is retained for historical rows only.

### Check-run meaning

`Fluent Flow — verify` reports the verifier gate for the current chain attempt. `PASS` means pinned red tests passed on the fixed head and the full suite had no blocking failures. `FAIL` means a requirement, suite, or configured flake gate failed. `TAMPERED` means the PR changed verifier-protected test/config files after red artifacts were pinned; the chain stops for human review. `SKIPPED` means the configured framework could not be verified under the repo policy.

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

Database migrations live in `@fluent-flow/db` and cover the baseline schema, GitHub App installation state, runner sessions, claim archival, null-PR pipelines, verification results, and persisted verification manifests.

Migrations run automatically on server startup. See [DESIGN.md](DESIGN.md) for full schema.
