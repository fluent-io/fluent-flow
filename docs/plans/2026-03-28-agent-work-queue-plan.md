# Agent Work Queue — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the static `agents.yml` file with a DB-backed agent registry, claim-based work queue, and long-poll runner transport so that review feedback is deterministically pushed to agents in single or multi-agent pools.

**Architecture:** Five new DB tables (`orgs`, `agents`, `agent_tokens`, `agent_sessions`, `agent_claims`) added incrementally across three vertical slices. Each slice delivers end-to-end verifiable functionality. A claim manager creates, assigns, and expires claims. The dispatcher integrates with the claim manager to resolve sessions. A new long-poll transport serves `fluent-flow-runner` instances.

**Tech Stack:** Node.js, Express, raw pg queries, Zod validation, Vitest, ESM imports, pino logger.

**Spec:** [docs/plans/2026-03-28-agent-work-queue-design.md](2026-03-28-agent-work-queue-design.md)

---

## Vertical Slices

| Slice | Delivers | E2E Verification |
|---|---|---|
| **1: Agent Registry** | Admin can create agents, issue tokens, bootstrap org | `curl` → create agent → create token → list agents → token validates |
| **2: Runner Connection** | Runner can connect, authenticate, register session, long-poll | Token from Slice 1 → register session → poll returns empty → session visible |
| **3: Review → Claim → Runner** | Review failure creates claim, pushes to runner, runner reports back | Mock review failure → claim created → poll returns payload → report result → claim completed |
| **4: Polish** | MCP tools, agents.yml deprecation, mock factories | MCP `create_agent` works, YAML agents log deprecation warning |

---

## File Structure

### New Files

| File | Slice | Responsibility |
|---|---|---|
| `src/db/migrations/005_agent_registry.sql` | 1 | Schema: orgs, agents, agent_tokens |
| `src/db/migrations/006_agent_sessions.sql` | 2 | Schema: agent_sessions |
| `src/db/migrations/007_agent_claims.sql` | 3 | Schema: agent_claims |
| `src/agents/org-manager.js` | 1 | Org CRUD + self-hosted bootstrap |
| `src/agents/agent-manager.js` | 1 | Agent CRUD |
| `src/agents/token-manager.js` | 1 | Token create, validate, revoke |
| `src/agents/session-manager.js` | 2 | Session register, heartbeat, expire, resolve |
| `src/agents/claim-manager.js` | 3 | Claim create, assign, complete, expire |
| `src/notifications/transports/long-poll.js` | 2 | Long-poll transport (server-side queue) |
| `src/routes/agents.js` | 1 | REST API: agent CRUD, tokens |
| `src/routes/runner.js` | 2 | REST API: register, poll, claim result |
| `src/mcp/tools/agents.js` | 4 | MCP tools: create_agent, list_agents, etc. |
| `tests/unit/org-manager.test.js` | 1 | Tests for org manager |
| `tests/unit/agent-manager.test.js` | 1 | Tests for agent CRUD |
| `tests/unit/token-manager.test.js` | 1 | Tests for token operations |
| `tests/unit/routes-agents.test.js` | 1 | Tests for agent REST API |
| `tests/unit/session-manager.test.js` | 2 | Tests for session lifecycle |
| `tests/unit/long-poll-transport.test.js` | 2 | Tests for long-poll transport |
| `tests/unit/routes-runner.test.js` | 2 | Tests for runner REST API |
| `tests/unit/claim-manager.test.js` | 3 | Tests for claim lifecycle |

### Modified Files

| File | Slice | Change |
|---|---|---|
| `src/db/client.js` | 1,2,3 | Add migrations to array (one per slice) |
| `src/index.js` | 1,2 | Mount routers, bootstrap org |
| `src/notifications/transports/index.js` | 2 | Register `long_poll` transport |
| `src/notifications/dispatcher.js` | 3 | DB agent lookup, pass session_id for long-poll |
| `src/engine/review-manager.js` | 3 | Create claims on review failure, complete on pass |
| `src/config/agents.js` | 4 | DB-first lookup with YAML deprecation warning |
| `src/mcp/server.js` | 4 | Register agent management tools |
| `tests/helpers/mocks.js` | 4 | Add agent/session/claim mock factories |
| `tests/unit/review-manager.test.js` | 3 | Add claim integration tests |
| `tests/unit/dispatcher.test.js` | 3 | Add DB agent lookup tests |

---

# SLICE 1: Agent Registry

**Delivers:** Admin can create agents, issue tokens, and list them. Self-hosted org bootstraps on startup.

**E2E Verification:**
```bash
curl POST /api/agents → 201, agent created
curl POST /api/agents/:id/tokens → 201, plaintext token returned
curl GET /api/agents → list includes the agent
```

---

## Task 1.1: Migration — orgs, agents, agent_tokens

**Files:**
- Create: `src/db/migrations/005_agent_registry.sql`
- Modify: `src/db/client.js`

- [ ] **Step 1: Write the migration SQL**

Create `src/db/migrations/005_agent_registry.sql`:

```sql
-- Orgs: multi-tenant root
CREATE TABLE IF NOT EXISTS orgs (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  settings      JSONB DEFAULT '{}',
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- Agents: admin-managed identities
CREATE TABLE IF NOT EXISTS agents (
  id            TEXT NOT NULL,
  org_id        TEXT NOT NULL REFERENCES orgs(id),
  agent_type    TEXT NOT NULL,
  transport     TEXT NOT NULL,
  transport_meta JSONB DEFAULT '{}',
  repos         TEXT[] DEFAULT '{}',
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (org_id, id)
);

-- Agent tokens: auth for runners and API
CREATE TABLE IF NOT EXISTS agent_tokens (
  id            SERIAL PRIMARY KEY,
  org_id        TEXT NOT NULL REFERENCES orgs(id),
  agent_id      TEXT NOT NULL,
  token_hash    TEXT NOT NULL,
  label         TEXT,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  expires_at    TIMESTAMPTZ,
  revoked_at    TIMESTAMPTZ,
  FOREIGN KEY (org_id, agent_id) REFERENCES agents(org_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_agent_tokens_lookup
  ON agent_tokens(org_id, agent_id) WHERE revoked_at IS NULL;
```

- [ ] **Step 2: Register migration in client.js**

In `src/db/client.js`, update the migrations array:

```javascript
const migrations = ['001_initial.sql', '002_audit_log.sql', '003_mcp_pending.sql', '004_dispatch_dedup.sql', '005_agent_registry.sql'];
```

- [ ] **Step 3: Verify migration runs**

Run: `npm run dev`

Expected: log line "Migration applied, file: 005_agent_registry.sql", server starts. Stop the server.

- [ ] **Step 4: Commit**

```bash
git add src/db/migrations/005_agent_registry.sql src/db/client.js
git commit -m "feat: add migration 005 for orgs, agents, agent_tokens tables"
```

---

## Task 1.2: Org Manager + Bootstrap

**Files:**
- Create: `src/agents/org-manager.js`
- Create: `tests/unit/org-manager.test.js`
- Modify: `src/index.js`

- [ ] **Step 1: Write failing tests**

Create `tests/unit/org-manager.test.js`:

```javascript
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockQuery = vi.fn();
vi.mock('../../src/db/client.js', () => ({
  query: (...args) => mockQuery(...args),
  audit: vi.fn(),
}));

vi.mock('../../src/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { createOrg, getOrg, bootstrapSelfHosted } = await import('../../src/agents/org-manager.js');

describe('org-manager', () => {
  beforeEach(() => { mockQuery.mockReset(); });

  describe('createOrg', () => {
    it('inserts an org and returns it', async () => {
      const org = { id: 'acme', name: 'Acme Corp' };
      mockQuery.mockResolvedValueOnce({ rows: [{ ...org, settings: {}, created_at: '2026-03-28T00:00:00Z' }] });
      const result = await createOrg(org.id, org.name);
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO orgs'),
        ['acme', 'Acme Corp', '{}']
      );
      expect(result.id).toBe('acme');
    });

    it('throws on duplicate org', async () => {
      mockQuery.mockRejectedValueOnce(new Error('duplicate key'));
      await expect(createOrg('acme', 'Acme')).rejects.toThrow('duplicate key');
    });
  });

  describe('getOrg', () => {
    it('returns the org if found', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ id: 'acme', name: 'Acme Corp' }] });
      const result = await getOrg('acme');
      expect(result.id).toBe('acme');
    });

    it('returns null if not found', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });
      const result = await getOrg('missing');
      expect(result).toBeNull();
    });
  });

  describe('bootstrapSelfHosted', () => {
    it('creates default org if none exists', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] }); // getOrg returns nothing
      mockQuery.mockResolvedValueOnce({ rows: [{ id: 'self-hosted', name: 'Self-Hosted' }] }); // createOrg
      const result = await bootstrapSelfHosted();
      expect(result.id).toBe('self-hosted');
      expect(mockQuery).toHaveBeenCalledTimes(2);
    });

    it('skips creation if org already exists', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ id: 'self-hosted', name: 'Self-Hosted' }] });
      const result = await bootstrapSelfHosted();
      expect(result.id).toBe('self-hosted');
      expect(mockQuery).toHaveBeenCalledTimes(1);
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/unit/org-manager.test.js`

Expected: FAIL — module `../../src/agents/org-manager.js` not found.

- [ ] **Step 3: Implement org-manager.js**

Create `src/agents/org-manager.js`:

