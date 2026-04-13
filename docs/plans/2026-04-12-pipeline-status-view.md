# Pipeline Status View Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a top-level Pipelines page to the dashboard showing task pipeline status per PR (spec → build → review_fix → test_verify) with drill-down into individual stage details.

**Architecture:** Query-only — no new tables. Pipeline state derived from `agent_claims` grouped by `(org_id, repo, pr_number)`. Stages rendered dynamically from whatever claim types exist. New queries in `packages/db`, new API routes and pages in `packages/dashboard`.

**Tech Stack:** Next.js App Router, TypeScript, Tailwind, shadcn/ui, pg, Zod, Vitest

**Spec:** `docs/specs/2026-04-12-pipeline-status-view-design.md`

---

### Task 1: Pipeline queries in packages/db

**Files:**
- Create: `packages/db/src/queries/pipelines.ts`
- Modify: `packages/db/src/queries/index.ts`
- Create: `packages/db/tests/queries/pipelines.test.ts`

- [ ] **Step 1: Write failing test for listPipelines**

```typescript
// packages/db/tests/queries/pipelines.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockQuery = vi.fn();
vi.mock('../../src/pool', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
}));

const { listPipelines, getPipelineDetail } = await import('../../src/queries/pipelines');

describe('listPipelines', () => {
  beforeEach(() => { mockQuery.mockReset(); });

  it('returns pipelines grouped by PR for given orgs', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          org_id: 'fluent-io',
          repo: 'fluent-io/fluent-flow',
          pr_number: 28,
          latest_attempt: 1,
          last_activity: new Date(),
          stages: JSON.stringify([
            { claim_type: 'spec', status: 'completed', created_at: new Date().toISOString(), claimed_at: new Date().toISOString(), completed_at: new Date().toISOString() },
            { claim_type: 'build', status: 'claimed', created_at: new Date().toISOString(), claimed_at: new Date().toISOString(), completed_at: null },
          ]),
        },
      ],
    });

    const result = await listPipelines(['fluent-io']);
    expect(result).toHaveLength(1);
    expect(result[0].repo).toBe('fluent-io/fluent-flow');
    expect(result[0].pr_number).toBe(28);
    expect(result[0].stages).toHaveLength(2);
    expect(result[0].stages[0].claim_type).toBe('spec');
    expect(mockQuery.mock.calls[0][1]).toEqual([['fluent-io']]);
  });

  it('returns all pipelines for superadmin (no org filter)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const result = await listPipelines([]);
    expect(result).toEqual([]);
    expect(mockQuery.mock.calls[0][0]).not.toContain('org_id = ANY');
  });
});

describe('getPipelineDetail', () => {
  beforeEach(() => { mockQuery.mockReset(); });

  it('returns claims for a specific PR pipeline', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          id: 1, org_id: 'fluent-io', repo: 'fluent-io/fluent-flow', pr_number: 28,
          attempt: 1, session_id: 12, claim_type: 'spec', status: 'completed',
          payload: {}, claimed_at: new Date(), completed_at: new Date(),
          expires_at: null, created_at: new Date(), agent_id: 'ff-runner', session_meta: {},
        },
      ],
    });

    const result = await getPipelineDetail(['fluent-io'], 'fluent-io/fluent-flow', 28);
    expect(result).toHaveLength(1);
    expect(result[0].claim_type).toBe('spec');
    expect(result[0].agent_id).toBe('ff-runner');
  });

  it('returns empty array when pipeline not found', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const result = await getPipelineDetail(['fluent-io'], 'fluent-io/nonexistent', 999);
    expect(result).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd packages/db && npx vitest run tests/queries/pipelines.test.ts
```

Expected: FAIL — `pipelines` module does not exist.

- [ ] **Step 3: Write pipeline query implementation**

