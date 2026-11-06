import { createHash } from 'node:crypto';
import { z } from 'zod';
import { getPool } from '../pool.js';
import { insertPendingClaim } from '../queries/claims.js';
import { authorize, getProjectCapabilities } from './authorize.js';
import type { CollabActor } from './auth.js';
import { CollabServiceError } from './errors.js';
import { requireCurrentPrincipal } from './principals.js';
import { withClientTransaction } from './tx.js';

export type ClaimExecutionBadge = {
  id: number;
  taskId: string;
  claimType: string;
  attempt: number;
  status: string;
  rootClaimId: number;
  createdAt: string;
  completedAt: string | null;
};

export type ClaimExecution = ClaimExecutionBadge & {
  projectId: string;
  repo: string;
  prNumber: number | null;
  sessionId: number | null;
  payload: Record<string, unknown>;
  headSha: string | null;
};

export type StartClaimExecutionResult = {
  claim: ClaimExecution | ClaimExecutionBadge;
  created: boolean;
};

type ClaimExecutionRow = {
  id: number;
  task_id: string;
  project_id: string;
  root_claim_id: number;
  repo: string;
  pr_number: number | null;
  attempt: number;
  session_id: number | null;
  claim_type: string;
  status: string;
  payload: Record<string, unknown>;
  head_sha: string | null;
  execution_created_at: Date;
  completed_at: Date | null;
  cursor_created_at: string;
};

const startSchema = z.object({
  actor: z.object({ principalId: z.string().uuid(), sessionVersion: z.number().int().min(1) }),
  taskId: z.string().uuid(),
  expectedVersion: z.number().int().min(1),
  idempotencyKey: z.string().min(8).max(256),
  repo: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/).max(200),
  prNumber: z.number().int().positive().nullable().optional(),
  branch: z.string().min(1).max(500).nullable().optional(),
  claimType: z.enum(['spec', 'build']),
  instructions: z.string().max(20000).optional(),
});

const listSchema = z.object({
  actor: z.object({ principalId: z.string().uuid(), sessionVersion: z.number().int().min(1) }),
  taskId: z.string().uuid(),
  cursor: z.string().optional(),
  limit: z.number().int().positive().max(100).default(50),
});

const detailSchema = z.object({
  actor: z.object({ principalId: z.string().uuid(), sessionVersion: z.number().int().min(1) }),
  claimId: z.number().int().positive(),
});

const cursorSchema = z.object({
  t: z.string().min(1),
  c: z.number().int().positive(),
});

const CLAIM_SELECT = `SELECT
  claim.id,
  execution.task_id,
  execution.project_id,
  execution.root_claim_id,
  claim.repo,
  claim.pr_number,
  claim.attempt,
  claim.session_id,
  claim.claim_type,
  claim.status,
  claim.payload,
  claim.head_sha,
  execution.created_at AS execution_created_at,
  claim.completed_at,
  to_char(execution.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_created_at
FROM collab_claim_executions execution
JOIN agent_claims claim ON claim.id = execution.claim_id`;

function requestHash(value: Record<string, unknown>): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function rowToBadge(row: ClaimExecutionRow): ClaimExecutionBadge {
  return {
    id: row.id,
    taskId: row.task_id,
    claimType: row.claim_type,
    attempt: row.attempt,
    status: row.status,
    rootClaimId: row.root_claim_id,
    createdAt: row.execution_created_at.toISOString(),
    completedAt: row.completed_at?.toISOString() ?? null,
  };
}

function rowToClaim(row: ClaimExecutionRow): ClaimExecution {
  return {
    id: row.id,
    taskId: row.task_id,
    projectId: row.project_id,
    claimType: row.claim_type,
    attempt: row.attempt,
    status: row.status,
    rootClaimId: row.root_claim_id,
    repo: row.repo,
    prNumber: row.pr_number,
    sessionId: row.session_id,
    payload: row.payload,
    headSha: row.head_sha,
    createdAt: row.execution_created_at.toISOString(),
    completedAt: row.completed_at?.toISOString() ?? null,
  };
}

