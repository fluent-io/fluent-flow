# Fluent Flow

Open-source, self-hostable control plane for agent-written pull requests. Today Fluent Flow orchestrates review and remediation through customer-controlled runners; its in-flight verification machine will add independent red-before-fix and green-after-fix evidence at the merge boundary.

**Bring your own subscription.** Fluent Flow never holds your API keys — your runner invokes the model locally with whatever credentials it already has.

## How it works

Three boundaries: **GitHub**, the **Fluent Flow server + DB**, and **one or more runners** you register to your org. The server orchestrates; runners execute.

### Install

Install the GitHub App on your org. The server records the installation and materializes repo rows for every repo the App can see. Adding, removing, or reinstalling repos later stays in sync via `installation_repositories.*` webhooks.

### Connect a runner

From the dashboard, create an agent. You get a runner command — run it wherever your AI CLI lives. The runner registers a session with the server and holds a long-poll open, waiting for work. Agents are scoped to all repos in their org by default.

### Do work

Two paths into the same engine:

**Reactive** — GitHub events trigger claims automatically:
```
Push → CI completes → check_run.completed webhook → server
  → creates a pending review claim → runner claims via poll → harness posts review
  → on failure, creates a pending fix claim → runner claims it → pushes a fix → loop continues
  → on claim expiry, auto-re-dispatches at attempt + 1 (cap at 10)
```

The deterministic verification machine is in development. Its target failure path is:

```text
review FAIL → verify:red → fix → CI success → verify:green → re-review → merge or human escalation
```

The verifier will bind evidence to the reviewed commit, prove new tests fail before the fix, seal the verifier inputs, and rerun them without LLM judgment after the fix.

**Proactive** — you start work from the dashboard:
```
Pick a repo → choose type (Feature / Fix / Review / Spec) → describe the task
  → server creates a pending claim (spec / build / review / fix / test)
  → runner claims it via poll → harness does the work → result flows back
  → on claim expiry, auto-re-dispatches at attempt + 1 (cap at 10)
```
Feature claims auto-chain spec → build. Spec claims produce a plan for the user to create a PR. Fix and Review require an existing PR number.

Both paths produce claims that flow through the same dispatch pipeline. The pipelines page shows all in-flight work regardless of how it started.

## Packages

| Package | Description |
|---------|-------------|
| [fluent-flow](packages/fluent-flow/) | Server — claim dispatch, agent registry, webhook handler, MCP server |
| [fluent-flow-runner](packages/fluent-flow-runner/) | CLI runner — connects to server, picks up claims, spawns harness locally |
| [dashboard](packages/dashboard/) | Admin UI — Next.js dashboard for repos, agents, and pipeline monitoring |
| [db](packages/db/) | Shared data access — pg pool, Zod schemas, org-scoped queries |

## Quick start

### For org admins

1. **Install the GitHub App** on your org via the dashboard install CTA.
2. **Create an agent** on the Agents page. Name it, pick a harness (e.g. `claude-code`). Copy the runner command.
3. **Run the command** on the machine where your AI CLI lives. The dashboard shows "Connected" when the runner registers.
4. **Do work** — open a PR for an automatic review, or start a workflow from the Repos page.

### For developers

Turborepo monorepo. All packages run together:

```bash
npm install         # install workspace deps
npm run dev         # turbo run dev — server (3847) + dashboard (3000)
npm test            # full test suite
npm run build       # build all packages
```

Per-package:

```bash
cd packages/fluent-flow    && npm run dev   # server
cd packages/dashboard      && npm run dev   # Next.js
```

Copy `.env.example` → `.env.local` in each package. Dashboard needs `NEXT_PUBLIC_FLUENT_FLOW_URL=http://localhost:3847`.

Local runner (workspace-linked, no publish yet):

```bash
npx @fluent-flow/runner --server http://127.0.0.1:3847 --token ff_<token>
```

Docker:

```bash
docker compose up -d --build
```

## Documentation

- [Documentation index](docs/README.md) — product direction, architecture specifications, implementation plans, and project history
- [Product positioning and competitive landscape](docs/product-positioning-and-competitive-landscape.md) — open-source/self-hosted offer, competitive boundaries, and roadmap implications
- [Roadmap](ROADMAP.md) — shipped, in-flight, and known gaps
- [Design specs](docs/specs/) — architecture and design decisions
- [Implementation plans](docs/plans/) — step-by-step build plans
- Per-package: [fluent-flow](packages/fluent-flow/README.md) · [runner](packages/fluent-flow-runner/README.md) · [dashboard](packages/dashboard/README.md) · [db](packages/db/README.md)

## License

MIT
