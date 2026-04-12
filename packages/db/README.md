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

All query functions that accept `orgIds` follow the same pattern: pass an array of org IDs for scoped access, or an empty array for superadmin (no filter).

## Queries

| Function | Description |
|----------|-------------|
| `listAgents(orgIds)` | Agents with latest session status |
| `getAgentDetail(orgIds, agentId)` | Single agent by ID |
| `getAgentSessions(orgId, agentId)` | Sessions for an agent |
| `getAgentClaims(orgId, agentId)` | Claims for an agent |
| `upsertUser(input)` | Create or update user from GitHub OAuth |
| `getUserOrgs(userId)` | Org memberships for a user |
| `regenerateKey(orgId, agentId)` | Revoke old key + create new (transactional) |
| `getKeyInfo(orgId, agentId)` | Active key creation date |
| `listPipelines(orgIds)` | Pipelines grouped by PR with stages |
| `getPipelineDetail(orgIds, repo, prNumber)` | Full claims for a PR pipeline |

## Schemas

Zod schemas for all database row types, exported as both schemas and TypeScript types:

`Agent`, `AgentListItem`, `Session`, `Claim`, `User`, `UserOrg`, `PipelineListItem`, `PipelineStage`, `PipelineDetailClaim`

## Testing

```bash
npm test        # 15 tests
npm run test:watch
```

Tests mock the pg pool — no database required.