```javascript
import { query, audit } from '../db/client.js';
import logger from '../logger.js';

const SELF_HOSTED_ORG_ID = 'self-hosted';

/**
 * Create an org.
 * @param {string} id
 * @param {string} name
 * @param {object} [settings={}]
 * @returns {Promise<object>}
 */
export async function createOrg(id, name, settings = {}) {
  const result = await query(
    `INSERT INTO orgs (id, name, settings) VALUES ($1, $2, $3) RETURNING *`,
    [id, name, JSON.stringify(settings)]
  );
  audit('org_created', { data: { orgId: id } });
  return result.rows[0];
}

/**
 * Get an org by ID.
 * @param {string} id
 * @returns {Promise<object|null>}
 */
export async function getOrg(id) {
  const result = await query(`SELECT * FROM orgs WHERE id = $1`, [id]);
  return result.rows[0] ?? null;
}

/**
 * Bootstrap the default org for self-hosted deployments.
 * Idempotent — skips if the org already exists.
 * @returns {Promise<object>}
 */
export async function bootstrapSelfHosted() {
  const existing = await getOrg(SELF_HOSTED_ORG_ID);
  if (existing) {
    logger.info({ msg: 'Self-hosted org already exists', orgId: SELF_HOSTED_ORG_ID });
    return existing;
  }
  const org = await createOrg(SELF_HOSTED_ORG_ID, 'Self-Hosted');
  logger.info({ msg: 'Bootstrapped self-hosted org', orgId: SELF_HOSTED_ORG_ID });
  return org;
}

export { SELF_HOSTED_ORG_ID };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/unit/org-manager.test.js`

Expected: All 5 tests PASS.

- [ ] **Step 5: Wire bootstrap into startup**

In `src/index.js`, add import:

```javascript
import { bootstrapSelfHosted } from './agents/org-manager.js';
```

In the `start()` function, after `await healthCheck()`:

```javascript
// Bootstrap self-hosted org (idempotent)
await bootstrapSelfHosted();
```

- [ ] **Step 6: Commit**

```bash
git add src/agents/org-manager.js tests/unit/org-manager.test.js src/index.js
git commit -m "feat: add org manager with self-hosted bootstrap on startup"
```

---

## Task 1.3: Agent Manager + Token Manager

**Files:**
- Create: `src/agents/agent-manager.js`
- Create: `src/agents/token-manager.js`
- Create: `tests/unit/agent-manager.test.js`
- Create: `tests/unit/token-manager.test.js`

- [ ] **Step 1: Write failing agent-manager tests**

Create `tests/unit/agent-manager.test.js`:

```javascript
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockQuery = vi.fn();
vi.mock('../../src/db/client.js', () => ({
  query: (...args) => mockQuery(...args),
  audit: vi.fn(),
}));

vi.mock('../../src/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { createAgent, getAgent, listAgents, updateAgent, deleteAgent } = await import('../../src/agents/agent-manager.js');

describe('agent-manager', () => {
  beforeEach(() => { mockQuery.mockReset(); });

  describe('createAgent', () => {
    it('inserts and returns the agent', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ id: 'claude-1', org_id: 'acme', agent_type: 'claude-code', transport: 'long_poll', transport_meta: {}, repos: [] }] });
      const result = await createAgent({ id: 'claude-1', orgId: 'acme', agentType: 'claude-code', transport: 'long_poll' });
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO agents'),
        ['claude-1', 'acme', 'claude-code', 'long_poll', '{}', []]
      );
      expect(result.id).toBe('claude-1');
    });
  });

  describe('getAgent', () => {
    it('returns agent if found', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ id: 'claude-1', org_id: 'acme' }] });
      expect((await getAgent('acme', 'claude-1')).id).toBe('claude-1');
    });

    it('returns null if not found', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });
      expect(await getAgent('acme', 'missing')).toBeNull();
    });
  });

  describe('listAgents', () => {
    it('returns all agents for an org', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ id: 'a' }, { id: 'b' }] });
      expect(await listAgents('acme')).toHaveLength(2);
    });
  });

  describe('updateAgent', () => {
    it('updates specified fields and returns updated agent', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ id: 'claude-1', transport: 'webhook' }] });
      const result = await updateAgent('acme', 'claude-1', { transport: 'webhook' });
      expect(result.transport).toBe('webhook');
    });

    it('returns null if agent not found', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });
      expect(await updateAgent('acme', 'missing', { transport: 'webhook' })).toBeNull();
    });
  });

  describe('deleteAgent', () => {
    it('deletes and returns true', async () => {
      mockQuery.mockResolvedValueOnce({ rowCount: 1 });
      expect(await deleteAgent('acme', 'claude-1')).toBe(true);
    });

    it('returns false if not found', async () => {
      mockQuery.mockResolvedValueOnce({ rowCount: 0 });
      expect(await deleteAgent('acme', 'missing')).toBe(false);
    });
  });
});
```

- [ ] **Step 2: Run agent-manager tests to verify they fail**

Run: `npx vitest run tests/unit/agent-manager.test.js`

Expected: FAIL — module not found.

- [ ] **Step 3: Implement agent-manager.js**

Create `src/agents/agent-manager.js`:

```javascript
import { query, audit } from '../db/client.js';
import logger from '../logger.js';

/**
 * Create an agent.
 * @param {object} opts
 * @param {string} opts.id
 * @param {string} opts.orgId
 * @param {string} opts.agentType
 * @param {string} opts.transport
 * @param {object} [opts.transportMeta={}]
 * @param {string[]} [opts.repos=[]]
 * @returns {Promise<object>}
 */
export async function createAgent({ id, orgId, agentType, transport, transportMeta = {}, repos = [] }) {
  const result = await query(
    `INSERT INTO agents (id, org_id, agent_type, transport, transport_meta, repos)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [id, orgId, agentType, transport, JSON.stringify(transportMeta), repos]
  );
  audit('agent_created', { data: { orgId, agentId: id } });
  logger.info({ msg: 'Agent created', orgId, agentId: id, agentType, transport });
  return result.rows[0];
}

/**
 * Get an agent by org + id.
 * @param {string} orgId
 * @param {string} agentId
 * @returns {Promise<object|null>}
 */
export async function getAgent(orgId, agentId) {
  const result = await query(
    `SELECT * FROM agents WHERE org_id = $1 AND id = $2`,
    [orgId, agentId]
  );
  return result.rows[0] ?? null;
}

/**
 * List all agents for an org.
 * @param {string} orgId
 * @returns {Promise<Array>}
 */
export async function listAgents(orgId) {
  const result = await query(
    `SELECT * FROM agents WHERE org_id = $1 ORDER BY created_at`,
    [orgId]
  );
  return result.rows;
}

/**
 * Update agent fields.
 * @param {string} orgId
 * @param {string} agentId
 * @param {object} fields
 * @returns {Promise<object|null>}
 */
export async function updateAgent(orgId, agentId, fields) {
  const setClauses = [];
  const params = [];
  let idx = 1;

  if (fields.agentType !== undefined) { setClauses.push(`agent_type = $${idx++}`); params.push(fields.agentType); }
  if (fields.transport !== undefined) { setClauses.push(`transport = $${idx++}`); params.push(fields.transport); }
  if (fields.transportMeta !== undefined) { setClauses.push(`transport_meta = $${idx++}`); params.push(JSON.stringify(fields.transportMeta)); }
  if (fields.repos !== undefined) { setClauses.push(`repos = $${idx++}`); params.push(fields.repos); }
  setClauses.push(`updated_at = NOW()`);

  params.push(orgId, agentId);
  const result = await query(
    `UPDATE agents SET ${setClauses.join(', ')} WHERE org_id = $${idx++} AND id = $${idx} RETURNING *`,
    params
  );
  if (result.rows[0]) {
    audit('agent_updated', { data: { orgId, agentId, fields: Object.keys(fields) } });
  }
  return result.rows[0] ?? null;
}

/**
 * Delete an agent.
 * @param {string} orgId
 * @param {string} agentId
 * @returns {Promise<boolean>}
 */
export async function deleteAgent(orgId, agentId) {
  const result = await query(
    `DELETE FROM agents WHERE org_id = $1 AND id = $2`,
    [orgId, agentId]
  );
  if (result.rowCount > 0) {
    audit('agent_deleted', { data: { orgId, agentId } });
  }
  return result.rowCount > 0;
}
```

- [ ] **Step 4: Run agent-manager tests to verify they pass**

Run: `npx vitest run tests/unit/agent-manager.test.js`

Expected: All 7 tests PASS.

- [ ] **Step 5: Write failing token-manager tests**

Create `tests/unit/token-manager.test.js`:

```javascript
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockQuery = vi.fn();
vi.mock('../../src/db/client.js', () => ({
  query: (...args) => mockQuery(...args),
  audit: vi.fn(),
}));