async function taskScope(taskId: string): Promise<{ projectId: string; legacyOrgId: string | null }> {
  const result = await getPool().query<{ project_id: string; legacy_org_id: string | null }>(
    `SELECT task.project_id, workspace.legacy_org_id
     FROM collab_tasks task
     JOIN collab_projects project ON project.id = task.project_id
     JOIN collab_workspaces workspace ON workspace.id = project.workspace_id
     WHERE task.id = $1`,
    [taskId],
  );
  if (result.rows.length === 0) throw new CollabServiceError(404, 'not_found', 'Not found.');
  return {
    projectId: result.rows[0].project_id,
    legacyOrgId: result.rows[0].legacy_org_id,
  };
}

async function requireLegacyRepo(
  repo: string,
  legacyOrgId: string,
  legacyUserId: number,
): Promise<void> {
  const result = await getPool().query(
    `SELECT repo.id
     FROM repos repo
     JOIN users actor ON actor.id = $3
     WHERE repo.repo_full_name = $1
       AND repo.org_id = $2
       AND (
         actor.is_superadmin
         OR EXISTS (
           SELECT 1 FROM user_orgs membership
           WHERE membership.user_id = actor.id AND membership.org_id = repo.org_id
         )
       )`,
    [repo, legacyOrgId, legacyUserId],
  );
  if (result.rows.length === 0) throw new CollabServiceError(404, 'not_found', 'Not found.');
}

async function projectClaim(
  principalId: string,
  projectId: string,
  row: ClaimExecutionRow,
): Promise<ClaimExecution | ClaimExecutionBadge> {
  const capabilities = await getProjectCapabilities(principalId, projectId);
  return capabilities.has('internal.read') ? rowToClaim(row) : rowToBadge(row);
}

function decodeCursor(cursor: string | undefined): { t: string; c: number } | null {
  if (cursor === undefined) return null;
  try {
    return cursorSchema.parse(JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')));
  } catch {
    throw new CollabServiceError(400, 'invalid_cursor', 'The cursor is invalid.');
  }
}

function encodeCursor(row: ClaimExecutionRow): string {
  return Buffer.from(JSON.stringify({ t: row.cursor_created_at, c: row.id })).toString('base64url');
}

export async function startCollabClaimExecution(input: {
  actor: CollabActor;
  taskId: string;
  expectedVersion: number;
  idempotencyKey: string;
  repo: string;
  prNumber?: number | null;
  branch?: string | null;
  claimType: 'spec' | 'build';
  instructions?: string;
}): Promise<StartClaimExecutionResult> {
  const parsed = startSchema.parse(input);
  const principal = await requireCurrentPrincipal(parsed.actor);
  const scope = await taskScope(parsed.taskId);
  await authorize(parsed.actor, { projectId: scope.projectId }, ['run.start']);
  if (scope.legacyOrgId === null || principal.legacyUserId === null) {
    throw new CollabServiceError(404, 'not_found', 'Not found.');
  }
  const legacyOrgId = scope.legacyOrgId;
  const legacyUserId = principal.legacyUserId;
  await requireLegacyRepo(parsed.repo, legacyOrgId, legacyUserId);
  const canonical = {
    expectedVersion: parsed.expectedVersion,
    repo: parsed.repo,
    prNumber: parsed.prNumber ?? null,
    branch: parsed.branch ?? null,
    claimType: parsed.claimType,
    instructions: parsed.instructions ?? '',
  };
  const hash = requestHash(canonical);
  const result = await withClientTransaction(async (tx) => {
    await tx.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`run-start:${parsed.taskId}`]);
    const existing = await tx.query<{ request_hash: string; claim_id: number | null }>(
      `SELECT request_hash, claim_id
       FROM collab_idempotency_records
       WHERE principal_id = $1 AND scope_key = $2 AND idempotency_key = $3`,
      [principal.id, `claim-exec:${parsed.taskId}`, parsed.idempotencyKey],
    );
    if (existing.rows.length > 0) {
      if (existing.rows[0].request_hash !== hash) {
        throw new CollabServiceError(
          409,
          'idempotency_conflict',
          'This request identity was already used with a different payload.',
        );
      }
      const replay = await tx.query<ClaimExecutionRow>(
        `${CLAIM_SELECT} WHERE execution.task_id = $1 AND execution.claim_id = $2`,
        [parsed.taskId, existing.rows[0].claim_id],
      );
      if (replay.rows.length === 0) throw new CollabServiceError(404, 'not_found', 'Not found.');
      return { row: replay.rows[0], created: false };
    }
    const task = await tx.query<{ version: number }>(
      `SELECT version FROM collab_tasks WHERE id = $1 FOR UPDATE`,
      [parsed.taskId],
    );
    if (task.rows.length === 0 || task.rows[0].version !== parsed.expectedVersion) {
      throw new CollabServiceError(
        409,
        'version_conflict',
        'This item changed. Refresh before saving.',
        { currentVersion: task.rows[0]?.version },
      );
    }
    const claim = await insertPendingClaim({
      orgId: legacyOrgId,
      repo: parsed.repo,
      prNumber: parsed.prNumber ?? null,
      claimType: parsed.claimType,
      payload: {
        source: 'collab',
        branch: parsed.branch ?? null,
        instructions: parsed.instructions ?? '',
      },
    }, tx);
    if (claim === null) {
      throw new CollabServiceError(409, 'claim_conflict', 'The claim could not be created.');
    }
    await tx.query(
      `INSERT INTO collab_claim_executions
         (task_id, project_id, claim_id, root_claim_id, created_by_principal_id)
       VALUES ($1, $2, $3, $3, $4)`,
      [parsed.taskId, scope.projectId, claim.id, principal.id],
    );
    await tx.query(
      `INSERT INTO collab_idempotency_records
         (principal_id, scope_key, idempotency_key, request_hash, claim_id)
       VALUES ($1, $2, $3, $4, $5)`,
      [principal.id, `claim-exec:${parsed.taskId}`, parsed.idempotencyKey, hash, claim.id],
    );
    const created = await tx.query<ClaimExecutionRow>(
      `${CLAIM_SELECT} WHERE execution.claim_id = $1`,
      [claim.id],
    );
    return { row: created.rows[0], created: true };
  });
  return {
    claim: await projectClaim(principal.id, scope.projectId, result.row),
    created: result.created,
  };
}

