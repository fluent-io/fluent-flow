# Fluent Flow

Automated code review orchestrator for AI coding agents. Manages the review-fix loop so agents focus on writing code — not deciding what to do next.

## How It Works

1. An AI agent opens a PR
2. Fluent Flow runs an automated review
3. If the review fails, the agent is notified with specific feedback
4. The agent pushes a fix, triggering a re-review
5. On pass, the PR is auto-merged. On repeated failure, a human is escalated

## How data flows

Three boundaries: **GitHub**, the **Fluent Flow server + DB**, and **one or
more runners** you register to your org. Every interaction between them is a
webhook, a GitHub API call, or a long-poll — there's no shared state.

### 1. Install

Install the GitHub App on your org. The server records the install and the
repos it has access to. Re-installing, adding, or removing repos later keeps
this in sync via `installation_repositories.*` webhooks.

### 2. Register agents

From the dashboard, create one or more agents. Each returns a runner command
(`npx fluent-flow-runner --token ff_…`) that you run wherever you want the
harness to execute. Each runner registers a session with the server and
holds a long-poll open, waiting for work.

### 3. Review + fix

```
Push → GitHub CI runs → check_run.completed webhook → server
                                                        │
                                                        └─→ finds an available agent
                                                              │
                                                              └─→ creates a review claim
                                                                    │
                                                   runner long-poll picks up the claim
                                                                    │
                                             spawns the configured harness (claude-code, aider, …)
                                                                    │
                                                     harness posts the review → server processes
                  ┌─────────────────────────────────────────────────┴───────────────────────────────┐
                PASS                                                                              FAIL
                  │                                                                                  │
                  └─→ enable auto-merge                                                              └─→ creates a fix claim
                                                                                                       │
                                                                             runner picks it up → harness pushes a fix commit
                                                                                                       │
                                                                                     back to check_run.completed, loop continues
```

Each step is idempotent — re-running any box produces the same result.
Agents don't share state; the server is the only orchestrator. No per-repo
workflow files or API-key secrets are required: the harness on your runner
already has whatever credentials it needs.

## Packages

| Package | Description |
|---------|-------------|
| [fluent-flow](packages/fluent-flow/) | Server — review engine, agent registry, MCP server, webhook handler |
| [fluent-flow-runner](packages/fluent-flow-runner/) | CLI runner — connects to the server, picks up work, spawns agents locally |
| [dashboard](packages/dashboard/) | Admin UI — Next.js dashboard for managing agents and monitoring pipelines |
| [db](packages/db/) | Shared data access — pg pool, Zod schemas, org-scoped queries |

## Using Fluent Flow (for org admins)

The production path — no code, no CLI setup beyond one `npx` command:

1. **Install the GitHub App** on your org at the dashboard's install CTA. Creates your org, installation, and admin membership on first sign-in.
2. **Click "+ New agent"** on the Agents page. Name the agent, pick a harness (`claude-code` default). The modal returns a runner command pre-filled with your token.
3. **Run the generated `npx fluent-flow-runner …` command** on the machine where the AI CLI (e.g. `claude`) lives. Modal flips to "Connected" when the runner registers.
4. Open a PR on any installed repo — Fluent Flow reviews it, creates a claim on failure, runner picks it up, agent pushes a fix, loop continues.

## Getting Started (dev)

This is a [Turborepo](https://turbo.build/) monorepo. All packages run together:

```bash
npm install         # install workspace deps
npm run dev         # turbo run dev — server (3847) + dashboard (3000) in parallel
npm test            # full test suite across packages
npm run build       # build all packages
```

### Per-package

```bash
cd packages/fluent-flow    && npm run dev   # server, reads .env.local via --env-file-if-exists
cd packages/dashboard      && npm run dev   # Next.js, reads .env.local automatically
```

Copy each package's `.env.example` → `.env.local` and fill in secrets.

Dashboard needs `NEXT_PUBLIC_FLUENT_FLOW_URL=http://localhost:3847` locally so the generated runner command points at your local server.

Local runner (no publish yet — workspace-linked):

```bash
npx fluent-flow-runner --server http://127.0.0.1:3847 --token ff_<token>
```

### Docker

```bash
docker compose up -d --build
```

## Documentation

- [Roadmap](ROADMAP.md) — shipped milestones, in-flight work, known gaps
- [Design specs](docs/specs/) — architecture and design decisions
- [Implementation plans](docs/plans/) — step-by-step build plans
- Per-package docs: [fluent-flow](packages/fluent-flow/README.md), [fluent-flow-runner](packages/fluent-flow-runner/README.md), [dashboard](packages/dashboard/README.md), [db](packages/db/README.md)

## License

MIT
