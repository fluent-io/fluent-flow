import { z } from 'zod';
import { getPool } from '../pool.js';
import { withClientTransaction } from './tx.js';
import { authorize } from './authorize.js';
import { CollabServiceError } from './errors.js';

const createCommentSchema = z.object({
  actor: z.object({ principalId: z.string().uuid(), sessionVersion: z.number().int().min(1) }),
  taskId: z.string().uuid(),
  body: z.string().min(1).max(20000),
  visibility: z.enum(['client', 'internal']),
});

export type CollabComment = {
  id: string;
  taskId: string;
  authorId: string;
  authorName: string;
  body: string;
  visibility: 'client' | 'internal';
  createdAt: string;
};

const COMMENT_SELECT = `SELECT c.*, p.display_name AS author_name
  FROM collab_task_comments c
  JOIN collab_principals p ON p.id = c.author_id`;

/**
 * Add a comment. client visibility needs only comment.write; INTERNAL
 * visibility additionally requires internal.read (a collaborator must not
 * publish — or later read — internal discussion).
 */
export async function createCollabComment(input: {
  actor: { principalId: string; sessionVersion: number };
  taskId: string;
  body: string;
  visibility: 'client' | 'internal';
}): Promise<CollabComment> {
  const input2 = createCommentSchema.parse(input);
  const projectId = await projectIdForTask(input2.taskId);
  await authorize(input2.actor, { projectId }, ['comment.write']);
  if (input2.visibility === 'internal') {
    await authorize(input2.actor, { projectId }, ['internal.read']);
  }

  return withClientTransaction(async (tx) => {
    const { rows } = await tx.query(
      `INSERT INTO collab_task_comments (task_id, project_id, author_id, body, visibility)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [input2.taskId, projectId, input2.actor.principalId, input2.body, input2.visibility],
    );
    await tx.query(
      `INSERT INTO collab_task_events (task_id, project_id, kind, payload, visibility, actor_id)
       VALUES ($1, $2, 'comment_added', $3, $4, $5)`,
      [
        input2.taskId,
        projectId,
        JSON.stringify({ commentId: rows[0].id, visibility: input2.visibility }),
        input2.visibility,
        input2.actor.principalId,
      ],
    );
    return rowToComment(rows[0]);
  });
}

/** Client-safe projection: internal comments are absent, never redacted. */
export async function listCollabComments(input: {
  actor: { principalId: string; sessionVersion: number };
  taskId: string;
  cursor?: string;
  limit?: number;
}): Promise<{ comments: CollabComment[]; nextCursor: string | null }> {
  const limit = Math.min(Math.max(input.limit ?? 50, 1), 100);
  const projectId = await projectIdForTask(input.taskId);
  await authorize(input.actor, { projectId }, ['task.read']);
  const capabilities = await (await import('./authorize.js')).getProjectCapabilities(
    input.actor.principalId,
    projectId,
  );
  const visibilityClause = capabilities.has('internal.read')
    ? ''
    : ` AND c.visibility = 'client'`;

  const after = decodeCursor(input.cursor);
  const params: unknown[] = [input.taskId];
  let cursorClause = '';
  if (after) {
    params.push(after);
    cursorClause = `AND (c.created_at, c.id) > ($${params.length}::timestamptz, $${params.length + 1}::uuid)`;
    params.push(afterId(input.cursor));
  }
  params.push(limit + 1);
  const limitIdx = params.length;

  const { rows } = await getPool().query(
    `${COMMENT_SELECT}
     WHERE c.task_id = $1${visibilityClause}${cursorClause}
     ORDER BY c.created_at, c.id
     LIMIT $${limitIdx}`,
    params,
  );
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  const nextCursor =
    rows.length > limit && last
      ? Buffer.from(
          JSON.stringify({ t: new Date(last.created_at).toISOString(), i: last.id }),
        ).toString('base64url')
      : null;
  return { comments: page.map(rowToComment), nextCursor };
}

function rowToComment(row: Record<string, unknown>): CollabComment {
  return {
    id: row.id as string,
    taskId: row.task_id as string,
    authorId: row.author_id as string,
    authorName: (row.author_name as string) ?? null,
    body: row.body as string,
    visibility: row.visibility as 'client' | 'internal',
    createdAt: new Date(row.created_at as Date).toISOString(),
  };
}

async function projectIdForTask(taskId: string): Promise<string> {
  if (!z.string().uuid().safeParse(taskId).success) {
    throw new CollabServiceError(404, 'not_found', 'Not found.');
  }
  const { rows } = await getPool().query(`SELECT project_id FROM collab_tasks WHERE id = $1`, [taskId]);
  if (rows.length === 0) {
    throw new CollabServiceError(404, 'not_found', 'Not found.');
  }
  return rows[0].project_id;
}

function decodeCursor(cursor: string | undefined): string | null {
  if (!cursor) return null;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    return typeof parsed?.t === 'string' ? parsed.t : null;
  } catch {
    return null;
  }
}

function afterId(cursor: string | undefined): string | null {
  if (!cursor) return null;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    return typeof parsed?.i === 'string' ? parsed.i : null;
  } catch {
    return null;
  }
}
