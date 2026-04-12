# Admin Dashboard Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a multi-tenant admin dashboard for managing AI agents, deployed as a Next.js app in the existing Turborepo monorepo.

**Architecture:** Two new packages — `packages/db` (shared data access: pg pool, queries, Zod schemas) and `packages/dashboard` (Next.js App Router + shadcn/ui). Dashboard reads agent/session/claim data via `packages/db`, writes only to new auth tables (`users`, `user_orgs`). GitHub OAuth via NextAuth.js with org-scoped role enforcement.

**Tech Stack:** Next.js 15 (App Router), TypeScript, Tailwind CSS, shadcn/ui, NextAuth.js, pg, Zod, Vitest, Playwright

**Spec:** `docs/specs/2026-04-12-admin-dashboard-phase1-design.md`

---

### Task 1: Database Migration — users and user_orgs tables

**Files:**
- Create: `packages/fluent-flow/src/db/migrations/009_dashboard_users.sql`

Migration convention: `NNN_descriptor.sql`, sequential numbering. Latest is `008_test_failures.sql`.

- [ ] **Step 1: Write the migration SQL**

```sql
-- 009_dashboard_users.sql

CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  github_id INTEGER NOT NULL UNIQUE,
  login TEXT NOT NULL,
  email TEXT,
  avatar_url TEXT,
  is_superadmin BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS user_orgs (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  org_id TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, org_id)
);

CREATE INDEX idx_user_orgs_org_id ON user_orgs(org_id);
```

- [ ] **Step 2: Run migration against the database**

```bash
cd packages/fluent-flow
# If using the docker postgres:
docker exec fluent-flow-postgres-1 psql -U fluentflow -d fluentflow -f /dev/stdin < src/db/migrations/009_dashboard_users.sql
```

Expected: tables created, no errors.

- [ ] **Step 3: Verify tables exist**

```bash
docker exec fluent-flow-postgres-1 psql -U fluentflow -d fluentflow -c "\dt users" -c "\dt user_orgs"
```

Expected: both tables listed.

- [ ] **Step 4: Commit**

```bash
git add packages/fluent-flow/src/db/migrations/009_dashboard_users.sql
git commit -m "feat: add users and user_orgs migration for dashboard auth"
```

---

### Task 2: packages/db — Scaffold shared data access package

**Files:**
- Create: `packages/db/package.json`
- Create: `packages/db/tsconfig.json`
- Create: `packages/db/src/index.ts`
- Create: `packages/db/src/pool.ts`

- [ ] **Step 1: Create package.json**

```json
{
  "name": "@fluent-flow/db",
  "version": "0.0.1",
  "type": "module",
  "private": true,
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "scripts": {
    "build": "tsc",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "dependencies": {
    "pg": "^8.11.3",
    "zod": "^3.22.4"
  },
  "devDependencies": {
    "@types/pg": "^8.11.0",
    "typescript": "^5.7.0",
    "vitest": "^4.1.0"
  },
  "engines": {
    "node": ">=20"
  }
}
```

- [ ] **Step 2: Create tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "esModuleInterop": true,
    "strict": true,
    "outDir": "dist",
    "rootDir": "src",
    "declaration": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true
  },
  "include": ["src"],
  "exclude": ["node_modules", "dist", "tests"]
}
```

- [ ] **Step 3: Create pool.ts**

Follow the existing lazy-init singleton pattern from `packages/fluent-flow/src/db/client.js`:

```typescript
import pg from 'pg';

const { Pool } = pg;

let pool: pg.Pool | null = null;

export function getPool(): pg.Pool {
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
    });
    pool.on('error', (err) => {
      console.error('Unexpected pg pool error', err.message);
    });
  }
  return pool;
}

export async function query(text: string, params?: unknown[]): Promise<pg.QueryResult> {
  return getPool().query(text, params);
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
```

- [ ] **Step 4: Create index.ts**

```typescript
export { getPool, query, closePool } from './pool.js';
```

- [ ] **Step 5: Install dependencies**

```bash
cd packages/db && npm install
```

- [ ] **Step 6: Verify TypeScript compiles**

```bash
cd packages/db && npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add packages/db/
git commit -m "feat: scaffold packages/db shared data access package"
```

---

### Task 3: packages/db — Zod schemas

**Files:**
- Create: `packages/db/src/schemas/agents.ts`
- Create: `packages/db/src/schemas/sessions.ts`
- Create: `packages/db/src/schemas/claims.ts`
- Create: `packages/db/src/schemas/users.ts`
- Create: `packages/db/src/schemas/index.ts`

- [ ] **Step 1: Write agent schema**

```typescript
// packages/db/src/schemas/agents.ts
import { z } from 'zod';

export const agentSchema = z.object({
  id: z.string(),
  org_id: z.string(),
  agent_type: z.enum(['claude-code', 'codex', 'devin', 'openclaw', 'aider', 'custom']),
  transport: z.enum(['webhook', 'workflow_dispatch', 'long_poll', 'api']),
  transport_meta: z.record(z.unknown()).nullable(),
  repos: z.array(z.string()),
  created_at: z.coerce.date(),
  updated_at: z.coerce.date(),
});

export type Agent = z.infer<typeof agentSchema>;

export const agentListItemSchema = agentSchema.extend({
  status: z.enum(['online', 'offline', 'busy']).nullable(),
  last_seen_at: z.coerce.date().nullable(),
});

export type AgentListItem = z.infer<typeof agentListItemSchema>;
```

- [ ] **Step 2: Write session schema**

```typescript
// packages/db/src/schemas/sessions.ts
import { z } from 'zod';

export const sessionSchema = z.object({
  id: z.number(),
  org_id: z.string(),
  agent_id: z.string(),
  session_meta: z.record(z.unknown()).nullable(),
  status: z.enum(['online', 'offline']),
  registered_at: z.coerce.date(),
  last_seen_at: z.coerce.date(),
  expires_at: z.coerce.date(),
});

export type Session = z.infer<typeof sessionSchema>;
```

- [ ] **Step 3: Write claim schema**

```typescript
// packages/db/src/schemas/claims.ts
import { z } from 'zod';

export const claimSchema = z.object({
  id: z.number(),
  org_id: z.string(),
  repo: z.string(),
  pr_number: z.number(),
  attempt: z.number(),
  session_id: z.number().nullable(),
  claim_type: z.enum(['spec', 'build', 'review_fix', 'test_verify']),
  status: z.enum(['pending', 'claimed', 'completed', 'failed', 'expired']),
  payload: z.record(z.unknown()).nullable(),
  claimed_at: z.coerce.date().nullable(),
  completed_at: z.coerce.date().nullable(),
  created_at: z.coerce.date(),
});

export type Claim = z.infer<typeof claimSchema>;
```

- [ ] **Step 4: Write user schema**

```typescript
// packages/db/src/schemas/users.ts
import { z } from 'zod';

export const userSchema = z.object({
  id: z.number(),
  github_id: z.number(),
  login: z.string(),
  email: z.string().nullable(),
  avatar_url: z.string().nullable(),
  is_superadmin: z.boolean(),
  created_at: z.coerce.date(),
  updated_at: z.coerce.date(),
});

export type User = z.infer<typeof userSchema>;

export const userOrgSchema = z.object({
  user_id: z.number(),
  org_id: z.string(),
  role: z.enum(['superadmin', 'admin', 'member']),
  created_at: z.coerce.date(),
});

export type UserOrg = z.infer<typeof userOrgSchema>;
```

- [ ] **Step 5: Write barrel export**

```typescript
// packages/db/src/schemas/index.ts
export * from './agents.js';
export * from './sessions.js';
export * from './claims.js';
export * from './users.js';
```

- [ ] **Step 6: Update packages/db/src/index.ts**

```typescript
export { getPool, query, closePool } from './pool.js';
export * from './schemas/index.js';
```

- [ ] **Step 7: Verify TypeScript compiles**

```bash
cd packages/db && npx tsc --noEmit
```

- [ ] **Step 8: Commit**

```bash
git add packages/db/src/schemas/ packages/db/src/index.ts
git commit -m "feat: add Zod schemas for agents, sessions, claims, users"
```

---

### Task 4: packages/db — Query functions with tests

**Files:**
- Create: `packages/db/src/queries/agents.ts`
- Create: `packages/db/src/queries/sessions.ts`
- Create: `packages/db/src/queries/claims.ts`
- Create: `packages/db/src/queries/users.ts`
- Create: `packages/db/src/queries/tokens.ts`
- Create: `packages/db/src/queries/index.ts`
- Create: `packages/db/tests/queries/agents.test.ts`
- Create: `packages/db/tests/queries/users.test.ts`
- Create: `packages/db/tests/queries/tokens.test.ts`
- Create: `packages/db/vitest.config.ts`

- [ ] **Step 1: Create vitest config**

```typescript
// packages/db/vitest.config.ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    fileParallelism: false,
  },
});
```

- [ ] **Step 2: Write failing test for listAgents**

```typescript
// packages/db/tests/queries/agents.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockQuery = vi.fn();
vi.mock('../../src/pool.js', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
}));