vi.mock('../../src/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { createToken, validateToken, revokeToken, listTokens, hashToken } = await import('../../src/agents/token-manager.js');

describe('token-manager', () => {
  beforeEach(() => { mockQuery.mockReset(); });

  describe('hashToken', () => {
    it('produces a consistent sha256 hash', () => {
      const hash1 = hashToken('test-token');
      const hash2 = hashToken('test-token');
      expect(hash1).toBe(hash2);
      expect(hash1).toHaveLength(64);
    });

    it('produces different hashes for different tokens', () => {
      expect(hashToken('a')).not.toBe(hashToken('b'));
    });
  });

  describe('createToken', () => {
    it('returns plaintext token with ff_ prefix and inserts hashed version', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ id: 1, org_id: 'acme', agent_id: 'a1', label: 'laptop' }] });
      const result = await createToken('acme', 'a1', 'laptop');
      expect(result.plaintext).toBeDefined();
      expect(result.plaintext.startsWith('ff_')).toBe(true);
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO agent_tokens'),
        expect.arrayContaining(['acme', 'a1'])
      );
    });
  });

  describe('validateToken', () => {
    it('returns org_id and agent_id for valid token', async () => {
      const hash = hashToken('ff_test123');
      mockQuery.mockResolvedValueOnce({ rows: [{ id: 1, org_id: 'acme', agent_id: 'a1' }] });
      const result = await validateToken('ff_test123');
      expect(result).toEqual({ id: 1, org_id: 'acme', agent_id: 'a1' });
      expect(mockQuery).toHaveBeenCalledWith(expect.stringContaining('SELECT'), [hash]);
    });

    it('returns null for invalid token', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });
      expect(await validateToken('ff_bad')).toBeNull();
    });
  });

  describe('revokeToken', () => {
    it('soft-revokes a token', async () => {
      mockQuery.mockResolvedValueOnce({ rowCount: 1 });
      expect(await revokeToken('acme', 1)).toBe(true);
    });
  });

  describe('listTokens', () => {
    it('returns tokens with hashes redacted', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [
        { id: 1, org_id: 'acme', agent_id: 'a1', label: 'laptop', created_at: '2026-03-28', expires_at: null, revoked_at: null }
      ]});
      const result = await listTokens('acme', 'a1');
      expect(result[0].token_hash).toBeUndefined();
      expect(result[0].id).toBe(1);
    });
  });
});
```

- [ ] **Step 6: Run token-manager tests to verify they fail**

Run: `npx vitest run tests/unit/token-manager.test.js`

Expected: FAIL — module not found.

- [ ] **Step 7: Implement token-manager.js**

Create `src/agents/token-manager.js`:

```javascript
import { randomBytes, createHash } from 'crypto';
import { query, audit } from '../db/client.js';
import logger from '../logger.js';

const TOKEN_PREFIX = 'ff_';

/**
 * Hash a plaintext token using SHA-256.
 * @param {string} plaintext
 * @returns {string} hex hash
 */
export function hashToken(plaintext) {
  return createHash('sha256').update(plaintext).digest('hex');
}

/**
 * Create a new agent token. Returns the plaintext token (only shown once).
 * @param {string} orgId
 * @param {string} agentId
 * @param {string} [label]
 * @param {Date} [expiresAt]
 * @returns {Promise<{ plaintext: string, id: number }>}
 */
export async function createToken(orgId, agentId, label = null, expiresAt = null) {
  const plaintext = TOKEN_PREFIX + randomBytes(32).toString('hex');
  const hash = hashToken(plaintext);

  const result = await query(
    `INSERT INTO agent_tokens (org_id, agent_id, token_hash, label, expires_at)
     VALUES ($1, $2, $3, $4, $5) RETURNING id, org_id, agent_id, label, created_at`,
    [orgId, agentId, hash, label, expiresAt]
  );

  audit('agent_token_created', { data: { orgId, agentId, tokenId: result.rows[0].id } });
  logger.info({ msg: 'Agent token created', orgId, agentId, tokenId: result.rows[0].id });

  return { plaintext, ...result.rows[0] };
}

/**
 * Validate a plaintext token. Returns token record if valid, null otherwise.
 * @param {string} plaintext
 * @returns {Promise<{ id: number, org_id: string, agent_id: string }|null>}
 */
export async function validateToken(plaintext) {
  const hash = hashToken(plaintext);
  const result = await query(
    `SELECT id, org_id, agent_id FROM agent_tokens
     WHERE token_hash = $1 AND revoked_at IS NULL
       AND (expires_at IS NULL OR expires_at > NOW())`,
    [hash]
  );
  return result.rows[0] ?? null;
}

/**
 * Revoke a token by ID.
 * @param {string} orgId
 * @param {number} tokenId
 * @returns {Promise<boolean>}
 */
export async function revokeToken(orgId, tokenId) {
  const result = await query(
    `UPDATE agent_tokens SET revoked_at = NOW() WHERE org_id = $1 AND id = $2 AND revoked_at IS NULL`,
    [orgId, tokenId]
  );
  if (result.rowCount > 0) {
    audit('agent_token_revoked', { data: { orgId, tokenId } });
  }
  return result.rowCount > 0;
}

/**
 * List tokens for an agent (hashes redacted).
 * @param {string} orgId
 * @param {string} agentId
 * @returns {Promise<Array>}
 */
export async function listTokens(orgId, agentId) {
  const result = await query(
    `SELECT id, org_id, agent_id, label, created_at, expires_at, revoked_at
     FROM agent_tokens WHERE org_id = $1 AND agent_id = $2 ORDER BY created_at`,
    [orgId, agentId]
  );
  return result.rows;
}
```

- [ ] **Step 8: Run token-manager tests to verify they pass**

Run: `npx vitest run tests/unit/token-manager.test.js`

Expected: All 7 tests PASS.

- [ ] **Step 9: Commit**

```bash
git add src/agents/agent-manager.js src/agents/token-manager.js tests/unit/agent-manager.test.js tests/unit/token-manager.test.js
git commit -m "feat: add agent manager (CRUD) and token manager (create, validate, revoke)"
```

---

## Task 1.4: Agent REST API + E2E Verification

**Files:**
- Create: `src/routes/agents.js`
- Create: `tests/unit/routes-agents.test.js`
- Modify: `src/index.js`

- [ ] **Step 1: Write failing tests**

Create `tests/unit/routes-agents.test.js`:

```javascript
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockCreateAgent = vi.fn();
const mockGetAgent = vi.fn();
const mockListAgents = vi.fn();
const mockUpdateAgent = vi.fn();
const mockDeleteAgent = vi.fn();
const mockCreateToken = vi.fn();
const mockListTokens = vi.fn();
const mockRevokeToken = vi.fn();

vi.mock('../../src/agents/agent-manager.js', () => ({
  createAgent: (...args) => mockCreateAgent(...args),
  getAgent: (...args) => mockGetAgent(...args),
  listAgents: (...args) => mockListAgents(...args),
  updateAgent: (...args) => mockUpdateAgent(...args),
  deleteAgent: (...args) => mockDeleteAgent(...args),
}));
vi.mock('../../src/agents/token-manager.js', () => ({
  createToken: (...args) => mockCreateToken(...args),
  listTokens: (...args) => mockListTokens(...args),
  revokeToken: (...args) => mockRevokeToken(...args),
  validateToken: vi.fn(),
}));
vi.mock('../../src/agents/session-manager.js', () => ({
  getActiveSessions: vi.fn().mockResolvedValue([]),
}));
vi.mock('../../src/db/client.js', () => ({
  query: vi.fn().mockResolvedValue({ rows: [] }),
  audit: vi.fn(),
}));
vi.mock('../../src/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { handleCreateAgent, handleGetAgent, handleListAgents, handleDeleteAgent, handleCreateToken } = await import('../../src/routes/agents.js');

const adminReq = (body = {}, params = {}) => ({ adminOrg: 'acme', body, params });
const fakeRes = () => ({ status: vi.fn().mockReturnThis(), json: vi.fn(), end: vi.fn() });

describe('agent routes', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  describe('handleCreateAgent', () => {
    it('creates an agent and returns 201', async () => {
      mockCreateAgent.mockResolvedValueOnce({ id: 'a1', org_id: 'acme' });
      const res = fakeRes();
      await handleCreateAgent(adminReq({ id: 'a1', agent_type: 'claude-code', transport: 'long_poll' }), res);
      expect(mockCreateAgent).toHaveBeenCalledWith(expect.objectContaining({ id: 'a1', orgId: 'acme' }));
      expect(res.status).toHaveBeenCalledWith(201);
    });
  });

  describe('handleGetAgent', () => {
    it('returns agent if found', async () => {
      mockGetAgent.mockResolvedValueOnce({ id: 'a1' });
      const res = fakeRes();
      await handleGetAgent(adminReq({}, { id: 'a1' }), res);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ id: 'a1' }));
    });

    it('returns 404 if not found', async () => {
      mockGetAgent.mockResolvedValueOnce(null);
      const res = fakeRes();
      await handleGetAgent(adminReq({}, { id: 'missing' }), res);
      expect(res.status).toHaveBeenCalledWith(404);
    });
  });

  describe('handleListAgents', () => {
    it('returns all agents for org', async () => {
      mockListAgents.mockResolvedValueOnce([{ id: 'a1' }, { id: 'a2' }]);
      const res = fakeRes();
      await handleListAgents(adminReq(), res);
      expect(res.json).toHaveBeenCalledWith({ agents: [{ id: 'a1' }, { id: 'a2' }] });
    });
  });

  describe('handleDeleteAgent', () => {
    it('returns 204 on success', async () => {
      mockDeleteAgent.mockResolvedValueOnce(true);
      const res = fakeRes();
      await handleDeleteAgent(adminReq({}, { id: 'a1' }), res);
      expect(res.status).toHaveBeenCalledWith(204);
    });
  });

  describe('handleCreateToken', () => {
    it('returns plaintext token on creation', async () => {
      mockCreateToken.mockResolvedValueOnce({ plaintext: 'ff_abc', id: 1 });
      const res = fakeRes();
      await handleCreateToken(adminReq({ label: 'laptop' }, { id: 'a1' }), res);
      expect(res.status).toHaveBeenCalledWith(201);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ token: 'ff_abc' }));
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/unit/routes-agents.test.js`

Expected: FAIL — module not found.

- [ ] **Step 3: Implement agent routes**

Create `src/routes/agents.js`:

```javascript
import { Router } from 'express';
import { createAgent, getAgent, listAgents, updateAgent, deleteAgent } from '../agents/agent-manager.js';
import { createToken, listTokens, revokeToken } from '../agents/token-manager.js';
import { getActiveSessions } from '../agents/session-manager.js';
import logger from '../logger.js';

const router = Router();

/**
 * Admin auth middleware.
 * Uses MCP_AUTH_TOKEN for now. Will be replaced by proper admin auth.
 */
function adminAuth(req, res, next) {
  const token = process.env.MCP_AUTH_TOKEN;
  if (!token) {
    req.adminOrg = 'self-hosted';
    return next();
  }
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ') || auth.slice(7) !== token) {
    return res.status(403).json({ error: 'Unauthorized' });
  }
  req.adminOrg = process.env.ORG_ID || 'self-hosted';
  next();
}