```typescript
// packages/db/src/queries/pipelines.ts
import { query } from '../pool';

export interface PipelineStage {
  claim_type: string;
  status: string;
  created_at: string;
  claimed_at: string | null;
  completed_at: string | null;
}

export interface PipelineListItem {
  org_id: string;
  repo: string;
  pr_number: number;
  latest_attempt: number;
  last_activity: Date;
  stages: PipelineStage[];
}

export async function listPipelines(orgIds: string[]): Promise<PipelineListItem[]> {
  const isSuper = orgIds.length === 0;

  const sql = `
    SELECT
      c.org_id,
      c.repo,
      c.pr_number,
      MAX(c.attempt) AS latest_attempt,
      MAX(c.created_at) AS last_activity,
      json_agg(
        json_build_object(
          'claim_type', c.claim_type,
          'status', c.status,
          'created_at', c.created_at,
          'claimed_at', c.claimed_at,
          'completed_at', c.completed_at
        ) ORDER BY c.created_at
      ) AS stages
    FROM agent_claims c
    ${isSuper ? '' : 'WHERE c.org_id = ANY($1)'}
    GROUP BY c.org_id, c.repo, c.pr_number
    ORDER BY MAX(c.created_at) DESC
    LIMIT 100
  `;

  const result = isSuper ? await query(sql) : await query(sql, [orgIds]);
  return result.rows.map((row: Record<string, unknown>) => ({
    ...row,
    stages: typeof row.stages === 'string' ? JSON.parse(row.stages as string) : row.stages,
  })) as PipelineListItem[];
}

export interface PipelineDetailClaim {
  id: number;
  org_id: string;
  repo: string;
  pr_number: number;
  attempt: number;
  session_id: number | null;
  claim_type: string;
  status: string;
  payload: Record<string, unknown>;
  claimed_at: Date | null;
  completed_at: Date | null;
  expires_at: Date | null;
  created_at: Date;
  agent_id: string | null;
  session_meta: Record<string, unknown> | null;
}

export async function getPipelineDetail(orgIds: string[], repo: string, prNumber: number): Promise<PipelineDetailClaim[]> {
  const isSuper = orgIds.length === 0;

  const sql = `
    SELECT
      c.*,
      s.agent_id,
      s.session_meta
    FROM agent_claims c
    LEFT JOIN agent_sessions s ON c.session_id = s.id
    WHERE ${isSuper ? '' : 'c.org_id = ANY($1) AND '}c.repo = $${isSuper ? 1 : 2} AND c.pr_number = $${isSuper ? 2 : 3}
      AND c.attempt = (
        SELECT MAX(c2.attempt)
        FROM agent_claims c2
        WHERE c2.org_id = c.org_id AND c2.repo = c.repo AND c2.pr_number = c.pr_number
      )
    ORDER BY c.created_at ASC
  `;

  const params = isSuper ? [repo, prNumber] : [orgIds, repo, prNumber];
  const result = await query(sql, params);
  return result.rows as PipelineDetailClaim[];
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd packages/db && npx vitest run tests/queries/pipelines.test.ts
```

Expected: PASS.

- [ ] **Step 5: Update queries barrel export**

```typescript
// packages/db/src/queries/index.ts
export { listAgents, getAgentDetail } from './agents';
export { getAgentSessions } from './sessions';
export { getAgentClaims } from './claims';
export { upsertUser, getUserOrgs } from './users';
export { regenerateKey, getKeyInfo } from './tokens';
export { listPipelines, getPipelineDetail } from './pipelines';
export type { PipelineListItem, PipelineStage, PipelineDetailClaim } from './pipelines';
```

- [ ] **Step 6: Run all db tests**

```bash
cd packages/db && npx vitest run
```

Expected: all tests pass.

- [ ] **Step 7: Commit**

```bash
git add packages/db/src/queries/pipelines.ts packages/db/src/queries/index.ts packages/db/tests/queries/pipelines.test.ts
git commit -m "feat: add pipeline queries for list and detail views"
```

---

### Task 2: Pipeline API routes

**Files:**
- Create: `packages/dashboard/src/app/api/pipelines/route.ts`
- Create: `packages/dashboard/src/app/api/pipelines/[...slug]/route.ts`
- Create: `packages/dashboard/tests/api/pipelines.test.ts`
- Create: `packages/dashboard/tests/api/pipeline-detail.test.ts`

- [ ] **Step 1: Write failing test for pipelines list API**

