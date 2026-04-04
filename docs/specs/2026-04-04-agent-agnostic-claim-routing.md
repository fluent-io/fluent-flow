# Agent-Agnostic Claim Routing

## Problem

When a review fails, the server must assign a claim to an agent that can fix it. Today, the agent is resolved by ID: `agentId` (from PR body marker) > `config.default_agent` > `config.agent_id`. This requires every repo to pre-configure a specific agent ID, and breaks when the named agent has no online sessions.

In a multi-tenant SaaS, companies register multiple agents of different types (Claude Code on dev machines, Codex on headless servers, Copilot via GitHub). The server should route work to **any available agent** that can handle the repo, not a pre-configured default.

## Design

### Resolution algorithm

When a review fails and a claim needs to be created:

```
resolveAvailableAgent(orgId, repo, prNumber):

  1. Explicit override (PR body marker):
     If PR body contains <!-- fluent-flow-agent: agent-id -->,
     use that agent. Skip to step 4.

  2. PR affinity:
     Find the most recent claim for this PR.
     If that claim's session is still online, reuse it.
     Return { agentId, sessionId }.

  3. Any available session:
     Find all agents in this org where:
       - agent.repos includes this repo, OR agent.repos is empty (handles all repos)
     Among those agents, find the first online session
     ordered by last_seen_at DESC (most recently active first).
     Return { agentId, sessionId }.

  4. No session available:
     Create claim with status 'pending' and the agentId from step 1
     (or null if no explicit override).
     When an agent registers a session and polls, the server matches
     pending claims to the new session by checking repo scope.
```

### Pending claim pickup

Today, pending claims have `session_id = NULL` and `status = 'pending'`. The poll handler needs to check for these and assign them:

```
handlePoll(orgId, agentId, sessionId):

  1. Check for claims already assigned to this session (existing behavior).
  2. If none, check for pending claims where:
     - claim.session_id IS NULL AND claim.status = 'pending', AND
     - this agent's repos includes the claim's repo (or agent.repos is empty)
     Claim the first match: set session_id, status = 'claimed', claimed_at, expires_at.
```

### Changes to review-manager.js

`handleReviewResult()` line 148 currently does:

```js
const resolvedAgent = agentId ?? config.default_agent ?? config.agent_id;
```

Replace with:

```js
// Explicit override from PR body marker
const explicitAgent = agentId;

// Find any available session for this repo
const resolved = await resolveAvailableAgent(
  config.org_id ?? 'self-hosted',
  `${owner}/${repo}`,
  prNumber,
  explicitAgent
);
```

If `resolved` returns `{ agentId, sessionId }`, create the claim with both. If `resolved` is null, create a pending claim with `agent_id: explicitAgent ?? null`.

### Changes to session-manager.js

New function: `findAvailableSession(orgId, repo, prNumber)`

Query: join `agent_sessions` with `agents`, filter by:
- `agent_sessions.status = 'online'`
- `agent_sessions.expires_at > NOW()`
- `agents.repos @> ARRAY[repo]` OR `agents.repos = '{}'`
- Order by `agent_sessions.last_seen_at DESC`
- Return first match with its `agent_id`

PR affinity check: query `agent_claims` for the most recent claim on this PR, check if that session is still online.

### Changes to claim-manager.js

`createClaim` takes `agentId` but only passes it to `resolveSession` — the claim table itself has no `agent_id` column, only `session_id`. Change `createClaim` to call `findAvailableSession(orgId, repo, prNumber)` instead of `resolveSession(orgId, agentId, repo, prNumber)`. When an explicit agent is specified (PR body marker), pass it to narrow the search.

### Changes to runner poll handler

`handlePoll` in `routes/runner.js` currently only checks for claims assigned to the polling agent. Add a second check: find unassigned pending claims that match the agent's repo scope, claim them atomically.

### What stays the same

- Agent registration, tokens, runner CLI — unchanged.
- `<!-- fluent-flow-agent: id -->` PR body marker — still works as explicit override.
- Claim lifecycle (claimed > completed/failed/expired) — unchanged.
- Long-poll transport, webhook transport — unchanged.
- Config file format — `default_agent` becomes optional, ignored for long-poll routing.

### Interaction with GitHub App (future)

When the GitHub App replaces PAT-based auth, the server performs reviews itself. On review failure, the same `resolveAvailableAgent` function runs. The GitHub App changes where reviews happen (server-side vs GitHub Actions), not how claims are routed.

### Interaction with Admin UI (future)

The Admin UI will let operators register agents, view sessions, and monitor claims. Agent-agnostic routing means the UI doesn't need a "default agent" dropdown per repo — registering agents and scoping their repos is sufficient. The UI can show which agents are online and eligible for each repo.

## Database changes

Minimal. The existing schema mostly supports this:
- `agents.repos` already stores repo scope as `TEXT[]`
- `agent_claims` links to agents via `session_id` (FK to `agent_sessions`), not a direct `agent_id` column
- `agent_sessions` already tracks online/offline status and expiry
- `agent_claims.session_id` is already nullable (pending claims have no session)

No migration needed. Pending claims already work with `session_id = NULL`. The resolution logic changes are purely in application code.

## Verification

1. Register two agents with different IDs but overlapping repo scope
2. Start a runner for each agent
3. Push a PR that fails review
4. Verify the claim is assigned to whichever agent has an online session
5. Stop one runner, push another failing PR
6. Verify the claim goes to the remaining online agent
7. Stop all runners, push a failing PR
8. Verify the claim is created as pending (agent_id = NULL)
9. Start a runner — verify it picks up the pending claim on next poll
10. Test explicit override: PR with `<!-- fluent-flow-agent: specific-id -->` routes to that agent regardless
