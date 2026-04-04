# Agent-Agnostic Claim Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route review failure claims to any available agent that can handle the repo, instead of requiring a pre-configured default agent ID.

**Architecture:** Add `findAvailableSession(orgId, repo, prNumber)` to session-manager that searches across all agents with matching repo scope. Update `createClaim` to use it. Update the poll handler to pick up unassigned pending claims. Remove the hard requirement for `config.default_agent` in the review failure path.

**Tech Stack:** Node.js, ESM, raw pg queries, Vitest, Zod

---

### Task 1: Add `findAvailableSession` to session-manager

**Files:**
- Modify: `packages/fluent-flow/src/agents/session-manager.js`
- Test: `packages/fluent-flow/tests/unit/session-manager.test.js`

- [ ] **Step 1: Write failing test — PR affinity across agents**

Add to `tests/unit/session-manager.test.js`:

```js
describe('findAvailableSession', () => {
  it('returns previous session for same PR if still online', async () => {
    // 1. agent_claims query returns a prior session
    mockQuery.mockResolvedValueOnce({ rows: [{ session_id: 5 }] });
    // 2. session online check passes
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 5, agent_id: 'cc' }] });
    const result = await findAvailableSession('acme', 'owner/repo', 7);
    expect(result).toEqual({ agentId: 'cc', sessionId: 5 });
  });

  it('finds any online session with matching repo scope', async () => {
    // 1. No prior claim
    mockQuery.mockResolvedValueOnce({ rows: [] });
    // 2. Cross-agent session search returns a match
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 3, agent_id: 'runner1' }] });
    const result = await findAvailableSession('acme', 'owner/repo', 7);
    expect(result).toEqual({ agentId: 'runner1', sessionId: 3 });
  });

  it('returns null when no sessions available', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const result = await findAvailableSession('acme', 'owner/repo', 7);
    expect(result).toBeNull();
  });

  it('skips affinity if previous session is offline', async () => {
    // 1. Prior claim exists
    mockQuery.mockResolvedValueOnce({ rows: [{ session_id: 5 }] });
    // 2. Session is offline
    mockQuery.mockResolvedValueOnce({ rows: [] });
    // 3. Cross-agent search finds another
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 8, agent_id: 'runner2' }] });
    const result = await findAvailableSession('acme', 'owner/repo', 7);
    expect(result).toEqual({ agentId: 'runner2', sessionId: 8 });
  });
});
```

Update the import line to include `findAvailableSession`:

```js
const { registerSession, touchSession, expireSessions, getActiveSessions, resolveSession, setSessionStatus, findAvailableSession } = await import('../../src/agents/session-manager.js');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/fluent-flow && npx vitest run tests/unit/session-manager.test.js`
Expected: FAIL — `findAvailableSession` is not exported

- [ ] **Step 3: Implement `findAvailableSession`**

Add to `packages/fluent-flow/src/agents/session-manager.js`:

```js
/**
 * Find any available session across all agents that can handle this repo.
 * Priority: previous session for this PR → first available session with repo scope match.
 * @param {string} orgId
 * @param {string} repo - "owner/repo"
 * @param {number} prNumber
 * @returns {Promise<{agentId: string, sessionId: number}|null>}
 */
export async function findAvailableSession(orgId, repo, prNumber) {
  // 1. PR affinity — check if a prior claim used a session still online
  try {
    const prev = await query(
      `SELECT c.session_id FROM agent_claims c
       WHERE c.org_id = $1 AND c.repo = $2 AND c.pr_number = $3
         AND c.status IN ('completed', 'expired')
       ORDER BY c.attempt DESC LIMIT 1`,
      [orgId, repo, prNumber]
    );
    if (prev.rows[0]?.session_id) {
      const check = await query(
        `SELECT s.id, s.agent_id FROM agent_sessions s
         WHERE s.id = $1 AND s.status = 'online' AND s.expires_at > NOW()`,
        [prev.rows[0].session_id]
      );
      if (check.rows[0]) {
        return { agentId: check.rows[0].agent_id, sessionId: check.rows[0].id };
      }
    }
  } catch (err) {
    if (err?.code !== '42P01') throw err;
  }

  // 2. Any available session — join sessions with agents, filter by repo scope
  const avail = await query(
    `SELECT s.id, s.agent_id FROM agent_sessions s
     JOIN agents a ON a.org_id = s.org_id AND a.id = s.agent_id
     WHERE s.org_id = $1 AND s.status = 'online' AND s.expires_at > NOW()
       AND (a.repos = '{}' OR $2 = ANY(a.repos))
     ORDER BY s.last_seen_at DESC LIMIT 1`,
    [orgId, repo]
  );
  if (avail.rows[0]) {
    return { agentId: avail.rows[0].agent_id, sessionId: avail.rows[0].id };
  }

  return null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/fluent-flow && npx vitest run tests/unit/session-manager.test.js`