```typescript
// packages/dashboard/tests/api/pipelines.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockGetServerSession = vi.fn();
const mockListPipelines = vi.fn();

vi.mock('next-auth', () => ({
  getServerSession: (...args: unknown[]) => mockGetServerSession(...args),
}));

vi.mock('@fluent-flow/db', () => ({
  listPipelines: (...args: unknown[]) => mockListPipelines(...args),
}));

vi.mock('@/lib/auth', () => ({
  authOptions: {},
  getOrgScope: vi.fn((session: { user: { isSuperadmin: boolean; orgs: { org_id: string }[] } }) => {
    if (session.user.isSuperadmin) return { orgIds: [], isSuperadmin: true };
    return { orgIds: session.user.orgs.map((o) => o.org_id), isSuperadmin: false };
  }),
}));

const { GET } = await import('../../src/app/api/pipelines/route');

describe('GET /api/pipelines', () => {
  beforeEach(() => {
    mockGetServerSession.mockReset();
    mockListPipelines.mockReset();
  });

  it('returns 401 when not authenticated', async () => {
    mockGetServerSession.mockResolvedValueOnce(null);

    const response = await GET();
    expect(response.status).toBe(401);
  });

  it('returns pipelines scoped to user orgs', async () => {
    mockGetServerSession.mockResolvedValueOnce({
      user: { id: 1, login: 'victor', isSuperadmin: false, orgs: [{ org_id: 'fluent-io', role: 'admin' }] },
    });
    mockListPipelines.mockResolvedValueOnce([
      { org_id: 'fluent-io', repo: 'fluent-io/fluent-flow', pr_number: 28, latest_attempt: 1, stages: [] },
    ]);

    const response = await GET();
    const data = await response.json();
    expect(response.status).toBe(200);
    expect(data).toHaveLength(1);
    expect(mockListPipelines).toHaveBeenCalledWith(['fluent-io']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd packages/dashboard && npx vitest run tests/api/pipelines.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Write pipelines list API route**

```typescript
// packages/dashboard/src/app/api/pipelines/route.ts
import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { listPipelines } from '@fluent-flow/db';
import { authOptions, getOrgScope } from '@/lib/auth';

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { orgIds } = getOrgScope(session);
  const pipelines = await listPipelines(orgIds);
  return NextResponse.json(pipelines);
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd packages/dashboard && npx vitest run tests/api/pipelines.test.ts
```

Expected: PASS.

- [ ] **Step 5: Write failing test for pipeline detail API**

```typescript
// packages/dashboard/tests/api/pipeline-detail.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockGetServerSession = vi.fn();
const mockGetPipelineDetail = vi.fn();

vi.mock('next-auth', () => ({
  getServerSession: (...args: unknown[]) => mockGetServerSession(...args),
}));

vi.mock('@fluent-flow/db', () => ({
  getPipelineDetail: (...args: unknown[]) => mockGetPipelineDetail(...args),
}));

vi.mock('@/lib/auth', () => ({
  authOptions: {},
  getOrgScope: vi.fn((session: { user: { isSuperadmin: boolean; orgs: { org_id: string }[] } }) => {
    if (session.user.isSuperadmin) return { orgIds: [], isSuperadmin: true };
    return { orgIds: session.user.orgs.map((o) => o.org_id), isSuperadmin: false };
  }),
}));

const { GET } = await import('../../src/app/api/pipelines/[...slug]/route');

