# Admin Dashboard — Phase 1 Design Spec

**Date:** 2026-04-12
**Scope:** Phase 1 — Agent Management
**Stack:** Next.js (App Router) + TypeScript + Tailwind + shadcn/ui

## Context

Fluent Flow needs a customer-facing dashboard for managing AI agents. The engine (`packages/fluent-flow/`) handles review orchestration, claim routing, and agent sessions, but operators currently interact through MCP tools or raw API calls. Phase 1 delivers a multi-tenant web UI focused on agent management — listing agents, viewing sessions and claims, and managing API keys.

## Architecture

```
packages/dashboard/          ← Next.js app (new)
packages/db/                 ← Shared data access: pg pool, queries, Zod schemas (new)
packages/fluent-flow/        ← Express engine (unchanged)
packages/fluent-flow-runner/ ← Runner CLI (unchanged)
```

### Direct DB access, no Express proxy

The dashboard reads from `agents`, `agent_sessions`, `agent_claims`, `agent_tokens` — tables the engine writes to. The dashboard only writes to auth tables (`users`, `user_orgs`). No overlap in write paths, so no proxy needed. Both apps share the database via `DATABASE_URL`.

### Shared data access package (`packages/db/`)

A new Turborepo package holds the pg connection pool, query functions, and Zod schemas consumed by the dashboard. The engine keeps its existing query code for now. Consolidation into `packages/db/` happens in a future phase to avoid scope creep.

Exports:
- `pool` — pg connection pool configured from `DATABASE_URL`
- `queries/agents.ts` — org-scoped agent queries (list, getById, delete)
- `queries/sessions.ts` — session queries by agent
- `queries/claims.ts` — claim queries by agent
- `queries/tokens.ts` — token queries (create, revoke/regenerate)
- `queries/users.ts` — user upsert, org membership queries
- `schemas/` — Zod schemas for all query results

### Deployment

Deploy to Railway. The database connection is a `DATABASE_URL` env var pointing to wherever Postgres is hosted (currently G10, may move). The dashboard is fully independent of the engine at runtime — either can restart without affecting the other.

## Auth & Multi-Tenancy

### GitHub OAuth via NextAuth.js

1. User clicks "Sign in with GitHub"
2. NextAuth exchanges code for GitHub access token
3. GitHub API fetches user profile (login, email, avatar)
4. User record upserted in `users` table
5. Dashboard checks `user_orgs` for org memberships. No memberships = "no access" page with request instructions. Org access is granted manually by a superadmin.

### Roles

| Role | Scope | Capabilities |
|------|-------|-------------|
| **superadmin** | Global | View/manage any org, manage users, org provisioning |
| **admin** | Single org | View agents, trigger actions, regenerate API keys, delete agents |
| **member** | Single org | Read-only dashboard |

Role hierarchy: superadmin > admin > member. Stored in `user_orgs.role` per org. `users.is_superadmin` overrides all org-level roles.

### Security boundary

Every API route extracts `org_id(s)` from the authenticated session — never from URL params or request body. A user in org A cannot see org B's data. Superadmin routes bypass org scoping.

## Database Changes

Two new tables for auth. All other reads use existing tables.

```sql
CREATE TABLE users (
  id SERIAL PRIMARY KEY,
  github_id INTEGER NOT NULL UNIQUE,
  login TEXT NOT NULL,
  email TEXT,
  avatar_url TEXT,
  is_superadmin BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE user_orgs (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  org_id TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, org_id)
);
```

## Layout

### Top bar (fixed)
- Left: Fluent Flow logo
- Right: org badge (org name), user avatar + username

### Collapsible sidebar
- **Expanded:** icon + label for each nav item, collapse toggle at bottom
- **Collapsed:** icon-only with tooltips, expand toggle
- Phase 1 nav items: Agents, Settings
- Sidebar state persists (localStorage)

## Pages

### Login (`/login`)
- GitHub OAuth button
- Redirects to `/agents` on success

### Agent List (`/agents`)
- Data table with columns: agent ID, type badge (claude-code/codex/aider), status badge (online/offline/busy), last seen timestamp
- Filters: status dropdown, search by agent ID
- Row click navigates to `/agents/[id]`
- Empty state when no agents registered

### Agent Detail (`/agents/[id]`)

**Header card:**
- Agent ID (large), status badge, type, transport, repos list, registered date
- Delete Agent button (admin+ only, confirmation dialog)
- API key section:
  - Normal state: "API Key" label, creation date, Regenerate button (admin+)
  - After regenerate: green banner showing new plaintext key with Copy button and warning "Copy this key now. It won't be shown again." Ephemeral — gone on navigation/refresh.
  - Storage: hash-only (`agent_tokens` table). Plaintext returned only on creation, never retrievable after.
  - Regenerate = create new token + revoke old one atomically

