# @fluent-flow/dashboard

Client/project task board and internal agent, repository and pipeline management for Fluent Flow.


## Collaborative work

The dashboard owns a client/project/task board alongside existing agent, repository and pipeline screens. Invited collaborators sign in with a password; GitHub OAuth remains available for internal users. The view depends on the signed-in principal, not the sign-in method: a principal linked to a GitHub user gets that user's current login, email, avatar, superadmin flag and orgs either way, so password and GitHub sign-in show the same navigation. A GitHub session whose `github_id` does not match the principal's linked user is rejected. Unlinked invited collaborators stay limited to Board, Projects and Needs attention, and nothing is linked by email. Project roles control editing, execution, internal output, delivery acceptance and administration. A task can be created and discussed while the execution PC is offline.

Password sign-in for a GitHub-linked principal requires an already provisioned password. Local fixtures provision those credentials directly; this change does not introduce product password enrollment, password reset or account linking for GitHub users.

- [Product notes](PRODUCT.md): confirmed user-facing behavior.
- [Board](src/app/board/README.md), [projects](src/app/projects/README.md), [task detail](src/app/tasks/README.md), [attention](src/app/attention/README.md), [invitation entry](src/app/invite/README.md) and [settings](src/app/settings/README.md).
- [Collaboration views](src/components/collab/README.md), [browser-safe API helpers](src/lib/collab/README.md), [authenticated proxy](src/app/api/collab/README.md) and [regression tests](tests/collab/README.md).
- [Shared contracts](../../docs/plans/2026-10-19-collaborative-contracts.md) and [acceptance evidence/UAT](../../docs/plans/2026-10-19-collaborative-status.md).


Workpad checks show source, command, commit, dirty/unknown capture state and history. Unknown or dirty evidence is stale. Delivery acceptance binds the exact reviewed delivery/run/HEAD/dirty/evidence revision. A changed criterion or question at the same ID clears the prior acknowledgment. File previews use a stored reference and an authorized connector read, capped at 512 KiB; text, allowed images and PDFs render safely, while unsupported files download. HTML/SVG are never executed. Summaries use configured profiles/models and a frozen source cursor; disabled summaries queue no model work. Usage displays per-metric coverage and preserves unknown values.

For collaboration, configure `FF_COLLAB_API_URL` to the Express server base URL and give Express and Next the same server-only `FF_COLLAB_AUTH_SECRET`. Neither value belongs in a public Next variable. `NEXTAUTH_SECRET`, `NEXTAUTH_URL` and `DATABASE_URL` are also required. See [.env.example](.env.example). Password entry needs a privately shared project/client invitation; SMTP and GitHub accounts are unnecessary for invited users. GitHub sign-in still requires its approved OAuth app/callback credentials.

The proxy rechecks the current NextAuth principal and signs a short-lived HMAC assertion. The API rechecks current identity, membership and capability. The browser refreshes authorized resource state every three seconds, keeps active form drafts, ignores old responses and clears revoked resources. Draft edits retain the version at which editing began; conflicts preserve the draft and show current data before an explicit retry.

For local application acceptance, build `@fluent-flow/db`, migrate/seed only a dedicated disposable database, run the actual Express `createApp()` on loopback, then run Next on loopback. Keep host credentials and generated fixture passwords in owner-only temporary files. Provider/model execution and a live GitHub OAuth callback require their separate configured prerequisites; unit tests alone do not prove those paths.


## Stack

Next.js 15 (App Router), TypeScript, Tailwind CSS, shadcn/ui, NextAuth.js, @fluent-flow/db

## Features

### Agent Management
- Agent server list with provider badges, slots (`active / capacity`), status badges (online/offline/busy), deployment (Local, Self-hosted, Hosted) and last seen
- Agent server detail with provider, slots and deployment, sessions tab, claims tab, and API key management
- Role-gated admin actions: delete agent, regenerate API key (admin+ only)
- API key one-time reveal on regeneration (hash-only storage)