const { listAgents, getAgentDetail } = await import('../../src/queries/agents.js');

describe('listAgents', () => {
  beforeEach(() => { mockQuery.mockReset(); });

  it('returns agents with status for given org', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          id: 'ff-runner', org_id: 'fluent-io', agent_type: 'claude-code',
          transport: 'long_poll', transport_meta: null, repos: ['fluent-io/fluent-flow'],
          created_at: new Date(), updated_at: new Date(),
          status: 'online', last_seen_at: new Date(),
        },
      ],
    });

    const result = await listAgents(['fluent-io']);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('ff-runner');
    expect(result[0].status).toBe('online');
    expect(mockQuery.mock.calls[0][1]).toEqual([['fluent-io']]);
  });

  it('returns all agents for superadmin (no org filter)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const result = await listAgents([]);
    expect(result).toEqual([]);
    expect(mockQuery.mock.calls[0][0]).not.toContain('org_id = ANY');
  });
});

describe('getAgentDetail', () => {
  beforeEach(() => { mockQuery.mockReset(); });

  it('returns null when agent not found', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const result = await getAgentDetail(['fluent-io'], 'nonexistent');
    expect(result).toBeNull();
  });

  it('returns agent when found in allowed orgs', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{
        id: 'ff-runner', org_id: 'fluent-io', agent_type: 'claude-code',
        transport: 'long_poll', transport_meta: null, repos: ['fluent-io/fluent-flow'],
        created_at: new Date(), updated_at: new Date(),
      }],
    });

    const result = await getAgentDetail(['fluent-io'], 'ff-runner');
    expect(result?.id).toBe('ff-runner');
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

```bash
cd packages/db && npx vitest run tests/queries/agents.test.ts
```

Expected: FAIL — `agents.js` does not exist.

- [ ] **Step 4: Write agents query implementation**

```typescript
// packages/db/src/queries/agents.ts
import { query } from '../pool.js';
import { agentListItemSchema, agentSchema } from '../schemas/agents.js';
import type { AgentListItem, Agent } from '../schemas/agents.js';

export async function listAgents(orgIds: string[]): Promise<AgentListItem[]> {
  const isSuper = orgIds.length === 0;

  const sql = `
    SELECT a.*,
      s.status,
      s.last_seen_at
    FROM agents a
    LEFT JOIN LATERAL (
      SELECT status, last_seen_at
      FROM agent_sessions
      WHERE agent_id = a.id AND org_id = a.org_id
      ORDER BY last_seen_at DESC NULLS LAST
      LIMIT 1
    ) s ON true
    ${isSuper ? '' : 'WHERE a.org_id = ANY($1)'}
    ORDER BY a.id
  `;

  const result = isSuper ? await query(sql) : await query(sql, [orgIds]);
  return result.rows.map((row: unknown) => agentListItemSchema.parse(row));
}

export async function getAgentDetail(orgIds: string[], agentId: string): Promise<Agent | null> {
  const isSuper = orgIds.length === 0;

  const sql = isSuper
    ? `SELECT * FROM agents WHERE id = $1`
    : `SELECT * FROM agents WHERE id = $1 AND org_id = ANY($2)`;

  const params = isSuper ? [agentId] : [agentId, orgIds];
  const result = await query(sql, params);

  if (result.rows.length === 0) return null;
  return agentSchema.parse(result.rows[0]);
}
```

- [ ] **Step 5: Run test to verify it passes**

```bash
cd packages/db && npx vitest run tests/queries/agents.test.ts
```

Expected: PASS.

- [ ] **Step 6: Write failing test for user queries**

```typescript
// packages/db/tests/queries/users.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockQuery = vi.fn();
vi.mock('../../src/pool.js', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
}));

const { upsertUser, getUserOrgs } = await import('../../src/queries/users.js');

describe('upsertUser', () => {
  beforeEach(() => { mockQuery.mockReset(); });

  it('upserts user and returns record', async () => {
    const user = {
      github_id: 12345,
      login: 'victor',
      email: 'victor@example.com',
      avatar_url: 'https://github.com/victor.png',
    };

    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 1, ...user, is_superadmin: false, created_at: new Date(), updated_at: new Date() }],
    });

    const result = await upsertUser(user);
    expect(result.login).toBe('victor');
    expect(result.github_id).toBe(12345);
    expect(mockQuery.mock.calls[0][0]).toContain('ON CONFLICT');
  });
});

describe('getUserOrgs', () => {
  beforeEach(() => { mockQuery.mockReset(); });

  it('returns org memberships for user', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ user_id: 1, org_id: 'fluent-io', role: 'admin', created_at: new Date() }],
    });

    const result = await getUserOrgs(1);
    expect(result).toHaveLength(1);
    expect(result[0].org_id).toBe('fluent-io');
    expect(result[0].role).toBe('admin');
  });

  it('returns empty array when no memberships', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const result = await getUserOrgs(999);
    expect(result).toEqual([]);
  });
});
```

- [ ] **Step 7: Run test to verify it fails**

```bash
cd packages/db && npx vitest run tests/queries/users.test.ts
```

Expected: FAIL — `users.js` does not exist.

- [ ] **Step 8: Write user query implementation**

```typescript
// packages/db/src/queries/users.ts
import { query } from '../pool.js';
import { userSchema, userOrgSchema } from '../schemas/users.js';
import type { User, UserOrg } from '../schemas/users.js';

interface UpsertUserInput {
  github_id: number;
  login: string;
  email: string | null;
  avatar_url: string | null;
}

export async function upsertUser(input: UpsertUserInput): Promise<User> {
  const sql = `
    INSERT INTO users (github_id, login, email, avatar_url)
    VALUES ($1, $2, $3, $4)
    ON CONFLICT (github_id) DO UPDATE SET
      login = EXCLUDED.login,
      email = EXCLUDED.email,
      avatar_url = EXCLUDED.avatar_url,
      updated_at = NOW()
    RETURNING *
  `;

  const result = await query(sql, [input.github_id, input.login, input.email, input.avatar_url]);
  return userSchema.parse(result.rows[0]);
}

export async function getUserOrgs(userId: number): Promise<UserOrg[]> {
  const sql = `SELECT * FROM user_orgs WHERE user_id = $1 ORDER BY org_id`;
  const result = await query(sql, [userId]);
  return result.rows.map((row: unknown) => userOrgSchema.parse(row));
}
```

- [ ] **Step 9: Run test to verify it passes**

```bash
cd packages/db && npx vitest run tests/queries/users.test.ts
```

Expected: PASS.

- [ ] **Step 10: Write failing test for token regeneration**

```typescript
// packages/db/tests/queries/tokens.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockQuery = vi.fn();
vi.mock('../../src/pool.js', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
}));

const { regenerateKey, getKeyInfo } = await import('../../src/queries/tokens.js');

describe('regenerateKey', () => {
  beforeEach(() => { mockQuery.mockReset(); });

  it('revokes existing tokens and creates a new one', async () => {
    // First call: revoke existing
    mockQuery.mockResolvedValueOnce({ rows: [] });
    // Second call: insert new token
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 5, org_id: 'fluent-io', agent_id: 'ff-runner', created_at: new Date() }],
    });

    const result = await regenerateKey('fluent-io', 'ff-runner');
    expect(result.plaintext).toMatch(/^ff_/);
    expect(result.id).toBe(5);
    expect(mockQuery).toHaveBeenCalledTimes(2);
  });
});

describe('getKeyInfo', () => {
  beforeEach(() => { mockQuery.mockReset(); });

  it('returns key creation date when key exists', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 3, created_at: new Date('2026-04-05') }],
    });

    const result = await getKeyInfo('fluent-io', 'ff-runner');
    expect(result).not.toBeNull();
    expect(result!.id).toBe(3);
  });

  it('returns null when no active key exists', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const result = await getKeyInfo('fluent-io', 'ff-runner');
    expect(result).toBeNull();
  });
});
```