describe('GET /api/pipelines/[...slug]', () => {
  beforeEach(() => {
    mockGetServerSession.mockReset();
    mockGetPipelineDetail.mockReset();
  });

  it('returns 401 when not authenticated', async () => {
    mockGetServerSession.mockResolvedValueOnce(null);

    const response = await GET({} as Request, { params: Promise.resolve({ slug: ['fluent-io', 'fluent-flow', '28'] }) });
    expect(response.status).toBe(401);
  });

  it('returns 400 for invalid slug', async () => {
    mockGetServerSession.mockResolvedValueOnce({
      user: { id: 1, isSuperadmin: false, orgs: [{ org_id: 'fluent-io' }] },
    });

    const response = await GET({} as Request, { params: Promise.resolve({ slug: ['bad'] }) });
    expect(response.status).toBe(400);
  });

  it('returns pipeline detail for valid slug', async () => {
    mockGetServerSession.mockResolvedValueOnce({
      user: { id: 1, isSuperadmin: false, orgs: [{ org_id: 'fluent-io' }] },
    });
    mockGetPipelineDetail.mockResolvedValueOnce([
      { id: 1, claim_type: 'spec', status: 'completed', agent_id: 'ff-runner' },
    ]);

    const response = await GET({} as Request, { params: Promise.resolve({ slug: ['fluent-io', 'fluent-flow', '28'] }) });
    const data = await response.json();
    expect(response.status).toBe(200);
    expect(data).toHaveLength(1);
    expect(mockGetPipelineDetail).toHaveBeenCalledWith(['fluent-io'], 'fluent-io/fluent-flow', 28);
  });
});
```

- [ ] **Step 6: Run test to verify it fails**

```bash
cd packages/dashboard && npx vitest run tests/api/pipeline-detail.test.ts
```

Expected: FAIL.

- [ ] **Step 7: Write pipeline detail API route**

```typescript
// packages/dashboard/src/app/api/pipelines/[...slug]/route.ts
import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { getPipelineDetail } from '@fluent-flow/db';
import { authOptions, getOrgScope } from '@/lib/auth';

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ slug: string[] }> },
) {
  const session = await getServerSession(authOptions);
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { slug } = await params;
  if (slug.length < 3) {
    return NextResponse.json({ error: 'Invalid path. Expected: owner/repo/prNumber' }, { status: 400 });
  }

  const owner = slug[0];
  const repo = slug[1];
  const prNumber = parseInt(slug[2], 10);

  if (isNaN(prNumber)) {
    return NextResponse.json({ error: 'Invalid PR number' }, { status: 400 });
  }

  const { orgIds } = getOrgScope(session);
  const claims = await getPipelineDetail(orgIds, `${owner}/${repo}`, prNumber);
  return NextResponse.json(claims);
}
```

- [ ] **Step 8: Run test to verify it passes**

```bash
cd packages/dashboard && npx vitest run tests/api/pipeline-detail.test.ts
```

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add packages/dashboard/src/app/api/pipelines/ packages/dashboard/tests/api/pipelines.test.ts packages/dashboard/tests/api/pipeline-detail.test.ts
git commit -m "feat: add pipeline list and detail API routes"
```

---

### Task 3: Pipeline UI components

**Files:**
- Create: `packages/dashboard/src/components/pipelines/pipeline-stage.tsx`
- Create: `packages/dashboard/src/components/pipelines/pipeline-card.tsx`
- Create: `packages/dashboard/src/components/pipelines/pipeline-timeline.tsx`

- [ ] **Step 1: Create pipeline stage component**

```tsx
// packages/dashboard/src/components/pipelines/pipeline-stage.tsx
import { cn } from '@/lib/utils';

const stageConfig: Record<string, { label: string; color: string }> = {
  spec: { label: 'Spec', color: 'emerald' },
  build: { label: 'Build', color: 'amber' },
  review_fix: { label: 'Review Fix', color: 'indigo' },
  test_verify: { label: 'Test Verify', color: 'cyan' },
  security_review: { label: 'Security', color: 'rose' },
};

function getStageConfig(claimType: string) {
  return stageConfig[claimType] ?? { label: claimType, color: 'zinc' };
}

const statusStyles: Record<string, string> = {
  completed: 'bg-green-950 border-green-800 text-green-400',
  claimed: 'bg-amber-950 border-amber-800 text-amber-400',
  pending: 'bg-amber-950/50 border-amber-800/50 text-amber-400/70',
  failed: 'bg-red-950 border-red-800 text-red-400',
  expired: 'bg-red-950 border-red-800 text-red-400',
};

const statusIcons: Record<string, string> = {
  completed: '✓',
  claimed: '⟳',
  pending: '⏳',
  failed: '✗',
  expired: '✗',
};

function formatDuration(start: string | Date | null, end: string | Date | null): string {
  if (!start || !end) return '';
  const ms = new Date(end).getTime() - new Date(start).getTime();
  const minutes = Math.floor(ms / 60000);
  if (minutes < 1) return '<1m';
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h${minutes % 60}m`;
}

interface PipelineStageProps {
  claimType: string;
  status: string;
  createdAt?: string | null;
  claimedAt?: string | null;
  completedAt?: string | null;
  isFirst?: boolean;
  isLast?: boolean;
}

export function PipelineStage({ claimType, status, claimedAt, completedAt, isFirst, isLast }: PipelineStageProps) {
  const config = getStageConfig(claimType);
  const style = statusStyles[status] ?? 'bg-secondary border-border text-muted-foreground';
  const icon = statusIcons[status] ?? '—';
  const duration = formatDuration(claimedAt, completedAt);

  return (
    <div
      className={cn(
        'flex-1 border px-3 py-2 text-center',
        style,
        isFirst && 'rounded-l-md',
        isLast && 'rounded-r-md',
      )}
    >
      <div className="text-[9px] uppercase tracking-wider text-muted-foreground">{config.label}</div>
      <div className="text-[11px]">{icon} {status}</div>
      {duration && <div className="text-[9px] text-muted-foreground/70">{duration}</div>}
    </div>
  );
}

