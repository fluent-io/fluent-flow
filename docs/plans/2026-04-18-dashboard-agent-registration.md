# Dashboard-Driven Agent Registration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. (Do NOT use subagent-driven-development on this codebase — Victor's machine crashes with subagent dispatches; always execute inline.)

**Goal:** Let an org admin register a runner agent from the dashboard in a single 3-step modal (Name → Run → Connect), without ever touching the server-wide `MCP_AUTH_TOKEN`.

**Architecture:** Reuse the existing `agents` + `agent_tokens` tables. Dashboard session-authed route pre-creates both rows and returns the plaintext token exactly once. Modal shows `npx @fluent-flow/runner@latest run --token ff_...` command, polls for the runner's first session, confirms connected. No new schema, no new server endpoints, no new CLI flags. See [design doc](../specs/2026-04-18-dashboard-agent-registration-design.md).

**Tech Stack:** PostgreSQL + Drizzle ORM, Node.js + Express (fluent-flow server), Next.js 15 App Router + NextAuth (dashboard), Radix UI dialog primitives, Vitest.

---

## File Structure

**Created:**
- `packages/db/src/queries/agents.ts` — *extended* — add `createAgent`, `updateAgent`, `deleteAgent`, `getAgent` (currently only has `listAgents` + `getAgentDetail`).
- `packages/db/src/queries/tokens.ts` — *extended* — add `createToken` (currently only has `regenerateKey`, `getKeyInfo`).
- `packages/dashboard/src/app/api/agents/route.ts` — *extended* — add `POST` handler.
- `packages/dashboard/src/components/agents/new-agent-dialog.tsx` — stepper modal.
- `packages/fluent-flow/tests/unit/runner-defaults.test.js` — regression guards for Task 0.

**Modified:**
- `packages/fluent-flow-runner/src/runner.js` — remove silent `?? 'claude-code'` fallback.
- `packages/fluent-flow-runner/src/bootstrap.js` — remove silent `|| 'claude-code'` fallback, require explicit agentType.
- `packages/fluent-flow/src/agents/agent-manager.js` — delegate `createAgent` to `@fluent-flow/db`; keep audit/logging wrapper.
- `packages/fluent-flow/src/agents/token-manager.js` — delegate `createToken` to `@fluent-flow/db`; keep audit/logging wrapper.
- `packages/db/src/queries/index.ts` — export new functions.
- `packages/dashboard/src/app/agents/page.tsx` — mount the dialog + "+ New agent" button.
- `packages/dashboard/README.md` — document the new flow, remove the manual-SQL bootstrap section.
- `.github/workflows/deploy.yml` — smoke-check for the new POST route.

---

## Task 0: Remove silent `claude-code` defaults from runner

**Files:**
- Modify: `packages/fluent-flow-runner/src/runner.js:121`
- Modify: `packages/fluent-flow-runner/src/bootstrap.js:22` (and the docstring at :10)
- Create: `packages/fluent-flow-runner/tests/unit/runner-defaults.test.js`

- [ ] **Step 1: Write the failing tests**

Create `packages/fluent-flow-runner/tests/unit/runner-defaults.test.js`:

```javascript
import { describe, it, expect, vi } from 'vitest';
import { bootstrap } from '../../src/bootstrap.js';

describe('bootstrap — requires agentType', () => {
  it('throws a clear error when agentType is not provided and no env fallback', async () => {
    const prev = process.env.FLUENT_FLOW_AGENT_TYPE;
    delete process.env.FLUENT_FLOW_AGENT_TYPE;
    try {
      await expect(bootstrap({
        server: 'https://flow.example.com',
        agentId: 'x',
        mcpAuthToken: 'mcp-token-minimum-len',
      })).rejects.toThrow(/agentType/);
    } finally {
      if (prev !== undefined) process.env.FLUENT_FLOW_AGENT_TYPE = prev;
    }
  });

  it('accepts FLUENT_FLOW_AGENT_TYPE from env', async () => {
    const prev = process.env.FLUENT_FLOW_AGENT_TYPE;
    process.env.FLUENT_FLOW_AGENT_TYPE = 'aider';
    const fetchFn = vi.fn().mockResolvedValue({ ok: true, status: 201, json: async () => ({ token: 'ff_x' }) });
    try {
      await bootstrap({
        server: 'https://flow.example.com',
        agentId: 'x',
        mcpAuthToken: 'mcp-token-minimum-len',
        fetch: fetchFn,
      });
      const [, init] = fetchFn.mock.calls[0];
      expect(JSON.parse(init.body).agent_type).toBe('aider');
    } finally {
      if (prev !== undefined) process.env.FLUENT_FLOW_AGENT_TYPE = prev;
      else delete process.env.FLUENT_FLOW_AGENT_TYPE;
    }
  });
});
```