- [ ] **Step 11: Run test to verify it fails**

```bash
cd packages/db && npx vitest run tests/queries/tokens.test.ts
```

Expected: FAIL — `tokens.js` does not exist.

- [ ] **Step 12: Write token query implementation**

```typescript
// packages/db/src/queries/tokens.ts
import crypto from 'node:crypto';
import { query } from '../pool.js';

const TOKEN_PREFIX = 'ff_';

function generateToken(): string {
  return TOKEN_PREFIX + crypto.randomBytes(32).toString('hex');
}

function hashToken(plaintext: string): string {
  return crypto.createHash('sha256').update(plaintext).digest('hex');
}

export async function regenerateKey(orgId: string, agentId: string): Promise<{ plaintext: string; id: number }> {
  await query(
    `UPDATE agent_tokens SET revoked_at = NOW() WHERE org_id = $1 AND agent_id = $2 AND revoked_at IS NULL`,
    [orgId, agentId],
  );

  const plaintext = generateToken();
  const hash = hashToken(plaintext);

  const result = await query(
    `INSERT INTO agent_tokens (org_id, agent_id, token_hash, label) VALUES ($1, $2, $3, $4) RETURNING id, org_id, agent_id, created_at`,
    [orgId, agentId, hash, 'default'],
  );

  return { plaintext, ...result.rows[0] };
}

export async function getKeyInfo(orgId: string, agentId: string): Promise<{ id: number; created_at: Date } | null> {
  const result = await query(
    `SELECT id, created_at FROM agent_tokens WHERE org_id = $1 AND agent_id = $2 AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 1`,
    [orgId, agentId],
  );
  return result.rows[0] ?? null;
}
```

- [ ] **Step 13: Run test to verify it passes**

```bash
cd packages/db && npx vitest run tests/queries/tokens.test.ts
```

Expected: PASS.

- [ ] **Step 14: Write session and claim query functions**

```typescript
// packages/db/src/queries/sessions.ts
import { query } from '../pool.js';
import { sessionSchema } from '../schemas/sessions.js';
import type { Session } from '../schemas/sessions.js';

export async function getAgentSessions(orgId: string, agentId: string): Promise<Session[]> {
  const sql = `
    SELECT * FROM agent_sessions
    WHERE org_id = $1 AND agent_id = $2
    ORDER BY last_seen_at DESC
    LIMIT 50
  `;
  const result = await query(sql, [orgId, agentId]);
  return result.rows.map((row: unknown) => sessionSchema.parse(row));
}
```

```typescript
// packages/db/src/queries/claims.ts
import { query } from '../pool.js';
import { claimSchema } from '../schemas/claims.js';
import type { Claim } from '../schemas/claims.js';

export async function getAgentClaims(orgId: string, agentId: string): Promise<Claim[]> {
  const sql = `
    SELECT c.* FROM agent_claims c
    JOIN agent_sessions s ON c.session_id = s.id
    WHERE c.org_id = $1 AND s.agent_id = $2
    ORDER BY c.created_at DESC
    LIMIT 100
  `;
  const result = await query(sql, [orgId, agentId]);
  return result.rows.map((row: unknown) => claimSchema.parse(row));
}
```

- [ ] **Step 15: Write barrel export for queries**

```typescript
// packages/db/src/queries/index.ts
export { listAgents, getAgentDetail } from './agents.js';
export { getAgentSessions } from './sessions.js';
export { getAgentClaims } from './claims.js';
export { upsertUser, getUserOrgs } from './users.js';
export { regenerateKey, getKeyInfo } from './tokens.js';
```

- [ ] **Step 16: Update packages/db/src/index.ts**

```typescript
export { getPool, query, closePool } from './pool.js';
export * from './schemas/index.js';
export * from './queries/index.js';
```

- [ ] **Step 17: Run all db package tests**

```bash
cd packages/db && npx vitest run
```

Expected: all tests pass.

- [ ] **Step 18: Commit**

```bash
git add packages/db/
git commit -m "feat: add query functions and tests for packages/db"
```

---

### Task 5: packages/dashboard — Scaffold Next.js app

**Files:**
- Create: `packages/dashboard/package.json`
- Create: `packages/dashboard/next.config.ts`
- Create: `packages/dashboard/tsconfig.json`
- Create: `packages/dashboard/tailwind.config.ts`
- Create: `packages/dashboard/postcss.config.mjs`
- Create: `packages/dashboard/src/app/globals.css`
- Create: `packages/dashboard/src/app/layout.tsx`
- Create: `packages/dashboard/src/app/page.tsx`
- Create: `packages/dashboard/src/lib/utils.ts`
- Create: `packages/dashboard/components.json`

- [ ] **Step 1: Create package.json**

```json
{
  "name": "@fluent-flow/dashboard",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "next dev --port 3000",
    "build": "next build",
    "start": "next start",
    "test": "vitest run",
    "test:watch": "vitest",
    "test:e2e": "playwright test"
  },
  "dependencies": {
    "@fluent-flow/db": "*",
    "@tanstack/react-table": "^8.20.0",
    "class-variance-authority": "^0.7.0",
    "clsx": "^2.1.0",
    "lucide-react": "^0.460.0",
    "next": "^15.0.0",
    "next-auth": "^4.24.0",
    "react": "^19.0.0",
    "react-dom": "^19.0.0",
    "tailwind-merge": "^2.6.0",
    "tailwindcss-animate": "^1.0.7"
  },
  "devDependencies": {
    "@playwright/test": "^1.49.0",
    "@types/node": "^22.0.0",
    "@types/react": "^19.0.0",
    "@types/react-dom": "^19.0.0",
    "autoprefixer": "^10.4.20",
    "postcss": "^8.4.49",
    "tailwindcss": "^3.4.0",
    "typescript": "^5.7.0",
    "vitest": "^4.1.0"
  }
}
```

- [ ] **Step 2: Create next.config.ts**

```typescript
import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  transpilePackages: ['@fluent-flow/db'],
};

export default nextConfig;
```

- [ ] **Step 3: Create tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2017",
    "lib": ["dom", "dom.iterable", "esnext"],
    "allowJs": true,
    "skipLibCheck": true,
    "strict": true,
    "noEmit": true,
    "esModuleInterop": true,
    "module": "esnext",
    "moduleResolution": "bundler",
    "resolveJsonModule": true,
    "isolatedModules": true,
    "jsx": "preserve",
    "incremental": true,
    "plugins": [{ "name": "next" }],
    "paths": {
      "@/*": ["./src/*"]
    }
  },
  "include": ["next-env.d.ts", "**/*.ts", "**/*.tsx", ".next/types/**/*.ts"],
  "exclude": ["node_modules"]
}
```

- [ ] **Step 4: Create tailwind.config.ts**

```typescript
import type { Config } from 'tailwindcss';
import animate from 'tailwindcss-animate';

const config: Config = {
  darkMode: 'class',
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        border: 'hsl(var(--border))',
        input: 'hsl(var(--input))',
        ring: 'hsl(var(--ring))',
        background: 'hsl(var(--background))',
        foreground: 'hsl(var(--foreground))',
        primary: {
          DEFAULT: 'hsl(var(--primary))',
          foreground: 'hsl(var(--primary-foreground))',
        },
        secondary: {
          DEFAULT: 'hsl(var(--secondary))',
          foreground: 'hsl(var(--secondary-foreground))',
        },
        destructive: {
          DEFAULT: 'hsl(var(--destructive))',
          foreground: 'hsl(var(--destructive-foreground))',
        },
        muted: {
          DEFAULT: 'hsl(var(--muted))',
          foreground: 'hsl(var(--muted-foreground))',
        },
        accent: {
          DEFAULT: 'hsl(var(--accent))',
          foreground: 'hsl(var(--accent-foreground))',
        },
        card: {
          DEFAULT: 'hsl(var(--card))',
          foreground: 'hsl(var(--card-foreground))',
        },
      },
      borderRadius: {
        lg: 'var(--radius)',
        md: 'calc(var(--radius) - 2px)',
        sm: 'calc(var(--radius) - 4px)',
      },
    },
  },
  plugins: [animate],
};

export default config;
```

- [ ] **Step 5: Create postcss.config.mjs**

```javascript
const config = {
  plugins: {
    tailwindcss: {},
    autoprefixer: {},
  },
};

