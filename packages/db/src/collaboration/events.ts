import { z } from 'zod';
import { getPool } from '../pool.js';
import { withClientTransaction } from './tx.js';
import { authorize, getProjectCapabilities } from './authorize.js';
import { requireCurrentPrincipal } from './principals.js';
import { CollabServiceError } from './errors.js';

const listEventsSchema = z.object({
  actor: z.object({ principalId: z.string().uuid(), sessionVersion: z.number().int().min(1) }),
  taskId: z.string().uuid().optional(),
  projectId: z.string().uuid().optional(),
  cursor: z.string().max(256).optional(),
  limit: z.number().int().min(1).max(200).default(100),
});

export type TaskEvent = {
  id: string; taskId: string; projectId: string; kind: string;
  payload: Record<string, unknown>; visibility: 'client' | 'internal'; createdAt: string;
  cursor: string;
};

function cursorFor(row: Record<string, any>): string {
  // Preserve PostgreSQL microseconds; JS Date would replay events within the
  // same millisecond on an open stream.
  return Buffer.from(JSON.stringify({ t: row.cursor_at, i: row.id })).toString('base64url');
}

function decodeCursor(cursor: string | undefined): { t: string; i: string } | null {
  if (!cursor) return null;
  try {
    return z.object({ t: z.string().datetime(), i: z.string().uuid() }).parse(
      JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')),
    );
  } catch {
    throw new CollabServiceError(400, 'invalid_cursor', 'The update cursor is invalid. Refresh and try again.');
  }
}

const EVENT_ACCESS = `EXISTS (
  SELECT 1 FROM collab_projects p
  JOIN collab_memberships m ON m.workspace_id=p.workspace_id AND (m.project_id IS NULL OR m.project_id=p.id)
  JOIN collab_roles role ON role.id=m.role_id
  WHERE p.id=e.project_id AND m.principal_id=$1 AND 'task.read'=ANY(role.capabilities)
) AND (e.visibility='client' OR EXISTS (
  SELECT 1 FROM collab_projects p
  JOIN collab_memberships m ON m.workspace_id=p.workspace_id AND (m.project_id IS NULL OR m.project_id=p.id)
  JOIN collab_roles role ON role.id=m.role_id
  WHERE p.id=e.project_id AND m.principal_id=$1 AND 'internal.read'=ANY(role.capabilities)
))`;
const CURSOR_TIME = `to_char(e.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_at`;

export async function listTaskEvents(input: z.input<typeof listEventsSchema>): Promise<{
  events: TaskEvent[]; nextCursor: string | null;
}> {
  const parsed = listEventsSchema.parse(input);
  await requireCurrentPrincipal(parsed.actor);
  if (parsed.taskId) {
    const projectId = await projectIdForTask(parsed.taskId);
    await authorize(parsed.actor, { projectId }, ['task.read']);
    if (parsed.projectId && parsed.projectId !== projectId) throw new CollabServiceError(404, 'not_found', 'Not found.');
  } else if (parsed.projectId) {
    await authorize(parsed.actor, { projectId: parsed.projectId }, ['task.read']);
  }
  const params: unknown[] = [parsed.actor.principalId];
  const conditions = [EVENT_ACCESS];
  for (const [column, value] of [['task_id', parsed.taskId], ['project_id', parsed.projectId]]) {
    if (value) { params.push(value); conditions.push(`e.${column}=$${params.length}`); }
  }
  const after = decodeCursor(parsed.cursor);
  if (after) {
    params.push(after.t, after.i);
    conditions.push(`(e.created_at,e.id)>($${params.length - 1}::timestamptz,$${params.length}::uuid)`);
  }
  params.push(parsed.limit);
  const { rows } = await getPool().query(
    `SELECT e.*, ${CURSOR_TIME} FROM collab_task_events e WHERE ${conditions.join(' AND ')}
     ORDER BY e.created_at,e.id LIMIT $${params.length}`, params,
  );
  const events = rows.map((r) => ({
    id: r.id, taskId: r.task_id, projectId: r.project_id, kind: r.kind, payload: r.payload,
    visibility: r.visibility, createdAt: new Date(r.created_at).toISOString(), cursor: cursorFor(r),
  }));
  return { events, nextCursor: events.at(-1)?.cursor ?? parsed.cursor ?? null };
}

async function projectIdForTask(taskId: string): Promise<string> {
  if (!z.string().uuid().safeParse(taskId).success) throw new CollabServiceError(404, 'not_found', 'Not found.');
  const { rows } = await getPool().query(`SELECT project_id FROM collab_tasks WHERE id=$1`, [taskId]);
  if (!rows.length) throw new CollabServiceError(404, 'not_found', 'Not found.');
  return rows[0].project_id;
}