export async function listCollabClaimExecutions(input: {
  actor: CollabActor;
  taskId: string;
  cursor?: string;
  limit?: number;
}): Promise<{ claims: ClaimExecutionBadge[]; nextCursor: string | null }> {
  const parsed = listSchema.parse(input);
  await requireCurrentPrincipal(parsed.actor);
  const scope = await taskScope(parsed.taskId);
  await authorize(parsed.actor, { projectId: scope.projectId }, ['task.read']);
  const cursor = decodeCursor(parsed.cursor);
  const result = await getPool().query<ClaimExecutionRow>(
    `${CLAIM_SELECT}
     WHERE execution.task_id = $1
       AND ($2::timestamptz IS NULL OR (execution.created_at, execution.claim_id) > ($2::timestamptz, $3::integer))
     ORDER BY execution.created_at, execution.claim_id
     LIMIT $4`,
    [parsed.taskId, cursor?.t ?? null, cursor?.c ?? 0, parsed.limit + 1],
  );
  const hasMore = result.rows.length > parsed.limit;
  const page = hasMore ? result.rows.slice(0, parsed.limit) : result.rows;
  return {
    claims: page.map(rowToBadge),
    nextCursor: hasMore ? encodeCursor(page[page.length - 1]) : null,
  };
}

export async function getCollabClaimExecution(input: {
  actor: CollabActor;
  claimId: number;
}): Promise<ClaimExecution | ClaimExecutionBadge> {
  const parsed = detailSchema.parse(input);
  const principal = await requireCurrentPrincipal(parsed.actor);
  const result = await getPool().query<ClaimExecutionRow>(
    `${CLAIM_SELECT} WHERE execution.claim_id = $1`,
    [parsed.claimId],
  );
  if (result.rows.length === 0) throw new CollabServiceError(404, 'not_found', 'Not found.');
  const row = result.rows[0];
  await authorize(parsed.actor, { projectId: row.project_id }, ['task.read']);
  return projectClaim(principal.id, row.project_id, row);
}
