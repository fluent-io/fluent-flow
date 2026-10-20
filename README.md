# Fluent Flow

Open-source, self-hostable collaboration and delivery control plane for agent-assisted work. The approved expansion brings client/project Kanban, individual collaborators, and task-linked Paseo execution into Fluent Flow, alongside its existing GitHub review and remediation workflows.

The collaborative expansion is implemented and locally verified, including real PC-side Paseo execution. See the [acceptance status](docs/plans/2026-10-19-collaborative-status.md) for evidence, setup guides and release boundaries. This work has not been released or deployed. Deterministic red-before-fix and green-after-fix verification remains an unreleased delivery target.

**Bring your own subscription.** Model-provider credentials stay on the execution host. Your runner uses the local tools and credentials already configured there.

## Collaborative work and execution

A client workspace contains projects and tasks. Collaborators can capture and discuss backlog work without a repository, pull request, agent session, or online execution host. Project permissions separately control editing, AI execution, internal information, delivery acceptance, and administration.

An authorized operator explicitly starts AI work from a task. Moving a card to Ready does not launch work. The PC connector connects outward to the control plane and uses the PC's existing Paseo daemon and allowed profiles; offline requests stay queued for that selected host. The Mac can run the web app, server, and database without model credentials or a Paseo daemon.

Tasks retain their runs, sessions, discussion, workpad, checks, artifacts, summaries, and ideas. A finished agent turn is separate from human delivery acceptance. The [approved specification](docs/plans/2026-10-19-collaborative-spec.md) defines the complete behavior; it is not evidence that every scenario has passed.

## Existing GitHub workflows

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

Collaboration tests need separate disposable PostgreSQL databases for the database, server and connector suites. Existing claim SQL tests use a fourth database. The collaboration suites refuse non-loopback or non-test database names and reset their dedicated schemas. See the [database package testing guide](packages/db/README.md) before running them. The Paseo connector requires Node 22 or newer; the existing review runner also supports Node 20.

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

MIT. See [third-party notices](THIRD_PARTY_NOTICES.md) for Flowly and Kaneo source references and licenses.