### Pipeline Status
- Pipeline list showing task pipeline progress per PR
- Dynamic stages rendered from claim data (spec, build, review_fix, test_verify, or any future types)
- Pipeline detail with vertical timeline showing per-stage status, duration, agent, and session
- Links to GitHub PRs
- Pipeline detail renders red and green verification outcomes, requirement coverage, pinned test hashes, artifact commits, failure diagnostics, and the chain step selected by the deterministic transition policy.

### Auth & Multi-Tenancy
- GitHub OAuth via NextAuth.js
- Roles: superadmin (global), admin (per-org), member (per-org, read-only)
- Org scoping enforced from server-side session on every API route

### Layout
- Top bar with logo, org badge, user avatar
- Collapsible sidebar (state persisted to localStorage)

## Setup

Install dependencies with `npm ci` from the repository root. In `packages/dashboard`, copy the environment template:

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
FF_COLLAB_API_URL=http://127.0.0.1:3847
FF_COLLAB_AUTH_SECRET=<same private value as the server>
NEXT_PUBLIC_FLUENT_FLOW_URL=http://127.0.0.1:3847
```

Use the same development database as the server. Configure the server's [required environment](../fluent-flow/README.md#environment-variables) separately, including its GitHub App settings.
`NEXT_PUBLIC_FLUENT_FLOW_URL` supplies the server URL in the commands generated from Agents. It must be an `https:` URL, or `http:` on `localhost` or a `127.x.x.x` address, because the agent server refuses any other plain HTTP URL. Any other value makes `POST /api/agents` answer with a generic misconfiguration error and logs the reason server-side only.

GitHub OAuth app settings:
- Homepage URL: `http://localhost:3000`
- Callback URL: `http://localhost:3000/api/auth/callback/github`

```bash
npm run dev     # from repository root: API on 3847 + dashboard on 3000
```

The root command first ensures the existing project demo database at `127.0.0.1:55432/ff_demo` is running, then builds the shared database package before either app starts and forwards exported environment variables. Custom databases must be started separately. Next continues to load this package's `.env.local`. To run only Next after building the database package, use `npm run dev -w @fluent-flow/dashboard` from the root; that per-workspace command does not start PostgreSQL.

### Registering your first agent

1. Sign in and install the Fluent Flow GitHub App on your org — the install webhook creates the `orgs` row and links you as admin automatically.
2. On the Agents page, click **+ New agent server**. Enter a server name (e.g. `laptop-1`), choose the provider (`claude-code` or `codex`), a capacity from 1 to 16 and a deployment (Local (npm) or Self-hosted (Docker)). Admins of several orgs also pick the organization.
3. Copy and run the generated command. It is single-use and valid for the number of minutes the dialog shows. Local mode reuses the provider CLI login on that machine and needs Node 20+, git and gh on PATH. Self-hosted mode needs the provider credential file placed at the mounted secret path, and the command's state and work volumes persist the enrollment.
4. The dialog waits for a slot to come online and advances to **Connected**. Click Done.

The enrollment command is shown exactly once. If it expires or is lost, delete the server from the detail page and create a new one.

### Provider, capacity and deployment

Dashboard-created agent servers always use `long_poll`. Provider selects the local ACP adapter (`claude-code` or `codex`), capacity is the number of slots the server runs at once, and deployment selects the command variant. The agent row stores `{ provider, capacity, deployment }` in `transport_meta`. The list and detail pages show the live slot count, capacity and deployment that the running server reports, and fall back to those stored values. Hosted servers appear in the list when the hosting platform provisions them, but the dialog has no Hosted option. The server does not provide a command or AI provider credentials. Provider is not the task role (`claim_type`), which the server decides per claim. The [agent server README](../fluent-flow-agent-server/README.md) covers running the command.

## API Routes

| Route | Method | Auth | Description |
|-------|--------|------|-------------|
| `/api/auth/[...nextauth]` | * | — | NextAuth handler |
| `/api/agents` | GET | any | List agents (org-scoped) |
| `/api/agents` | POST | admin | Body `{ org_id, agent_id, provider, capacity, deployment }`. Creates the agent and a 15-minute single-use enrollment token in one transaction and returns `{ agent, command, enrollment_expires_at }`. The token appears only inside `command` |
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