export async function handleCreateAgent(req, res) {
  const { id, agent_type, transport, transport_meta, repos } = req.body;
  const agent = await createAgent({ id, orgId: req.adminOrg, agentType: agent_type, transport, transportMeta: transport_meta, repos });
  res.status(201).json(agent);
}

export async function handleGetAgent(req, res) {
  const agent = await getAgent(req.adminOrg, req.params.id);
  if (!agent) return res.status(404).json({ error: 'Agent not found' });
  res.json(agent);
}

export async function handleListAgents(req, res) {
  const agents = await listAgents(req.adminOrg);
  res.json({ agents });
}

export async function handleUpdateAgent(req, res) {
  const { agent_type, transport, transport_meta, repos } = req.body;
  const agent = await updateAgent(req.adminOrg, req.params.id, {
    agentType: agent_type, transport, transportMeta: transport_meta, repos,
  });
  if (!agent) return res.status(404).json({ error: 'Agent not found' });
  res.json(agent);
}

export async function handleDeleteAgent(req, res) {
  const deleted = await deleteAgent(req.adminOrg, req.params.id);
  if (!deleted) return res.status(404).json({ error: 'Agent not found' });
  res.status(204).end();
}

export async function handleCreateToken(req, res) {
  const { label, expires_at } = req.body;
  const result = await createToken(req.adminOrg, req.params.id, label, expires_at);
  res.status(201).json({ token: result.plaintext, id: result.id });
}

export async function handleListTokens(req, res) {
  const tokens = await listTokens(req.adminOrg, req.params.id);
  res.json({ tokens });
}

export async function handleRevokeToken(req, res) {
  const revoked = await revokeToken(req.adminOrg, parseInt(req.params.tokenId, 10));
  if (!revoked) return res.status(404).json({ error: 'Token not found' });
  res.json({ ok: true });
}

export async function handleListSessions(req, res) {
  const sessions = await getActiveSessions(req.adminOrg, req.params.id);
  res.json({ sessions });
}

router.use('/agents', adminAuth);
router.post('/agents', handleCreateAgent);
router.get('/agents', handleListAgents);
router.get('/agents/:id', handleGetAgent);
router.patch('/agents/:id', handleUpdateAgent);
router.delete('/agents/:id', handleDeleteAgent);
router.post('/agents/:id/tokens', handleCreateToken);
router.get('/agents/:id/tokens', handleListTokens);
router.delete('/agents/:id/tokens/:tokenId', handleRevokeToken);
router.get('/agents/:id/sessions', handleListSessions);

export default router;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/unit/routes-agents.test.js`

Expected: All 6 tests PASS.

- [ ] **Step 5: Mount router in index.js**

In `src/index.js`, add import:

```javascript
import agentsRouter from './routes/agents.js';
```

Mount after existing routes:

```javascript
app.use('/api', agentsRouter);
```

- [ ] **Step 6: Run full test suite**

Run: `npm test`

Expected: All tests pass.

- [ ] **Step 7: E2E verification (manual smoke test)**

Start the server: `npm run dev`

```bash
# Create an agent
curl -s -X POST http://localhost:3847/api/agents \
  -H "Content-Type: application/json" \
  -d '{"id":"test-claude","agent_type":"claude-code","transport":"long_poll"}' | jq .

# List agents
curl -s http://localhost:3847/api/agents | jq .

# Create a token
curl -s -X POST http://localhost:3847/api/agents/test-claude/tokens \
  -H "Content-Type: application/json" \
  -d '{"label":"dev-laptop"}' | jq .