export default config;
```

- [ ] **Step 6: Create globals.css with dark theme**

```css
/* packages/dashboard/src/app/globals.css */
@tailwind base;
@tailwind components;
@tailwind utilities;

@layer base {
  :root {
    --background: 0 0% 3.9%;
    --foreground: 0 0% 98%;
    --card: 0 0% 6.5%;
    --card-foreground: 0 0% 98%;
    --primary: 239 84% 67%;
    --primary-foreground: 0 0% 98%;
    --secondary: 0 0% 14.9%;
    --secondary-foreground: 0 0% 98%;
    --muted: 0 0% 14.9%;
    --muted-foreground: 0 0% 63.9%;
    --accent: 0 0% 14.9%;
    --accent-foreground: 0 0% 98%;
    --destructive: 0 62.8% 30.6%;
    --destructive-foreground: 0 0% 98%;
    --border: 0 0% 14.9%;
    --input: 0 0% 14.9%;
    --ring: 239 84% 67%;
    --radius: 0.5rem;
  }
}

@layer base {
  * {
    @apply border-border;
  }
  body {
    @apply bg-background text-foreground;
  }
}
```

- [ ] **Step 7: Create lib/utils.ts**

```typescript
// packages/dashboard/src/lib/utils.ts
import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
```

- [ ] **Step 8: Create components.json for shadcn**

```json
{
  "$schema": "https://ui.shadcn.com/schema.json",
  "style": "new-york",
  "rsc": true,
  "tsx": true,
  "tailwind": {
    "config": "tailwind.config.ts",
    "css": "src/app/globals.css",
    "baseColor": "zinc",
    "cssVariables": true
  },
  "aliases": {
    "components": "@/components",
    "utils": "@/lib/utils",
    "ui": "@/components/ui"
  }
}
```

- [ ] **Step 9: Create minimal layout.tsx**

```tsx
// packages/dashboard/src/app/layout.tsx
import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Fluent Flow',
  description: 'AI agent management dashboard',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark">
      <body className="min-h-screen bg-background font-sans antialiased">
        {children}
      </body>
    </html>
  );
}
```

- [ ] **Step 10: Create placeholder page.tsx**

```tsx
// packages/dashboard/src/app/page.tsx
import { redirect } from 'next/navigation';

export default function Home() {
  redirect('/agents');
}
```

- [ ] **Step 11: Install dependencies and add shadcn components**

```bash
cd packages/dashboard && npm install
npx shadcn@latest add button table badge tabs dialog dropdown-menu separator avatar tooltip
```

- [ ] **Step 12: Verify dev server starts**

```bash
cd packages/dashboard && npm run dev
```

Expected: Next.js dev server on http://localhost:3000, renders a redirect (will 404 for /agents since that page doesn't exist yet).

- [ ] **Step 13: Commit**

```bash
git add packages/dashboard/
git commit -m "feat: scaffold Next.js dashboard with Tailwind and shadcn/ui"
```

---

### Task 6: NextAuth.js — GitHub OAuth

**Files:**
- Create: `packages/dashboard/src/lib/auth.ts`
- Create: `packages/dashboard/src/app/api/auth/[...nextauth]/route.ts`
- Create: `packages/dashboard/src/app/login/page.tsx`
- Create: `packages/dashboard/src/components/layout/auth-guard.tsx`
- Create: `packages/dashboard/.env.example`

- [ ] **Step 1: Create .env.example**

```
DATABASE_URL=postgresql://fluentflow:password@localhost:5432/fluentflow
GITHUB_CLIENT_ID=
GITHUB_CLIENT_SECRET=
NEXTAUTH_SECRET=
NEXTAUTH_URL=http://localhost:3000
```

- [ ] **Step 2: Create auth config**

```typescript
// packages/dashboard/src/lib/auth.ts
import type { NextAuthOptions, Session } from 'next-auth';
import GitHubProvider from 'next-auth/providers/github';
import { upsertUser, getUserOrgs } from '@fluent-flow/db';
import type { UserOrg } from '@fluent-flow/db';

declare module 'next-auth' {
  interface Session {
    user: {
      id: number;
      login: string;
      email?: string | null;
      image?: string | null;
      isSuperadmin: boolean;
      orgs: UserOrg[];
    };
  }
}

export const authOptions: NextAuthOptions = {
  providers: [
    GitHubProvider({
      clientId: process.env.GITHUB_CLIENT_ID!,
      clientSecret: process.env.GITHUB_CLIENT_SECRET!,
    }),
  ],
  callbacks: {
    async signIn({ user, profile }) {
      const ghProfile = profile as { id: number; login: string; avatar_url?: string };
      await upsertUser({
        github_id: ghProfile.id,
        login: ghProfile.login,
        email: user.email ?? null,
        avatar_url: ghProfile.avatar_url ?? null,
      });
      return true;
    },
    async jwt({ token, profile }) {
      if (profile) {
        const ghProfile = profile as { id: number; login: string };
        token.github_id = ghProfile.id;
        token.login = ghProfile.login;
      }
      return token;
    },
    async session({ session, token }) {
      const { query } = await import('@fluent-flow/db');
      const userResult = await query(
        'SELECT id, is_superadmin FROM users WHERE github_id = $1',
        [token.github_id as number],
      );

      if (userResult.rows.length === 0) {
        throw new Error('User not found');
      }

      const dbUser = userResult.rows[0];
      const orgs = await getUserOrgs(dbUser.id);

      session.user = {
        id: dbUser.id,
        login: token.login as string,
        email: token.email,
        image: token.picture,
        isSuperadmin: dbUser.is_superadmin,
        orgs,
      };
      return session;
    },
  },
  pages: {
    signIn: '/login',
  },
};

export function getOrgScope(session: Session): { orgIds: string[]; isSuperadmin: boolean } {
  if (session.user.isSuperadmin) {
    return { orgIds: [], isSuperadmin: true };
  }
  return { orgIds: session.user.orgs.map((o) => o.org_id), isSuperadmin: false };
}

export function hasRole(session: Session, orgId: string, minRole: 'member' | 'admin'): boolean {
  if (session.user.isSuperadmin) return true;
  const org = session.user.orgs.find((o) => o.org_id === orgId);
  if (!org) return false;
  if (minRole === 'member') return true;
  return org.role === 'admin';
}
```

- [ ] **Step 3: Create NextAuth route handler**

```typescript
// packages/dashboard/src/app/api/auth/[...nextauth]/route.ts
import NextAuth from 'next-auth';
import { authOptions } from '@/lib/auth';

const handler = NextAuth(authOptions);
export { handler as GET, handler as POST };
```

- [ ] **Step 4: Create login page**

```tsx
// packages/dashboard/src/app/login/page.tsx
'use client';

import { signIn } from 'next-auth/react';
import { Button } from '@/components/ui/button';

export default function LoginPage() {
  return (
    <div className="flex min-h-screen items-center justify-center">
      <div className="mx-auto flex w-full max-w-sm flex-col items-center gap-6">
        <div className="text-center">
          <h1 className="text-2xl font-bold">Fluent Flow</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Sign in to manage your AI agents
          </p>
        </div>
        <Button onClick={() => signIn('github', { callbackUrl: '/agents' })} className="w-full">
          Sign in with GitHub
        </Button>
      </div>
    </div>
  );
}
```

- [ ] **Step 5: Create auth guard component**

```tsx
// packages/dashboard/src/components/layout/auth-guard.tsx
'use client';

import { useSession } from 'next-auth/react';
import { redirect } from 'next/navigation';

export function AuthGuard({ children }: { children: React.ReactNode }) {
  const { data: session, status } = useSession();

  if (status === 'loading') {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <p className="text-sm text-muted-foreground">Loading...</p>
      </div>
    );
  }

  if (!session) {
    redirect('/login');
  }

  if (session.user.orgs.length === 0 && !session.user.isSuperadmin) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="text-center">
          <h2 className="text-lg font-semibold">No Access</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            You don't have access to any organization. Contact a superadmin to get access.
          </p>
        </div>
      </div>
    );
  }

  return <>{children}</>;
}
```

- [ ] **Step 6: Commit**

```bash
git add packages/dashboard/src/lib/auth.ts packages/dashboard/src/app/api/ packages/dashboard/src/app/login/ packages/dashboard/src/components/layout/auth-guard.tsx packages/dashboard/.env.example
git commit -m "feat: add GitHub OAuth via NextAuth with org-scoped roles"
```

---

### Task 7: Dashboard layout — Top bar + collapsible sidebar

**Files:**
- Create: `packages/dashboard/src/components/layout/top-bar.tsx`
- Create: `packages/dashboard/src/components/layout/sidebar.tsx`
- Create: `packages/dashboard/src/components/layout/dashboard-shell.tsx`
- Modify: `packages/dashboard/src/app/layout.tsx`

- [ ] **Step 1: Create top bar**

```tsx
// packages/dashboard/src/components/layout/top-bar.tsx
'use client';