/** A read cursor acknowledges visible updates, never resolves pending work. */
export async function markTaskRead(input: {
  actor: { principalId: string; sessionVersion: number }; taskId: string; eventId: string;
}): Promise<void> {
  if (!z.string().uuid().safeParse(input.eventId).success) throw new CollabServiceError(404, 'not_found', 'Not found.');
  const projectId = await projectIdForTask(input.taskId);
  await authorize(input.actor, { projectId }, ['task.read']);
  const caps = await getProjectCapabilities(input.actor.principalId, projectId);
  await withClientTransaction(async (tx) => {
    const event = await tx.query(
      `SELECT id FROM collab_task_events WHERE id=$1 AND task_id=$2 AND ($3::boolean OR visibility='client')`,
      [input.eventId, input.taskId, caps.has('internal.read')],
    );
    if (!event.rows.length) throw new CollabServiceError(404, 'not_found', 'Not found.');
    await tx.query(
      `INSERT INTO collab_read_cursors (task_id,principal_id,last_event_id,last_read_at) VALUES ($1,$2,$3,now())
       ON CONFLICT (task_id,principal_id) DO UPDATE SET last_event_id=excluded.last_event_id,last_read_at=now()
       WHERE (SELECT (created_at,id) FROM collab_task_events WHERE id=excluded.last_event_id)
           > (SELECT (created_at,id) FROM collab_task_events WHERE id=collab_read_cursors.last_event_id)`,
      [input.taskId, input.actor.principalId, input.eventId],
    );
  });
}

export type AttentionItem = {
  id: string; taskId: string; projectId: string; kind: 'question'|'permission'|'error'|'unread'|'attention';
  title: string; detail: string | null; createdAt: string; sessionId: string | null; requestId: string | null;
};

/** Scope and visibility precede pagination; resolved requests are history only. */
export async function listAttention(input: z.input<typeof listEventsSchema>): Promise<{
  attention: AttentionItem[]; nextCursor: string | null;
}> {
  const parsed = listEventsSchema.parse(input);
  await requireCurrentPrincipal(parsed.actor);
  const params: unknown[] = [parsed.actor.principalId];
  const conditions = [EVENT_ACCESS];
  for (const [column, value] of [['task_id', parsed.taskId], ['project_id', parsed.projectId]]) {
    if (value) { params.push(value); conditions.push(`e.${column}=$${params.length}`); }
  }
  conditions.push(`(
    (e.kind='attention' AND e.payload->>'attention'='permission'
      AND COALESCE(e.payload->>'requestId','')<>''
      AND (e.payload->>'expiresAt' IS NULL OR (e.payload->>'expiresAt')::timestamptz>now())
      AND NOT EXISTS (SELECT 1 FROM collab_task_events resolved WHERE resolved.task_id=e.task_id
        AND resolved.payload->>'sessionId'=e.payload->>'sessionId'
        AND resolved.payload->>'requestId'=e.payload->>'requestId'
        AND (resolved.payload->>'attention'='permission_resolved' OR resolved.payload->>'resolved'='true')
        AND (resolved.created_at,resolved.id)>(e.created_at,e.id)))
    OR (e.kind='attention' AND e.payload->>'commandId' IS NOT NULL AND EXISTS (
      SELECT 1 FROM collab_connector_commands command WHERE command.id::text=e.payload->>'commandId'
        AND command.state IN ('failed','ambiguous')))
    OR (e.kind='attention' AND e.payload->>'state' IN ('failed','reconciling') AND EXISTS (
      SELECT 1 FROM collab_runs run WHERE run.id::text=e.payload->>'runId' AND run.state=e.payload->>'state'))
    OR (e.kind<>'attention' AND e.actor_id IS DISTINCT FROM $1::uuid
      AND (cursor_event.id IS NULL OR (e.created_at,e.id)>(cursor_event.created_at,cursor_event.id)))
  )`);
  const after = decodeCursor(parsed.cursor);
  if (after) {
    params.push(after.t, after.i);
    conditions.push(`(e.created_at,e.id)<($${params.length - 1}::timestamptz,$${params.length}::uuid)`);
  }
  params.push(parsed.limit + 1);
  const { rows } = await getPool().query(
    `SELECT e.*,t.title,${CURSOR_TIME} FROM collab_task_events e JOIN collab_tasks t ON t.id=e.task_id
     LEFT JOIN collab_read_cursors reader ON reader.task_id=e.task_id AND reader.principal_id=$1
     LEFT JOIN collab_task_events cursor_event ON cursor_event.id=reader.last_event_id
     WHERE ${conditions.join(' AND ')} ORDER BY e.created_at DESC,e.id DESC LIMIT $${params.length}`, params,
  );
  const page = rows.slice(0, parsed.limit);
  return {
    attention: page.map((r) => ({
      id: r.id, taskId: r.task_id, projectId: r.project_id,
      kind: r.kind !== 'attention' ? 'unread' : r.payload.attention === 'permission'
        ? r.payload.permissionKind === 'question' ? 'question' : 'permission' : 'error',
      title: r.title,
      detail: r.kind === 'attention' ? r.payload.attention === 'permission' ? 'A response is needed.' : 'Execution needs attention.' : 'The task has new updates.',
      createdAt: new Date(r.created_at).toISOString(),
      sessionId: typeof r.payload.sessionId === 'string' ? r.payload.sessionId : null,
      requestId: typeof r.payload.requestId === 'string' ? r.payload.requestId : null,
    })),
    nextCursor: rows.length > parsed.limit && page.length ? cursorFor(page[page.length - 1]) : null,
  };
}