```

Expected: agent created (201), agent listed, token returned with `ff_` prefix. Stop the server.

- [ ] **Step 8: Commit**

```bash
git add src/routes/agents.js tests/unit/routes-agents.test.js src/index.js
git commit -m "feat: agent REST API with CRUD, tokens — slice 1 complete"
```

---

# SLICE 2: Runner Connection

**Delivers:** A runner can authenticate with a token, register a session, and long-poll for work (receiving empty responses until Slice 3 wires up claims).

**E2E Verification:**
```bash
# Using token from Slice 1:
curl POST /api/runner/register → 200, session_id returned
curl POST /api/runner/poll → 200, { work: null } (no work yet)
curl GET /api/agents/:id/sessions → session visible
```

---

## Task 2.1: Migration — agent_sessions

**Files:**
- Create: `src/db/migrations/006_agent_sessions.sql`
- Modify: `src/db/client.js`

- [ ] **Step 1: Write the migration SQL**

Create `src/db/migrations/006_agent_sessions.sql`:

```sql
CREATE TABLE IF NOT EXISTS agent_sessions (
  id            SERIAL PRIMARY KEY,
  org_id        TEXT NOT NULL REFERENCES orgs(id),
  agent_id      TEXT NOT NULL,
  session_meta  JSONB DEFAULT '{}',
  status        TEXT DEFAULT 'online',
  registered_at TIMESTAMPTZ DEFAULT NOW(),
  last_seen_at  TIMESTAMPTZ DEFAULT NOW(),
  expires_at    TIMESTAMPTZ NOT NULL,
  FOREIGN KEY (org_id, agent_id) REFERENCES agents(org_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_agent_sessions_active
  ON agent_sessions(org_id, agent_id, status) WHERE status = 'online';
```

- [ ] **Step 2: Register migration**

In `src/db/client.js`, update the migrations array:

```javascript
const migrations = ['001_initial.sql', '002_audit_log.sql', '003_mcp_pending.sql', '004_dispatch_dedup.sql', '005_agent_registry.sql', '006_agent_sessions.sql'];
```

- [ ] **Step 3: Commit**

```bash
git add src/db/migrations/006_agent_sessions.sql src/db/client.js
git commit -m "feat: add migration 006 for agent_sessions table"
```

---

## Task 2.2: Session Manager

**Files:**
- Create: `src/agents/session-manager.js`
- Create: `tests/unit/session-manager.test.js`

- [ ] **Step 1: Write failing tests**

Create `tests/unit/session-manager.test.js`:

```javascript
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockQuery = vi.fn();
vi.mock('../../src/db/client.js', () => ({
  query: (...args) => mockQuery(...args),
  audit: vi.fn(),
}));

vi.mock('../../src/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { registerSession, touchSession, expireSessions, getActiveSessions, setSessionStatus } = await import('../../src/agents/session-manager.js');

describe('session-manager', () => {
  beforeEach(() => { mockQuery.mockReset(); });

  describe('registerSession', () => {
    it('inserts a session with TTL and returns it', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ id: 1, org_id: 'acme', agent_id: 'a1', status: 'online' }] });
      const result = await registerSession('acme', 'a1', { hostname: 'dev-laptop' });
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO agent_sessions'),
        expect.arrayContaining(['acme', 'a1'])
      );
      expect(result.status).toBe('online');
    });
  });

  describe('touchSession', () => {
    it('updates last_seen_at and extends expires_at', async () => {
      mockQuery.mockResolvedValueOnce({ rowCount: 1 });
      await touchSession(1);
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE agent_sessions'),
        expect.arrayContaining([1])
      );
    });
  });

  describe('expireSessions', () => {
    it('marks expired sessions as offline', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ id: 1 }, { id: 2 }] });
      const expired = await expireSessions();
      expect(expired).toHaveLength(2);
    });
  });

  describe('getActiveSessions', () => {
    it('returns online sessions for an agent', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ id: 1 }, { id: 2 }] });
      const result = await getActiveSessions('acme', 'a1');
      expect(result).toHaveLength(2);
    });
  });

  describe('setSessionStatus', () => {
    it('updates session status', async () => {
      mockQuery.mockResolvedValueOnce({ rowCount: 1 });
      await setSessionStatus(1, 'busy');
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE agent_sessions SET status'),
        [1, 'busy']
      );
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/unit/session-manager.test.js`

Expected: FAIL — module not found.

- [ ] **Step 3: Implement session-manager.js**

Create `src/agents/session-manager.js`:

```javascript
import { query, audit } from '../db/client.js';
import logger from '../logger.js';

const DEFAULT_SESSION_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Register a new session for an agent.
 * @param {string} orgId
 * @param {string} agentId
 * @param {object} [sessionMeta={}]
 * @param {number} [ttlMs=DEFAULT_SESSION_TTL_MS]
 * @returns {Promise<object>}
 */
export async function registerSession(orgId, agentId, sessionMeta = {}, ttlMs = DEFAULT_SESSION_TTL_MS) {
  const expiresAt = new Date(Date.now() + ttlMs).toISOString();
  const result = await query(
    `INSERT INTO agent_sessions (org_id, agent_id, session_meta, expires_at)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [orgId, agentId, JSON.stringify(sessionMeta), expiresAt]
  );
  audit('session_registered', { data: { orgId, agentId, sessionId: result.rows[0].id } });
  logger.info({ msg: 'Session registered', orgId, agentId, sessionId: result.rows[0].id });
  return result.rows[0];
}

/**
 * Touch a session — refresh last_seen_at and extend expiry.
 * @param {number} sessionId
 * @param {number} [ttlMs=DEFAULT_SESSION_TTL_MS]
 */
export async function touchSession(sessionId, ttlMs = DEFAULT_SESSION_TTL_MS) {
  const expiresAt = new Date(Date.now() + ttlMs).toISOString();
  await query(
    `UPDATE agent_sessions SET last_seen_at = NOW(), expires_at = $2
     WHERE id = $1 AND status != 'offline'`,
    [sessionId, expiresAt]
  );
}

/**
 * Expire all sessions past their TTL. Returns expired session IDs.
 * @returns {Promise<Array>}
 */
export async function expireSessions() {
  const result = await query(
    `UPDATE agent_sessions SET status = 'offline'
     WHERE status != 'offline' AND expires_at < NOW()
     RETURNING id, org_id, agent_id`,
    []
  );
  if (result.rows.length > 0) {
    logger.info({ msg: 'Sessions expired', count: result.rows.length });
  }
  return result.rows;
}

/**
 * Get active (online) sessions for an agent.
 * @param {string} orgId
 * @param {string} agentId
 * @returns {Promise<Array>}
 */
export async function getActiveSessions(orgId, agentId) {
  const result = await query(
    `SELECT * FROM agent_sessions
     WHERE org_id = $1 AND agent_id = $2 AND status = 'online' AND expires_at > NOW()
     ORDER BY last_seen_at DESC`,
    [orgId, agentId]
  );
  return result.rows;
}

/**
 * Resolve the best session for a claim.
 * Priority: previous session for this PR → first available online session → null.
 * @param {string} orgId
 * @param {string} agentId
 * @param {string} repo
 * @param {number} prNumber
 * @returns {Promise<number|null>} session ID or null
 */
export async function resolveSession(orgId, agentId, repo, prNumber) {
  // 1. Previous session affinity
  const prev = await query(
    `SELECT session_id FROM agent_claims
     WHERE org_id = $1 AND repo = $2 AND pr_number = $3
       AND status IN ('completed', 'expired')
     ORDER BY attempt DESC LIMIT 1`,
    [orgId, repo, prNumber]
  );
  if (prev.rows[0]?.session_id) {
    const check = await query(
      `SELECT id FROM agent_sessions
       WHERE id = $1 AND status = 'online' AND expires_at > NOW()`,
      [prev.rows[0].session_id]
    );
    if (check.rows[0]) return check.rows[0].id;
  }

  // 2. First available
  const avail = await query(
    `SELECT id FROM agent_sessions
     WHERE org_id = $1 AND agent_id = $2 AND status = 'online' AND expires_at > NOW()
     ORDER BY last_seen_at DESC LIMIT 1`,
    [orgId, agentId]
  );
  return avail.rows[0]?.id ?? null;
}

/**
 * Update session status.
 * @param {number} sessionId
 * @param {string} status
 */
export async function setSessionStatus(sessionId, status) {
  await query(
    `UPDATE agent_sessions SET status = $2 WHERE id = $1`,
    [sessionId, status]
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/unit/session-manager.test.js`

Expected: All 5 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/agents/session-manager.js tests/unit/session-manager.test.js
git commit -m "feat: add session manager with register, touch, expire, resolve"
```

---

## Task 2.3: Long-Poll Transport

**Files:**
- Create: `src/notifications/transports/long-poll.js`
- Create: `tests/unit/long-poll-transport.test.js`
- Modify: `src/notifications/transports/index.js`

- [ ] **Step 1: Write failing tests**

Create `tests/unit/long-poll-transport.test.js`:

```javascript
import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('../../src/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { send, enqueue, dequeue, hasPending, clearQueue } = await import('../../src/notifications/transports/long-poll.js');

describe('long-poll transport', () => {
  afterEach(() => { clearQueue(); });

  describe('send', () => {
    it('enqueues payload keyed by session_id', async () => {
      await send({}, { agentId: 'a1', session_id: 5, message: 'fix it' });
      expect(hasPending(5)).toBe(true);
    });

    it('warns if no session_id in payload', async () => {
      await send({}, { agentId: 'a1' });
      expect(hasPending(undefined)).toBe(false);
    });
  });

  describe('dequeue', () => {
    it('returns and removes the queued payload', () => {
      enqueue(5, { message: 'fix it' });
      const payload = dequeue(5);
      expect(payload.message).toBe('fix it');
      expect(hasPending(5)).toBe(false);
    });

    it('returns null if nothing queued', () => {
      expect(dequeue(999)).toBeNull();
    });
  });

  describe('enqueue', () => {
    it('queues multiple payloads in FIFO order', () => {
      enqueue(5, { attempt: 1 });
      enqueue(5, { attempt: 2 });
      expect(dequeue(5).attempt).toBe(1);
      expect(dequeue(5).attempt).toBe(2);
      expect(dequeue(5)).toBeNull();
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/unit/long-poll-transport.test.js`

Expected: FAIL — module not found.

- [ ] **Step 3: Implement long-poll.js**

Create `src/notifications/transports/long-poll.js`:

```javascript
/**
 * Long-poll transport — queues payloads for runner sessions to pick up.
 */
import logger from '../../logger.js';

/** @type {Map<number, Array<object>>} session_id → queued payloads */
const queue = new Map();

/**
 * Enqueue a payload for a session.
 * @param {number} sessionId
 * @param {object} payload
 */
export function enqueue(sessionId, payload) {
  if (!queue.has(sessionId)) queue.set(sessionId, []);
  queue.get(sessionId).push(payload);
}

/**
 * Dequeue the next payload for a session.
 * @param {number} sessionId
 * @returns {object|null}
 */
export function dequeue(sessionId) {
  const items = queue.get(sessionId);
  if (!items || items.length === 0) return null;
  const payload = items.shift();
  if (items.length === 0) queue.delete(sessionId);
  return payload;
}

/**
 * Check if a session has pending work.
 * @param {number} sessionId
 * @returns {boolean}
 */
export function hasPending(sessionId) {
  return (queue.get(sessionId)?.length ?? 0) > 0;
}

/**
 * Clear the queue (for testing).
 */
export function clearQueue() {
  queue.clear();
}

/**
 * Transport send — enqueues payload for the target session.
 * @param {object} agentConfig
 * @param {object} payload - must include session_id
 */
export async function send(agentConfig, payload) {
  const sessionId = payload.session_id;
  if (!sessionId) {
    logger.warn({ msg: 'Long-poll transport: no session_id in payload', agentId: payload.agentId });
    return;
  }
  enqueue(sessionId, payload);
  logger.info({ msg: 'Work enqueued for runner session', agentId: payload.agentId, sessionId });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/unit/long-poll-transport.test.js`

Expected: All 5 tests PASS.

- [ ] **Step 5: Register in transport index**

In `src/notifications/transports/index.js`:

```javascript
import * as webhook from './webhook.js';
import * as workflow from './workflow.js';
import * as longPoll from './long-poll.js';

const registry = new Map([
  ['webhook', webhook],
  ['workflow_dispatch', workflow],
  ['long_poll', longPoll],
]);
```

- [ ] **Step 6: Commit**

```bash
git add src/notifications/transports/long-poll.js tests/unit/long-poll-transport.test.js src/notifications/transports/index.js
git commit -m "feat: add long-poll transport with in-memory queue"
```

---

## Task 2.4: Runner Endpoints + E2E Verification

**Files:**
- Create: `src/routes/runner.js`
- Create: `tests/unit/routes-runner.test.js`
- Modify: `src/index.js`

- [ ] **Step 1: Write failing tests**

Create `tests/unit/routes-runner.test.js`:

```javascript
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockValidateToken = vi.fn();
const mockRegisterSession = vi.fn();
const mockTouchSession = vi.fn();
const mockDequeue = vi.fn();
const mockHasPending = vi.fn();

vi.mock('../../src/agents/token-manager.js', () => ({
  validateToken: (...args) => mockValidateToken(...args),
}));
vi.mock('../../src/agents/session-manager.js', () => ({
  registerSession: (...args) => mockRegisterSession(...args),
  touchSession: (...args) => mockTouchSession(...args),
  setSessionStatus: vi.fn(),
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
  query: vi.fn().mockResolvedValue({ rows: [] }),
  audit: vi.fn(),
}));
vi.mock('../../src/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { authenticateRunner, handleRegister, handlePoll } = await import('../../src/routes/runner.js');

describe('runner routes', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  describe('authenticateRunner', () => {
    it('returns 401 if no Authorization header', async () => {
      const req = { headers: {} };
      const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };
      const next = vi.fn();
      await authenticateRunner(req, res, next);
      expect(res.status).toHaveBeenCalledWith(401);
      expect(next).not.toHaveBeenCalled();
    });

    it('returns 403 if token is invalid', async () => {
      mockValidateToken.mockResolvedValueOnce(null);
      const req = { headers: { authorization: 'Bearer ff_bad' } };
      const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };
      const next = vi.fn();
      await authenticateRunner(req, res, next);
      expect(res.status).toHaveBeenCalledWith(403);
    });

    it('attaches tokenInfo to req and calls next on valid token', async () => {
      mockValidateToken.mockResolvedValueOnce({ id: 1, org_id: 'acme', agent_id: 'a1' });
      const req = { headers: { authorization: 'Bearer ff_good' } };
      const res = {};
      const next = vi.fn();
      await authenticateRunner(req, res, next);
      expect(req.tokenInfo).toEqual({ id: 1, org_id: 'acme', agent_id: 'a1' });
      expect(next).toHaveBeenCalled();
    });
  });

  describe('handleRegister', () => {
    it('registers a session and returns session_id', async () => {
      mockRegisterSession.mockResolvedValueOnce({ id: 10, status: 'online' });
      const req = { tokenInfo: { org_id: 'acme', agent_id: 'a1' }, body: { meta: { hostname: 'dev' } } };
      const res = { json: vi.fn() };
      await handleRegister(req, res);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ session_id: 10 }));
    });
  });

  describe('handlePoll', () => {
    it('returns payload immediately if work is queued', async () => {
      mockHasPending.mockReturnValueOnce(true);
      mockDequeue.mockReturnValueOnce({ claim_id: 1, message: 'fix it' });
      mockTouchSession.mockResolvedValueOnce();
      const req = { tokenInfo: { org_id: 'acme', agent_id: 'a1' }, body: { session_id: 10 } };
      const res = { json: vi.fn() };
      await handlePoll(req, res, { pollTimeoutMs: 0 });
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ work: { claim_id: 1, message: 'fix it' } }));
    });

    it('returns empty if no work after timeout', async () => {
      mockHasPending.mockReturnValue(false);
      mockTouchSession.mockResolvedValue();
      const req = { tokenInfo: { org_id: 'acme', agent_id: 'a1' }, body: { session_id: 10 } };
      const res = { json: vi.fn() };
      await handlePoll(req, res, { pollTimeoutMs: 0 });
      expect(res.json).toHaveBeenCalledWith({ work: null });
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/unit/routes-runner.test.js`

Expected: FAIL — module not found.

- [ ] **Step 3: Implement runner routes**

Create `src/routes/runner.js`:

```javascript
import { Router } from 'express';
import { validateToken } from '../agents/token-manager.js';
import { registerSession, touchSession } from '../agents/session-manager.js';
import { completeClaim, failClaim } from '../agents/claim-manager.js';
import { dequeue, hasPending } from '../notifications/transports/long-poll.js';
import { audit } from '../db/client.js';
import logger from '../logger.js';

const router = Router();

/**
 * Authenticate runner requests via agent token.
 */
export async function authenticateRunner(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing Authorization header' });
  }
  const tokenInfo = await validateToken(auth.slice(7));
  if (!tokenInfo) {
    return res.status(403).json({ error: 'Invalid or expired token' });
  }
  req.tokenInfo = tokenInfo;
  next();
}

/**
 * POST /api/runner/register — register a new session.
 */
export async function handleRegister(req, res) {
  const { org_id, agent_id } = req.tokenInfo;
  const meta = req.body?.meta ?? {};
  const session = await registerSession(org_id, agent_id, meta);
  res.json({ ok: true, session_id: session.id, status: session.status });
}

/**
 * POST /api/runner/poll — long-poll for work.
 */
export async function handlePoll(req, res, opts = {}) {
  const sessionId = req.body?.session_id;
  const pollTimeoutMs = opts.pollTimeoutMs ?? 30000;

  await touchSession(sessionId);

  if (hasPending(sessionId)) {
    return res.json({ work: dequeue(sessionId) });
  }

  if (pollTimeoutMs === 0) {
    return res.json({ work: null });
  }

  const start = Date.now();
  const interval = setInterval(async () => {
    if (hasPending(sessionId)) {
      clearInterval(interval);
      await touchSession(sessionId);
      return res.json({ work: dequeue(sessionId) });
    }
    if (Date.now() - start >= pollTimeoutMs) {
      clearInterval(interval);
      await touchSession(sessionId);
      return res.json({ work: null });
    }
  }, 1000);
}

/**
 * POST /api/runner/claim/:id — report claim result.
 */
export async function handleClaimResult(req, res) {
  const { org_id } = req.tokenInfo;
  const { status, repo, pr_number, attempt } = req.body;

  const claim = status === 'completed'
    ? await completeClaim(org_id, repo, pr_number, attempt)
    : await failClaim(org_id, repo, pr_number, attempt);

  if (!claim) {
    return res.status(404).json({ error: 'Claim not found or already resolved' });
  }

  audit('claim_result', { repo, data: { claimId: claim.id, status } });
  res.json({ ok: true, claim_id: claim.id, status: claim.status });
}

router.use('/runner', authenticateRunner);
router.post('/runner/register', handleRegister);
router.post('/runner/poll', handlePoll);
router.post('/runner/claim/:id', handleClaimResult);

export default router;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/unit/routes-runner.test.js`

Expected: All 5 tests PASS.

- [ ] **Step 5: Mount router in index.js**

In `src/index.js`, add:

```javascript
import runnerRouter from './routes/runner.js';
```

Mount:

```javascript
app.use('/api', runnerRouter);
```

- [ ] **Step 6: Run full test suite**

Run: `npm test`

Expected: All tests pass.

- [ ] **Step 7: E2E verification (manual smoke test)**

Start the server: `npm run dev`

```bash
# Use the token from Slice 1's smoke test
TOKEN="ff_<from-slice-1>"

# Register a session
curl -s -X POST http://localhost:3847/api/runner/register \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"meta":{"hostname":"dev-laptop"}}' | jq .

# Poll for work (should return empty immediately since no claims exist)
curl -s -X POST http://localhost:3847/api/runner/poll \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"session_id": 1}' | jq .

# Verify session visible in admin API
curl -s http://localhost:3847/api/agents/test-claude/sessions | jq .
```

Expected: session registered, poll returns `{ work: null }`, session visible in list. Stop the server.

- [ ] **Step 8: Commit**

```bash
git add src/routes/runner.js tests/unit/routes-runner.test.js src/index.js
git commit -m "feat: runner endpoints (register, poll, claim result) — slice 2 complete"
```

---

# SLICE 3: Review → Claim → Runner

**Delivers:** When a review fails, Fluent Flow creates a claim, assigns it to an available runner session, and pushes the payload via long-poll. The runner reports back, completing the claim.

**E2E Verification:** Mock a review failure → claim created and assigned → runner poll returns payload → runner reports result → claim completed.

---

## Task 3.1: Migration — agent_claims

**Files:**
- Create: `src/db/migrations/007_agent_claims.sql`
- Modify: `src/db/client.js`

- [ ] **Step 1: Write the migration SQL**

Create `src/db/migrations/007_agent_claims.sql`:

```sql
CREATE TABLE IF NOT EXISTS agent_claims (
  id            SERIAL PRIMARY KEY,
  org_id        TEXT NOT NULL REFERENCES orgs(id),
  repo          TEXT NOT NULL,
  pr_number     INT NOT NULL,
  attempt       INT NOT NULL,
  session_id    INT REFERENCES agent_sessions(id),
  claim_type    TEXT DEFAULT 'review_fix',
  status        TEXT DEFAULT 'pending',
  payload       JSONB DEFAULT '{}',
  claimed_at    TIMESTAMPTZ,
  completed_at  TIMESTAMPTZ,
  expires_at    TIMESTAMPTZ,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(org_id, repo, pr_number, attempt)
);

CREATE INDEX IF NOT EXISTS idx_agent_claims_active
  ON agent_claims(org_id, repo, pr_number) WHERE status IN ('pending', 'claimed');
```

- [ ] **Step 2: Register migration**

In `src/db/client.js`:

```javascript
const migrations = ['001_initial.sql', '002_audit_log.sql', '003_mcp_pending.sql', '004_dispatch_dedup.sql', '005_agent_registry.sql', '006_agent_sessions.sql', '007_agent_claims.sql'];
```

- [ ] **Step 3: Commit**

```bash
git add src/db/migrations/007_agent_claims.sql src/db/client.js
git commit -m "feat: add migration 007 for agent_claims table"
```

---

## Task 3.2: Claim Manager

**Files:**
- Create: `src/agents/claim-manager.js`
- Create: `tests/unit/claim-manager.test.js`

- [ ] **Step 1: Write failing tests**

Create `tests/unit/claim-manager.test.js`:

```javascript
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockQuery = vi.fn();
vi.mock('../../src/db/client.js', () => ({
  query: (...args) => mockQuery(...args),
  audit: vi.fn(),
}));

vi.mock('../../src/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const mockResolveSession = vi.fn();
const mockSetSessionStatus = vi.fn();
vi.mock('../../src/agents/session-manager.js', () => ({
  resolveSession: (...args) => mockResolveSession(...args),
  setSessionStatus: (...args) => mockSetSessionStatus(...args),
}));

const { createClaim, completeClaim, failClaim, expireClaims, getActiveClaim } = await import('../../src/agents/claim-manager.js');

describe('claim-manager', () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockResolveSession.mockReset();
    mockSetSessionStatus.mockReset();
  });

  describe('createClaim', () => {
    it('creates a claimed record when session is available', async () => {
      mockResolveSession.mockResolvedValueOnce(5);
      mockQuery.mockResolvedValueOnce({ rows: [{ id: 1, status: 'claimed', session_id: 5 }] });
      mockSetSessionStatus.mockResolvedValueOnce();
      const result = await createClaim({
        orgId: 'acme', repo: 'owner/repo', prNumber: 7, attempt: 1,
        agentId: 'a1', payload: { message: 'fix it' },
      });
      expect(result.status).toBe('claimed');
      expect(result.session_id).toBe(5);
      expect(mockSetSessionStatus).toHaveBeenCalledWith(5, 'busy');
    });

    it('creates a pending record when no session available', async () => {
      mockResolveSession.mockResolvedValueOnce(null);
      mockQuery.mockResolvedValueOnce({ rows: [{ id: 1, status: 'pending', session_id: null }] });
      const result = await createClaim({
        orgId: 'acme', repo: 'owner/repo', prNumber: 7, attempt: 1,
        agentId: 'a1', payload: {},
      });
      expect(result.status).toBe('pending');
      expect(mockSetSessionStatus).not.toHaveBeenCalled();
    });
  });

  describe('completeClaim', () => {
    it('marks claim completed and frees session', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ id: 1, session_id: 5, status: 'completed' }] });
      mockSetSessionStatus.mockResolvedValueOnce();
      const result = await completeClaim('acme', 'owner/repo', 7, 1);
      expect(mockSetSessionStatus).toHaveBeenCalledWith(5, 'online');
      expect(result.status).toBe('completed');
    });

    it('returns null if no active claim', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });
      expect(await completeClaim('acme', 'owner/repo', 7, 99)).toBeNull();
    });
  });

  describe('failClaim', () => {
    it('marks claim failed and frees session', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ id: 1, session_id: 5, status: 'failed' }] });
      mockSetSessionStatus.mockResolvedValueOnce();
      await failClaim('acme', 'owner/repo', 7, 1);
      expect(mockSetSessionStatus).toHaveBeenCalledWith(5, 'online');
    });
  });

  describe('expireClaims', () => {
    it('expires overdue claims and offlines sessions', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ id: 1, session_id: 5 }, { id: 2, session_id: 6 }] });
      mockSetSessionStatus.mockResolvedValue();
      const expired = await expireClaims();
      expect(expired).toHaveLength(2);
      expect(mockSetSessionStatus).toHaveBeenCalledWith(5, 'offline');
      expect(mockSetSessionStatus).toHaveBeenCalledWith(6, 'offline');
    });
  });

  describe('getActiveClaim', () => {
    it('returns active claim for a PR', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [{ id: 1, status: 'claimed' }] });
      expect((await getActiveClaim('acme', 'owner/repo', 7)).status).toBe('claimed');
    });

    it('returns null if none', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });
      expect(await getActiveClaim('acme', 'owner/repo', 7)).toBeNull();
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/unit/claim-manager.test.js`

Expected: FAIL — module not found.

- [ ] **Step 3: Implement claim-manager.js**

Create `src/agents/claim-manager.js`:

```javascript
import { query, audit } from '../db/client.js';
import { resolveSession, setSessionStatus } from './session-manager.js';
import logger from '../logger.js';

