import { z } from 'zod';
import type { PoolClient } from 'pg';
import { getPool } from '../pool.js';
import { withClientTransaction } from './tx.js';
import { authorize, getProjectCapabilities } from './authorize.js';
import { requireCurrentPrincipal } from './principals.js';
import { CollabServiceError } from './errors.js';
import { taskStatusSchema, taskPrioritySchema } from './schemas.js';
import type { CollabTask } from './schemas.js';

// Positions are fixed-width 18-digit zero-padded decimal strings: JS-string
// order equals numeric order and BigInt math gives exact, collision-free
// midpoints. Compaction renumbers a lane with wide spacing when a gap runs out.
const RANK_WIDTH = 18;
const RANK_ZERO = '0'.repeat(RANK_WIDTH);
const RANK_MAX = 10n ** 18n - 1n;
const APPEND_STEP = 10n ** 15n;      // ~999 tail appends per compaction cycle
const COMPACT_SPACING = 10n ** 12n;  // ~999,000,000,000 slots per compaction cycle

const createTaskSchema = z.object({
  actor: z.object({ principalId: z.string().uuid(), sessionVersion: z.number().int().min(1) }),
  projectId: z.string().uuid(),
  title: z.string().min(1).max(300),
  description: z.string().max(65535).default(''),
  priority: z.enum(['low', 'normal', 'high', 'urgent']).default('normal'),
  assigneeId: z.string().uuid().nullable().default(null),
});

const moveTaskSchema = z.object({
  actor: z.object({ principalId: z.string().uuid(), sessionVersion: z.number().int().min(1) }),
  taskId: z.string().uuid(),
  expectedVersion: z.number().int().min(1),
  expectedBoardVersion: z.number().int().min(1),
  status: taskStatusSchema,
  beforeTaskId: z.string().uuid().nullable().default(null),
  afterTaskId: z.string().uuid().nullable().default(null),
});

const updateTaskSchema = z.object({
  actor: z.object({ principalId: z.string().uuid(), sessionVersion: z.number().int().min(1) }),
  taskId: z.string().uuid(),
  expectedVersion: z.number().int().min(1),
  title: z.string().min(1).max(300).optional(),
  description: z.string().max(65535).optional(),
  priority: taskPrioritySchema.optional(),
  assigneeId: z.string().uuid().nullable().optional(),
  blockedReason: z.string().max(2000).nullable().optional(),
});

const listTasksSchema = z.object({
  actor: z.object({ principalId: z.string().uuid(), sessionVersion: z.number().int().min(1) }),
  projectId: z.string().uuid().optional(),
  workspaceId: z.string().uuid().optional(),
  status: taskStatusSchema.optional(),
  assigneeId: z.string().uuid().optional(),
  q: z.string().max(200).optional(),
  cursor: z.string().max(256).optional(),
  limit: z.number().int().min(1).max(100).default(50),
});

const TASK_SELECT = `SELECT t.*, p.display_name AS assignee_name,
    execution.id AS execution_id, execution.state AS execution_state,
    execution.stage AS execution_stage, execution.last_observed_at AS execution_observed_at,
    CASE WHEN EXISTS(SELECT 1 FROM collab_connector_commands c WHERE c.run_id=execution.id AND c.state IN ('failed','ambiguous')) THEN 1 ELSE 0 END AS command_attention,
    CASE WHEN host.revoked_at IS NOT NULL OR host.last_heartbeat_at IS NULL THEN 'offline'
      WHEN host.last_heartbeat_at >= now()-interval '45 seconds' THEN 'online'
      WHEN host.last_heartbeat_at >= now()-interval '120 seconds' THEN 'stale' ELSE 'offline' END AS execution_reachability
  FROM collab_tasks t
  LEFT JOIN collab_principals p ON p.id = t.assignee_id
  LEFT JOIN LATERAL (SELECT id,state,stage,last_observed_at,host_id FROM collab_runs
    WHERE task_id=t.id ORDER BY created_at DESC,id DESC LIMIT 1) execution ON true
  LEFT JOIN collab_hosts host ON host.id=execution.host_id`;