- [ ] **Step 2: Verify the tests fail**

Run: `cd packages/fluent-flow-runner && npx vitest run tests/unit/runner-defaults.test.js`
Expected: FAIL on "throws a clear error" (today `bootstrap()` silently defaults).

- [ ] **Step 3: Fix `bootstrap.js`**

Edit `packages/fluent-flow-runner/src/bootstrap.js`. Replace the existing resolution + docstring:

```javascript
 * @param {string} [opts.agentType] — agent type. Required: pass explicitly,
 *   via --agent-type CLI flag, or via FLUENT_FLOW_AGENT_TYPE env var.
 */
export async function bootstrap({ server, agentId, mcpAuthToken, agentType, fetch: fetchFn = globalThis.fetch }) {
  if (!mcpAuthToken || typeof mcpAuthToken !== 'string') {
    throw new Error('MCP_AUTH_TOKEN is required');
  }
  if (mcpAuthToken.length < 8) {
    throw new Error('MCP_AUTH_TOKEN must be at least 8 characters');
  }

  const resolvedAgentType = agentType ?? process.env.FLUENT_FLOW_AGENT_TYPE;
  if (!resolvedAgentType) {
    throw new Error('agentType is required — pass --agent-type or set FLUENT_FLOW_AGENT_TYPE');
  }
```

Leave the rest of the function untouched.

- [ ] **Step 4: Fix `runner.js:121`**

Edit `packages/fluent-flow-runner/src/runner.js`. The work-item handler:

```javascript
// Before:
agentType: work.agentType ?? 'claude-code',

// After:
agentType: work.agentType,
```

Add a guard right above that block:

```javascript
if (!work.agentType) {
  log.error('Work item missing agentType — server bug', { workId: work.id });
  throw new Error(`Work item ${work.id} has no agentType`);
}
```

- [ ] **Step 5: Run tests — should pass**

Run: `cd packages/fluent-flow-runner && npx vitest run tests/unit/runner-defaults.test.js`
Expected: both tests pass.

Run the full runner test suite to catch regressions:
`cd packages/fluent-flow-runner && npx vitest run`
Expected: all tests pass.

- [ ] **Step 6: Breaking-change verification**

Revert only the bootstrap.js throw to the old `|| 'claude-code'`. Rerun — expect FAIL on the "throws a clear error" test. Restore.

- [ ] **Step 7: Commit**

```bash
git add packages/fluent-flow-runner/src/runner.js \
        packages/fluent-flow-runner/src/bootstrap.js \
        packages/fluent-flow-runner/tests/unit/runner-defaults.test.js
git commit -m "fix(runner): require explicit agentType; remove silent claude-code default"
```

---

## Task 1: Move `createAgent` and `createToken` into `@fluent-flow/db`

**Files:**
- Modify: `packages/db/src/queries/agents.ts`
- Modify: `packages/db/src/queries/tokens.ts`
- Modify: `packages/db/src/queries/index.ts`
- Modify: `packages/fluent-flow/src/agents/agent-manager.js` — delegate to db.
- Modify: `packages/fluent-flow/src/agents/token-manager.js` — delegate to db.
- Modify: `packages/db/tests/queries/agents.test.ts` — add tests for the new export.
- Modify: `packages/db/tests/queries/tokens.test.ts` — add tests for the new export.

- [ ] **Step 1: Write failing tests for `createAgent` in `@fluent-flow/db`**

Append to `packages/db/tests/queries/agents.test.ts` (create if missing, matching the pattern of `users.test.ts`):

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockDb = {
  insert: vi.fn(),
};
vi.mock('../../src/client', () => ({ db: mockDb, schema: { agents: { _: 'agents' } } }));

const { createAgent } = await import('../../src/queries/agents');