const DEFAULT_CLAIM_TTL_MS = 15 * 60 * 1000; // 15 minutes

/**
 * Create a claim for a review attempt. Resolves a session and assigns if available.
 * @param {object} opts
 * @param {string} opts.orgId
 * @param {string} opts.repo
 * @param {number} opts.prNumber
 * @param {number} opts.attempt
 * @param {string} opts.agentId
 * @param {object} opts.payload
 * @param {string} [opts.claimType='review_fix'] - "review_fix" | "issue_work"
 * @param {number} [opts.ttlMs]
 * @returns {Promise<object>}
 */
export async function createClaim({ orgId, repo, prNumber, attempt, agentId, payload, claimType = 'review_fix', ttlMs = DEFAULT_CLAIM_TTL_MS }) {
  const sessionId = await resolveSession(orgId, agentId, repo, prNumber);
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

  if (sessionId) await setSessionStatus(sessionId, 'busy');

  const claim = result.rows[0];
  audit('claim_created', { repo, data: { claimId: claim.id, prNumber, attempt, sessionId, status } });
  logger.info({ msg: 'Claim created', orgId, repo, prNumber, attempt, sessionId, status });
  return claim;
}

/**
 * Mark a claim as completed. Frees the session.
 * @param {string} orgId
 * @param {string} repo
 * @param {number} prNumber
 * @param {number} attempt
 * @returns {Promise<object|null>}
 */
