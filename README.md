# Fluent Flow

Open-source, self-hostable collaboration and delivery control plane for agent-assisted work. The approved expansion brings client/project Kanban, individual collaborators, and task-linked Paseo execution into Fluent Flow, alongside its existing GitHub review and remediation workflows.

The collaborative expansion is implemented and locally verified, including real PC-side Paseo execution. See the [acceptance status](docs/plans/2026-10-19-collaborative-status.md) for evidence, setup guides and release boundaries. This work has not been released or deployed. Deterministic red-before-fix and green-after-fix verification remains an unreleased delivery target.

**Bring your own subscription.** Fluent Flow never calls model APIs. Your agent server uses the provider login or subscription credential file that you give it on its own host.

## Collaborative work and execution

A client workspace contains projects and tasks. Collaborators can capture and discuss backlog work without a repository, pull request, agent session, or online execution host. Project permissions separately control editing, AI execution, internal information, delivery acceptance, and administration.

An authorized operator explicitly starts AI work from a task. Moving a card to Ready does not launch work. The PC connector connects outward to the control plane and uses the PC's existing Paseo daemon and allowed profiles; offline requests stay queued for that selected host. The Mac can run the web app, server, and database without model credentials or a Paseo daemon.

Tasks retain their runs, sessions, discussion, workpad, checks, artifacts, summaries, and ideas. A finished agent turn is separate from human delivery acceptance. The [approved specification](docs/plans/2026-10-19-collaborative-spec.md) defines the complete behavior; it is not evidence that every scenario has passed.

## Existing GitHub workflows

Three boundaries: **GitHub**, the **Fluent Flow server + DB**, and **one or more agent servers** you register to your org. The server orchestrates; agent servers execute.

### Install

Install the GitHub App on your org. The server records the installation and materializes repo rows for every repo the App can see. Adding, removing, or reinstalling repos later stays in sync via `installation_repositories.*` webhooks.

### Connect an agent server

From the dashboard, create an agent server: pick a provider (`claude-code` or `codex`), a capacity from 1 to 16 concurrent claims, and local (npm) or self-hosted (Docker). You get one command with a 15-minute, single-use enrollment token. Run it where your provider login lives, or run the Docker command on a VM. The agent server registers one long-poll session per capacity slot and waits for work, and agents are scoped to all repos in their org by default. Platform operators run hosted servers from the same image. See the [agent server guide](packages/fluent-flow-agent-server/README.md).

### Do work

Two paths into the same engine:

**Reactive** — GitHub events trigger claims automatically:
```
Push → CI completes → check_run.completed webhook → server
  → creates a pending review claim → agent server slot claims via poll → local ACP adapter posts review
  → on failure, creates a pending fix claim → a slot claims it → pushes a fix → loop continues
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
  → an agent server slot claims it via poll → local ACP adapter does the work → result flows back
  → on claim expiry, auto-re-dispatches at attempt + 1 (cap at 10)
```
Feature claims auto-chain spec → build. Spec claims produce a plan for the user to create a PR. Fix and Review require an existing PR number.

Both paths produce claims that flow through the same dispatch pipeline. The pipelines page shows all in-flight work regardless of how it started.

## Packages

| Package | Description |
|---------|-------------|
| [fluent-flow](packages/fluent-flow/) | Server — claim dispatch, agent registry, webhook handler, MCP server |
| [fluent-flow-agent-server](packages/fluent-flow-agent-server/) | Agent server — connects to the server, runs up to 16 claims at once in isolated worktrees with a local ACP adapter, ships as an npm package and a Docker image. Also holds the separate Paseo connector |
| [dashboard](packages/dashboard/) | Admin UI — Next.js dashboard for repos, agents, and pipeline monitoring |
| [db](packages/db/) | Shared data access — pg pool, Zod schemas, org-scoped queries |

## Quick start

### For org admins

1. **Install the GitHub App** on your org via the dashboard install CTA.
2. **Create an agent server** on the Agents page. Name it, choose `claude-code` or `codex`, a capacity, and local or self-hosted.
3. **Run the generated command.** Local mode needs Node 20+, git, gh, the provider's ACP adapter and a signed-in provider CLI. Self-hosted mode needs Docker and a provider secret file. The dashboard shows "Connected" when a slot registers.
4. **Do work** — open a PR for an automatic review, or start a workflow from the Repos page.

### For developers

Use Node 22 and a configured PostgreSQL database. From the repository root, install dependencies and prepare each app's local environment once:

```bash
npm ci
cp packages/fluent-flow/.env.example packages/fluent-flow/.env.local
cp packages/dashboard/.env.example packages/dashboard/.env.local
```