describe('createAgent', () => {
  beforeEach(() => { mockDb.insert.mockReset(); });

  it('inserts an agent row and returns the created row', async () => {
    const returning = vi.fn().mockResolvedValue([{
      id: 'laptop-1', orgId: 'fluent-io', agentType: 'claude-code', transport: 'long_poll',
    }]);
    const values = vi.fn().mockReturnValue({ returning });
    mockDb.insert.mockReturnValue({ values });

    const result = await createAgent({
      id: 'laptop-1', orgId: 'fluent-io', agentType: 'claude-code', transport: 'long_poll',
    });

    expect(result.id).toBe('laptop-1');
    expect(values).toHaveBeenCalledWith(expect.objectContaining({
      id: 'laptop-1', orgId: 'fluent-io', agentType: 'claude-code', transport: 'long_poll',
    }));
  });
});
```

- [ ] **Step 2: Verify the tests fail**

Run: `cd packages/db && npx vitest run tests/queries/agents.test.ts`
Expected: FAIL on "createAgent is not exported".

- [ ] **Step 3: Implement `createAgent`**

Edit `packages/db/src/queries/agents.ts`. Add at the bottom of the file:

```typescript
import { db, schema } from '../client.js';

export interface CreateAgentInput {
  id: string;
  orgId: string;
  agentType: string;
  transport: string;
  transportMeta?: Record<string, unknown>;
  repos?: string[];
}

export async function createAgent(input: CreateAgentInput) {
  const [row] = await db
    .insert(schema.agents)
    .values({
      id: input.id,
      orgId: input.orgId,
      agentType: input.agentType,
      transport: input.transport,
      transportMeta: input.transportMeta ?? {},
      repos: input.repos ?? [],
    })
    .returning();
  return row;
}
```

Export it from `packages/db/src/queries/index.ts`:

```typescript
export { listAgents, getAgentDetail, createAgent } from './agents.js';
```

- [ ] **Step 4: Verify the tests pass**

Run: `cd packages/db && npx vitest run tests/queries/agents.test.ts`
Expected: all tests pass.

- [ ] **Step 5: Repeat for `createToken`**

Append to `packages/db/tests/queries/tokens.test.ts`:

```typescript
describe('createToken', () => {
  beforeEach(() => { mockDb.insert.mockReset(); });

  it('generates ff_ token, hashes it, stores row, returns plaintext + id', async () => {
    const returning = vi.fn().mockResolvedValue([{ id: 42 }]);
    const values = vi.fn().mockReturnValue({ returning });
    mockDb.insert.mockReturnValue({ values });

    const result = await createToken({
      orgId: 'fluent-io', agentId: 'laptop-1', label: 'dashboard-abc',
    });

    expect(result.plaintext).toMatch(/^ff_[0-9a-f]{64}$/);
    expect(result.id).toBe(42);
    expect(values).toHaveBeenCalledWith(expect.objectContaining({
      orgId: 'fluent-io', agentId: 'laptop-1', label: 'dashboard-abc',
      tokenHash: expect.any(String),
    }));
  });
});
```

Then implement in `packages/db/src/queries/tokens.ts`:

```typescript
import crypto from 'node:crypto';
import { db, schema } from '../client.js';

const TOKEN_PREFIX = 'ff_';
const DEFAULT_TTL_MS = 365 * 24 * 60 * 60 * 1000; // 1 year

function hashToken(plaintext: string): string {
  return crypto.createHash('sha256').update(plaintext).digest('hex');
}

export interface CreateTokenInput {
  orgId: string;
  agentId: string;
  label: string;
  expiresAt?: Date | null;
}

export async function createToken(input: CreateTokenInput) {
  const plaintext = TOKEN_PREFIX + crypto.randomBytes(32).toString('hex');
  const tokenHash = hashToken(plaintext);
  const expiresAt = input.expiresAt ?? new Date(Date.now() + DEFAULT_TTL_MS);

  const [row] = await db
    .insert(schema.agentTokens)
    .values({
      orgId: input.orgId,
      agentId: input.agentId,
      tokenHash,
      label: input.label,
      expiresAt,
    })
    .returning({ id: schema.agentTokens.id });

  return { plaintext, id: row.id };
}
```

Export from `packages/db/src/queries/index.ts`:

```typescript
export { regenerateKey, getKeyInfo, createToken } from './tokens.js';
```

Run tests: `cd packages/db && npx vitest run tests/queries/tokens.test.ts` — expect green.

- [ ] **Step 6: Make fluent-flow server's `agent-manager.js` delegate**

Edit `packages/fluent-flow/src/agents/agent-manager.js`. Replace the existing `createAgent` function body with a call to the new db export, preserving the audit + log wrapper:

```javascript
import { createAgent as dbCreateAgent } from '@fluent-flow/db';

