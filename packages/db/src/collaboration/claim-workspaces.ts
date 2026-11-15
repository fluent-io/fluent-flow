import { z } from 'zod';
import { getPool } from '../pool.js';
import { authorize } from './authorize.js';
import type { CollabActor } from './auth.js';
import { CollabServiceError } from './errors.js';

const reasons = z.enum(['dirty','unpushed','scratch','clean_pushed','inspection_failed','preparation_failed']);
const reportSchema = z.object({
  orgId: z.string().min(1), agentId: z.string().min(1), sessionId: z.number().int().positive(),
  claimId: z.number().int().positive(), retained: z.boolean(), reason: reasons,
}).strict().refine(value => value.retained === (value.reason !== 'clean_pushed'));

export async function recordClaimWorkspace(input: z.input<typeof reportSchema>) {
  const parsed = reportSchema.parse(input);
  const { rows } = await getPool().query(`INSERT INTO agent_claim_workspaces(claim_id,retained,reason)
    SELECT c.id,$5,$6 FROM agent_claims c JOIN agent_sessions s ON s.id=c.session_id AND s.org_id=c.org_id
    JOIN collab_claim_executions e ON e.claim_id=c.id
    WHERE c.org_id=$1 AND s.agent_id=$2 AND c.session_id=$3 AND c.id=$4 AND c.claim_type='chat'
    ON CONFLICT(claim_id) DO UPDATE SET claim_id=EXCLUDED.claim_id
      WHERE agent_claim_workspaces.retained=EXCLUDED.retained AND agent_claim_workspaces.reason=EXCLUDED.reason
    RETURNING retained,reason`, [parsed.orgId,parsed.agentId,parsed.sessionId,parsed.claimId,parsed.retained,parsed.reason]);
  return rows[0] ?? null;
}

export async function listCollabRetainedWork(input: {
  actor: CollabActor; taskId: string; cursor?: string; limit?: number;
}) {
  const parsed = z.object({
    actor: z.object({ principalId: z.string().uuid(), sessionVersion: z.number().int().positive() }),
    taskId: z.string().uuid(), cursor: z.string().regex(/^[1-9]\d*$/).optional(),
    limit: z.number().int().positive().max(100).default(50),
  }).strict().parse(input);
  const cursor = parsed.cursor === undefined ? null : Number(parsed.cursor);
  if (cursor !== null && (!Number.isSafeInteger(cursor) || cursor > 2147483647)) {
    throw new CollabServiceError(400, 'invalid_cursor', 'The cursor is invalid.');
  }
  const project = await getPool().query(`SELECT project_id FROM collab_tasks WHERE id=$1`, [parsed.taskId]);
  if (!project.rows[0]) throw new CollabServiceError(404, 'not_found', 'Not found.');
  await authorize(parsed.actor, { projectId: project.rows[0].project_id }, ['task.read','internal.read']);
  const { rows } = await getPool().query(`SELECT c.id,c.repo,s.agent_id,w.retained,w.reason,w.reported_at
    FROM collab_claim_executions e JOIN agent_claims c ON c.id=e.claim_id
    LEFT JOIN agent_sessions s ON s.id=c.session_id AND s.org_id=c.org_id
    LEFT JOIN agent_claim_workspaces w ON w.claim_id=c.id
    WHERE e.task_id=$1 AND c.claim_type='chat' AND c.session_id IS NOT NULL AND c.status NOT IN ('pending','claimed')
      AND w.retained IS DISTINCT FROM false AND ($2::integer IS NULL OR c.id<$2)
    ORDER BY c.id DESC LIMIT $3`, [parsed.taskId,cursor,parsed.limit+1]);
  const page = rows.slice(0,parsed.limit);
  return { items: page.map(row => ({ claimId: row.id as number, agentId: row.agent_id as string|null,
    repo: row.repo as string|null, retained: row.retained as boolean|null, reason: row.reason as string|null,
    reportedAt: row.reported_at ? (row.reported_at as Date).toISOString() : null })),
    nextCursor: rows.length > parsed.limit ? String(page.at(-1)!.id) : null };
}
