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
| `listAgents(orgIds, isSuperadmin?)` | Agents with the [slot aggregate](#agent-aggregates): `status`, `last_seen_at`, `active_slots`, `capacity`, `deployment` |
| `getAgentDetail(orgIds, agentId, isSuperadmin?)` | Single agent with the same aggregate fields as the list |
| `createAgent(input)` | Insert an agent row |
| `createAgentWithEnrollment(input, expiresAt?)` | Insert an agent and an [enrollment token](#enrollment-tokens) in one transaction. Returns `{ agent, enrollment: { plaintext, id } }` |
| `getAgentSessions(orgId, agentId)` | Sessions for an agent |
| `getAgentClaims(orgId, agentId)` | Claims for an agent |
| `upsertUser(input)` | Create or update user from GitHub OAuth |
| `getUserOrgs(userId)` | Org memberships for a user |
| `regenerateKey(orgId, agentId)` | Revoke old key + create new (transactional) |
| `getKeyInfo(orgId, agentId)` | Active key creation date |
| `createToken(input)` | Insert a durable `ff_` token. Expiry defaults to one year, `null` means no expiry |
| `createEnrollmentToken(input, executor?)` | Insert a single-use `enroll_` token (15 minutes unless `expiresAt` is given) |
| `exchangeEnrollmentToken({ plaintext, instanceId })` | Consume an enrollment token and return a durable token, or `null` |
| `listPipelines(orgIds, filter?, isSuperadmin?)` | Pipelines grouped by PR with stages |
| `getPipelineDetail(orgIds, repo, prNumber, filter?, isSuperadmin?)` | Full claims for a PR pipeline |
| `getVerificationResultByClaim(orgId, claimId)` | Persisted red or green verification evidence for one claim |
| `getVerificationResultsForPR(orgId, repo, prNumber)` | Ordered verification history for a PR |
| `insertVerificationResultAtomic(row, client)` | Store mutable verification evidence inside claim finalization; applied results reject replacement |
| `markVerificationTransitionApplied(claimId)` | Conditionally mark previously-unapplied transition effects complete |
| `dismissStaleClaims(orgIds, olderThanMs?, isSuperadmin?)` | Cancel/archive stale claims; 0 for empty non-superadmin |
| `dismissPipelineClaims(orgIds, repo, prNumber?, isSuperadmin?)` | Cancel/archive a pipeline's claims; 0 for empty non-superadmin |

## Schemas

Zod schemas for all database row types, exported as both schemas and TypeScript types:

`Agent`, `AgentDetail`, `AgentListItem`, `Session`, `Claim`, `User`, `UserOrg`, `PipelineListItem`, `PipelineStage`, `PipelineDetailClaim`

`AgentDetail` is `Agent` plus `deployment` (`local`, `self_hosted`, `hosted` or `null`), `capacity` (integer or `null`), `active_slots` (non-negative integer), `status` (string or `null`) and `last_seen_at` (date or `null`). `AgentListItem` uses the same schema.

`verification_results` stores the server-owned requirement matrix, manifest, pinned test hashes, artifact commits, and transition completion marker. Migration `0025_verification_results` adds the table and prevents concurrent active green claims for the same PR commit.

## Agent aggregates

An agent server registers one `agent_sessions` row per capacity slot. `listAgents` and `getAgentDetail` join one lateral aggregate over an agent's sessions, scoped to the agent and its organization, so the list and detail views always agree:

- A session is live when its status at read time is not `offline`. Status is computed from the stored status and the TTL, so a slot that died without reporting surfaces as offline without any write.
- `active_slots` counts distinct live `(instance_id, slot_id)` pairs. Two live rows for the same instance and slot, as during a restart overlap, count once. Live sessions without that metadata count one each.
- `status` is `busy` when any session is busy, `online` when any is live and `offline` otherwise. `last_seen_at` is the latest `last_seen_at` over all sessions, including expired ones.
- `capacity` is the sum over live instances of each instance's latest valid reading. Without instance metadata it is the latest valid reading of the live sessions, and without live sessions it is `transport_meta.capacity` on the agent. A valid reading is an integer from 1 to 16.
- `deployment` is the latest valid value reported by a live session (`local`, `self_hosted` or `hosted`), else `transport_meta.deployment`.
- Malformed or hostile `session_meta` and `transport_meta` values are ignored in SQL and never fail the page. Ties on `last_seen_at` break toward the higher session ID.
- An agent that never connected has status `offline`, zero slots, a null `last_seen_at`, and capacity and deployment from `transport_meta` or `null`.

## Enrollment tokens

The dashboard creates an agent and its first credential together with `createAgentWithEnrollment`, so a failed token insert leaves no agent behind. A failed rollback surfaces as an `AggregateError`.

An enrollment token is `enroll_` plus 64 hex characters. Only its SHA-256 hash is stored, in `agent_tokens` with the label `enrollment:<agent id>` and a 15-minute `expires_at`. No migration is involved. The distinct prefix and label keep it from authenticating as a durable `ff_` token.

`exchangeEnrollmentToken` runs in one transaction. It locks the matching row with `SELECT ... FOR UPDATE`, requires that the row is unrevoked, unexpired by the database clock and labelled as an enrollment, revokes it and inserts a durable `ff_` token labelled `instance:<instance id>` with a one-year expiry. Of two concurrent exchanges exactly one succeeds. An unknown, expired, revoked, replayed or non-enrollment credential returns `null`, and the caller cannot tell which.

## Testing

```bash
npm test        # unit suites mock the pg pool — no database required
npm run test:watch
```

The `tests/collaboration/` suites and the real-database query suites (see
[tests/queries](tests/queries/README.md)) are the exception: they run against a REAL
disposable Postgres and require `COLLAB_DB_TEST_DATABASE_URL` pointing at a
dedicated loopback `ff_*` database (never the project default or a shared
database — resets drop and recreate the public schema; the guard enforces
naming + loopback + test mode). The dashboard auth-workspace regression additionally
requires `COLLAB_AUTH_TEST_DATABASE_URL` pointing at its own dedicated loopback
`ff_*` database. CI provisions independent `ff_db_test`, `ff_server_test`,
`ff_connector_test`, `ff_legacy_test` and `ff_auth_test` automatically
(see `.github/workflows/ci.yml`).

For local browser/UAT fixtures run `node scripts/collab-fixture.mjs
--database postgres://…ff_fixture` (see [scripts/README.md](scripts/README.md)).

Collaboration schema is additive-only (`collab_*` tables; migrations
`0010`+ forward-only, journal entries appended under `src/migrations/meta`).
