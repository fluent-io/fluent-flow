# Agent System

DB-backed agent registry, session management, claim-based work queue, and token authentication.

## Architecture

```
Admin API (/api/agents)          Runner API (/api/runner)
        │                                │
        ▼                                ▼
┌─────────────────┐            ┌──────────────────┐
│  agent-manager   │            │  token-manager    │ ← authenticates runners
│  org-manager     │            │  session-manager  │ ← registers/tracks sessions
└─────────────────┘            │  claim-manager    │ ← assigns/tracks work
                               └──────────────────┘
```

## Modules

### org-manager.js
- `createOrg(id, name)` — create an organization
- `getOrg(id)` — look up org by ID
- `bootstrapSelfHosted()` — idempotent, creates `self-hosted` org on startup

### agent-manager.js
- `createAgent({ id, orgId, agentType, transport, transportMeta, repos })`
- `getAgent(orgId, agentId)` / `listAgents(orgId)`
- `updateAgent(orgId, agentId, fields)` — partial update, only specified fields
- `deleteAgent(orgId, agentId)` — cascades to tokens and sessions

### token-manager.js
Tokens authenticate runners. SHA-256 hashed, `ff_` prefixed, 67 chars total.
- `createToken(orgId, agentId, label)` — returns plaintext (shown once)
- `validateToken(plaintext)` — returns `{ org_id, agent_id }` or null
- `revokeToken(orgId, tokenId)` — soft revoke
- `listTokens(orgId, agentId)` — hashes redacted

### session-manager.js
Sessions are ephemeral runner instances with TTL.
- `registerSession(orgId, agentId, meta)` — 5min default TTL
- `touchSession(orgId, agentId, sessionId)` — extends TTL on poll
- `expireSessions()` — marks expired sessions offline
- `resolveSession(orgId, agentId, repo, prNumber)` — PR affinity → first available
- `setSessionStatus(orgId, agentId, sessionId, status)` — scoped by org+agent

### claim-manager.js
Claims track work assignments per review attempt.
- `createClaim({ orgId, repo, prNumber, attempt, agentId, payload, claimType })` — resolves session, marks busy
- `completeClaim(orgId, repo, prNumber, attempt)` — frees session to online
- `failClaim(orgId, repo, prNumber, attempt)` — frees session to online
- `expireClaims()` — marks expired claims, sets sessions offline
- `getActiveClaim(orgId, repo, prNumber)` — latest pending/claimed claim

## Claim Lifecycle

```
Review fails → createClaim (pending or claimed)
                    │
          ┌─────────┴─────────┐
          ▼                   ▼
     No session          Session found
     (pending)           (claimed, busy)
          │                   │
          │        ┌──────────┴──────────┐
          │        ▼                     ▼
          │   Agent fixes code      Claim expires
          │   Review passes         (session → offline)
          │        │
          │        ▼
          │   completeClaim
          │   (session → online)
          │
          └── Re-assigned when session becomes available
```

## Multi-tenancy

All tables include `org_id`. Self-hosted deployments use a single `self-hosted` org bootstrapped on startup. All queries are scoped by org.

## DB Tables

- `orgs` — tenant root (migration 005)
- `agents` — agent identities with transport config (migration 005)
- `agent_tokens` — SHA-256 hashed auth tokens (migration 005)
- `agent_sessions` — ephemeral runner instances with TTL (migration 006)
- `agent_claims` — per-attempt work assignments with claim_type (migration 007)