Fill in both files before starting. Set `DATABASE_URL` to your development database in both apps and use the same private `FF_COLLAB_AUTH_SECRET`. The server also requires its existing `FF_GITHUB_APP_ID`, `FF_GITHUB_APP_PRIVATE_KEY` and `FF_GITHUB_APP_WEBHOOK_SECRET` configuration. In the dashboard, set `FF_COLLAB_API_URL=http://127.0.0.1:3847`, `NEXTAUTH_URL=http://localhost:3000` and a private `NEXTAUTH_SECRET`; configure GitHub OAuth credentials when using GitHub sign-in. Creating agent servers from the Agents page also needs dashboard `NEXT_PUBLIC_FLUENT_FLOW_URL=http://127.0.0.1:3847`. See the [server](packages/fluent-flow/README.md#environment-variables) and [dashboard](packages/dashboard/README.md#setup) setup guides.

Then start the API and dashboard together:

```bash
npm run dev         # server (3847) + dashboard (3000); Ctrl+C stops both
```

Turbo builds the shared database package before starting the apps. Each app loads its own `.env.local`; exported shell variables also reach the dev processes. The server applies pending migrations to the configured database during normal startup. Database creation and optional fixture seeding are separate setup steps.

For the project-local demo at `127.0.0.1:55432/ff_demo`, `npm run dev` first starts the existing `.local/postgres-data` cluster if stopped and checks that PostgreSQL is accepting connections before launching the apps. It reuses a running cluster and leaves it running when the apps stop. PostgreSQL tools must match the cluster version; standard Linux versioned installs and tools on `PATH` are supported. It never recreates data or passwords. Custom development databases still need to be running separately. See the [development scripts](scripts/README.md).

To test task execution, keep `npm run dev` running and open another terminal:

```bash
npm run runner
```

With the local demo seeded to `.local/ff-demo-users.json` and Paseo already running, this connects a real local execution host, prepares a disposable Git repository, and configures Project A1. It prefers your existing OMP AI3 `ai3/qwen38-flash` coding profile; choose another with `npm run runner -- --profile <paseo-profile-id>`. Enrollment and journal state stay private in `.local/runner/` and are reused on restart. No AI task starts automatically. In Project A1, create a task asking the agent to fix `add` so `npm test` passes, then open Execution and click Start. This command runs the Paseo connector, not the agent server. See the [connector guide](packages/fluent-flow-agent-server/README.md#local-browser-testing).

Other root commands:

```bash
npm test            # full test suite
npm run build       # build all packages
```

Collaboration tests need separate disposable PostgreSQL databases for the database, server and connector suites. Existing claim SQL tests use a fourth database. The collaboration suites refuse non-loopback or non-test database names and reset their dedicated schemas. See the [database package testing guide](packages/db/README.md) before running them. The Paseo connector requires Node 22 or newer; the agent server also supports Node 20.

To develop one app separately, build the shared database package first and run the desired workspace:

```bash
npm run build -w @fluent-flow/db
npm run dev -w fluent-flow             # server
npm run dev -w @fluent-flow/dashboard   # Next.js, in a separate terminal
```

Local agent server from this checkout. Create the server in the dashboard first to get its enrollment token. No package has been published yet, so `npx @fluent-flow/agent-server@latest` works only after the first release:

```bash
node packages/fluent-flow-agent-server/bin/fluent-flow-agent-server.js --server http://127.0.0.1:3847 --provider claude-code --enrollment-token enroll_<token>
```

Docker:

```bash
docker compose up -d --build
```

This starts the server, dashboard and PostgreSQL. The compose file also defines an optional `hosted-agent` profile that runs the published agent server image against an HTTPS control-plane URL, with its token and provider credential supplied as files and no network shared with PostgreSQL. The default command does not start it. See [Hosted](packages/fluent-flow-agent-server/README.md#hosted).

## Pull request previews

Every pull request whose branch belongs to this repository receives an isolated full-stack preview:

- Dashboard: `https://pr-<number>-preview.fluentflow.tech`
- Service: `https://api-pr-<number>-preview.fluentflow.tech`

Opening, reopening, or updating the pull request deploys its current head. Closing it removes that pull request's containers, network, images, and PostgreSQL volume. Fork pull requests are excluded before a self-hosted runner is assigned.

The preview stack uses a dedicated preview GitHub App and preview-only repository secrets: `PREVIEW_GITHUB_APP_ID`, `PREVIEW_GITHUB_APP_PRIVATE_KEY`, `PREVIEW_GITHUB_APP_WEBHOOK_SECRET`, `PREVIEW_GITHUB_CLIENT_ID`, `PREVIEW_GITHUB_CLIENT_SECRET`, `PREVIEW_STACK_SECRET`, and `PREVIEW_TUNNEL_TOKEN`. Never populate these names with production credentials. The stack seed derives separate PostgreSQL, NextAuth, MCP, and collaboration secrets for each pull request.

`Pull Request Preview` manages application stacks. `Preview Edge` is a manual workflow that reconciles the shared Traefik and Cloudflare Tunnel edge after the `fluent-flow-preview` tunnel and wildcard DNS route have been created. The preview comment on each pull request is the authoritative URL and deployment-state record.

## Documentation

- [Documentation index](docs/README.md) — product direction, architecture specifications, implementation plans, and project history
- [Product positioning and competitive landscape](docs/product-positioning-and-competitive-landscape.md) — open-source/self-hosted offer, competitive boundaries, and roadmap implications
- [Roadmap](ROADMAP.md) — shipped, in-flight, and known gaps
- [Design specs](docs/specs/) — architecture and design decisions
- [Implementation plans](docs/plans/) — step-by-step build plans
- Per-package: [fluent-flow](packages/fluent-flow/README.md) · [agent server](packages/fluent-flow-agent-server/README.md) · [dashboard](packages/dashboard/README.md) · [db](packages/db/README.md)

## License

MIT. See [third-party notices](THIRD_PARTY_NOTICES.md) for Flowly and Kaneo source references and licenses.
