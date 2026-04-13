# Admin Dashboard — Design Spec

**Date:** 2026-04-07
**Scope:** Phase 1 — Agent Management
**Stack:** Next.js (App Router) + TypeScript + Tailwind + shadcn/ui + shadcn/admin template

## Overview

Customer-facing SaaS dashboard for Fluent Flow. Multi-tenant: each org sees only their own data. First phase focuses on agent management — listing agents, viewing sessions/claims/tokens, and basic admin actions.

Lives in the existing turborepo as `packages/dashboard/`. Reads from the same PostgreSQL database as the engine (`packages/fluent-flow`). No changes to the existing Express server.

## Architecture

```
packages/dashboard/          ← Next.js app
packages/fluent-flow/        ← Express engine (unchanged)
packages/fluent-flow-runner/ ← Runner CLI (unchanged)
```

The dashboard is a separate deploy. It queries the database directly using the same `pg` connection pattern. The Express server and the dashboard never talk to each other — they share the database.

### Why not proxy through Express?

- Dashboard reads from `agents`, `agent_sessions`, `agent_claims`, `agent_tokens` — tables the engine writes to
- No overlap in write paths (dashboard only writes to the new `users`/`user_orgs` tables)
- Adding a proxy layer adds latency and coupling with no benefit
- Direct DB access keeps the dashboard independent — engine can restart without affecting the dashboard

## Auth & Multi-Tenancy

### GitHub OAuth via NextAuth.js

1. User clicks "Sign in with GitHub"
2. NextAuth exchanges code for GitHub access token
3. GitHub API fetches user profile (login, email, avatar)
4. User record upserted in `users` table (created on first login, updated on subsequent logins)
5. Dashboard checks `user_orgs` for the user. If no org memberships exist, user sees a "no access" page with request instructions. Org access is granted manually by a superadmin.

### Roles

| Role | Scope | Capabilities |
|------|-------|-------------|
| **superadmin** | Global | View/manage any org, manage users, org provisioning |
| **admin** | Single org | View agents, trigger actions, manage agent tokens |
| **member** | Single org | Read-only dashboard |

Role hierarchy: superadmin > admin > member. Stored in `user_orgs.role` per org. Superadmin flag on `users` table overrides all org-level roles.

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

Org provisioning is manual (superadmin inserts rows into `user_orgs`). Self-service onboarding is a future phase.

## Project Structure

```
packages/dashboard/
├── src/
│   ├── app/
│   │   ├── layout.tsx                          # Root: auth provider, sidebar
│   │   ├── page.tsx                            # Redirect to /agents
│   │   ├── login/page.tsx                      # GitHub OAuth button
│   │   ├── agents/
│   │   │   ├── page.tsx                        # Agent list
│   │   │   └── [id]/page.tsx                   # Agent detail
│   │   └── api/
│   │       ├── auth/[...nextauth]/route.ts     # NextAuth handler
│   │       └── agents/
│   │           ├── route.ts                    # GET list
│   │           └── [id]/
│   │               ├── route.ts               # GET detail, DELETE
│   │               └── tokens/[tokenId]/route.ts  # DELETE revoke
│   ├── lib/
│   │   ├── db.ts                              # pg connection pool
│   │   ├── auth.ts                            # NextAuth config
│   │   └── queries/
│   │       ├── agents.ts                      # Agent queries (org-scoped)
│   │       └── users.ts                       # User/org queries
│   └── components/
│       ├── ui/                                # shadcn components
│       ├── layout/
│       │   ├── sidebar.tsx
│       │   ├── header.tsx
│       │   └── auth-guard.tsx
│       └── agents/
│           ├── agent-table.tsx
│           ├── agent-detail-header.tsx
│           ├── sessions-tab.tsx
│           ├── claims-tab.tsx
│           └── tokens-tab.tsx
├── tailwind.config.ts
├── next.config.ts
├── tsconfig.json
└── package.json
```

## API Routes

All routes require authentication. Org scoping applied automatically.

| Route | Method | Auth | Description |
|-------|--------|------|-------------|
| `/api/agents` | GET | any | List agents for user's org(s). Superadmin sees all. |
| `/api/agents/[id]` | GET | any | Agent detail: sessions, claims, tokens. Org-scoped. |
| `/api/agents/[id]` | DELETE | admin+ | Delete agent. Calls `failClaim()` for any active claims, then deletes agent record and revokes all tokens. |
| `/api/agents/[id]/tokens/[tokenId]` | DELETE | admin+ | Revoke a single token. |

### Org scoping pattern

```typescript
// Every route handler follows this pattern
async function getOrgScope(session: Session): Promise<{ orgIds: string[]; isSuperadmin: boolean }> {
  if (session.user.isSuperadmin) {
    return { orgIds: [], isSuperadmin: true };
  }
  const orgs = await getUserOrgs(session.user.id);
  return { orgIds: orgs.map(o => o.org_id), isSuperadmin: false };
}
```

## Agent Management UI

### Agent List (`/agents`)

- Data table with columns: agent ID, type (claude-code/codex/aider), status badge (online/offline/busy), current session, last seen timestamp
- Filters: status dropdown, search by agent ID
- Row click navigates to detail view
- Empty state when no agents registered

### Agent Detail (`/agents/[id]`)

- Header card: agent ID, type, status badge, registered date
- Tabbed content:
  - **Sessions**: table of sessions — status, hostname, OS, connected at, last poll
  - **Claims**: recent claims — claim type badge, repo/PR, status, timestamps. Link to GitHub PR where available.
  - **Tokens**: active tokens — label, created date, last used
- Admin actions (visible to admin+ role only):
  - "Delete agent" button (with confirmation dialog)
  - "Revoke" button per token row

## Dependencies

| Package | Purpose |
|---------|---------|
| `next` | Framework |
| `react`, `react-dom` | UI |
| `next-auth` | GitHub OAuth |
| `@tanstack/react-table` | Data tables |
| `tailwindcss` | Styling |
| `shadcn/ui` | Component library |
| `pg` | Database (same driver as engine) |
| `zod` | Request/response validation |

## Testing

- **Unit tests (Vitest)**: API route handlers — mock DB, verify org scoping, role enforcement, response shapes
- **E2E tests (Playwright)**: login flow, agent list renders, agent detail renders, admin actions gated by role
- Tests run via turborepo `npm test` from repo root alongside existing tests

## Out of Scope (Future Phases)

- Pipeline status view (spec → build → review_fix → test_verify per PR)
- Claim history with filtering and charts
- Manual spec trigger
- Self-service org onboarding
- Notification preferences
- Audit log viewer
- API key management for programmatic access