export { getStageConfig, formatDuration, statusIcons };
```

- [ ] **Step 2: Create pipeline card component**

```tsx
// packages/dashboard/src/components/pipelines/pipeline-card.tsx
'use client';

import { useRouter } from 'next/navigation';
import type { PipelineListItem } from '@fluent-flow/db';
import { PipelineStage } from './pipeline-stage';
import { Badge } from '@/components/ui/badge';

function derivePipelineStatus(stages: { status: string }[]): { label: string; className: string } {
  const hasActive = stages.some((s) => s.status === 'pending' || s.status === 'claimed');
  const hasFailed = stages.some((s) => s.status === 'failed' || s.status === 'expired');

  if (hasActive) return { label: 'in progress', className: 'border-amber-800 bg-amber-950 text-amber-400' };
  if (hasFailed) return { label: 'failed', className: 'border-red-800 bg-red-950 text-red-400' };
  return { label: 'completed', className: 'border-green-800 bg-green-950 text-green-400' };
}

function timeAgo(date: Date | string | null): string {
  if (!date) return '';
  const seconds = Math.floor((Date.now() - new Date(date).getTime()) / 1000);
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

export function PipelineCard({ pipeline }: { pipeline: PipelineListItem }) {
  const router = useRouter();
  const status = derivePipelineStatus(pipeline.stages);
  const [owner, repo] = pipeline.repo.split('/');

  return (
    <div
      className="cursor-pointer rounded-lg border border-border bg-card p-4 transition-colors hover:border-muted-foreground/30"
      onClick={() => router.push(`/pipelines/${owner}/${repo}/${pipeline.pr_number}`)}
    >
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <a
            href={`https://github.com/${pipeline.repo}/pull/${pipeline.pr_number}`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm font-medium text-primary hover:underline"
            onClick={(e) => e.stopPropagation()}
          >
            {pipeline.repo} #{pipeline.pr_number}
          </a>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant="outline" className={`text-xs font-normal ${status.className}`}>
            ● {status.label}
          </Badge>
          <span className="text-xs text-muted-foreground">{timeAgo(pipeline.last_activity)}</span>
        </div>
      </div>
      <div className="flex items-center gap-px">
        {pipeline.stages.map((stage, i) => (
          <PipelineStage
            key={stage.claim_type}
            claimType={stage.claim_type}
            status={stage.status}
            claimedAt={stage.claimed_at}
            completedAt={stage.completed_at}
            isFirst={i === 0}
            isLast={i === pipeline.stages.length - 1}
          />
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Create pipeline timeline component**

```tsx
// packages/dashboard/src/components/pipelines/pipeline-timeline.tsx
import type { PipelineDetailClaim } from '@fluent-flow/db';
import { getStageConfig, formatDuration, statusIcons } from './pipeline-stage';
import { cn } from '@/lib/utils';

const nodeStyles: Record<string, string> = {
  completed: 'border-green-500 bg-green-950 text-green-400',
  claimed: 'border-amber-500 bg-amber-950 text-amber-400',
  pending: 'border-amber-500/50 bg-amber-950/50 text-amber-400/70',
  failed: 'border-red-500 bg-red-950 text-red-400',
  expired: 'border-red-500 bg-red-950 text-red-400',
};

const lineStyles: Record<string, string> = {
  completed: 'bg-green-800',
  claimed: 'bg-amber-800',
  pending: 'bg-border',
  failed: 'bg-red-800',
  expired: 'bg-red-800',
};

function formatTime(date: Date | string | null): string {
  if (!date) return '';
  return new Date(date).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
}

function formatDate(date: Date | string | null): string {
  if (!date) return '';
  return new Date(date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

export function PipelineTimeline({ claims }: { claims: PipelineDetailClaim[] }) {
  if (claims.length === 0) {
    return <p className="py-8 text-center text-sm text-muted-foreground">No pipeline stages found</p>;
  }

  return (
    <div className="flex flex-col">
      {claims.map((claim, i) => {
        const config = getStageConfig(claim.claim_type);
        const icon = statusIcons[claim.status] ?? '—';
        const nodeStyle = nodeStyles[claim.status] ?? 'border-border bg-secondary text-muted-foreground';
        const lineStyle = lineStyles[claim.status] ?? 'bg-border';
        const duration = formatDuration(claim.claimed_at, claim.completed_at);
        const isLast = i === claims.length - 1;
        const meta = (claim.session_meta ?? {}) as Record<string, unknown>;

        return (
          <div key={claim.id} className="flex gap-4">
            <div className="flex w-6 flex-col items-center">
              <div className={cn('flex h-6 w-6 items-center justify-center rounded-full border-2 text-xs', nodeStyle)}>
                {icon}
              </div>
              {!isLast && <div className={cn('w-0.5 flex-1', lineStyle)} />}
            </div>
            <div className="mb-3 flex-1 rounded-lg border border-border bg-card p-3.5">
              <div className="mb-2 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium">{config.label}</span>
                  <span className="text-xs text-muted-foreground">{claim.status}</span>
                </div>
                <span className="text-xs text-muted-foreground">
                  {duration && `${duration} · `}{formatDate(claim.created_at)} {formatTime(claim.created_at)}
                  {claim.completed_at && ` → ${formatTime(claim.completed_at)}`}
                </span>
              </div>
              <div className="flex gap-4 text-xs text-muted-foreground">
                {claim.agent_id && <div>Agent: <span className="text-foreground">{claim.agent_id}</span></div>}
                {claim.session_id && <div>Session: <span className="text-foreground">#{claim.session_id}</span></div>}
                {meta.hostname && <div>Host: <span className="text-foreground">{meta.hostname as string}</span></div>}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 4: Commit**

```bash
git add packages/dashboard/src/components/pipelines/
git commit -m "feat: add pipeline stage, card, and timeline components"
```

---

### Task 4: Pipeline pages and sidebar update

**Files:**
- Create: `packages/dashboard/src/app/pipelines/layout.tsx`
- Create: `packages/dashboard/src/app/pipelines/page.tsx`
- Create: `packages/dashboard/src/app/pipelines/[...slug]/page.tsx`
- Modify: `packages/dashboard/src/components/layout/sidebar.tsx`

- [ ] **Step 1: Create pipelines layout**

```tsx
// packages/dashboard/src/app/pipelines/layout.tsx
import { DashboardShell } from '@/components/layout/dashboard-shell';

export default function PipelinesLayout({ children }: { children: React.ReactNode }) {
  return <DashboardShell>{children}</DashboardShell>;
}
```

- [ ] **Step 2: Create pipeline list page**

```tsx
// packages/dashboard/src/app/pipelines/page.tsx
import { getServerSession } from 'next-auth';
import { listPipelines } from '@fluent-flow/db';
import { authOptions, getOrgScope } from '@/lib/auth';
import { PipelineCard } from '@/components/pipelines/pipeline-card';

export default async function PipelinesPage() {
  const session = await getServerSession(authOptions);
  if (!session) return null;

  const { orgIds } = getOrgScope(session);
  const pipelines = await listPipelines(orgIds);

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-xl font-semibold">Pipelines</h1>
        <p className="text-sm text-muted-foreground">Task pipeline status per PR</p>
      </div>
      {pipelines.length === 0 ? (
        <div className="flex min-h-[200px] items-center justify-center rounded-lg border border-border">
          <p className="text-sm text-muted-foreground">No pipelines yet</p>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {pipelines.map((p) => (
            <PipelineCard key={`${p.repo}-${p.pr_number}`} pipeline={p} />
          ))}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Create pipeline detail page**

```tsx
// packages/dashboard/src/app/pipelines/[...slug]/page.tsx
import Link from 'next/link';
import { getServerSession } from 'next-auth';
import { getPipelineDetail } from '@fluent-flow/db';
import { authOptions, getOrgScope } from '@/lib/auth';
import { PipelineTimeline } from '@/components/pipelines/pipeline-timeline';
import { Badge } from '@/components/ui/badge';
import { notFound } from 'next/navigation';

function derivePipelineStatus(claims: { status: string }[]): { label: string; className: string } {
  const hasActive = claims.some((s) => s.status === 'pending' || s.status === 'claimed');
  const hasFailed = claims.some((s) => s.status === 'failed' || s.status === 'expired');

  if (hasActive) return { label: 'in progress', className: 'border-amber-800 bg-amber-950 text-amber-400' };
  if (hasFailed) return { label: 'failed', className: 'border-red-800 bg-red-950 text-red-400' };
  return { label: 'completed', className: 'border-green-800 bg-green-950 text-green-400' };
}

function formatDuration(start: Date | string, end: Date | string | null): string {
  const endTime = end ? new Date(end).getTime() : Date.now();
  const ms = endTime - new Date(start).getTime();
  const minutes = Math.floor(ms / 60000);
  if (minutes < 1) return '<1m';
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h${minutes % 60}m`;
}

export default async function PipelineDetailPage({ params }: { params: Promise<{ slug: string[] }> }) {
  const session = await getServerSession(authOptions);
  if (!session) return null;

  const { slug } = await params;
  if (slug.length < 3) notFound();

  const owner = slug[0];
  const repo = slug[1];
  const prNumber = parseInt(slug[2], 10);
  if (isNaN(prNumber)) notFound();

  const fullRepo = `${owner}/${repo}`;
  const { orgIds } = getOrgScope(session);
  const claims = await getPipelineDetail(orgIds, fullRepo, prNumber);

  if (claims.length === 0) notFound();

  const status = derivePipelineStatus(claims);
  const firstClaim = claims[0];
  const lastClaim = claims[claims.length - 1];
  const totalDuration = formatDuration(firstClaim.created_at, lastClaim.completed_at);

  return (
    <div>
      <div className="mb-4 text-xs text-muted-foreground">
        <Link href="/pipelines" className="text-primary hover:underline">Pipelines</Link>
        <span className="mx-1">/</span>
        {fullRepo} #{prNumber}
      </div>

      <div className="mb-6 rounded-lg border border-border bg-card p-5">
        <div className="flex items-start justify-between">
          <div>
            <div className="mb-2 flex items-center gap-2.5">
              <h1 className="text-xl font-semibold">{fullRepo} #{prNumber}</h1>
              <Badge variant="outline" className={`text-xs font-normal ${status.className}`}>
                ● {status.label}
              </Badge>
            </div>
            <div className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-muted-foreground">
              {firstClaim.agent_id && <div>Agent: <span className="text-primary">{firstClaim.agent_id}</span></div>}
              <div>Attempt: {firstClaim.attempt}</div>
              <div>Started: {new Date(firstClaim.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</div>
              <div>Duration: {totalDuration}</div>
            </div>
          </div>
          <a
            href={`https://github.com/${fullRepo}/pull/${prNumber}`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-primary hover:underline"
          >
            View on GitHub ↗
          </a>
        </div>
      </div>

      <PipelineTimeline claims={claims} />
    </div>
  );
}
```

- [ ] **Step 4: Update sidebar with Pipelines nav item**

Add `GitBranch` to the lucide-react import and add the Pipelines item to `navItems`:

```tsx
// In packages/dashboard/src/components/layout/sidebar.tsx
// Change import line:
import { Bot, Settings, ChevronLeft, ChevronRight, GitBranch } from 'lucide-react';

// Change navItems array:
const navItems = [
  { label: 'Agents', href: '/agents', icon: Bot },
  { label: 'Pipelines', href: '/pipelines', icon: GitBranch },
  { label: 'Settings', href: '/settings', icon: Settings },
];
```

- [ ] **Step 5: Commit**

```bash
git add packages/dashboard/src/app/pipelines/ packages/dashboard/src/components/layout/sidebar.tsx
git commit -m "feat: add pipeline list and detail pages with sidebar nav"
```

---

### Task 5: Verify end-to-end

- [ ] **Step 1: Run all tests**

```bash
cd packages/db && npx vitest run
cd ../dashboard && npx vitest run
cd ../fluent-flow && npx vitest run
```

Expected: all packages pass.

- [ ] **Step 2: Verify TypeScript compiles**

```bash
cd packages/db && npx tsc --noEmit
cd ../dashboard && npx tsc --noEmit
```

- [ ] **Step 3: Manual verification**

```bash
cd packages/dashboard && npm run dev
```

Verify:
1. Sidebar shows Pipelines between Agents and Settings
2. /pipelines page renders pipeline cards with dynamic stages
3. Clicking a card navigates to /pipelines/owner/repo/N
4. Detail page shows PR header and vertical timeline
5. GitHub links open correct PRs

- [ ] **Step 4: Commit any fixes**

```bash
git add -A && git commit -m "fix: end-to-end verification fixes"
```

(Only if fixes were needed.)
