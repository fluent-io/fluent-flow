# @fluent-flow/dashboard

Client/project task board and internal agent, repository and pipeline management for Fluent Flow.


## Collaborative work

The dashboard owns a client/project/task board alongside existing agent, repository and pipeline screens. Invited collaborators sign in with a password; GitHub OAuth remains available for internal users. Project roles control editing, execution, internal output, delivery acceptance and administration. A task can be created and discussed while the execution PC is offline.

- [Board](src/app/board/README.md), [task detail](src/app/tasks/README.md), [attention](src/app/attention/README.md), [invitation entry](src/app/invite/README.md) and [settings](src/app/settings/README.md).
- [Collaboration views](src/components/collab/README.md), [browser-safe API helpers](src/lib/collab/README.md), [authenticated proxy](src/app/api/collab/README.md) and [regression tests](tests/collab/README.md).
- [Shared contracts](../../docs/plans/2026-10-19-collaborative-contracts.md) and [acceptance evidence/UAT](../../docs/plans/2026-10-19-collaborative-status.md).

Start AI work is explicit. Moving a card to Ready creates no run. Requests remain queued for the configured host while it is offline. Session/turn state is separate from task delivery status; only a human delivery decision marks Done. Ambiguous requests expose operator reconciliation of the same durable command.

Workpad checks show source, command, commit, dirty/unknown capture state and history. Unknown or dirty evidence is stale. Delivery acceptance binds the exact reviewed delivery/run/HEAD/dirty/evidence revision. A changed criterion or question at the same ID clears the prior acknowledgment. File previews use a stored reference and an authorized connector read, capped at 512 KiB; text, allowed images and PDFs render safely, while unsupported files download. HTML/SVG are never executed. Summaries use configured profiles/models and a frozen source cursor; disabled summaries queue no model work. Usage displays per-metric coverage and preserves unknown values.

For collaboration, configure `FF_COLLAB_API_URL` to the Express server base URL and give Express and Next the same server-only `FF_COLLAB_AUTH_SECRET`. Neither value belongs in a public Next variable. `NEXTAUTH_SECRET`, `NEXTAUTH_URL` and `DATABASE_URL` are also required. See [.env.example](.env.example). Password entry needs a privately shared project/client invitation; SMTP and GitHub accounts are unnecessary for invited users. GitHub sign-in still requires its approved OAuth app/callback credentials.

The proxy rechecks the current NextAuth principal and signs a short-lived HMAC assertion. The API rechecks current identity, membership and capability. The browser refreshes authorized resource state every three seconds, keeps active form drafts, ignores old responses and clears revoked resources. Draft edits retain the version at which editing began; conflicts preserve the draft and show current data before an explicit retry.

For local application acceptance, build `@fluent-flow/db`, migrate/seed only a dedicated disposable database, run the actual Express `createApp()` on loopback, then run Next on loopback. Keep host credentials and generated fixture passwords in owner-only temporary files. Provider/model execution and a live GitHub OAuth callback require their separate configured prerequisites; unit tests alone do not prove those paths.


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
npm test        # dashboard API, auth, proxy, board and interaction-contract regressions
npm run test:watch
```

## Deployment

Designed for Railway or any Node.js host. Requires `DATABASE_URL` pointing to the Fluent Flow Postgres instance and GitHub OAuth credentials.

```bash
npm run build   # Next.js production build
npm start       # Start production server
```