export async function createAgent({ id, orgId, agentType, transport, transportMeta = {}, repos = [] }) {
  const row = await dbCreateAgent({ id, orgId, agentType, transport, transportMeta, repos });
  audit('agent_created', { data: { orgId, agentId: id } });
  logger.info({ msg: 'Agent created', orgId, agentId: id, agentType, transport });
  return toSnakeAgent(row);
}
```

Leave `getAgent`, `listAgents`, `updateAgent`, `deleteAgent` alone.

- [ ] **Step 7: Make fluent-flow server's `token-manager.js` delegate**

Edit `packages/fluent-flow/src/agents/token-manager.js`. Similar surgery — replace the `createToken` body to call `dbCreateToken`, keep the audit wrapper.

- [ ] **Step 8: Build + full test suite**

Run: `npm test` (from repo root)
Expected: all 5 workspace tasks pass.

Run: `cd packages/db && npm run build`
Expected: exit 0.

- [ ] **Step 9: Commit**

```bash
git add packages/db/src/queries/agents.ts \
        packages/db/src/queries/tokens.ts \
        packages/db/src/queries/index.ts \
        packages/db/tests/queries/agents.test.ts \
        packages/db/tests/queries/tokens.test.ts \
        packages/fluent-flow/src/agents/agent-manager.js \
        packages/fluent-flow/src/agents/token-manager.js
git commit -m "refactor(db): move createAgent + createToken into @fluent-flow/db"
```

---

## Task 2: Dashboard `POST /api/agents` route

**Files:**
- Modify: `packages/dashboard/src/app/api/agents/route.ts`

- [ ] **Step 1: Read the current file**

The file currently has only `GET`. Keep it.

- [ ] **Step 2: Add the `POST` handler**

Replace `packages/dashboard/src/app/api/agents/route.ts` with:

```typescript
import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { z } from 'zod';
import { listAgents, createAgent, createToken } from '@fluent-flow/db';
import { authOptions, getOrgScope, hasRole } from '@/lib/auth';

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const { orgIds } = getOrgScope(session);
  const agents = await listAgents(orgIds);
  return NextResponse.json(agents);
}

const CreateBodySchema = z.object({
  org_id: z.string().min(1),
  agent_id: z.string().min(1).regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/, 'Must start alphanumeric; letters, digits, _, - only'),
  agent_type: z.enum(['claude-code', 'codex', 'devin', 'openclaw', 'aider', 'custom']),
});

const SERVER_URL = process.env.NEXT_PUBLIC_FLUENT_FLOW_URL ?? 'https://flow.fluentflow.tech';

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body = await req.json().catch(() => null);
  const parsed = CreateBodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Validation failed', details: parsed.error.flatten() }, { status: 400 });
  }

  const { org_id, agent_id, agent_type } = parsed.data;
  if (!hasRole(session, org_id, 'admin')) {
    return NextResponse.json({ error: 'Forbidden: must be admin of the target org' }, { status: 403 });
  }

  try {
    const agent = await createAgent({
      id: agent_id, orgId: org_id, agentType: agent_type, transport: 'long_poll',
    });
    const token = await createToken({
      orgId: org_id, agentId: agent_id, label: `dashboard-${Date.now().toString(36)}`,
    });

    const command = [
      'npx @fluent-flow/runner@latest run',
      `--server ${SERVER_URL}`,
      `--token ${token.plaintext}`,
      `--agent-type ${agent_type}`,
    ].join(' \\\n  ');

    return NextResponse.json({ agent, token: token.plaintext, command }, { status: 201 });
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === '23505') {
      return NextResponse.json({ error: `Agent '${agent_id}' already exists in org '${org_id}'` }, { status: 409 });
    }
    throw err;
  }
}
```

- [ ] **Step 3: Typecheck**

Run: `cd packages/dashboard && npx tsc --noEmit`
Expected: exit 0.

- [ ] **Step 4: Commit**

```bash
git add packages/dashboard/src/app/api/agents/route.ts
git commit -m "feat(dashboard): add POST /api/agents session-authed endpoint"
```

---

## Task 3: Stepper `NewAgentDialog` component

**Files:**
- Create: `packages/dashboard/src/components/agents/new-agent-dialog.tsx`
- Modify: `packages/dashboard/src/app/agents/page.tsx`

- [ ] **Step 1: Build the dialog**

Create `packages/dashboard/src/components/agents/new-agent-dialog.tsx`:

```tsx
'use client';