function rowToTask(row: Record<string, unknown>): CollabTask {
  return {
    id: row.id as string,
    projectId: row.project_id as string,
    title: row.title as string,
    description: row.description as string,
    status: row.status as CollabTask['status'],
    priority: row.priority as CollabTask['priority'],
    assigneeId: (row.assignee_id as string | null) ?? null,
    assigneeName: (row.assignee_name as string | null) ?? null,
    version: row.version as number,
    position: row.position as string,
    blockedReason: (row.blocked_reason as string | null) ?? null,
    createdAt: (row.created_at as Date).toISOString(),
    updatedAt: (row.updated_at as Date).toISOString(),
    execution: {
      latestRun: row.execution_id ? {
        id: row.execution_id as string, state: row.execution_state as any, stage: row.execution_stage as any,
        lastObservedAt: row.execution_observed_at ? new Date(row.execution_observed_at as Date).toISOString() : null,
      } : null,
      hostReachability: row.execution_id ? row.execution_reachability as 'online'|'stale'|'offline' : null,
      // Public progress is derived from observed state, never transcript text.
      progress: row.execution_id ? ({ queued:'Queued', launching:'Connecting', running:'Working', needs_input:'Response needed', idle:'Turn complete', failed:'Execution failed', reconciling:'Execution needs review', cancel_requested:'Cancellation requested', cancelled:'Execution stopped' } as Record<string,string>)[row.execution_state as string] ?? null : null,
      attentionCount: ['needs_input','failed','reconciling'].includes(row.execution_state as string) || row.command_attention === 1 ? 1 : 0,
    },
  };
}

function padRank(n: bigint): string {
  return n.toString().padStart(RANK_WIDTH, '0');
}

/**
 * Tail rank after prev (null = empty lane). Returns null when the lane needs
 * compaction — callers do that in the same transaction and retry once.
 */
export function nextTailRank(prev: string | null): string | null {
  const n = prev === null ? 0n : BigInt(prev);
  const next = prev === null ? RANK_MAX / 2n : n + APPEND_STEP;
  return next > RANK_MAX ? null : padRank(next);
}

/** Strictly between a and b (both non-null, a < b); null when no room. */
export function betweenRanks(a: string, b: string): string | null {
  const gap = BigInt(b) - BigInt(a);
  if (gap <= 1n) return null;
  return padRank(BigInt(a) + gap / 2n);
}

/**
 * Renumber a lane with wide spacing (000…001×10¹², …). Must run inside the
 * caller's transaction while the project board lock is held.
 */
export async function compactLane(tx: PoolClient, projectId: string, status: string): Promise<void> {
  const lanes = await tx.query<{ id: string }>(
    `SELECT id FROM collab_tasks WHERE project_id = $1 AND status = $2 ORDER BY position, id FOR UPDATE`,
    [projectId, status],
  );
  if (BigInt(lanes.rows.length) * COMPACT_SPACING > RANK_MAX) {
    throw new CollabServiceError(422, 'lane_full', 'This board column is full.');
  }
  let index = 0n;
  for (const task of lanes.rows) {
    index += 1n;
    await tx.query(`UPDATE collab_tasks SET position = $1, updated_at = now() WHERE id = $2`, [
      padRank(index * COMPACT_SPACING),
      task.id,
    ]);
  }
}

/**
 * Create a backlog task. No repository, run, host or mapping prerequisite:
 * capture must work with the execution host offline (contract scenario 2).
 */