Expected: PASS — all tests including new `findAvailableSession` tests

- [ ] **Step 5: Commit**

```bash
git add packages/fluent-flow/src/agents/session-manager.js packages/fluent-flow/tests/unit/session-manager.test.js
git commit -m "feat: add findAvailableSession for cross-agent routing"
```

---

### Task 2: Update `createClaim` to use `findAvailableSession`

**Files:**
- Modify: `packages/fluent-flow/src/agents/claim-manager.js`
- Test: `packages/fluent-flow/tests/unit/claim-manager.test.js` (in `tests/unit/` — check existing file)

- [ ] **Step 1: Write failing test — createClaim without agentId**

Check existing test file location:

```bash
ls packages/fluent-flow/tests/unit/claim*
```

Add test to the claim-manager test file:

```js
describe('createClaim without agentId', () => {
  it('uses findAvailableSession when agentId is not provided', async () => {
    mockFindAvailableSession.mockResolvedValueOnce({ agentId: 'runner1', sessionId: 3 });
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 1, session_id: 3, status: 'claimed' }] });
    mockSetSessionStatus.mockResolvedValueOnce();
    const claim = await createClaim({
      orgId: 'acme', repo: 'owner/repo', prNumber: 1, attempt: 1, payload: {},
    });
    expect(mockFindAvailableSession).toHaveBeenCalledWith('acme', 'owner/repo', 1);
    expect(claim.session_id).toBe(3);
  });

  it('creates pending claim when no session available and no agentId', async () => {
    mockFindAvailableSession.mockResolvedValueOnce(null);
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 1, session_id: null, status: 'pending' }] });
    const claim = await createClaim({
      orgId: 'acme', repo: 'owner/repo', prNumber: 1, attempt: 1, payload: {},
    });
    expect(claim.status).toBe('pending');
  });

  it('uses resolveSession when agentId is provided', async () => {
    mockResolveSession.mockResolvedValueOnce(5);
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 1, session_id: 5, status: 'claimed' }] });
    mockSetSessionStatus.mockResolvedValueOnce();
    const claim = await createClaim({
      orgId: 'acme', repo: 'owner/repo', prNumber: 1, attempt: 1, agentId: 'explicit', payload: {},
    });
    expect(mockResolveSession).toHaveBeenCalledWith('acme', 'explicit', 'owner/repo', 1);
  });
});
```

Mock `findAvailableSession` alongside the existing `resolveSession` mock:

```js
const mockFindAvailableSession = vi.fn();
vi.mock('../../src/agents/session-manager.js', () => ({
  resolveSession: (...args) => mockResolveSession(...args),
  findAvailableSession: (...args) => mockFindAvailableSession(...args),
  setSessionStatus: (...args) => mockSetSessionStatus(...args),
}));
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/fluent-flow && npx vitest run tests/unit/claim-manager.test.js`
Expected: FAIL — `createClaim` without `agentId` still calls `resolveSession` which requires it

- [ ] **Step 3: Update `createClaim` implementation**

In `packages/fluent-flow/src/agents/claim-manager.js`, add import and update logic:

```js
import { resolveSession, setSessionStatus, findAvailableSession } from './session-manager.js';
```

Update `createClaim` function body:

```js
export async function createClaim({ orgId, repo, prNumber, attempt, agentId, payload, claimType = 'review_fix', ttlMs = DEFAULT_CLAIM_TTL_MS }) {
  let sessionId = null;
  let resolvedAgentId = agentId;

  if (agentId) {
    // Explicit agent — resolve within that agent's sessions
    sessionId = await resolveSession(orgId, agentId, repo, prNumber);
  } else {
    // No explicit agent — find any available session for this repo
    const available = await findAvailableSession(orgId, repo, prNumber);
    if (available) {
      sessionId = available.sessionId;
      resolvedAgentId = available.agentId;
    }
  }

  const status = sessionId ? 'claimed' : 'pending';
  const claimedAt = sessionId ? new Date().toISOString() : null;
  const expiresAt = sessionId ? new Date(Date.now() + ttlMs).toISOString() : null;

  const result = await query(
    `INSERT INTO agent_claims (org_id, repo, pr_number, attempt, session_id, claim_type, status, payload, claimed_at, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (org_id, repo, pr_number, attempt)
     DO UPDATE SET session_id = $5, claim_type = $6, status = $7, payload = $8, claimed_at = $9, expires_at = $10
     RETURNING *`,
    [orgId, repo, prNumber, attempt, sessionId, claimType, status, JSON.stringify(payload), claimedAt, expiresAt]
  );

  if (sessionId && resolvedAgentId) {
    await setSessionStatus(orgId, resolvedAgentId, sessionId, 'busy');
  }

  const claim = result.rows[0];
  audit('claim_created', { repo, data: { claimId: claim.id, prNumber, attempt, sessionId, status, claimType } });
  logger.info({ msg: 'Claim created', orgId, repo, prNumber, attempt, sessionId, status, claimType });
  return claim;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/fluent-flow && npx vitest run tests/unit/claim-manager.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/fluent-flow/src/agents/claim-manager.js packages/fluent-flow/tests/unit/claim-manager.test.js
git commit -m "feat: createClaim routes to any available agent when agentId omitted"
```

---

### Task 3: Update `handleReviewResult` to drop required agentId

**Files:**
- Modify: `packages/fluent-flow/src/engine/review-manager.js`
- Test: `packages/fluent-flow/tests/unit/review-manager.test.js`

- [ ] **Step 1: Write failing test — review failure creates claim without default_agent**

Add to `tests/unit/review-manager.test.js` (find the existing test for review failure):

```js
it('creates claim without requiring default_agent or agentId', async () => {
  mockClaimDispatch.mockResolvedValueOnce({ id: 1, retry_count: 0 });
  mockCreateClaim.mockResolvedValueOnce({ id: 1, session_id: 3, status: 'claimed' });

  await handleReviewResult({
    owner: 'fluent-io', repo: 'fluent-flow', prNumber: 40,
    result: { status: 'FAIL', blocking: [{ file: 'a.js', line: 1, issue: 'bug', fix: 'fix it' }], advisory: [] },
    reviewSha: 'abc123',
    // No agentId passed
  });

  expect(mockCreateClaim).toHaveBeenCalledWith(
    expect.objectContaining({ agentId: undefined })
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/fluent-flow && npx vitest run tests/unit/review-manager.test.js`
Expected: FAIL — current code skips claim creation when `resolvedAgent` is falsy (line 149: `if (resolvedAgent)`)

- [ ] **Step 3: Update `handleReviewResult`**

In `packages/fluent-flow/src/engine/review-manager.js`, replace lines 147-177:

```js
  // Create claim — agentId is optional; claim-manager will find any available session
  const explicitAgent = agentId;
  try {
    await createClaim({
      orgId: config.org_id ?? 'self-hosted',
      repo: repoKey,
      prNumber,
      attempt,
      agentId: explicitAgent,
      payload: {
        message: formatRichMessage({ repo: repoKey, prNumber, attempt, blocking, advisory }),
        issues: allIssues,
        onFailure: config.reviewer?.on_failure,
      },
    });
  } catch (err) {
    logger.warn({ msg: 'Failed to create claim on review failure', error: err.message });
  }

  // Notify agent if we know which one (explicit or resolved from config)
  const notifyAgent = explicitAgent ?? config.default_agent ?? config.agent_id;
  if (notifyAgent) {
    await notifyReviewFailure({
      agentId: notifyAgent,
      repo: repoKey,
      prNumber,
      attempt,
      issues: allIssues,
      onFailure: config.reviewer?.on_failure,
      delivery: config.delivery ?? {},
    });
  }
```

Key change: claim creation always happens (no `if (resolvedAgent)` gate). Notification still uses an explicit or config-based agent if available, but the claim is created regardless so a polling runner can pick it up.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/fluent-flow && npx vitest run tests/unit/review-manager.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/fluent-flow/src/engine/review-manager.js packages/fluent-flow/tests/unit/review-manager.test.js
git commit -m "feat: always create claim on review failure, agentId optional"
```

---

### Task 4: Update poll handler to pick up pending claims

**Files:**
- Modify: `packages/fluent-flow/src/routes/runner.js`
- Test: `packages/fluent-flow/tests/unit/runner-poll.test.js` (check if exists, else create)

- [ ] **Step 1: Write failing test — poll picks up pending claim**

Create or update the runner poll test:

```js
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockValidateToken = vi.fn();
const mockTouchSession = vi.fn();
const mockQuery = vi.fn();
const mockHasPending = vi.fn();
const mockDequeue = vi.fn();

vi.mock('../../src/agents/token-manager.js', () => ({
  validateToken: (...args) => mockValidateToken(...args),
}));
vi.mock('../../src/agents/session-manager.js', () => ({
  registerSession: vi.fn(),
  touchSession: (...args) => mockTouchSession(...args),
}));
vi.mock('../../src/agents/claim-manager.js', () => ({
  completeClaim: vi.fn(),
  failClaim: vi.fn(),
}));
vi.mock('../../src/notifications/transports/long-poll.js', () => ({
  dequeue: (...args) => mockDequeue(...args),
  hasPending: (...args) => mockHasPending(...args),
}));
vi.mock('../../src/db/client.js', () => ({
  query: (...args) => mockQuery(...args),
  audit: vi.fn(),
}));
vi.mock('../../src/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { handlePoll } = await import('../../src/routes/runner.js');

describe('handlePoll pending claim pickup', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('picks up unassigned pending claim when long-poll queue is empty', async () => {
    mockTouchSession.mockResolvedValue();
    mockHasPending.mockReturnValue(false);
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 1, repo: 'owner/repo', pr_number: 5, attempt: 1, payload: '{"message":"fix"}' }],
    });

    const req = {
      body: { session_id: 10 },
      tokenInfo: { org_id: 'acme', agent_id: 'runner1' },
      on: vi.fn(),
    };
    const res = { json: vi.fn(), status: vi.fn().mockReturnThis() };

    await handlePoll(req, res, { pollTimeoutMs: 0 });

    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('agent_claims'),
      expect.arrayContaining(['acme', 'runner1', 10])
    );
    expect(res.json).toHaveBeenCalledWith({
      work: expect.objectContaining({ repo: 'owner/repo', pr_number: 5 }),
    });
  });

  it('returns null when no pending claims and no long-poll work', async () => {
    mockTouchSession.mockResolvedValue();
    mockHasPending.mockReturnValue(false);
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const req = {
      body: { session_id: 10 },
      tokenInfo: { org_id: 'acme', agent_id: 'runner1' },
      on: vi.fn(),
    };
    const res = { json: vi.fn(), status: vi.fn().mockReturnThis() };

    await handlePoll(req, res, { pollTimeoutMs: 0 });
    expect(res.json).toHaveBeenCalledWith({ work: null });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/fluent-flow && npx vitest run tests/unit/runner-poll.test.js`
Expected: FAIL — `handlePoll` doesn't query for pending claims

- [ ] **Step 3: Update `handlePoll` to check pending claims**

In `packages/fluent-flow/src/routes/runner.js`, add import and helper:

```js
import { query } from '../db/client.js';
```

Add a function before `handlePoll`:

```js
/**
 * Check for unassigned pending claims that match this agent's repo scope.
 * Atomically claims the first match.
 * @param {string} orgId
 * @param {string} agentId
 * @param {number} sessionId
 * @param {number} ttlMs
 * @returns {Promise<object|null>}
 */
async function claimPendingWork(orgId, agentId, sessionId, ttlMs = 15 * 60 * 1000) {
  const expiresAt = new Date(Date.now() + ttlMs).toISOString();
  const result = await query(
    `UPDATE agent_claims SET
       session_id = $3, status = 'claimed', claimed_at = NOW(), expires_at = $4
     WHERE id = (
       SELECT c.id FROM agent_claims c
       JOIN agents a ON a.org_id = c.org_id AND a.id = $2
       WHERE c.org_id = $1 AND c.status = 'pending' AND c.session_id IS NULL
         AND (a.repos = '{}' OR c.repo = ANY(a.repos))
       ORDER BY c.created_at ASC
       LIMIT 1
       FOR UPDATE SKIP LOCKED
     )
     RETURNING *`,
    [orgId, agentId, sessionId, expiresAt]
  );
  return result.rows[0] ?? null;
}
```

Update `handlePoll` — after checking `hasPending(sessionId)` returns false and before the long-poll timeout loop, add:

```js
    // Check for unassigned pending claims in the DB
    const pendingClaim = await claimPendingWork(org_id, agent_id, sessionId);
    if (pendingClaim) {
      const payload = typeof pendingClaim.payload === 'string'
        ? JSON.parse(pendingClaim.payload)
        : pendingClaim.payload;
      respond({
        work: {
          repo: pendingClaim.repo,
          pr_number: pendingClaim.pr_number,
          attempt: pendingClaim.attempt,
          claim_id: pendingClaim.id,
          ...payload,
        },
      });
      return;
    }
```

Place this block after the first `hasPending` check (line 88) and before the `pollTimeoutMs === 0` check.

Also add the pending claim check inside the polling loop (after `hasPending` check at line 97), so pending claims are picked up during long-poll waits too.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/fluent-flow && npx vitest run tests/unit/runner-poll.test.js`
Expected: PASS

- [ ] **Step 5: Run full test suite**

Run: `cd packages/fluent-flow && npx vitest run`
Expected: All tests pass

- [ ] **Step 6: Commit**

```bash
git add packages/fluent-flow/src/routes/runner.js packages/fluent-flow/tests/unit/runner-poll.test.js
git commit -m "feat: poll handler picks up unassigned pending claims"
```

---

### Task 5: End-to-end verification

- [ ] **Step 1: Run full test suite**

```bash
cd packages/fluent-flow && npx vitest run
```

Expected: All tests pass (existing + new)

- [ ] **Step 2: Run runner tests**

```bash
cd packages/fluent-flow-runner && npx vitest run
```

Expected: All runner tests pass (no changes to runner package)

- [ ] **Step 3: Commit docs**

```bash
git add docs/
git commit -m "docs: move docs to repo root, add agent-agnostic routing spec and plan"
```

- [ ] **Step 4: Push and create PR**

```bash
git push -u origin feat/agent-agnostic-routing
gh pr create --title "feat: agent-agnostic claim routing" --body "## Summary
- Claims route to any available agent with matching repo scope
- No default_agent config required — server finds online sessions automatically
- Poll handler picks up unassigned pending claims
- PR body marker still works as explicit override

Spec: docs/specs/2026-04-04-agent-agnostic-claim-routing.md

## Test plan
- [ ] Two agents registered, claim goes to whichever is online
- [ ] No agents online → pending claim → runner picks up on connect
- [ ] Explicit PR body marker overrides auto-routing
- [ ] Full test suite passes"
```