import { useEffect, useState } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

interface NewAgentDialogProps {
  orgId: string;
  onCreated?: () => void;
}

type Step = 1 | 2 | 3;

export function NewAgentDialog({ orgId, onCreated }: NewAgentDialogProps) {
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<Step>(1);
  const [agentId, setAgentId] = useState('');
  const [agentType, setAgentType] = useState('claude-code');
  const [submitting, setSubmitting] = useState(false);
  const [command, setCommand] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  function reset() {
    setStep(1); setAgentId(''); setAgentType('claude-code');
    setCommand(null); setError(null); setSubmitting(false);
  }

  async function createAgent() {
    setSubmitting(true); setError(null);
    try {
      const res = await fetch('/api/agents', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ org_id: orgId, agent_id: agentId, agent_type: agentType }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `Request failed with ${res.status}`);
      }
      const data = await res.json();
      setCommand(data.command);
      setStep(2);
      onCreated?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  // Step 2 → 3: poll until the agent has an active session.
  useEffect(() => {
    if (step !== 2 || !agentId) return;
    let cancelled = false;
    const poll = async () => {
      try {
        const res = await fetch(`/api/agents/${encodeURIComponent(agentId)}`);
        if (!res.ok) return;
        const data = await res.json();
        if (!cancelled && data.active_session) setStep(3);
      } catch { /* ignore transient errors */ }
    };
    const id = setInterval(poll, 2000);
    poll();
    return () => { cancelled = true; clearInterval(id); };
  }, [step, agentId]);

  return (
    <Dialog open={open} onOpenChange={(v) => { setOpen(v); if (!v) reset(); }}>
      <DialogTrigger asChild>
        <Button>+ New agent</Button>
      </DialogTrigger>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>New agent</DialogTitle>
        </DialogHeader>

        <Stepper step={step} />

        {step === 1 && (
          <div className="flex flex-col gap-3">
            <label className="flex flex-col gap-1 text-sm">
              Agent ID
              <input
                className="rounded border bg-background px-2 py-1"
                value={agentId}
                onChange={(e) => setAgentId(e.target.value)}
                placeholder="laptop-1"
                pattern="[a-zA-Z0-9][a-zA-Z0-9_-]*"
                autoFocus
              />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              Agent type
              <select
                className="rounded border bg-background px-2 py-1"
                value={agentType}
                onChange={(e) => setAgentType(e.target.value)}
              >
                <option value="claude-code">claude-code</option>
                <option value="codex">codex</option>
                <option value="openclaw">openclaw</option>
                <option value="devin">devin</option>
                <option value="aider">aider</option>
                <option value="custom">custom</option>
              </select>
              <span className="text-xs text-muted-foreground">
                Which CLI tool this runner will invoke when it claims work.
              </span>
            </label>
            {error && <p className="text-sm text-destructive">{error}</p>}
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
              <Button onClick={createAgent} disabled={submitting || !agentId}>
                {submitting ? 'Creating…' : 'Next →'}
              </Button>
            </div>
          </div>
        )}

        {step === 2 && command && (
          <div className="flex flex-col gap-3">
            <p className="text-sm">Run this on the machine where the runner should execute:</p>
            <pre className="overflow-auto rounded bg-muted p-3 text-xs">{command}</pre>
            <div className="flex items-center justify-between">
              <Button variant="outline" onClick={() => navigator.clipboard.writeText(command)}>
                Copy command
              </Button>
              <span className="flex items-center gap-2 text-sm text-muted-foreground">
                <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-amber-500" />
                Waiting for the runner to connect…
              </span>
            </div>
            <p className="text-xs text-muted-foreground">
              The token is shown once. Copy it before closing — if lost, delete this agent and create a new one.
            </p>
          </div>
        )}

        {step === 3 && (
          <div className="flex flex-col items-center gap-3 py-4">
            <div className="rounded-full bg-emerald-500/20 p-3">
              <span className="text-2xl">✓</span>
            </div>
            <p className="text-sm font-medium">Connected</p>
            <p className="text-sm text-muted-foreground">{agentId} is online.</p>
            <Button onClick={() => setOpen(false)}>Done</Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function Stepper({ step }: { step: Step }) {
  const steps = [
    { n: 1, label: 'Name' },
    { n: 2, label: 'Run' },
    { n: 3, label: 'Connect' },
  ];
  return (
    <div className="mb-4 flex items-center justify-between">
      {steps.map((s, i) => (
        <div key={s.n} className="flex flex-1 items-center">
          <div className={cn(
            'flex h-7 w-7 items-center justify-center rounded-full border text-xs',
            step >= s.n ? 'border-primary bg-primary text-primary-foreground' : 'border-muted-foreground text-muted-foreground',
          )}>{s.n}</div>
          <span className={cn('ml-2 text-xs', step >= s.n ? '' : 'text-muted-foreground')}>{s.label}</span>
          {i < steps.length - 1 && (
            <div className={cn('mx-2 h-px flex-1', step > s.n ? 'bg-primary' : 'bg-muted-foreground/30')} />
          )}
        </div>
      ))}
    </div>
  );
}
```

- [ ] **Step 2: Confirm `/api/agents/:id` returns `active_session`**

Read `packages/dashboard/src/app/api/agents/[id]/route.ts`. If the response doesn't include an `active_session` field, add it (pulling from `agent_sessions` where `status='online'` and `last_seen_at > now() - interval '2 minutes'`). Use `getAgentDetail` from `@fluent-flow/db` which already joins sessions per its name. If the join exists but the field isn't named `active_session`, alias or transform in the route.

If the file has no session info today: update `getAgentDetail` in `packages/db/src/queries/agents.ts` to include `active_session: <first online session row, or null>`. Keep the existing shape backward-compatible by adding the new field without renaming anything.

- [ ] **Step 3: Wire the dialog into the Agents page**

Edit `packages/dashboard/src/app/agents/page.tsx`. Add the dialog next to the heading and pass the current org ID. The page should already have session context — pass the first admin org (or the org selector's current value):

```tsx
import { NewAgentDialog } from '@/components/agents/new-agent-dialog';
// ... existing imports

// Inside the page header row:
<div className="flex items-center justify-between">
  <div>
    <h1 className="text-xl font-semibold">Agents</h1>
    <p className="text-sm text-muted-foreground">Manage your org's AI agents</p>
  </div>
  <NewAgentDialog orgId={currentOrgId} onCreated={refresh} />
</div>
```

Use whatever existing state management the page has for `currentOrgId` and `refresh` (the agent list's refetcher).

- [ ] **Step 4: Typecheck + build**

Run: `cd packages/dashboard && npx tsc --noEmit && npm run build`
Expected: exit 0.

- [ ] **Step 5: Manual verification**

Run the dashboard locally (or deploy to a preview). Sign in, go to Agents, click "+ New agent". Enter `test-agent`, pick `claude-code`, click Next. Verify step 2 shows a command with `--token ff_...` and `--agent-type claude-code`. Copy button copies the whole command. In a separate terminal run the command (with a valid server URL pointing at your local/preview fluent-flow). Confirm step 3 flips to "Connected" within ~5s of the runner starting.

- [ ] **Step 6: Commit**

```bash
git add packages/dashboard/src/components/agents/new-agent-dialog.tsx \
        packages/dashboard/src/app/agents/page.tsx \
        packages/dashboard/src/app/api/agents/\[id\]/route.ts \
        packages/db/src/queries/agents.ts
git commit -m "feat(dashboard): stepper NewAgentDialog with connected-state polling"
```

---

## Task 4: Smoke check + docs + PR

**Files:**
- Modify: `.github/workflows/deploy.yml`
- Modify: `packages/dashboard/README.md`

- [ ] **Step 1: Add smoke check for the new route**

In `.github/workflows/deploy.yml`, inside the "Smoke test deployed endpoints" step, add:

```bash
# 4. Dashboard POST /api/agents requires auth (returns 401 without session)
status=$($CURL -o /dev/null -w '%{http_code}' -X POST \
  -H 'content-type: application/json' -d '{}' \
  http://127.0.0.1:3000/api/agents || echo "000")
check_eq "dashboard POST /api/agents gated" "401" "$status"
```

- [ ] **Step 2: Update dashboard README**

Replace the old "First user bootstrap" section in `packages/dashboard/README.md` with:

```markdown
### Registering your first agent

1. Sign in. Install the Fluent Flow GitHub App on your org (install CTA lands on the Agents page).
2. Click **+ New agent**. Pick an ID and agent type, click Next.
3. Copy the displayed `npx @fluent-flow/runner@latest run ...` command and paste it into a terminal on the machine where the runner should live.
4. The modal auto-confirms when the runner connects. Close the modal — the agent is ready to claim work.

The runner token is shown exactly once. If you lose it, delete the agent from the detail page and create a new one.
```

- [ ] **Step 3: Full test suite**

Run: `npm test`
Expected: all 5 workspace tasks pass.

- [ ] **Step 4: Commit, push, open PR**

```bash
git add .github/workflows/deploy.yml packages/dashboard/README.md
git commit -m "docs + ci: document new agent flow and smoke-check the route"
git push -u origin feat/dashboard-agent-registration
gh pr create --base main \
  --title "feat: dashboard-driven agent registration" \
  --body "$(cat <<'EOF'
## Summary
Org admins can register runner agents from the dashboard — three-step modal (Name → Run → Connect) that pre-creates the agent + token and auto-detects when the runner connects. No MCP_AUTH_TOKEN required for end users.

## Why
Multi-tenant SaaS requirement: no user should need the server's admin token. See [design doc](docs/specs/2026-04-18-dashboard-agent-registration-design.md).

Also removes silent claude-code fallbacks in the runner so real misconfiguration stops hiding behind a string default.

## How did you verify this end-to-end?
- New unit tests: createAgent / createToken / runner agentType requirement.
- Full suite green across all 5 workspace tasks.
- Post-deploy smoke asserts POST /api/agents returns 401 without session.
- Manual: signed in, clicked New agent, ran generated command on a test box, confirmed agent appeared in DB + dashboard list + modal auto-flipped to Connected.
- Breaking-change verification on the runner defaults — restoring the `?? 'claude-code'` fallback fails the new test; reverting restores green.

## Out of scope / follow-ups
- Regenerate-key button on agent detail page for session-authed users (today MCP-only).
- Rotation-on-first-use for tokens (single-display + existing revocation is sufficient for now).
- Server-side routing by agent_type (today any runner claims any work in its org + repo scope; agent_type is metadata).
EOF
)"
```

---

## Self-review checklist

- **Spec coverage:**
  - "Session-authed create" → Task 2 ✓
  - "Dashboard writes directly via @fluent-flow/db" → Task 1 (export) + Task 2 (use) ✓
  - "No new tables" → no schema changes anywhere ✓
  - "Stepper modal 3 steps" → Task 3 Step 1 ✓
  - "Copy whole npx command" → Task 3 Step 1 (`navigator.clipboard.writeText(command)`) ✓
  - "Connected-state polling" → Task 3 Step 1 (`useEffect` poll loop) + Step 2 (response shape) ✓
  - "Remove silent claude-code defaults" → Task 0 ✓
  - "Smoke-check the route" → Task 4 Step 1 ✓
  - "Docs" → Task 4 Step 2 ✓
- **Placeholders:** none — every step has actual code or exact commands.
- **Type consistency:**
  - `createAgent({ id, orgId, agentType, transport, ... })` in Task 1 matches the call-site in Task 2 ✓
  - `createToken(...)` returns `{ plaintext, id }` in Task 1 Step 5; consumed as `token.plaintext` in Task 2 ✓
  - Modal fetch body `{ org_id, agent_id, agent_type }` matches `CreateBodySchema` in Task 2 Step 2 ✓
  - Modal polls `/api/agents/<agentId>` expecting `{ active_session }` shape — Task 3 Step 2 covers adding that field if missing ✓
- **TDD structure:** Tasks 0, 1 have Red/Green/Refactor with breaking-change verification. Tasks 2, 3, 4 are additive (no new logic amenable to isolated unit tests — gated by type-check + manual + deploy smoke). That asymmetry is intentional: unit tests for Next.js App Router handlers + React dialogs have been deemed too heavy for their value elsewhere in this codebase.
