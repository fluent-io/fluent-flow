import { z } from 'zod';
import { getPool } from '../pool.js';
import { authorize, getProjectCapabilities } from './authorize.js';
import { requireCurrentPrincipal } from './principals.js';
import type { CollabActor } from './auth.js';
import { CollabServiceError } from './errors.js';
import { withClientTransaction } from './tx.js';

const POSTGRES_INTEGER_MAX = 2_147_483_647;
const TERMINAL_HISTORY_LIMIT = 50;

const actorSchema = z.object({
  principalId: z.string().uuid(),
  sessionVersion: z.number().int().min(1),
}).strict();

const progressSchema = z.object({
  actor: actorSchema,
  taskId: z.string().uuid(),
}).strict();

const markSchema = z.object({
  actor: actorSchema,
  claimId: z.number().int().positive().max(POSTGRES_INTEGER_MAX),
  seq: z.number().int().min(0).max(POSTGRES_INTEGER_MAX),
}).strict();

export type ClaimProgressCard = {
  claimId: number;
  claimType: string;
  attempt: number;
  status: string;
  endReason: string | null;
  createdAt: string;
  completedAt: string | null;
  lastSeq: number | null;
  readSeq: number | null;
  unread: boolean;
  needsInput: boolean;
  profile: string | null;
  model: string | null;
  targetAgentId: string | null;
};

export type TaskClaimProgress = {
  claims: ClaimProgressCard[];
  terminalTruncated: boolean;
};

type ProgressRow = {
  id: number;
  claim_type: string;
  attempt: number;
  status: string;
  end_reason: string | null;
  payload: Record<string, unknown> | null;
  target_agent_id: string | null;
  execution_created_at: Date;
  completed_at: Date | null;
  last_seq: string | number | null;
  read_seq: string | number | null;
  needs_input: boolean;
};

function cardFrom(row: ProgressRow, internalRead: boolean): ClaimProgressCard {
  const payload = row.payload ?? {};
  const lastSeq = internalRead ? Number(row.last_seq ?? 0) : null;
  const readSeq = internalRead ? Number(row.read_seq ?? 0) : null;
  const unread = internalRead && lastSeq !== null && readSeq !== null && lastSeq > readSeq;
  return {
    claimId: row.id,
    claimType: row.claim_type,
    attempt: row.attempt,
    status: row.status,
    endReason: row.claim_type === 'chat' ? row.end_reason : null,
    createdAt: row.execution_created_at.toISOString(),
    completedAt: row.completed_at?.toISOString() ?? null,
    lastSeq,
    readSeq,
    unread,
    needsInput: row.needs_input,
    ...(internalRead ? {
      profile: typeof payload.profile === 'string' ? payload.profile : null,
      model: typeof payload.model === 'string' ? payload.model : null,
      targetAgentId: row.target_agent_id,
    } : { profile: null, model: null, targetAgentId: null }),
  };
}

const PROGRESS_SELECT = `SELECT
  claim.id,
  claim.claim_type,
  claim.attempt,
  claim.status,
  claim.end_reason,
  claim.payload,
  claim.target_agent_id,
  execution.created_at AS execution_created_at,
  claim.completed_at,
  (SELECT max(event.seq) FROM agent_claim_events event
    WHERE event.org_id = claim.org_id AND event.claim_id = claim.id) AS last_seq,
  cursor.last_seq AS read_seq,
  EXISTS (
    SELECT 1 FROM agent_claim_requests request
    WHERE request.org_id = claim.org_id AND request.claim_id = claim.id
      AND request.status IN ('open','answer_queued')
  ) AS needs_input,
  CASE WHEN claim.status IN ('pending','claimed') THEN 0
    ELSE ROW_NUMBER() OVER (
      PARTITION BY (claim.status IN ('pending','claimed'))
      ORDER BY execution.created_at DESC, claim.id DESC
    )
  END AS terminal_rank
FROM collab_claim_executions execution
JOIN agent_claims claim ON claim.id = execution.claim_id
LEFT JOIN collab_claim_read_cursors cursor
  ON cursor.org_id = claim.org_id AND cursor.claim_id = claim.id AND cursor.principal_id = $2`;