import { useSession } from 'next-auth/react';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';

export function TopBar() {
  const { data: session } = useSession();
  const user = session?.user;
  const orgId = user?.orgs[0]?.org_id ?? 'no org';

  return (
    <header className="flex h-12 items-center justify-between border-b border-border bg-card px-5">
      <div className="text-sm font-bold tracking-tight">Fluent Flow</div>
      <div className="flex items-center gap-3">
        <span className="rounded border border-border bg-secondary px-2.5 py-0.5 text-xs text-muted-foreground">
          {orgId}
        </span>
        <div className="flex items-center gap-2">
          <Avatar className="h-7 w-7">
            <AvatarImage src={user?.image ?? undefined} />
            <AvatarFallback className="text-xs">
              {user?.login?.charAt(0).toUpperCase() ?? '?'}
            </AvatarFallback>
          </Avatar>
          <span className="text-xs text-muted-foreground">{user?.login}</span>
        </div>
      </div>
    </header>
  );
}
```

- [ ] **Step 2: Create collapsible sidebar**

```tsx
// packages/dashboard/src/components/layout/sidebar.tsx
'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Bot, Settings, ChevronLeft, ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';

const navItems = [
  { label: 'Agents', href: '/agents', icon: Bot },
  { label: 'Settings', href: '/settings', icon: Settings },
];

export function Sidebar() {
  const pathname = usePathname();
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    const stored = localStorage.getItem('sidebar-collapsed');
    if (stored !== null) setCollapsed(stored === 'true');
  }, []);

  function toggle() {
    const next = !collapsed;
    setCollapsed(next);
    localStorage.setItem('sidebar-collapsed', String(next));
  }

  return (
    <TooltipProvider delayDuration={0}>
      <aside
        className={cn(
          'flex flex-col border-r border-border bg-card/50 transition-all duration-200',
          collapsed ? 'w-14' : 'w-48',
        )}
      >
        <nav className="flex flex-1 flex-col gap-1 p-2 pt-3">
          {navItems.map((item) => {
            const isActive = pathname.startsWith(item.href);
            const link = (
              <Link
                key={item.href}
                href={item.href}
                className={cn(
                  'flex items-center gap-2.5 rounded-md px-3 py-2 text-sm transition-colors',
                  isActive
                    ? 'border-l-2 border-primary bg-primary/10 text-primary-foreground'
                    : 'text-muted-foreground hover:bg-secondary hover:text-foreground',
                  collapsed && 'justify-center px-0',
                )}
              >
                <item.icon className="h-4 w-4 shrink-0" />
                {!collapsed && <span>{item.label}</span>}
              </Link>
            );

            if (collapsed) {
              return (
                <Tooltip key={item.href}>
                  <TooltipTrigger asChild>{link}</TooltipTrigger>
                  <TooltipContent side="right">{item.label}</TooltipContent>
                </Tooltip>
              );
            }
            return link;
          })}
        </nav>
        <button
          onClick={toggle}
          className="flex items-center justify-center gap-1.5 border-t border-border p-2.5 text-xs text-muted-foreground hover:text-foreground"
        >
          {collapsed ? <ChevronRight className="h-3.5 w-3.5" /> : (
            <>
              <ChevronLeft className="h-3.5 w-3.5" />
              <span>Collapse</span>
            </>
          )}
        </button>
      </aside>
    </TooltipProvider>
  );
}
```

- [ ] **Step 3: Create dashboard shell**

```tsx
// packages/dashboard/src/components/layout/dashboard-shell.tsx
'use client';

import { SessionProvider } from 'next-auth/react';
import { AuthGuard } from './auth-guard';
import { TopBar } from './top-bar';
import { Sidebar } from './sidebar';

export function DashboardShell({ children }: { children: React.ReactNode }) {
  return (
    <SessionProvider>
      <AuthGuard>
        <div className="flex h-screen flex-col">
          <TopBar />
          <div className="flex flex-1 overflow-hidden">
            <Sidebar />
            <main className="flex-1 overflow-auto p-6">{children}</main>
          </div>
        </div>
      </AuthGuard>
    </SessionProvider>
  );
}
```

- [ ] **Step 4: Update layout.tsx to use dashboard shell**

```tsx
// packages/dashboard/src/app/layout.tsx
import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Fluent Flow',
  description: 'AI agent management dashboard',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark">
      <body className="min-h-screen bg-background font-sans antialiased">
        {children}
      </body>
    </html>
  );
}
```

Note: The `DashboardShell` wraps authenticated pages, not the root layout (login page should not have the sidebar). This is applied in the agents layout below.

- [ ] **Step 5: Create agents layout with shell**

```tsx
// packages/dashboard/src/app/agents/layout.tsx
import { DashboardShell } from '@/components/layout/dashboard-shell';

export default function AgentsLayout({ children }: { children: React.ReactNode }) {
  return <DashboardShell>{children}</DashboardShell>;
}
```

- [ ] **Step 6: Verify dev server renders layout**

```bash
cd packages/dashboard && npm run dev
```

Visit http://localhost:3000 — should redirect to /agents, which shows the shell layout (redirects to login if not authenticated).

- [ ] **Step 7: Commit**

```bash
git add packages/dashboard/src/components/layout/ packages/dashboard/src/app/agents/layout.tsx packages/dashboard/src/app/layout.tsx
git commit -m "feat: add top bar, collapsible sidebar, and dashboard shell layout"
```

---

### Task 8: Agent list page + API route

**Files:**
- Create: `packages/dashboard/src/app/api/agents/route.ts`
- Create: `packages/dashboard/src/app/agents/page.tsx`
- Create: `packages/dashboard/src/components/agents/agent-table.tsx`
- Create: `packages/dashboard/src/components/agents/status-badge.tsx`
- Create: `packages/dashboard/src/components/agents/type-badge.tsx`
- Create: `packages/dashboard/tests/api/agents.test.ts`
- Create: `packages/dashboard/vitest.config.ts`

- [ ] **Step 1: Create vitest config**

```typescript
// packages/dashboard/vitest.config.ts
import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    fileParallelism: false,
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
});
```

- [ ] **Step 2: Write failing test for agents API route**

```typescript
// packages/dashboard/tests/api/agents.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockGetServerSession = vi.fn();
const mockListAgents = vi.fn();

vi.mock('next-auth', () => ({
  getServerSession: (...args: unknown[]) => mockGetServerSession(...args),
}));

vi.mock('@fluent-flow/db', () => ({
  listAgents: (...args: unknown[]) => mockListAgents(...args),
}));

vi.mock('@/lib/auth', () => ({
  authOptions: {},
  getOrgScope: vi.fn((session) => {
    if (session.user.isSuperadmin) return { orgIds: [], isSuperadmin: true };
    return { orgIds: session.user.orgs.map((o: { org_id: string }) => o.org_id), isSuperadmin: false };
  }),
}));

const { GET } = await import('../../src/app/api/agents/route.js');