export async function completeClaim(orgId, repo, prNumber, attempt) {
  const result = await query(
    `UPDATE agent_claims SET status = 'completed', completed_at = NOW()
     WHERE org_id = $1 AND repo = $2 AND pr_number = $3 AND attempt = $4
       AND status IN ('claimed', 'pending')
     RETURNING *`,
    [orgId, repo, prNumber, attempt]
  );
  const claim = result.rows[0];
  if (claim?.session_id) await setSessionStatus(claim.session_id, 'online');
  return claim ?? null;
}

/**
 * Mark a claim as failed. Frees the session.
 * @param {string} orgId
 * @param {string} repo
 * @param {number} prNumber
 * @param {number} attempt
 * @returns {Promise<object|null>}
 */
export async function failClaim(orgId, repo, prNumber, attempt) {
  const result = await query(
    `UPDATE agent_claims SET status = 'failed', completed_at = NOW()
     WHERE org_id = $1 AND repo = $2 AND pr_number = $3 AND attempt = $4
       AND status IN ('claimed', 'pending')
     RETURNING *`,
    [orgId, repo, prNumber, attempt]
  );
  const claim = result.rows[0];
  if (claim?.session_id) await setSessionStatus(claim.session_id, 'online');
  return claim ?? null;
}

/**
 * Expire all overdue claims. Sets associated sessions to offline.
 * @returns {Promise<Array>}
 */
export async function expireClaims() {
  const result = await query(
    `UPDATE agent_claims SET status = 'expired'
     WHERE status = 'claimed' AND expires_at < NOW()
     RETURNING *`,
    []
  );
  for (const claim of result.rows) {
    if (claim.session_id) await setSessionStatus(claim.session_id, 'offline');
  }
  if (result.rows.length > 0) {
    logger.info({ msg: 'Claims expired', count: result.rows.length });
  }
  return result.rows;
}

/**
 * Get the active claim (pending or claimed) for a PR.
 * @param {string} orgId
 * @param {string} repo
 * @param {number} prNumber
 * @returns {Promise<object|null>}
 */