export async function createCollabTask(input: {
  actor: { principalId: string; sessionVersion: number };
  projectId: string;
  title: string;
  description?: string;
  priority?: 'low' | 'normal' | 'high' | 'urgent';
  assigneeId?: string | null;
}): Promise<CollabTask> {
  const input2 = createTaskSchema.parse(input);
  await authorize(input2.actor, { projectId: input2.projectId }, ['task.write']);

  if (input2.assigneeId !== null) {
    const assigneeCaps = await getProjectCapabilities(input2.assigneeId, input2.projectId);
    if (!assigneeCaps.has('task.read')) {
      throw new CollabServiceError(
        422,
        'invalid_assignee',
        'The assignee must have access to this project.',
      );
    }
  }

  return withClientTransaction(async (tx) => {
    // All board mutations for a project share ONE advisory lock + board
    // version counter (create included — it changes the visible board order).
    await tx.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`board:${input2.projectId}`]);
    const tail = await tx.query(
      `SELECT position FROM collab_tasks
       WHERE project_id = $1 AND status = 'backlog'
       ORDER BY position DESC, id DESC LIMIT 1 FOR UPDATE`,
      [input2.projectId],
    );
    let position = nextTailRank(tail.rows[0]?.position ?? null);
    if (position === null) {
      await compactLane(tx, input2.projectId, 'backlog');
      const renumbered = await tx.query(
        `SELECT position FROM collab_tasks WHERE project_id = $1 AND status = 'backlog'
         ORDER BY position DESC, id DESC LIMIT 1`,
        [input2.projectId],
      );
      position = nextTailRank(renumbered.rows[0]?.position ?? null);
    }
    if (position === null) {
      throw new CollabServiceError(422, 'lane_full', 'This board column is full.');
    }
    const { rows } = await tx.query(
      `INSERT INTO collab_tasks (project_id, title, description, priority, assignee_id, position, created_by_principal_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [
        input2.projectId,
        input2.title,
        input2.description,
        input2.priority,
        input2.assigneeId,
        position,
        input2.actor.principalId,
      ],
    );
    await tx.query(
      `UPDATE collab_projects SET board_version = board_version + 1, updated_at = now() WHERE id = $1`,
      [input2.projectId],
    );
    await tx.query(
      `INSERT INTO collab_task_events (task_id, project_id, kind, payload, visibility, actor_id)
       VALUES ($1, $2, 'task_created', $3, 'client', $4)`,
      [
        rows[0].id,
        input2.projectId,
        JSON.stringify({ title: input2.title }),
        input2.actor.principalId,
      ],
    );
    const created = await tx.query(`${TASK_SELECT} WHERE t.id = $1 AND t.project_id = $2`, [
      rows[0].id,
      input2.projectId,
    ]);
    return rowToTask(created.rows[0]);
  });
}

/** Projects where the principal's effective roles include task.read. */
export async function authorizedProjectIds(principalId: string): Promise<string[]> {
  const { rows } = await getPool().query<{ id: string }>(
    `SELECT DISTINCT p.id
     FROM collab_projects p
     JOIN collab_memberships m
       ON m.workspace_id = p.workspace_id AND (m.project_id IS NULL OR m.project_id = p.id)
     JOIN collab_roles r ON r.id = m.role_id
     WHERE m.principal_id = $1 AND 'task.read' = ANY(r.capabilities)`,
    [principalId],
  );
  return rows.map((r) => r.id);
}

function decodeCursor(cursor: string | undefined): { position: string; id: string } | null {
  if (!cursor) return null;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (typeof parsed?.p !== 'string' || typeof parsed?.i !== 'string') return null;
    return { position: parsed.p, id: parsed.i };
  } catch {
    return null;
  }
}

function encodeCursor(task: { position: string; id: string }): string {
  return Buffer.from(JSON.stringify({ p: task.position, i: task.id }), 'utf8').toString('base64url');
}

export async function listCollabTasks(input: {
  actor: { principalId: string; sessionVersion: number };
  projectId?: string;
  workspaceId?: string;
  status?: CollabTask['status'];
  assigneeId?: string;
  q?: string;
  cursor?: string;
  limit?: number;
}): Promise<{ tasks: CollabTask[]; nextCursor: string | null }> {
  const input2 = listTasksSchema.parse(input);
  // Service-boundary identity check: stale/disabled actors fail here even
  // when called outside the HTTP middleware (MCP, direct service use).
  const principal = await requireCurrentPrincipal(input2.actor);
  // Actor-scoped before pagination/search: only authorized project ids feed
  // the query, so counts and pages can never leak other clients' work.
  let projectIds = await authorizedProjectIds(principal.id);
  if (input2.projectId) {
    // Unknown/unauthorized project is indistinguishable → empty result, 404-free list.
    projectIds = projectIds.includes(input2.projectId) ? [input2.projectId] : [];
  }
  if (input2.workspaceId) {
    const { rows } = await getPool().query<{ id: string }>(
      `SELECT id FROM collab_projects WHERE workspace_id = $1`,
      [input2.workspaceId],
    );
    const wsIds = new Set(rows.map((r) => r.id));
    projectIds = projectIds.filter((id) => wsIds.has(id));
  }
  if (projectIds.length === 0) {
    return { tasks: [], nextCursor: null };
  }

  const conditions: string[] = ['t.project_id = ANY($1)'];
  const params: unknown[] = [projectIds];
  if (input2.status) {
    params.push(input2.status);
    conditions.push(`t.status = $${params.length}`);
  }
  if (input2.assigneeId) {
    params.push(input2.assigneeId);
    conditions.push(`t.assignee_id = $${params.length}`);
  }
  if (input2.q) {
    params.push(`%${input2.q}%`);
    conditions.push(`(t.title ILIKE $${params.length} OR t.description ILIKE $${params.length})`);
  }
  const cursor = decodeCursor(input2.cursor);
  if (cursor) {
    params.push(cursor.position, cursor.id);
    const pIdx = params.length - 1;
    const iIdx = params.length;
    conditions.push(`(t.position, t.id) > ($${pIdx}, $${iIdx})`);
  }
  params.push(input2.limit + 1);
  const limitIdx = params.length;

  const { rows } = await getPool().query(
    `${TASK_SELECT}
     WHERE ${conditions.join(' AND ')}
     ORDER BY t.position, t.id
     LIMIT $${limitIdx}`,
    params,
  );
  const page = rows.slice(0, input2.limit);
  const nextCursor = rows.length > input2.limit && page.length > 0 ? encodeCursor(page[page.length - 1]) : null;
  return { tasks: page.map(rowToTask), nextCursor };
}

export async function getCollabTask(
  actor: { principalId: string; sessionVersion: number },
  taskId: string,
): Promise<{ task: CollabTask; capabilities: string[] }> {
  if (!z.string().uuid().safeParse(taskId).success) {
    throw new CollabServiceError(404, 'not_found', 'Not found.');
  }
  // Unknown and unauthorized tasks are indistinguishable: both 404.
  const projectId = await projectIdForTask(taskId);
  await authorize(actor, { projectId }, ['task.read']);
  const { rows } = await getPool().query(`${TASK_SELECT} WHERE t.id = $1`, [taskId]);
  if (rows.length === 0) {
    throw new CollabServiceError(404, 'not_found', 'Not found.');
  }
  const capabilities = await getProjectCapabilities(actor.principalId, projectId);
  return { task: rowToTask(rows[0]), capabilities: [...capabilities] };
}

async function projectIdForTask(taskId: string): Promise<string> {
  const { rows } = await getPool().query(`SELECT project_id FROM collab_tasks WHERE id = $1`, [taskId]);
  if (rows.length === 0) {
    // Unknown task: the not-found result must be identical for missing vs
    // unauthorized, so this never leaks existence.
    throw new CollabServiceError(404, 'not_found', 'Not found.');
  }
  return rows[0].project_id;
}

/**
 * Board move. Locks the project board row, verifies board and task versions,
 * validates neighbors belong to the target lane, and ranks via midpoint in
 * one transaction. Done/Cancelled are decision endpoints and are rejected
 * here. Stale writers get 409 with the current version — never a silent
 * overwrite, never a lost update.
 */
export async function moveCollabTask(input: {
  actor: { principalId: string; sessionVersion: number };
  taskId: string;
  expectedVersion: number;
  expectedBoardVersion: number;
  status: CollabTask['status'];
  beforeTaskId?: string | null;
  afterTaskId?: string | null;
}): Promise<{ task: CollabTask; boardVersion: number }> {
  const input2 = moveTaskSchema.parse(input);
  if (input2.status === 'done' || input2.status === 'cancelled') {
    throw new CollabServiceError(
      422,
      'decision_required',
      'Use the delivery decision endpoint to accept or cancel a task.',
    );
  }
  const projectId = await projectIdForTask(input2.taskId);
  await authorize(input2.actor, { projectId }, ['task.write']);

  return withClientTransaction(async (tx) => {
    // Serialize all board mutations for this project (same lock as create).
    await tx.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`board:${projectId}`]);

    const board = await tx.query<{ board_version: number }>(
      `SELECT board_version FROM collab_projects WHERE id = $1 FOR UPDATE`,
      [projectId],
    );
    if (board.rows.length === 0) {
      throw new CollabServiceError(404, 'not_found', 'Not found.');
    }
    if (board.rows[0].board_version !== input2.expectedBoardVersion) {
      throw new CollabServiceError(
        409,
        'version_conflict',
        'This item changed. Refresh before saving.',
        { currentBoardVersion: board.rows[0].board_version },
      );
    }

    const task = await tx.query(
      `SELECT * FROM collab_tasks WHERE id = $1 AND project_id = $2 FOR UPDATE`,
      [input2.taskId, projectId],
    );
    if (task.rows.length === 0) {
      throw new CollabServiceError(404, 'not_found', 'Not found.');
    }
    if (task.rows[0].version !== input2.expectedVersion) {
      throw new CollabServiceError(
        409,
        'version_conflict',
        'This item changed. Refresh before saving.',
        { currentVersion: task.rows[0].version },
      );
    }

    // Canonical anchors, resolved against the FULL lane excluding the moving
    // task (B's filtered view may hide cards; server order is authoritative).
    const resolveAnchor = async (anchorId: string | null | undefined): Promise<{ rank: string | null; existsInProject: boolean; laneOk: boolean }> => {
      if (anchorId === null || anchorId === undefined) return { rank: null, existsInProject: true, laneOk: true };
      if (anchorId === input2.taskId) return { rank: null, existsInProject: true, laneOk: false };
      const { rows } = await tx.query(`SELECT status, position FROM collab_tasks WHERE id = $1 AND project_id = $2`, [anchorId, projectId]);
      if (rows.length === 0) return { rank: null, existsInProject: false, laneOk: false };
      return rows[0].status === input2.status
        ? { rank: rows[0].position, existsInProject: true, laneOk: true }
        : { rank: null, existsInProject: true, laneOk: false };
    };

    const beforeAnchor = await resolveAnchor(input2.beforeTaskId);
    const afterAnchor = await resolveAnchor(input2.afterTaskId);
    if (!beforeAnchor.existsInProject || !afterAnchor.existsInProject) {
      // Stale view (unknown/gone anchor) → refresh, not best-effort placement.
      throw new CollabServiceError(409, 'board_changed', 'This item changed. Refresh before saving.');
    }
    if (!beforeAnchor.laneOk || !afterAnchor.laneOk) {
      throw new CollabServiceError(422, 'invalid_neighbor', 'The task would land outside its column.');
    }

    const loadLane = (): Promise<{ rows: Array<{ id: string; position: string }> }> =>
      tx.query(
        `SELECT id, position FROM collab_tasks WHERE project_id = $1 AND status = $2 AND id <> $3 ORDER BY position`,
        [projectId, input2.status, input2.taskId],
      );

    const deriveBounds = (
      laneRows: Array<{ id: string; position: string }>,
    ): { before: string | null; after: string | null } => {
      const laneIds = laneRows.map((r) => r.id);
      if (input2.beforeTaskId !== null && input2.afterTaskId !== null) {
        const bi = laneIds.indexOf(input2.beforeTaskId);
        const ai = laneIds.indexOf(input2.afterTaskId);
        if (bi === -1 || ai !== bi + 1) {
          throw new CollabServiceError(409, 'board_changed', 'This item changed. Refresh before saving.');
        }
        return { before: laneRows[bi].position, after: laneRows[ai].position };
      }
      if (input2.beforeTaskId !== null) {
        const bi = laneIds.indexOf(input2.beforeTaskId);
        if (bi === -1) throw new CollabServiceError(409, 'board_changed', 'This item changed. Refresh before saving.');
        return { before: laneRows[bi].position, after: laneRows[bi + 1]?.position ?? null };
      }
      if (input2.afterTaskId !== null) {
        const ai = laneIds.indexOf(input2.afterTaskId);
        if (ai === -1) throw new CollabServiceError(409, 'board_changed', 'This item changed. Refresh before saving.');
        return { before: laneRows[ai - 1]?.position ?? null, after: laneRows[ai].position };
      }
      // End-of-lane drop (empty lane → first card).
      return { before: laneRows.length > 0 ? laneRows[laneRows.length - 1].position : null, after: null };
    };

    let laneRows = (await loadLane()).rows;
    let bounds = deriveBounds(laneRows);
    let position =
      bounds.before === null && bounds.after === null
        ? nextTailRank(null)
        : bounds.before === null
          ? betweenRanks(RANK_ZERO, bounds.after as string)
          : bounds.after === null
            ? nextTailRank(bounds.before)
            : betweenRanks(bounds.before, bounds.after);
    if (position === null) {
      // Gap exhausted: renumber the lane, RE-QUERY fresh ranks (the closed-over
      // rows are stale after compaction), then derive again.
      await compactLane(tx, projectId, input2.status);
      laneRows = (await loadLane()).rows;
      bounds = deriveBounds(laneRows);
      position =
        bounds.before === null && bounds.after === null
          ? nextTailRank(null)
          : bounds.before === null
            ? betweenRanks(RANK_ZERO, bounds.after as string)
            : bounds.after === null
              ? nextTailRank(bounds.before)
              : betweenRanks(bounds.before, bounds.after);
    }
    if (position === null) {
      throw new CollabServiceError(409, 'board_changed', 'This item changed. Refresh before saving.');
    }

    const updated = await tx.query(
      `UPDATE collab_tasks SET status = $1, position = $2, version = version + 1, updated_at = now()
       WHERE id = $3 RETURNING *`,
      [input2.status, position, input2.taskId],
    );
    const boardUpdate = await tx.query<{ board_version: number }>(
      `UPDATE collab_projects SET board_version = board_version + 1, updated_at = now()
       WHERE id = $1 RETURNING board_version`,
      [projectId],
    );
    await tx.query(`INSERT INTO collab_task_events(task_id,project_id,kind,payload,visibility,actor_id)
      VALUES($1,$2,'task_moved',$3,'client',$4)`,[input2.taskId,projectId,JSON.stringify({status:input2.status}),input2.actor.principalId]);
    const projected = await tx.query(`${TASK_SELECT} WHERE t.id = $1`, [input2.taskId]);
    return { task: rowToTask(projected.rows[0]), boardVersion: boardUpdate.rows[0].board_version };
  });
}

/**
 * Field edit with optimistic task-version concurrency. The first accepted
 * write wins; stale writers get 409 with the current version attached.
 */
export async function updateCollabTask(input: {
  actor: { principalId: string; sessionVersion: number };
  taskId: string;
  expectedVersion: number;
  title?: string;
  description?: string;
  priority?: CollabTask['priority'];
  assigneeId?: string | null;
  blockedReason?: string | null;
}): Promise<CollabTask> {
  const input2 = updateTaskSchema.parse(input);
  const projectId = await projectIdForTask(input2.taskId);
  await authorize(input2.actor, { projectId }, ['task.write']);

  if (input2.assigneeId) {
    const assigneeCaps = await getProjectCapabilities(input2.assigneeId, projectId);
    if (!assigneeCaps.has('task.read')) {
      throw new CollabServiceError(
        422,
        'invalid_assignee',
        'The assignee must have access to this project.',
      );
    }
  }

  return withClientTransaction(async (tx) => {
    const current = await tx.query(
      `SELECT version FROM collab_tasks WHERE id = $1 AND project_id = $2 FOR UPDATE`,
      [input2.taskId, projectId],
    );
    if (current.rows.length === 0) {
      throw new CollabServiceError(404, 'not_found', 'Not found.');
    }
    if (current.rows[0].version !== input2.expectedVersion) {
      throw new CollabServiceError(
        409,
        'version_conflict',
        'This item changed. Refresh before saving.',
        { currentVersion: current.rows[0].version },
      );
    }

    const sets: string[] = ['version = version + 1', 'updated_at = now()'];
    const params: unknown[] = [];
    for (const [column, value] of [
      ['title', input2.title],
      ['description', input2.description],
      ['priority', input2.priority],
      ['assignee_id', input2.assigneeId],
      ['blocked_reason', input2.blockedReason],
    ] as const) {
      if (value !== undefined) {
        params.push(value);
        sets.push(`${column} = $${params.length}`);
      }
    }
    params.push(input2.taskId);
    await tx.query(`UPDATE collab_tasks SET ${sets.join(', ')} WHERE id = $${params.length}`, params);
    await tx.query(`INSERT INTO collab_task_events(task_id,project_id,kind,payload,visibility,actor_id)
      VALUES($1,$2,'task_updated','{}','client',$3)`,[input2.taskId,projectId,input2.actor.principalId]);
    const projected = await tx.query(`${TASK_SELECT} WHERE t.id = $1`, [input2.taskId]);
    return rowToTask(projected.rows[0]);
  });
}