**Tabs:**
- **Sessions:** table — status, hostname, OS, connected at, last poll
- **Claims:** table — claim type badge (spec/build/review_fix/test_verify), repo/PR with link to GitHub, status, timestamps

## API Routes

All routes require NextAuth session. Org scoping applied automatically via session.

| Route | Method | Auth | Description |
|-------|--------|------|-------------|
| `/api/auth/[...nextauth]` | * | — | NextAuth handler |
| `/api/agents` | GET | any | List agents for user's org(s). Superadmin sees all. |
| `/api/agents/[id]` | GET | any | Agent detail with sessions, claims. Org-scoped. |
| `/api/agents/[id]` | DELETE | admin+ | Delete agent. Fails active claims, deletes record, revokes key. |
| `/api/agents/[id]/key` | POST | admin+ | Regenerate API key. Returns new plaintext once. |

### Org scoping pattern

```typescript
async function getOrgScope(session: Session): Promise<{ orgIds: string[]; isSuperadmin: boolean }> {
  if (session.user.isSuperadmin) {
    return { orgIds: [], isSuperadmin: true };
  }
  const orgs = await getUserOrgs(session.user.id);
  return { orgIds: orgs.map(o => o.org_id), isSuperadmin: false };
}
```

## Project Structure

```
packages/db/
├── src/
│   ├── index.ts                          # Pool + re-exports
│   ├── pool.ts                           # pg pool from DATABASE_URL
│   ├── queries/
│   │   ├── agents.ts
│   │   ├── sessions.ts
│   │   ├── claims.ts
│   │   ├── tokens.ts
│   │   └── users.ts
│   └── schemas/
│       ├── agents.ts
│       ├── sessions.ts
│       ├── claims.ts
│       └── users.ts
├── tsconfig.json
└── package.json

packages/dashboard/
├── src/
│   ├── app/
│   │   ├── layout.tsx                    # Root: auth provider, top bar, sidebar
│   │   ├── page.tsx                      # Redirect to /agents
│   │   ├── login/page.tsx                # GitHub OAuth button
│   │   ├── agents/
│   │   │   ├── page.tsx                  # Agent list
│   │   │   └── [id]/page.tsx             # Agent detail
│   │   └── api/
│   │       ├── auth/[...nextauth]/route.ts
│   │       └── agents/
│   │           ├── route.ts              # GET list
│   │           └── [id]/
│   │               ├── route.ts          # GET detail, DELETE
│   │               └── key/route.ts      # POST regenerate
│   ├── lib/
│   │   └── auth.ts                       # NextAuth config
│   └── components/
│       ├── ui/                           # shadcn components
│       ├── layout/
│       │   ├── top-bar.tsx
│       │   ├── sidebar.tsx
│       │   └── auth-guard.tsx
│       └── agents/
│           ├── agent-table.tsx
│           ├── agent-detail-header.tsx
│           ├── sessions-tab.tsx
│           └── claims-tab.tsx
├── tailwind.config.ts
├── next.config.ts
├── tsconfig.json
└── package.json
```

## Dependencies

| Package | Purpose |
|---------|---------|
| `next` | Framework |
| `react`, `react-dom` | UI |
| `next-auth` | GitHub OAuth |
| `@tanstack/react-table` | Data tables |
| `tailwindcss` | Styling |
| `shadcn/ui` | Component library |
| `pg` | Database (in packages/db) |
| `zod` | Validation (in packages/db) |

## Testing

- **Unit tests (Vitest):** API route handlers — mock DB, verify org scoping, role enforcement, response shapes. Query functions in `packages/db` tested against a test database.
- **E2E tests (Playwright):** Login flow, agent list renders, agent detail renders, admin actions gated by role.
- Tests run via Turborepo `npm test` from repo root alongside existing tests.

## Verification

1. `npm test` from repo root — all packages pass (existing 427 + new dashboard + db tests)
2. `npm run dev` in `packages/dashboard/` — login with GitHub, see agent list, click into detail, verify sessions/claims tabs render, regenerate key flow works
3. Role enforcement: member cannot see Delete/Regenerate buttons, admin can
4. Org scoping: user in org A cannot see org B's agents

## Out of Scope (Future Phases)

- Pipeline status view (spec -> build -> review_fix -> test_verify per PR)
- Claim history with filtering and charts
- Manual spec trigger from UI
- Self-service org onboarding
- Notification preferences
- Audit log viewer
- Engine query consolidation into packages/db