describe('GET /api/agents', () => {
  beforeEach(() => {
    mockGetServerSession.mockReset();
    mockListAgents.mockReset();
  });

  it('returns 401 when not authenticated', async () => {
    mockGetServerSession.mockResolvedValueOnce(null);

    const response = await GET();
    expect(response.status).toBe(401);
  });

  it('returns agents scoped to user orgs', async () => {
    mockGetServerSession.mockResolvedValueOnce({
      user: { id: 1, login: 'victor', isSuperadmin: false, orgs: [{ org_id: 'fluent-io', role: 'admin' }] },
    });
    mockListAgents.mockResolvedValueOnce([
      { id: 'ff-runner', org_id: 'fluent-io', agent_type: 'claude-code', status: 'online' },
    ]);

    const response = await GET();
    const data = await response.json();
    expect(response.status).toBe(200);
    expect(data).toHaveLength(1);
    expect(data[0].id).toBe('ff-runner');
    expect(mockListAgents).toHaveBeenCalledWith(['fluent-io']);
  });

  it('returns all agents for superadmin', async () => {
    mockGetServerSession.mockResolvedValueOnce({
      user: { id: 1, login: 'victor', isSuperadmin: true, orgs: [] },
    });
    mockListAgents.mockResolvedValueOnce([]);

    const response = await GET();
    expect(response.status).toBe(200);
    expect(mockListAgents).toHaveBeenCalledWith([]);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

```bash
cd packages/dashboard && npx vitest run tests/api/agents.test.ts
```

Expected: FAIL — route does not exist.

- [ ] **Step 4: Write agents API route**

```typescript
// packages/dashboard/src/app/api/agents/route.ts
import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { listAgents } from '@fluent-flow/db';
import { authOptions, getOrgScope } from '@/lib/auth';

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { orgIds } = getOrgScope(session);
  const agents = await listAgents(orgIds);
  return NextResponse.json(agents);
}
```

- [ ] **Step 5: Run test to verify it passes**

```bash
cd packages/dashboard && npx vitest run tests/api/agents.test.ts
```

Expected: PASS.

- [ ] **Step 6: Create status badge component**

```tsx
// packages/dashboard/src/components/agents/status-badge.tsx
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

const statusConfig = {
  online: { label: 'online', className: 'border-green-800 bg-green-950 text-green-400' },
  offline: { label: 'offline', className: 'border-border bg-secondary text-muted-foreground' },
  busy: { label: 'busy', className: 'border-amber-800 bg-amber-950 text-amber-400' },
} as const;

export function StatusBadge({ status }: { status: string | null }) {
  const config = statusConfig[(status as keyof typeof statusConfig) ?? 'offline'] ?? statusConfig.offline;
  return (
    <Badge variant="outline" className={cn('text-xs font-normal', config.className)}>
      <span className="mr-1">●</span>
      {config.label}
    </Badge>
  );
}
```

- [ ] **Step 7: Create type badge component**

```tsx
// packages/dashboard/src/components/agents/type-badge.tsx
import { Badge } from '@/components/ui/badge';

const typeColors: Record<string, string> = {
  'claude-code': 'border-indigo-800 bg-indigo-950 text-indigo-400',
  'codex': 'border-violet-800 bg-violet-950 text-violet-400',
  'aider': 'border-amber-800 bg-amber-950 text-amber-400',
  'devin': 'border-cyan-800 bg-cyan-950 text-cyan-400',
  'openclaw': 'border-emerald-800 bg-emerald-950 text-emerald-400',
  'custom': 'border-border bg-secondary text-muted-foreground',
};

export function TypeBadge({ type }: { type: string }) {
  const className = typeColors[type] ?? typeColors.custom;
  return (
    <Badge variant="outline" className={`text-xs font-normal ${className}`}>
      {type}
    </Badge>
  );
}
```

- [ ] **Step 8: Create agent table component**

```tsx
// packages/dashboard/src/components/agents/agent-table.tsx
'use client';

import { useRouter } from 'next/navigation';
import type { AgentListItem } from '@fluent-flow/db';
import { StatusBadge } from './status-badge';
import { TypeBadge } from './type-badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

function timeAgo(date: Date | string | null): string {
  if (!date) return '—';
  const seconds = Math.floor((Date.now() - new Date(date).getTime()) / 1000);
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

export function AgentTable({ agents }: { agents: AgentListItem[] }) {
  const router = useRouter();

  if (agents.length === 0) {
    return (
      <div className="flex min-h-[200px] items-center justify-center rounded-lg border border-border">
        <p className="text-sm text-muted-foreground">No agents registered</p>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Agent</TableHead>
            <TableHead>Type</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Last Seen</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {agents.map((agent) => (
            <TableRow
              key={agent.id}
              className="cursor-pointer"
              onClick={() => router.push(`/agents/${agent.id}`)}
            >
              <TableCell className="font-medium">{agent.id}</TableCell>
              <TableCell><TypeBadge type={agent.agent_type} /></TableCell>
              <TableCell><StatusBadge status={agent.status} /></TableCell>
              <TableCell className="text-muted-foreground">{timeAgo(agent.last_seen_at)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
```

- [ ] **Step 9: Create agent list page**

```tsx
// packages/dashboard/src/app/agents/page.tsx
import { getServerSession } from 'next-auth';
import { listAgents } from '@fluent-flow/db';
import { authOptions, getOrgScope } from '@/lib/auth';
import { AgentTable } from '@/components/agents/agent-table';

export default async function AgentsPage() {
  const session = await getServerSession(authOptions);
  if (!session) return null;

  const { orgIds } = getOrgScope(session);
  const agents = await listAgents(orgIds);

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-xl font-semibold">Agents</h1>
        <p className="text-sm text-muted-foreground">Manage your org's AI agents</p>
      </div>
      <AgentTable agents={agents} />
    </div>
  );
}
```

- [ ] **Step 10: Run tests**

```bash
cd packages/dashboard && npx vitest run
```

Expected: all tests pass.

- [ ] **Step 11: Commit**

```bash
git add packages/dashboard/src/app/agents/page.tsx packages/dashboard/src/app/api/agents/route.ts packages/dashboard/src/components/agents/ packages/dashboard/tests/ packages/dashboard/vitest.config.ts
git commit -m "feat: add agent list page with status/type badges and API route"
```

---

### Task 9: Agent detail page + API routes

**Files:**
- Create: `packages/dashboard/src/app/api/agents/[id]/route.ts`
- Create: `packages/dashboard/src/app/api/agents/[id]/key/route.ts`
- Create: `packages/dashboard/src/app/agents/[id]/page.tsx`
- Create: `packages/dashboard/src/components/agents/agent-detail-header.tsx`
- Create: `packages/dashboard/src/components/agents/sessions-tab.tsx`
- Create: `packages/dashboard/src/components/agents/claims-tab.tsx`
- Create: `packages/dashboard/src/components/agents/claim-type-badge.tsx`
- Create: `packages/dashboard/tests/api/agent-detail.test.ts`
- Create: `packages/dashboard/tests/api/agent-key.test.ts`

- [ ] **Step 1: Write failing test for agent detail API**

```typescript
// packages/dashboard/tests/api/agent-detail.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockGetServerSession = vi.fn();
const mockGetAgentDetail = vi.fn();
const mockGetAgentSessions = vi.fn();
const mockGetAgentClaims = vi.fn();
const mockGetKeyInfo = vi.fn();

vi.mock('next-auth', () => ({
  getServerSession: (...args: unknown[]) => mockGetServerSession(...args),
}));

vi.mock('@fluent-flow/db', () => ({
  getAgentDetail: (...args: unknown[]) => mockGetAgentDetail(...args),
  getAgentSessions: (...args: unknown[]) => mockGetAgentSessions(...args),
  getAgentClaims: (...args: unknown[]) => mockGetAgentClaims(...args),
  getKeyInfo: (...args: unknown[]) => mockGetKeyInfo(...args),
}));

vi.mock('@/lib/auth', () => ({
  authOptions: {},
  getOrgScope: vi.fn((session) => {
    if (session.user.isSuperadmin) return { orgIds: [], isSuperadmin: true };
    return { orgIds: session.user.orgs.map((o: { org_id: string }) => o.org_id), isSuperadmin: false };
  }),
}));

const { GET } = await import('../../src/app/api/agents/[id]/route.js');

describe('GET /api/agents/[id]', () => {
  beforeEach(() => {
    mockGetServerSession.mockReset();
    mockGetAgentDetail.mockReset();
    mockGetAgentSessions.mockReset();
    mockGetAgentClaims.mockReset();
    mockGetKeyInfo.mockReset();
  });

  it('returns 401 when not authenticated', async () => {
    mockGetServerSession.mockResolvedValueOnce(null);

    const response = await GET({} as Request, { params: Promise.resolve({ id: 'ff-runner' }) });
    expect(response.status).toBe(401);
  });

  it('returns 404 when agent not found', async () => {
    mockGetServerSession.mockResolvedValueOnce({
      user: { id: 1, isSuperadmin: false, orgs: [{ org_id: 'fluent-io' }] },
    });
    mockGetAgentDetail.mockResolvedValueOnce(null);

    const response = await GET({} as Request, { params: Promise.resolve({ id: 'nonexistent' }) });
    expect(response.status).toBe(404);
  });

  it('returns agent with sessions, claims, and key info', async () => {
    const agent = { id: 'ff-runner', org_id: 'fluent-io', agent_type: 'claude-code' };
    mockGetServerSession.mockResolvedValueOnce({
      user: { id: 1, isSuperadmin: false, orgs: [{ org_id: 'fluent-io' }] },
    });
    mockGetAgentDetail.mockResolvedValueOnce(agent);
    mockGetAgentSessions.mockResolvedValueOnce([]);
    mockGetAgentClaims.mockResolvedValueOnce([]);
    mockGetKeyInfo.mockResolvedValueOnce({ id: 3, created_at: new Date() });

    const response = await GET({} as Request, { params: Promise.resolve({ id: 'ff-runner' }) });
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.agent.id).toBe('ff-runner');
    expect(data.sessions).toEqual([]);
    expect(data.claims).toEqual([]);
    expect(data.key).toBeDefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd packages/dashboard && npx vitest run tests/api/agent-detail.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Write agent detail API route**

```typescript
// packages/dashboard/src/app/api/agents/[id]/route.ts
import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { getAgentDetail, getAgentSessions, getAgentClaims, getKeyInfo } from '@fluent-flow/db';
import { authOptions, getOrgScope } from '@/lib/auth';

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await getServerSession(authOptions);
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { id } = await params;
  const { orgIds } = getOrgScope(session);
  const agent = await getAgentDetail(orgIds, id);

  if (!agent) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const [sessions, claims, key] = await Promise.all([
    getAgentSessions(agent.org_id, agent.id),
    getAgentClaims(agent.org_id, agent.id),
    getKeyInfo(agent.org_id, agent.id),
  ]);

  return NextResponse.json({ agent, sessions, claims, key });
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await getServerSession(authOptions);
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { id } = await params;
  const { orgIds } = getOrgScope(session);
  const agent = await getAgentDetail(orgIds, id);

  if (!agent) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const { hasRole } = await import('@/lib/auth');
  if (!hasRole(session, agent.org_id, 'admin')) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const { query } = await import('@fluent-flow/db');
  await query('DELETE FROM agents WHERE org_id = $1 AND id = $2', [agent.org_id, agent.id]);

  return NextResponse.json({ deleted: true });
}
```

- [ ] **Step 4: Write failing test for key regeneration API**

```typescript
// packages/dashboard/tests/api/agent-key.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockGetServerSession = vi.fn();
const mockGetAgentDetail = vi.fn();
const mockRegenerateKey = vi.fn();

vi.mock('next-auth', () => ({
  getServerSession: (...args: unknown[]) => mockGetServerSession(...args),
}));

vi.mock('@fluent-flow/db', () => ({
  getAgentDetail: (...args: unknown[]) => mockGetAgentDetail(...args),
  regenerateKey: (...args: unknown[]) => mockRegenerateKey(...args),
}));

vi.mock('@/lib/auth', () => ({
  authOptions: {},
  getOrgScope: vi.fn((session) => {
    if (session.user.isSuperadmin) return { orgIds: [], isSuperadmin: true };
    return { orgIds: session.user.orgs.map((o: { org_id: string }) => o.org_id), isSuperadmin: false };
  }),
  hasRole: vi.fn((session, _orgId, minRole) => {
    if (session.user.isSuperadmin) return true;
    if (minRole === 'admin') return session.user.orgs.some((o: { role: string }) => o.role === 'admin');
    return true;
  }),
}));

const { POST } = await import('../../src/app/api/agents/[id]/key/route.js');

describe('POST /api/agents/[id]/key', () => {
  beforeEach(() => {
    mockGetServerSession.mockReset();
    mockGetAgentDetail.mockReset();
    mockRegenerateKey.mockReset();
  });

  it('returns 401 when not authenticated', async () => {
    mockGetServerSession.mockResolvedValueOnce(null);
    const response = await POST({} as Request, { params: Promise.resolve({ id: 'ff-runner' }) });
    expect(response.status).toBe(401);
  });

  it('returns 403 for members', async () => {
    mockGetServerSession.mockResolvedValueOnce({
      user: { id: 1, isSuperadmin: false, orgs: [{ org_id: 'fluent-io', role: 'member' }] },
    });
    mockGetAgentDetail.mockResolvedValueOnce({ id: 'ff-runner', org_id: 'fluent-io' });

    const response = await POST({} as Request, { params: Promise.resolve({ id: 'ff-runner' }) });
    expect(response.status).toBe(403);
  });

  it('regenerates key for admin', async () => {
    mockGetServerSession.mockResolvedValueOnce({
      user: { id: 1, isSuperadmin: false, orgs: [{ org_id: 'fluent-io', role: 'admin' }] },
    });
    mockGetAgentDetail.mockResolvedValueOnce({ id: 'ff-runner', org_id: 'fluent-io' });
    mockRegenerateKey.mockResolvedValueOnce({ plaintext: 'ff_abc123', id: 5 });

    const response = await POST({} as Request, { params: Promise.resolve({ id: 'ff-runner' }) });
    const data = await response.json();
    expect(response.status).toBe(200);
    expect(data.plaintext).toBe('ff_abc123');
  });
});
```

- [ ] **Step 5: Run test to verify it fails**

```bash
cd packages/dashboard && npx vitest run tests/api/agent-key.test.ts
```

Expected: FAIL.

- [ ] **Step 6: Write key regeneration API route**

```typescript
// packages/dashboard/src/app/api/agents/[id]/key/route.ts
import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { getAgentDetail, regenerateKey } from '@fluent-flow/db';
import { authOptions, getOrgScope, hasRole } from '@/lib/auth';

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await getServerSession(authOptions);
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { id } = await params;
  const { orgIds } = getOrgScope(session);
  const agent = await getAgentDetail(orgIds, id);

  if (!agent) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  if (!hasRole(session, agent.org_id, 'admin')) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const result = await regenerateKey(agent.org_id, agent.id);
  return NextResponse.json(result);
}
```

- [ ] **Step 7: Run test to verify it passes**

```bash
cd packages/dashboard && npx vitest run tests/api/agent-key.test.ts
```

Expected: PASS.

- [ ] **Step 8: Create claim type badge component**

```tsx
// packages/dashboard/src/components/agents/claim-type-badge.tsx
import { Badge } from '@/components/ui/badge';

const claimTypeColors: Record<string, string> = {
  spec: 'border-emerald-800 bg-emerald-950 text-emerald-400',
  build: 'border-amber-800 bg-amber-950 text-amber-400',
  review_fix: 'border-indigo-800 bg-indigo-950 text-indigo-400',
  test_verify: 'border-cyan-800 bg-cyan-950 text-cyan-400',
};

export function ClaimTypeBadge({ type }: { type: string }) {
  const className = claimTypeColors[type] ?? 'border-border bg-secondary text-muted-foreground';
  return (
    <Badge variant="outline" className={`text-xs font-normal ${className}`}>
      {type}
    </Badge>
  );
}
```

- [ ] **Step 9: Create sessions tab component**

```tsx
// packages/dashboard/src/components/agents/sessions-tab.tsx
import type { Session as AgentSession } from '@fluent-flow/db';
import { StatusBadge } from './status-badge';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';

export function SessionsTab({ sessions }: { sessions: AgentSession[] }) {
  if (sessions.length === 0) {
    return <p className="py-8 text-center text-sm text-muted-foreground">No sessions recorded</p>;
  }

  return (
    <div className="rounded-lg border border-border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Status</TableHead>
            <TableHead>Hostname</TableHead>
            <TableHead>OS</TableHead>
            <TableHead>Connected</TableHead>
            <TableHead>Last Poll</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {sessions.map((s) => {
            const meta = (s.session_meta ?? {}) as Record<string, unknown>;
            return (
              <TableRow key={s.id}>
                <TableCell><StatusBadge status={s.status} /></TableCell>
                <TableCell>{(meta.hostname as string) ?? '—'}</TableCell>
                <TableCell className="text-muted-foreground">{(meta.os as string) ?? '—'}</TableCell>
                <TableCell className="text-muted-foreground">
                  {new Date(s.registered_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {new Date(s.last_seen_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}
```

- [ ] **Step 10: Create claims tab component**

```tsx
// packages/dashboard/src/components/agents/claims-tab.tsx
import type { Claim } from '@fluent-flow/db';
import { StatusBadge } from './status-badge';
import { ClaimTypeBadge } from './claim-type-badge';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';

export function ClaimsTab({ claims }: { claims: Claim[] }) {
  if (claims.length === 0) {
    return <p className="py-8 text-center text-sm text-muted-foreground">No claims recorded</p>;
  }

  return (
    <div className="rounded-lg border border-border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Type</TableHead>
            <TableHead>Repo / PR</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Claimed</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {claims.map((c) => (
            <TableRow key={c.id}>
              <TableCell><ClaimTypeBadge type={c.claim_type} /></TableCell>
              <TableCell>
                <a
                  href={`https://github.com/${c.repo}/pull/${c.pr_number}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-primary hover:underline"
                >
                  {c.repo} #{c.pr_number}
                </a>
              </TableCell>
              <TableCell><StatusBadge status={c.status} /></TableCell>
              <TableCell className="text-muted-foreground">
                {c.claimed_at
                  ? new Date(c.claimed_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
                  : '—'}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
```

- [ ] **Step 11: Create agent detail header component**

```tsx
// packages/dashboard/src/components/agents/agent-detail-header.tsx
'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { Agent } from '@fluent-flow/db';
import { StatusBadge } from './status-badge';
import { TypeBadge } from './type-badge';
import { Button } from '@/components/ui/button';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger,
} from '@/components/ui/dialog';

interface AgentDetailHeaderProps {
  agent: Agent;
  keyInfo: { id: number; created_at: string } | null;
  status: string | null;
  isAdmin: boolean;
}

export function AgentDetailHeader({ agent, keyInfo, status, isAdmin }: AgentDetailHeaderProps) {
  const router = useRouter();
  const [newKey, setNewKey] = useState<string | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [regenerating, setRegenerating] = useState(false);
  const [deleting, setDeleting] = useState(false);

  async function handleRegenerate() {
    setRegenerating(true);
    const res = await fetch(`/api/agents/${agent.id}/key`, { method: 'POST' });
    const data = await res.json();
    setNewKey(data.plaintext);
    setRegenerating(false);
  }

  async function handleDelete() {
    setDeleting(true);
    await fetch(`/api/agents/${agent.id}`, { method: 'DELETE' });
    setDeleting(false);
    setDeleteOpen(false);
    router.push('/agents');
  }

  return (
    <div className="rounded-lg border border-border bg-card p-5">
      <div className="flex items-start justify-between">
        <div>
          <div className="mb-2 flex items-center gap-2.5">
            <h1 className="text-xl font-semibold">{agent.id}</h1>
            <StatusBadge status={status} />
          </div>
          <div className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-muted-foreground">
            <div>Type: <TypeBadge type={agent.agent_type} /></div>
            <div>Transport: {agent.transport}</div>
            <div>Registered: {new Date(agent.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</div>
            <div>Repos: {agent.repos.join(', ')}</div>
          </div>
        </div>
        {isAdmin && (
          <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
            <DialogTrigger asChild>
              <Button variant="outline" size="sm" className="border-destructive text-destructive hover:bg-destructive/10">
                Delete Agent
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Delete {agent.id}?</DialogTitle>
                <DialogDescription>
                  This will permanently delete the agent, revoke its API key, and fail any active claims. This action cannot be undone.
                </DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <Button variant="outline" onClick={() => setDeleteOpen(false)}>Cancel</Button>
                <Button variant="destructive" onClick={handleDelete} disabled={deleting}>
                  {deleting ? 'Deleting...' : 'Delete'}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        )}
      </div>

      {/* API Key section */}
      <div className="mt-4 flex items-center justify-between border-t border-border pt-4">
        {newKey ? (
          <div className="w-full rounded-md border border-green-800 bg-green-950 p-3">
            <div className="mb-1 flex items-center justify-between">
              <span className="text-xs font-medium text-green-400">New API key generated</span>
              <Button
                variant="outline"
                size="sm"
                className="h-6 text-xs"
                onClick={() => navigator.clipboard.writeText(newKey)}
              >
                Copy
              </Button>
            </div>
            <code className="block rounded border border-border bg-background p-2 font-mono text-xs">
              {newKey}
            </code>
            <p className="mt-2 text-xs text-amber-400">
              Copy this key now. It won't be shown again.
            </p>
          </div>
        ) : (
          <>
            <div className="flex items-center gap-3">
              <span className="text-xs uppercase tracking-wider text-muted-foreground">API Key</span>
              <span className="text-xs text-muted-foreground">
                {keyInfo ? `Created ${new Date(keyInfo.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}` : 'No key'}
              </span>
            </div>
            {isAdmin && (
              <Button variant="outline" size="sm" className="border-amber-700 text-amber-400 hover:bg-amber-950" onClick={handleRegenerate} disabled={regenerating}>
                {regenerating ? 'Regenerating...' : 'Regenerate'}
              </Button>
            )}
          </>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 12: Create agent detail page**

```tsx
// packages/dashboard/src/app/agents/[id]/page.tsx
import Link from 'next/link';
import { getServerSession } from 'next-auth';
import { getAgentDetail, getAgentSessions, getAgentClaims, getKeyInfo } from '@fluent-flow/db';
import { authOptions, getOrgScope, hasRole } from '@/lib/auth';
import { AgentDetailHeader } from '@/components/agents/agent-detail-header';
import { SessionsTab } from '@/components/agents/sessions-tab';
import { ClaimsTab } from '@/components/agents/claims-tab';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { notFound } from 'next/navigation';

export default async function AgentDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await getServerSession(authOptions);
  if (!session) return null;

  const { id } = await params;
  const { orgIds } = getOrgScope(session);
  const agent = await getAgentDetail(orgIds, id);

  if (!agent) notFound();

  const [sessions, claims, key] = await Promise.all([
    getAgentSessions(agent.org_id, agent.id),
    getAgentClaims(agent.org_id, agent.id),
    getKeyInfo(agent.org_id, agent.id),
  ]);

  const latestSession = sessions[0] ?? null;
  const isAdmin = hasRole(session, agent.org_id, 'admin');

  return (
    <div>
      <div className="mb-4 text-xs text-muted-foreground">
        <Link href="/agents" className="text-primary hover:underline">Agents</Link>
        <span className="mx-1">/</span>
        {agent.id}
      </div>

      <AgentDetailHeader
        agent={agent}
        keyInfo={key}
        status={latestSession?.status ?? 'offline'}
        isAdmin={isAdmin}
      />

      <Tabs defaultValue="sessions" className="mt-6">
        <TabsList>
          <TabsTrigger value="sessions">Sessions</TabsTrigger>
          <TabsTrigger value="claims">Claims</TabsTrigger>
        </TabsList>
        <TabsContent value="sessions" className="mt-4">
          <SessionsTab sessions={sessions} />
        </TabsContent>
        <TabsContent value="claims" className="mt-4">
          <ClaimsTab claims={claims} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
```

- [ ] **Step 13: Run all tests**

```bash
cd packages/dashboard && npx vitest run
```

Expected: all tests pass.

- [ ] **Step 14: Commit**

```bash
git add packages/dashboard/src/app/agents/[id]/ packages/dashboard/src/app/api/agents/[id]/ packages/dashboard/src/components/agents/ packages/dashboard/tests/
git commit -m "feat: add agent detail page with sessions, claims, and API key management"
```

---

### Task 10: Verify end-to-end

- [ ] **Step 1: Install all workspace dependencies**

```bash
cd d:/work/fluentflow/fluent-flow && npm install
```

- [ ] **Step 2: Run all tests across the monorepo**

```bash
npm test
```

Expected: all packages pass — existing 427 tests + new db + dashboard tests.

- [ ] **Step 3: Verify TypeScript compiles**

```bash
cd packages/db && npx tsc --noEmit
cd ../dashboard && npx tsc --noEmit
```

- [ ] **Step 4: Start dashboard dev server and verify manually**

```bash
cd packages/dashboard && npm run dev
```

Verify:
1. http://localhost:3000 redirects to /agents
2. /agents redirects to /login when not authenticated
3. After GitHub OAuth login, agent list page renders
4. Clicking an agent row navigates to detail page
5. Sessions and Claims tabs render data
6. API Key section shows creation date + Regenerate button for admins
7. Regenerate shows new key with copy button and warning
8. Delete agent shows confirmation dialog

- [ ] **Step 5: Commit any fixes**

```bash
git add -A && git commit -m "fix: end-to-end verification fixes"
```

(Only if fixes were needed.)