async function claimProjectScope(claimId: number): Promise<{ projectId: string; orgId: string }> {
  const result = await getPool().query<{ project_id: string; org_id: string }>(
    `SELECT execution.project_id, claim.org_id
     FROM collab_claim_executions execution
     JOIN agent_claims claim ON claim.id = execution.claim_id
     WHERE execution.claim_id = $1`,
    [claimId],
  );
  if (result.rows.length === 0) throw new CollabServiceError(404, 'not_found', 'Not found.');
  return { projectId: result.rows[0].project_id, orgId: result.rows[0].org_id };
}

type RankedProgressRow = ProgressRow & { terminal_rank: number };

export async function listTaskClaimProgress(input: z.input<typeof progressSchema>): Promise<TaskClaimProgress> {
  const parsed = progressSchema.parse(input);
  const principal = await requireCurrentPrincipal(parsed.actor);
  const scope = await getPool().query<{ project_id: string }>(
    `SELECT task.project_id
     FROM collab_tasks task
     WHERE task.id = $1`,
    [parsed.taskId],
  );
  if (scope.rows.length === 0) throw new CollabServiceError(404, 'not_found', 'Not found.');
  const projectId = scope.rows[0].project_id;
  await authorize(parsed.actor, { projectId }, ['task.read']);
  const capabilities = await getProjectCapabilities(principal.id, projectId);
  const internalRead = capabilities.has('internal.read');
  const result = await getPool().query<RankedProgressRow>(
    `WITH scoped AS (${PROGRESS_SELECT} WHERE execution.task_id = $1)
     SELECT * FROM scoped
     WHERE terminal_rank <= $3
     ORDER BY
       (terminal_rank = 0) DESC,
       CASE WHEN terminal_rank = 0 THEN execution_created_at END ASC,
       CASE WHEN terminal_rank = 0 THEN id END ASC,
       execution_created_at DESC,
       id DESC`,
    [parsed.taskId, principal.id, TERMINAL_HISTORY_LIMIT + 1],
  );
  const terminalTruncated = result.rows.some((row) => row.terminal_rank > TERMINAL_HISTORY_LIMIT);
  return {
    claims: result.rows
      .filter((row) => row.terminal_rank <= TERMINAL_HISTORY_LIMIT)
      .map((row) => cardFrom(row, internalRead)),
    terminalTruncated,
  };
}

export async function markClaimReadCursor(input: z.input<typeof markSchema>): Promise<{
  claimId: number;
  lastSeq: number;
}> {
  const parsed = markSchema.parse(input);
  await requireCurrentPrincipal(parsed.actor);
  const scope = await claimProjectScope(parsed.claimId);
  await authorize(parsed.actor, { projectId: scope.projectId }, ['task.read', 'internal.read']);
  if (parsed.seq === 0) {
    return { claimId: parsed.claimId, lastSeq: 0 };
  }
  const exists = await getPool().query(
    `SELECT 1 FROM agent_claim_events WHERE org_id = $1 AND claim_id = $2 AND seq = $3`,
    [scope.orgId, parsed.claimId, parsed.seq],
  );
  if (exists.rows.length === 0) {
    throw new CollabServiceError(422, 'invalid_read_seq', 'The read position is not part of this session.');
  }
  return withClientTransaction(async (tx) => {
    await tx.query(
      `INSERT INTO collab_claim_read_cursors (org_id, claim_id, principal_id, last_seq, updated_at)
       VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (org_id, claim_id, principal_id)
       DO UPDATE SET last_seq = EXCLUDED.last_seq, updated_at = now()
       WHERE collab_claim_read_cursors.last_seq < EXCLUDED.last_seq`,
      [scope.orgId, parsed.claimId, parsed.actor.principalId, parsed.seq],
    );
    const persisted = await tx.query<{ last_seq: number }>(
      `SELECT last_seq FROM collab_claim_read_cursors
       WHERE org_id = $1 AND claim_id = $2 AND principal_id = $3`,
      [scope.orgId, parsed.claimId, parsed.actor.principalId],
    );
    return { claimId: parsed.claimId, lastSeq: persisted.rows[0]?.last_seq ?? 0 };
  });
}
