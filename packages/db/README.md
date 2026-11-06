# @fluent-flow/db

Shared data access package for the Fluent Flow monorepo. Provides a PostgreSQL connection pool, Zod schemas, and org-scoped query functions consumed by the dashboard and (eventually) the engine.

## What's inside

- **Pool** — lazy-init singleton pg pool configured from `DATABASE_URL`
- **Schemas** — Zod schemas for agents, sessions, claims, users, and user orgs
- **Queries** — org-scoped read queries for agents, sessions, claims, users, tokens, and pipelines

## Usage

```typescript
import { listAgents, getAgentDetail, listPipelines } from '@fluent-flow/db';

const agents = await listAgents(['fluent-io']);
const pipelines = await listPipelines(['fluent-io']);
```

All query functions that accept `orgIds` follow the same pattern: pass an array of org IDs for scoped access. Empty `orgIds` means **no org access** (empty results, no query) unless `isSuperadmin: true` is also passed, which grants unscoped (all-org) access. Callers must pass `getOrgScope(session).isSuperadmin` explicitly — superadmin is never inferred from an empty org list.

## Queries

| Function | Description |
|----------|-------------|
| `listAgents(orgIds, isSuperadmin?)` | Agents with latest session status |
| `getAgentDetail(orgIds, agentId, isSuperadmin?)` | Single agent by ID |
| `getAgentSessions(orgId, agentId)` | Sessions for an agent |
| `getAgentClaims(orgId, agentId)` | Claims for an agent |
| `upsertUser(input)` | Create or update user from GitHub OAuth |
| `getUserOrgs(userId)` | Org memberships for a user |
| `regenerateKey(orgId, agentId)` | Revoke old key + create new (transactional) |
| `getKeyInfo(orgId, agentId)` | Active key creation date |
| `listPipelines(orgIds, filter?, isSuperadmin?)` | Pipelines grouped by PR with stages |
| `getPipelineDetail(orgIds, repo, prNumber, filter?, isSuperadmin?)` | Full claims for a PR pipeline |
| `dismissStaleClaims(orgIds, olderThanMs?, isSuperadmin?)` | Cancel/archive stale claims; 0 for empty non-superadmin |
| `dismissPipelineClaims(orgIds, repo, prNumber?, isSuperadmin?)` | Cancel/archive a pipeline's claims; 0 for empty non-superadmin |

## Schemas

Zod schemas for all database row types, exported as both schemas and TypeScript types:

`Agent`, `AgentListItem`, `Session`, `Claim`, `User`, `UserOrg`, `PipelineListItem`, `PipelineStage`, `PipelineDetailClaim`

## Testing

```bash
npm test        # unit suites mock the pg pool — no database required
npm run test:watch
```

The `tests/collaboration/` suites are the exception: they run against a REAL
disposable Postgres and require `COLLAB_DB_TEST_DATABASE_URL` pointing at a
dedicated loopback `ff_*` database (never the project default or a shared
database — resets drop and recreate the public schema; the guard enforces
naming + loopback + test mode). CI provisions independent `ff_db_test`, `ff_server_test`, `ff_connector_test` and `ff_legacy_test`
automatically (see `.github/workflows/ci.yml`).

For local browser/UAT fixtures run `node scripts/collab-fixture.mjs
--database postgres://…ff_fixture` (see [scripts/README.md](scripts/README.md)).

Collaboration schema is additive-only (`collab_*` tables; migrations
`0010`+ forward-only, journal entries appended under `src/migrations/meta`).