export async function getActiveClaim(orgId, repo, prNumber) {
  const result = await query(
    `SELECT * FROM agent_claims
     WHERE org_id = $1 AND repo = $2 AND pr_number = $3
       AND status IN ('pending', 'claimed')
     ORDER BY attempt DESC LIMIT 1`,
    [orgId, repo, prNumber]
  );
  return result.rows[0] ?? null;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/unit/claim-manager.test.js`

Expected: All 8 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/agents/claim-manager.js tests/unit/claim-manager.test.js
git commit -m "feat: add claim manager with create, complete, fail, expire lifecycle"
```

---

## Task 3.3: Integrate Claims with Review Manager

**Files:**
- Modify: `src/engine/review-manager.js`
- Modify: `tests/unit/review-manager.test.js`

- [ ] **Step 1: Read current review-manager tests**

Read `tests/unit/review-manager.test.js` to understand existing mock structure.

- [ ] **Step 2: Add claim-manager mock and tests**

At the top of `tests/unit/review-manager.test.js`, add alongside existing mocks:

```javascript
const mockCreateClaim = vi.fn().mockResolvedValue({ id: 1, status: 'claimed' });
const mockCompleteClaim = vi.fn().mockResolvedValue({ id: 1, status: 'completed' });
vi.mock('../../src/agents/claim-manager.js', () => ({
  createClaim: (...args) => mockCreateClaim(...args),
  completeClaim: (...args) => mockCompleteClaim(...args),
}));
```

Add test cases in the `handleReviewResult` describe block:

```javascript
it('creates a claim when review fails', async () => {
  // ... setup for FAIL result (use existing pattern) ...
  await handleReviewResult({ /* FAIL params */ });
  expect(mockCreateClaim).toHaveBeenCalledWith(expect.objectContaining({
    repo: expect.any(String),
    prNumber: expect.any(Number),
    attempt: expect.any(Number),
  }));
});

it('completes a claim when review passes', async () => {
  // ... setup for PASS result (use existing pattern) ...
  await handleReviewResult({ /* PASS params */ });
  expect(mockCompleteClaim).toHaveBeenCalled();
});
```

- [ ] **Step 3: Run tests to verify new tests fail**

Run: `npx vitest run tests/unit/review-manager.test.js`

Expected: New claim tests FAIL because `handleReviewResult` doesn't call claim functions yet.

- [ ] **Step 4: Add claim integration to review-manager.js**

In `src/engine/review-manager.js`, add import:

```javascript
import { createClaim, completeClaim } from '../agents/claim-manager.js';
```

In `handleReviewResult`, in the PASS block (after updating retry record):

```javascript
try {
  await completeClaim(config.org_id ?? 'self-hosted', repoKey, prNumber, attempt);
} catch (err) {
  logger.warn({ msg: 'Failed to complete claim on pass', error: err.message });
}
```

In the FAIL block, after `notifyReviewFailure`:

```javascript
try {
  await createClaim({
    orgId: config.org_id ?? 'self-hosted',
    repo: repoKey,
    prNumber,
    attempt,
    agentId: resolvedAgent,
    payload: {
      message: formatRichMessage({ repo: repoKey, prNumber, attempt, blocking, advisory }),
      issues: allIssues,
      onFailure: config.reviewer?.on_failure,
    },
  });
} catch (err) {
  logger.warn({ msg: 'Failed to create claim on review failure', error: err.message });
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/unit/review-manager.test.js`

Expected: All tests PASS.

- [ ] **Step 6: Commit**

```bash
git add src/engine/review-manager.js tests/unit/review-manager.test.js
git commit -m "feat: review manager creates claims on failure, completes on pass"
```

---

## Task 3.4: Integrate Dispatcher with DB Agents + Session Routing

**Files:**
- Modify: `src/notifications/dispatcher.js`
- Modify: `tests/unit/dispatcher.test.js`

- [ ] **Step 1: Read current dispatcher tests**

Read `tests/unit/dispatcher.test.js` to understand existing mock structure.

- [ ] **Step 2: Add DB agent lookup and session_id routing tests**

Add mocks at top of test file:

```javascript
const mockGetAgentDB = vi.fn();
const mockGetActiveClaim = vi.fn();
vi.mock('../../src/agents/agent-manager.js', () => ({
  getAgent: (...args) => mockGetAgentDB(...args),
}));
vi.mock('../../src/agents/claim-manager.js', () => ({
  getActiveClaim: (...args) => mockGetActiveClaim(...args),
}));
```

Add test cases:

```javascript
it('falls back to DB agent when YAML returns null', async () => {
  // Mock YAML returning null
  mockGetAgentConfig.mockReturnValueOnce(null);
  // Mock DB returning an agent
  mockGetAgentDB.mockResolvedValueOnce({ id: 'a1', transport: 'webhook', transport_meta: { url: 'http://test' } });
  await dispatch({ agentId: 'a1', event: 'review_failed', payload: { repo: 'o/r' } });
  expect(mockTransportSend).toHaveBeenCalled();
});

it('includes session_id in payload for long_poll agents', async () => {
  mockGetAgentConfig.mockReturnValueOnce(null);
  mockGetAgentDB.mockResolvedValueOnce({ id: 'a1', transport: 'long_poll', transport_meta: {} });
  mockGetActiveClaim.mockResolvedValueOnce({ session_id: 5 });
  await dispatch({ agentId: 'a1', event: 'review_failed', payload: { repo: 'o/r', prNumber: 7, orgId: 'acme' } });
  expect(mockTransportSend).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({ session_id: 5 })
  );
});
```

- [ ] **Step 3: Run tests to verify new tests fail**

Run: `npx vitest run tests/unit/dispatcher.test.js`

Expected: New tests FAIL.

- [ ] **Step 4: Update dispatcher.js**

In `src/notifications/dispatcher.js`, add imports:

```javascript
import { getAgent } from '../agents/agent-manager.js';
import { getActiveClaim } from '../agents/claim-manager.js';
```

Modify the `dispatch` function to check DB after YAML, and add session_id for long_poll:

```javascript
export async function dispatch({ agentId, event, payload }) {
  if (!agentId) {
    logger.warn({ msg: 'No agent ID — skipping notification', event });
    return;
  }

  // Try YAML first (deprecated fallback), then DB
  let agentConfig = getAgentConfig(agentId);
  if (!agentConfig) {
    const dbAgent = await getAgent(payload.orgId ?? 'self-hosted', agentId);
    if (dbAgent) {
      agentConfig = { transport: dbAgent.transport, ...dbAgent.transport_meta };
    }
  }

  if (!agentConfig) {
    logger.warn({ msg: 'Agent not found in registry or DB — skipping notification', agentId, event });
    return;
  }

  const transport = getTransport(agentConfig.transport);
  if (!transport) {
    logger.error({ msg: 'Unknown transport', transport: agentConfig.transport, agentId });
    return;
  }

  // For long_poll agents, resolve session_id from active claim
  let sessionId = null;
  if (agentConfig.transport === 'long_poll' && payload.repo && payload.prNumber) {
    try {
      const claim = await getActiveClaim(payload.orgId ?? 'self-hosted', payload.repo, payload.prNumber);
      sessionId = claim?.session_id ?? null;
    } catch (err) {
      logger.warn({ msg: 'Failed to resolve session for long-poll', error: err.message });
    }
  }

  const fullPayload = {
    agentId,
    event,
    ...payload,
    ...(sessionId && { session_id: sessionId }),
    ...(agentConfig.delivery?.channel && { channel: agentConfig.delivery.channel }),
    ...(agentConfig.delivery?.to && { to: agentConfig.delivery.to }),
  };

  await transport.send(agentConfig, fullPayload);
  audit('agent_woken', { data: { agentId, event } });
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/unit/dispatcher.test.js`

Expected: All tests PASS.

- [ ] **Step 6: Run full test suite**

Run: `npm test`

Expected: All tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/notifications/dispatcher.js tests/unit/dispatcher.test.js
git commit -m "feat: dispatcher resolves agents from DB, routes session_id for long-poll — slice 3 complete"
```

---

# SLICE 4: Polish

**Delivers:** MCP agent management tools, YAML deprecation, test mock factories.

---

## Task 4.1: MCP Agent Management Tools

**Files:**
- Create: `src/mcp/tools/agents.js`
- Modify: `src/mcp/server.js`

- [ ] **Step 1: Implement MCP agent tools**

Create `src/mcp/tools/agents.js`:

```javascript
import { z } from 'zod';
import { createAgent, listAgents, deleteAgent } from '../../agents/agent-manager.js';
import { audit } from '../../db/client.js';

export function registerAgentTools(server) {
  server.tool(
    'create_agent',
    'Create a new agent in the registry',
    {
      id: z.string().describe('Unique agent identifier'),
      org_id: z.string().default('self-hosted'),
      agent_type: z.enum(['claude-code', 'codex', 'devin', 'openclaw', 'aider', 'custom']),
      transport: z.enum(['webhook', 'workflow_dispatch', 'long_poll', 'api']),
      transport_meta: z.record(z.any()).optional(),
      repos: z.array(z.string()).optional(),
    },
    async ({ id, org_id, agent_type, transport, transport_meta, repos }) => {
      audit('mcp_tool_call', { data: { tool: 'create_agent', agentId: id } });
      try {
        const agent = await createAgent({ id, orgId: org_id, agentType: agent_type, transport, transportMeta: transport_meta, repos });
        return { content: [{ type: 'text', text: JSON.stringify({ ok: true, agent }) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: err.message }) }], isError: true };
      }
    }
  );

  server.tool(
    'list_agents',
    'List all registered agents',
    { org_id: z.string().default('self-hosted') },
    async ({ org_id }) => {
      audit('mcp_tool_call', { data: { tool: 'list_agents' } });
      const agents = await listAgents(org_id);
      return { content: [{ type: 'text', text: JSON.stringify({ agents }) }] };
    }
  );

  server.tool(
    'delete_agent',
    'Delete an agent from the registry',
    { id: z.string(), org_id: z.string().default('self-hosted') },
    async ({ id, org_id }) => {
      audit('mcp_tool_call', { data: { tool: 'delete_agent', agentId: id } });
      const deleted = await deleteAgent(org_id, id);
      return { content: [{ type: 'text', text: JSON.stringify({ ok: deleted }) }] };
    }
  );
}
```

- [ ] **Step 2: Register in server.js**

In `src/mcp/server.js`, add:

```javascript
import { registerAgentTools } from './tools/agents.js';
```

In `createMcpServer()`:

```javascript
registerAgentTools(server);
```

- [ ] **Step 3: Run full test suite**

Run: `npm test`

Expected: All tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/mcp/tools/agents.js src/mcp/server.js
git commit -m "feat: add MCP agent management tools (create, list, delete)"
```

---

## Task 4.2: Deprecate agents.yml + Test Mock Factories

**Files:**
- Modify: `src/config/agents.js`
- Modify: `tests/helpers/mocks.js`

- [ ] **Step 1: Add deprecation warning to YAML agent lookup**

In `src/config/agents.js`, modify `getAgentConfig` to log a deprecation warning:

```javascript
export function getAgentConfig(agentId) {
  if (!agentId) return null;
  const registry = loadAgents();
  const config = registry.agents[agentId] ?? null;
  if (config) {
    logger.warn({ msg: 'Agent loaded from agents.yml — migrate to DB via admin API', agentId });
  }
  return config;
}
```

- [ ] **Step 2: Add mock factories to test helpers**

Add to end of `tests/helpers/mocks.js`:

```javascript
/**
 * Create a mock agent record.
 */
export function makeAgentRecord(overrides = {}) {
  return {
    id: 'test-agent',
    org_id: 'self-hosted',
    agent_type: 'claude-code',
    transport: 'long_poll',
    transport_meta: {},
    repos: [],
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

/**
 * Create a mock agent session record.
 */
export function makeSessionRecord(overrides = {}) {
  return {
    id: 1,
    org_id: 'self-hosted',
    agent_id: 'test-agent',
    session_meta: { hostname: 'dev-laptop' },
    status: 'online',
    registered_at: new Date().toISOString(),
    last_seen_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 300000).toISOString(),
    ...overrides,
  };
}

/**
 * Create a mock agent claim record.
 */
export function makeClaimRecord(overrides = {}) {
  return {
    id: 1,
    org_id: 'self-hosted',
    repo: TEST_REPO_KEY,
    pr_number: 7,
    attempt: 1,
    session_id: 1,
    status: 'claimed',
    payload: {},
    claimed_at: new Date().toISOString(),
    completed_at: null,
    expires_at: new Date(Date.now() + 900000).toISOString(),
    created_at: new Date().toISOString(),
    ...overrides,
  };
}
```

- [ ] **Step 3: Run full test suite**

Run: `npm test`

Expected: All tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/config/agents.js tests/helpers/mocks.js
git commit -m "feat: deprecate agents.yml with warning, add agent/session/claim mock factories — slice 4 complete"
```

---

# Final Verification

- [ ] **Run full test suite**

Run: `npm test`

Expected: All tests pass.

- [ ] **Start server and run full smoke test**

```bash
npm run dev
```

```bash
# 1. Create agent
curl -s -X POST http://localhost:3847/api/agents \
  -H "Content-Type: application/json" \
  -d '{"id":"smoke-agent","agent_type":"claude-code","transport":"long_poll"}' | jq .

# 2. Create token
TOKEN=$(curl -s -X POST http://localhost:3847/api/agents/smoke-agent/tokens \
  -H "Content-Type: application/json" \
  -d '{"label":"smoke-test"}' | jq -r .token)
echo "Token: $TOKEN"

# 3. Register runner session
SESSION_ID=$(curl -s -X POST http://localhost:3847/api/runner/register \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"meta":{"hostname":"smoke"}}' | jq -r .session_id)
echo "Session: $SESSION_ID"

# 4. Verify session visible
curl -s http://localhost:3847/api/agents/smoke-agent/sessions | jq .

# 5. Poll (should be empty)
curl -s -X POST http://localhost:3847/api/runner/poll \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d "{\"session_id\": $SESSION_ID}" | jq .
```

Expected: All requests succeed, session visible, poll returns `{ work: null }`.
