# @fluent-flow/dashboard

Admin dashboard for Fluent Flow. Multi-tenant web UI for managing AI agents and monitoring task pipelines.

## Stack

Next.js 15 (App Router), TypeScript, Tailwind CSS, shadcn/ui, NextAuth.js, @fluent-flow/db

## Features

### Agent Management
- Agent list with status badges (online/offline/busy) and type badges (claude-code/codex/aider)
- Agent detail with sessions tab, claims tab, and API key management
- Role-gated admin actions: delete agent, regenerate API key (admin+ only)
- API key one-time reveal on regeneration (hash-only storage)

### Pipeline Status
- Pipeline list showing task pipeline progress per PR
- Dynamic stages rendered from claim data (spec, build, review_fix, test_verify, or any future types)
- Pipeline detail with vertical timeline showing per-stage status, duration, agent, and session
- Links to GitHub PRs

### Auth & Multi-Tenancy
- GitHub OAuth via NextAuth.js
- Roles: superadmin (global), admin (per-org), member (per-org, read-only)
- Org scoping enforced from server-side session on every API route

### Layout
- Top bar with logo, org badge, user avatar
- Collapsible sidebar (state persisted to localStorage)

## Setup

```bash
cp .env.example .env.local
```

Fill in `.env.local`:

```
DATABASE_URL=postgresql://fluentflow:password@<db-host>:5432/fluentflow
GITHUB_CLIENT_ID=<from GitHub OAuth app>
GITHUB_CLIENT_SECRET=<from GitHub OAuth app>
NEXTAUTH_SECRET=<random string: openssl rand -hex 32>
NEXTAUTH_URL=http://localhost:3000
```

GitHub OAuth app settings:
- Homepage URL: `http://localhost:3000`
- Callback URL: `http://localhost:3000/api/auth/callback/github`

```bash
npm run dev     # http://localhost:3000
```

### Registering your first agent

1. Sign in and install the Fluent Flow GitHub App on your org — the install webhook creates the `orgs` row and links you as admin automatically.
2. On the Agents page, click **+ New agent**. Enter an ID (e.g. `laptop-1`) and pick the agent type (`claude-code` by default — see [Agent types](#agent-types) below).
3. Copy the `npx @fluent-flow/runner@latest run ...` command shown in the dialog and run it on the machine where the runner should live.
4. The modal auto-detects when the runner connects and flips to the **Connected** step. Click Done.

The runner token is shown exactly once. If you lose it, delete the agent from the detail page and create a new one, or regenerate the key via `POST /api/agents/[id]/key`.

### Agent types

`agent_type` is a routing hint — which CLI tool the runner invokes when it claims work (`claude`, `aider`, `codex`, etc.). It is **not** the task role (`claim_type`: `spec`/`build`/`review_fix`/`test_verify`), which is decided per-claim by the server.

## API Routes

| Route | Method | Auth | Description |
|-------|--------|------|-------------|
| `/api/auth/[...nextauth]` | * | — | NextAuth handler |
| `/api/agents` | GET | any | List agents (org-scoped) |
| `/api/agents` | POST | admin | Create a new agent + token, returns `npx @fluent-flow/runner …` command |
| `/api/agents/[id]` | GET | any | Agent detail with sessions, claims, key info |
| `/api/agents/[id]` | DELETE | admin+ | Delete agent and cascade |
| `/api/agents/[id]/key` | POST | admin+ | Regenerate API key |
| `/api/pipelines` | GET | any | List pipelines (org-scoped) |
| `/api/pipelines/[...slug]` | GET | any | Pipeline detail (owner/repo/prNumber) |

## Testing

```bash
npm test        # 14 tests (API route handlers)
npm run test:watch
```

## Deployment

Designed for Railway or any Node.js host. Requires `DATABASE_URL` pointing to the Fluent Flow Postgres instance and GitHub OAuth credentials.

```bash
npm run build   # Next.js production build
npm start       # Start production server
```
