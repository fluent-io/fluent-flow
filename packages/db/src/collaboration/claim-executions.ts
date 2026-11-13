import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { chatDefaultsSchema, readChatAgents, validateChatSelection } from './chat-settings.js';
import { createCollabTask } from './tasks.js';
import { z } from 'zod';
import { getPool } from '../pool.js';
import {
  cancelOpenClaimInteractions,
  enqueueClaimCommand,
  reserveClaimRequestAnswer,
} from '../queries/claim-interactions.js';
import type { ClaimCommand } from '../queries/claim-interactions.js';
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
  endReason?: string | null;
};

export type ClaimExecution = ClaimExecutionBadge & {
  projectId: string;
  repo: string | null;
  prNumber: number | null;
  sessionId: number | null;
  payload: Record<string, unknown>;
  headSha: string | null;
  pendingDeadlineAt?: string | null;
  lastActivityAt?: string;
};

export type StartClaimExecutionResult = {
  claim: ClaimExecution | ClaimExecutionBadge;
  created: boolean;
};

export type ClaimExecutionEvent = {
  seq: number;
  kind: string;
  payload: unknown;
  createdAt: string;
};

export type ClaimExecutionRequest = {
  requestKey: string;
  kind: 'permission' | 'elicitation';
  payload: unknown;
  status: 'open' | 'answer_queued' | 'resolved' | 'uncertain' | 'cancelled';
  createdAt: string;
  resolvedAt: string | null;
};

export type SubmitClaimCommandResult = {
  commandId: number | null;
  kind: 'prompt' | 'cancel' | 'end_session' | 'handoff' | 'permission' | 'elicitation';
  status: string;
  created: boolean;
};

type ClaimExecutionRow = {
  id: number;
  task_id: string;
  project_id: string;
  root_claim_id: number;
  repo: string | null;
  pr_number: number | null;
  attempt: number;
  session_id: number | null;
  claim_type: string;
  status: string;
  payload: Record<string, unknown>;
  head_sha: string | null;
  execution_created_at: Date;
  completed_at: Date | null;
  end_reason: string | null;
  pending_deadline_at: Date | null;
  last_activity_at: Date;
  cursor_created_at: string;
};

const startSchema = z.object({
  actor: z.object({ principalId: z.string().uuid(), sessionVersion: z.number().int().min(1) }),
  taskId: z.string().uuid(),
  expectedVersion: z.number().int().min(1),
  idempotencyKey: z.string().min(8).max(256),
  repo: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/).max(200).nullable(),
  targetAgentId: z.string().min(1).max(200).optional(),
  prNumber: z.number().int().positive().nullable().optional(),
  branch: z.string().min(1).max(500).nullable().optional(),
  claimType: z.enum(['spec', 'build', 'chat']),
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

const POSTGRES_INTEGER_MAX = 2_147_483_647;
const CLAIM_INTERACTION_PAGE_BYTES = 1024 * 1024;
const CURSOR_TIMESTAMP_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{6})Z$/;

function validCursorTimestamp(value: string): boolean {
  const match = CURSOR_TIMESTAMP_PATTERN.exec(value);
  if (match === null) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const date = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day
    && date.getUTCHours() === hour
    && date.getUTCMinutes() === minute
    && date.getUTCSeconds() === second;
}

const cursorTimestampSchema = z.string().refine(validCursorTimestamp);
const cursorIntegerSchema = z.number().int().positive().max(POSTGRES_INTEGER_MAX);

const cursorSchema = z.object({
  t: cursorTimestampSchema,
  c: cursorIntegerSchema,
}).strict();

const eventListSchema = z.object({
  actor: z.object({ principalId: z.string().uuid(), sessionVersion: z.number().int().min(1) }),
  claimId: z.number().int().positive(),
  cursor: z.string().optional(),
  limit: z.number().int().positive().max(100).default(50),
});

const requestListSchema = eventListSchema;

const eventCursorSchema = z.object({
  s: cursorIntegerSchema,
}).strict();

const requestCursorSchema = z.object({
  t: cursorTimestampSchema,
  k: z.string().min(1).max(512),
}).strict();

const commandActorSchema = z.object({
  principalId: z.string().uuid(),
  sessionVersion: z.number().int().min(1),
}).strict();

const commandBase = {
  actor: commandActorSchema,
  claimId: z.number().int().positive(),
  idempotencyKey: z.string().min(8).max(256),
};

const commandSchema = z.discriminatedUnion('kind', [
  z.object({
    ...commandBase,
    kind: z.literal('handoff'),
    payload: z.object({}).strict(),
    requestKey: z.never().optional(),
  }).strict(),
  z.object({
    ...commandBase,
    kind: z.literal('prompt'),
    payload: z.object({ text: z.string().min(1).max(20000) }).strict(),
    requestKey: z.never().optional(),
  }).strict(),
  z.object({
    ...commandBase,
    kind: z.literal('end_session'),
    payload: z.object({}).strict(),
    requestKey: z.never().optional(),
  }).strict(),
  z.object({
    ...commandBase,
    kind: z.literal('cancel'),
    payload: z.object({}).strict(),
    requestKey: z.never().optional(),
  }).strict(),
  z.object({
    ...commandBase,
    kind: z.literal('permission'),
    payload: z.object({ answer: z.record(z.unknown()) }).strict(),
    requestKey: z.string().min(1).max(512),
  }).strict(),
  z.object({
    ...commandBase,
    kind: z.literal('elicitation'),
    payload: z.object({ answer: z.record(z.unknown()) }).strict(),
    requestKey: z.string().min(1).max(512),
  }).strict(),
]);

type ExecutionScope = {
  project_id: string;
  org_id: string;
};

type EventRow = {
  seq: number;
  kind: string;
  payload: unknown;
  created_at: Date;
};

type RequestRow = {
  request_key: string;
  kind: 'permission' | 'elicitation';
  payload: unknown;
  status: ClaimExecutionRequest['status'];
  created_at: Date;
  resolved_at: Date | null;
  cursor_created_at: string;
};

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
  claim.end_reason, claim.pending_deadline_at, claim.last_activity_at,
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
    ...(row.claim_type === 'chat' ? { endReason: row.end_reason } : {}),
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
    ...(row.claim_type === 'chat' ? { pendingDeadlineAt: row.pending_deadline_at?.toISOString() ?? null, lastActivityAt: row.last_activity_at.toISOString() } : {}),
    createdAt: row.execution_created_at.toISOString(),
    completedAt: row.completed_at?.toISOString() ?? null,
    ...(row.claim_type === 'chat' ? { endReason: row.end_reason } : {}),
  };
}

async function taskScope(taskId: string, executor?: PoolClient): Promise<{ projectId: string; orgId: string | null }> {
  const result = await (executor ?? getPool()).query<{ project_id: string; org_id: string | null }>(
    `SELECT task.project_id, workspace.org_id
     FROM collab_tasks task
     JOIN collab_projects project ON project.id = task.project_id
     JOIN collab_workspaces workspace ON workspace.id = project.workspace_id
     WHERE task.id = $1`,
    [taskId],
  );
  if (result.rows.length === 0) throw new CollabServiceError(404, 'not_found', 'Not found.');
  return {
    projectId: result.rows[0].project_id,
    orgId: result.rows[0].org_id,
  };
}

async function requireRepo(repo: string, orgId: string, executor?: PoolClient): Promise<void> {
  const result = await (executor ?? getPool()).query(
    `SELECT id
     FROM repos
     WHERE repo_full_name = $1 AND org_id = $2`,
    [repo, orgId],
  );
  if (result.rows.length === 0) throw new CollabServiceError(404, 'not_found', 'Not found.');
}

async function projectClaim(
  principalId: string,
  projectId: string,
  row: ClaimExecutionRow,
  executor?: PoolClient,
): Promise<ClaimExecution | ClaimExecutionBadge> {
  const capabilities = await getProjectCapabilities(principalId, projectId, executor);
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
  repo: string | null;
  prNumber?: number | null;
  branch?: string | null;
  claimType: 'spec' | 'build' | 'chat';
  targetAgentId?: string;
  instructions?: string;
}, executor?: PoolClient): Promise<StartClaimExecutionResult> {
  const parsed = startSchema.parse(input);
  const principal = await requireCurrentPrincipal(parsed.actor, executor);
  const scope = await taskScope(parsed.taskId, executor);
  await authorize(parsed.actor, { projectId: scope.projectId }, parsed.claimType === 'chat' ? ['run.start', 'internal.read'] : ['run.start'], executor);
  if (scope.orgId === null) {
    throw new CollabServiceError(404, 'not_found', 'Not found.');
  }
  const orgId = scope.orgId;
  if (parsed.claimType !== 'chat' && parsed.repo === null) throw new CollabServiceError(400, 'malformed', 'Invalid request.');
  if (parsed.claimType === 'chat' && (parsed.prNumber != null || parsed.branch != null)) throw new CollabServiceError(400, 'malformed', 'Invalid request.');
  if (parsed.repo !== null) await requireRepo(parsed.repo, orgId, executor);
  const canonical = {
    expectedVersion: parsed.expectedVersion,
    repo: parsed.repo,
    prNumber: parsed.prNumber ?? null,
    branch: parsed.branch ?? null,
    claimType: parsed.claimType,
    instructions: parsed.instructions ?? '',
    ...(parsed.claimType === 'chat' ? { targetAgentId: parsed.targetAgentId ?? null } : {}),
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
    let chatOptions = {};
    let chatPayload: Record<string, unknown> = {};
    if (parsed.claimType === 'chat') {
      const open = await tx.query(`SELECT id FROM agent_claims WHERE org_id=$1 AND task_id=$2 AND claim_type='chat' AND status IN ('pending','claimed')`, [orgId, parsed.taskId]);
      if (open.rows.length) throw new CollabServiceError(409, 'chat_already_open', 'This task already has an open session.');
      const settings = await tx.query(`SELECT execution_mode, default_agent_id, chat_execution_defaults, chat_pending_ttl_seconds, chat_idle_timeout_seconds FROM collab_projects WHERE id=$1`, [scope.projectId]);
      if (settings.rows[0].execution_mode !== 'chat') throw new CollabServiceError(409, 'chat_unavailable', 'Sessions are not available for this project.');
      const targetAgentId = parsed.targetAgentId ?? settings.rows[0].default_agent_id;
      if (targetAgentId !== null) {
        const target = await tx.query(`SELECT id FROM agents WHERE org_id=$1 AND id=$2 AND transport='long_poll'`, [orgId, targetAgentId]);
        if (!target.rows.length) throw new CollabServiceError(404, 'not_found', 'Not found.');
      }
      const defaults = chatDefaultsSchema.parse(settings.rows[0].chat_execution_defaults);
      validateChatSelection(await readChatAgents(orgId, tx), targetAgentId, defaults);
      chatPayload = { ...(defaults.profileId ? { profile: defaults.profileId } : {}), ...(defaults.model ? { model: defaults.model } : {}), instructions: parsed.instructions ?? defaults.instructions };
      chatOptions = { taskId: parsed.taskId, targetAgentId, pendingTtlSeconds: settings.rows[0].chat_pending_ttl_seconds, idleTimeoutSeconds: settings.rows[0].chat_idle_timeout_seconds };
    }
    const createTaskBranch = parsed.claimType !== 'chat' && parsed.prNumber == null && parsed.branch == null;
    const claim = await insertPendingClaim({
      ...chatOptions,
      orgId,
      repo: parsed.repo,
      prNumber: parsed.prNumber ?? null,
      claimType: parsed.claimType,
      payload: {
        source: 'collab',
        branch: createTaskBranch ? `ff/task-${parsed.taskId}` : parsed.branch ?? null,
        ...(createTaskBranch ? { create_branch: true } : {}),
        instructions: parsed.instructions ?? '',
        ...chatPayload,
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
  }, executor);
  return {
    claim: await projectClaim(principal.id, scope.projectId, result.row, executor),
    created: result.created,
  };
}

export async function startCollabChatSession(input: {
  actor: CollabActor;
  projectId: string;
  title: string;
  idempotencyKey: string;
  repo?: string | null;
  targetAgentId?: string;
}): Promise<StartClaimExecutionResult & { taskId: string }> {
  const parsed = z.object({
    actor: commandActorSchema,
    projectId: z.string().uuid(),
    title: z.string().min(1).max(300),
    idempotencyKey: z.string().min(8).max(256),
    repo: startSchema.shape.repo.optional().default(null),
    targetAgentId: startSchema.shape.targetAgentId,
  }).strict().parse(input);
  await requireCurrentPrincipal(parsed.actor);
  await authorize(parsed.actor, { projectId: parsed.projectId }, ['task.write', 'run.start', 'internal.read']);
  const scopeKey = `chat-new:${parsed.projectId}`;
  const hash = requestHash({ title: parsed.title, repo: parsed.repo, targetAgentId: parsed.targetAgentId ?? null });
  return withClientTransaction(async (tx) => {
    await tx.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`${scopeKey}:${parsed.actor.principalId}:${parsed.idempotencyKey}`]);
    const existing = await tx.query<{ request_hash: string; claim_id: number }>(
      `SELECT request_hash, claim_id FROM collab_idempotency_records WHERE principal_id=$1 AND scope_key=$2 AND idempotency_key=$3`,
      [parsed.actor.principalId, scopeKey, parsed.idempotencyKey],
    );
    if (existing.rows.length) {
      if (existing.rows[0].request_hash !== hash) throw new CollabServiceError(409, 'idempotency_conflict', 'This request identity was already used with a different payload.');
      const replay = await tx.query<ClaimExecutionRow>(`${CLAIM_SELECT} WHERE execution.claim_id=$1 AND execution.project_id=$2`, [existing.rows[0].claim_id, parsed.projectId]);
      if (!replay.rows.length) throw new CollabServiceError(404, 'not_found', 'Not found.');
      return { taskId: replay.rows[0].task_id, claim: rowToClaim(replay.rows[0]), created: false };
    }
    const task = await createCollabTask({ actor: parsed.actor, projectId: parsed.projectId, title: parsed.title }, tx);
    const started = await startCollabClaimExecution({ actor: parsed.actor, taskId: task.id, expectedVersion: task.version,
      idempotencyKey: parsed.idempotencyKey, repo: parsed.repo, targetAgentId: parsed.targetAgentId, claimType: 'chat' }, tx);
    await tx.query(`INSERT INTO collab_idempotency_records(principal_id,scope_key,idempotency_key,request_hash,claim_id) VALUES ($1,$2,$3,$4,$5)`,
      [parsed.actor.principalId, scopeKey, parsed.idempotencyKey, hash, started.claim.id]);
    return { ...started, taskId: task.id };
  });
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

async function claimExecutionScope(claimId: number): Promise<ExecutionScope> {
  const result = await getPool().query<ExecutionScope>(
    `SELECT execution.project_id, claim.org_id
     FROM collab_claim_executions execution
     JOIN agent_claims claim ON claim.id = execution.claim_id
     WHERE execution.claim_id = $1`,
    [claimId],
  );
  if (result.rows.length === 0) throw new CollabServiceError(404, 'not_found', 'Not found.');
  return result.rows[0];
}

function decodeEventCursor(cursor: string | undefined): { s: number } | null {
  if (cursor === undefined) return null;
  try {
    return eventCursorSchema.parse(JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')));
  } catch {
    throw new CollabServiceError(400, 'invalid_cursor', 'The cursor is invalid.');
  }
}

function decodeRequestCursor(cursor: string | undefined): { t: string; k: string } | null {
  if (cursor === undefined) return null;
  try {
    return requestCursorSchema.parse(JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')));
  } catch {
    throw new CollabServiceError(400, 'invalid_cursor', 'The cursor is invalid.');
  }
}

function encodeEventCursor(row: EventRow): string {
  return Buffer.from(JSON.stringify({ s: row.seq })).toString('base64url');
}

function encodeRequestCursor(row: RequestRow): string {
  return Buffer.from(JSON.stringify({ t: row.cursor_created_at, k: row.request_key })).toString('base64url');
}
function byteBoundedPage<Row, Value>(
  rows: Row[],
  limit: number,
  project: (row: Row) => Value,
): { items: Value[]; hasMore: boolean } {
  const items: Value[] = [];
  let bytes = 2;
  const candidateCount = Math.min(rows.length, limit);
  for (let index = 0; index < candidateCount; index += 1) {
    const item = project(rows[index]);
    const itemBytes = Buffer.byteLength(JSON.stringify(item), 'utf8');
    const separatorBytes = items.length === 0 ? 0 : 1;
    if (items.length > 0 && bytes + separatorBytes + itemBytes > CLAIM_INTERACTION_PAGE_BYTES) break;
    items.push(item);
    bytes += separatorBytes + itemBytes;
  }
  return { items, hasMore: rows.length > items.length };
}

export async function listCollabClaimEvents(input: {
  actor: CollabActor;
  claimId: number;
  cursor?: string;
  limit?: number;
}): Promise<{ events: ClaimExecutionEvent[]; nextCursor: string | null }> {
  const parsed = eventListSchema.parse(input);
  const scope = await claimExecutionScope(parsed.claimId);
  await authorize(parsed.actor, { projectId: scope.project_id }, ['task.read', 'internal.read']);
  const cursor = decodeEventCursor(parsed.cursor);
  const result = await getPool().query<EventRow>(
    `SELECT event.seq, event.kind, event.payload, event.created_at
     FROM collab_claim_executions execution
     JOIN agent_claims claim ON claim.id = execution.claim_id
     JOIN agent_claim_events event
       ON event.claim_id = execution.claim_id AND event.org_id = claim.org_id
     WHERE execution.claim_id = $1 AND claim.org_id = $2
       AND ($3::integer IS NULL OR event.seq > $3)
     ORDER BY event.seq
     LIMIT $4`,
    [parsed.claimId, scope.org_id, cursor?.s ?? null, parsed.limit + 1],
  );
  const page = byteBoundedPage(result.rows, parsed.limit, (row): ClaimExecutionEvent => ({
    seq: row.seq,
    kind: row.kind,
    payload: row.payload,
    createdAt: row.created_at.toISOString(),
  }));
  return {
    events: page.items,
    nextCursor: page.hasMore ? encodeEventCursor(result.rows[page.items.length - 1]) : null,
  };
}

export async function listCollabClaimRequests(input: {
  actor: CollabActor;
  claimId: number;
  cursor?: string;
  limit?: number;
}): Promise<{ requests: ClaimExecutionRequest[]; nextCursor: string | null }> {
  const parsed = requestListSchema.parse(input);
  const scope = await claimExecutionScope(parsed.claimId);
  await authorize(parsed.actor, { projectId: scope.project_id }, ['task.read', 'internal.read']);
  const cursor = decodeRequestCursor(parsed.cursor);
  const result = await getPool().query<RequestRow>(
    `SELECT
       request.request_key,
       request.kind,
       request.payload,
       request.status,
       request.created_at,
       request.resolved_at,
       to_char(request.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_created_at
     FROM collab_claim_executions execution
     JOIN agent_claims claim ON claim.id = execution.claim_id
     JOIN agent_claim_requests request
       ON request.claim_id = execution.claim_id AND request.org_id = claim.org_id
     WHERE execution.claim_id = $1 AND claim.org_id = $2
       AND (
         $3::timestamptz IS NULL
         OR (request.created_at, request.request_key) > ($3::timestamptz, $4::text)
       )
     ORDER BY request.created_at, request.request_key
     LIMIT $5`,
    [parsed.claimId, scope.org_id, cursor?.t ?? null, cursor?.k ?? '', parsed.limit + 1],
  );
  const page = byteBoundedPage(result.rows, parsed.limit, (row): ClaimExecutionRequest => ({
    requestKey: row.request_key,
    kind: row.kind,
    payload: row.payload,
    status: row.status,
    createdAt: row.created_at.toISOString(),
    resolvedAt: row.resolved_at?.toISOString() ?? null,
  }));
  return {
    requests: page.items,
    nextCursor: page.hasMore ? encodeRequestCursor(result.rows[page.items.length - 1]) : null,
  };
}

function interactionConflict(error: unknown, code: 'idempotency_conflict' | 'request_conflict'): never {
  if (error instanceof Error && error.message === 'Interaction conflict.') {
    const message = code === 'idempotency_conflict'
      ? 'This request identity was already used with a different payload.'
      : 'The request is not available.';
    throw new CollabServiceError(409, code, message);
  }
  throw error;
}

export async function submitCollabClaimCommand(input: {
  actor: CollabActor;
  claimId: number;
  idempotencyKey: string;
  kind: 'prompt' | 'cancel' | 'end_session' | 'handoff' | 'permission' | 'elicitation';
  payload: Record<string, unknown>;
  requestKey?: string;
}): Promise<SubmitClaimCommandResult> {
  const parsed = commandSchema.parse(input);
  if (Buffer.byteLength(JSON.stringify(parsed.payload), 'utf8') > 256 * 1024) {
    throw new CollabServiceError(413, 'payload_too_large', 'The request payload is too large.');
  }
  const principal = await requireCurrentPrincipal(parsed.actor);
  const scope = await claimExecutionScope(parsed.claimId);
  const required = parsed.kind === 'cancel' || parsed.kind === 'end_session'
    ? ['internal.read', 'run.cancel'] as const
    : parsed.kind === 'handoff' ? ['internal.read', 'run.start', 'run.steer'] as const
    : ['internal.read', 'run.steer'] as const;
  await authorize(parsed.actor, { projectId: scope.project_id }, required);
  const canonical = {
    kind: parsed.kind,
    payload: parsed.payload,
    requestKey: parsed.kind === 'permission' || parsed.kind === 'elicitation'
      ? parsed.requestKey
      : null,
  };
  const hash = requestHash(canonical);
  return withClientTransaction<SubmitClaimCommandResult>(async (tx) => {
    const locked = await tx.query<{ org_id: string; status: string; claim_type: string; repo: string | null }>(
      `SELECT claim.org_id, claim.status, claim.claim_type, claim.repo
       FROM collab_claim_executions execution
       JOIN agent_claims claim ON claim.id = execution.claim_id
       WHERE execution.claim_id = $1
         AND execution.project_id = $2
         AND claim.org_id = $3
       FOR UPDATE OF claim`,
      [parsed.claimId, scope.project_id, scope.org_id],
    );
    if (locked.rows.length === 0) throw new CollabServiceError(404, 'not_found', 'Not found.');
    const claim = locked.rows[0];
    const endsClaim = parsed.kind === 'end_session' || (parsed.kind === 'cancel' && claim.claim_type !== 'chat');
    if (parsed.kind === 'end_session' && claim.claim_type !== 'chat') throw new CollabServiceError(400, 'malformed', 'Invalid request.');
    if (parsed.kind === 'handoff' && (claim.claim_type !== 'chat' || claim.repo === null)) {
      throw new CollabServiceError(409, 'handoff_unavailable', 'Build handoff requires a repository session.');
    }
    const requestKey = parsed.kind === 'permission' || parsed.kind === 'elicitation'
      ? parsed.requestKey
      : null;
    const existingCommand = await tx.query<{
      id: number;
      kind: SubmitClaimCommandResult['kind'];
      status: string;
      body_matches: boolean;
    }>(
      `SELECT id, kind, status,
         kind = $4
           AND payload = $5::jsonb
           AND request_key IS NOT DISTINCT FROM $6::text AS body_matches
       FROM agent_claim_commands
       WHERE org_id = $1 AND claim_id = $2 AND idempotency_key = $3`,
      [
        claim.org_id,
        parsed.claimId,
        parsed.idempotencyKey,
        parsed.kind,
        JSON.stringify(parsed.payload),
        requestKey,
      ],
    );
    if (existingCommand.rows.length > 0) {
      const existing = existingCommand.rows[0];
      if (!existing.body_matches) {
        throw new CollabServiceError(
          409,
          'idempotency_conflict',
          'This request identity was already used with a different payload.',
        );
      }
      return {
        commandId: existing.id,
        kind: existing.kind,
        status: existing.status,
        created: false,
      };
    }
    if (endsClaim) {
      const existingCancellation = await tx.query<{ request_hash: string }>(
        `SELECT request_hash
         FROM collab_idempotency_records
         WHERE scope_key = $1 AND idempotency_key = $2`,
        [`claim-command:${parsed.claimId}`, parsed.idempotencyKey],
      );
      if (existingCancellation.rows.length > 0) {
        if (existingCancellation.rows[0].request_hash !== hash) {
          throw new CollabServiceError(
            409,
            'idempotency_conflict',
            'This request identity was already used with a different payload.',
          );
        }
        return { commandId: null, kind: parsed.kind, status: 'cancelled', created: false };
      }
    }
    if (parsed.kind === 'end_session' && claim.status === 'cancelled') {
      return { commandId: null, kind: parsed.kind, status: 'cancelled', created: false };
    }
    if (claim.status === 'pending') {
      if (!endsClaim) {
        throw new CollabServiceError(409, 'claim_not_active', 'The execution is not active.');
      }
      const cancelled = await tx.query(
        `UPDATE agent_claims
         SET status = 'cancelled', completed_at = now(), end_reason = CASE WHEN claim_type='chat' THEN 'user' ELSE NULL END
         WHERE id = $1 AND org_id = $2 AND status = 'pending'
         RETURNING id`,
        [parsed.claimId, claim.org_id],
      );
      if (cancelled.rows.length === 0) {
        throw new CollabServiceError(409, 'claim_not_active', 'The execution is not active.');
      }
      await cancelOpenClaimInteractions(
        { orgId: claim.org_id, claimId: parsed.claimId },
        tx,
      );
      await tx.query(
        `INSERT INTO collab_idempotency_records
           (principal_id, scope_key, idempotency_key, request_hash, claim_id)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          principal.id,
          `claim-command:${parsed.claimId}`,
          parsed.idempotencyKey,
          hash,
          parsed.claimId,
        ],
      );
      return { commandId: null, kind: parsed.kind, status: 'cancelled', created: true };
    }
    if (claim.status !== 'claimed') {
      throw new CollabServiceError(409, 'claim_not_active', 'The execution is not active.');
    }
    if (parsed.kind === 'permission' || parsed.kind === 'elicitation') {
      let reserved: { command: ClaimCommand; created: boolean } | null;
      try {
        reserved = await reserveClaimRequestAnswer({
          orgId: claim.org_id,
          claimId: parsed.claimId,
          requestKey: parsed.requestKey,
          idempotencyKey: parsed.idempotencyKey,
          kind: parsed.kind,
          payload: parsed.payload,
          originator: parsed.actor,
        }, tx);
      } catch (error) {
        interactionConflict(error, 'request_conflict');
      }
      if (reserved === null) {
        throw new CollabServiceError(409, 'request_conflict', 'The request is not available.');
      }
      return {
        commandId: reserved.command.id,
        kind: reserved.command.kind,
        status: reserved.command.status,
        created: reserved.created,
      };
    }
    try {
      const queued = await enqueueClaimCommand({
        orgId: claim.org_id,
        claimId: parsed.claimId,
        idempotencyKey: parsed.idempotencyKey,
        kind: parsed.kind,
        payload: parsed.payload,
        originator: parsed.actor,
      }, tx);
      return {
        commandId: queued.command.id,
        kind: queued.command.kind,
        status: queued.command.status,
        created: queued.created,
      };
    } catch (error) {
      interactionConflict(error, 'idempotency_conflict');
    }
  });
}

export async function getCollabClaimCommand(input:{actor:CollabActor;claimId:number;commandId:number}):Promise<{commandId:number;kind:string;status:string}> {
 const parsed=detailSchema.extend({commandId:z.number().int().positive().max(POSTGRES_INTEGER_MAX)}).strict().parse(input);
 const scope=await claimExecutionScope(parsed.claimId);
 await authorize(parsed.actor,{projectId:scope.project_id},['task.read','internal.read']);
 const {rows}=await getPool().query(`SELECT id,kind,status FROM agent_claim_commands WHERE id=$1 AND claim_id=$2 AND org_id=$3`,[parsed.commandId,parsed.claimId,scope.org_id]);
 if(!rows[0])throw new CollabServiceError(404,'not_found','Not found.');
 return {commandId:rows[0].id,kind:rows[0].kind,status:rows[0].status};
}

export async function listCollabClaimPrompts(input:{actor:CollabActor;claimId:number;cursor?:string;limit?:number}):Promise<{prompts:{commandId:number;text:string;status:string;createdAt:string;messageId:string|null}[];nextCursor:string|null}> {
 const parsed=eventListSchema.extend({cursor:z.string().regex(/^[1-9]\d*$/).optional()}).strict().parse(input);
 const after=parsed.cursor?Number(parsed.cursor):0;
 if(!Number.isSafeInteger(after)||after>POSTGRES_INTEGER_MAX)throw new CollabServiceError(400,'invalid_cursor','The cursor is invalid.');
 const scope=await claimExecutionScope(parsed.claimId);
 await authorize(parsed.actor,{projectId:scope.project_id},['task.read','internal.read']);
 const {rows}=await getPool().query(`SELECT id,payload->>'text' AS text,result->>'messageId' AS message_id,status,created_at FROM agent_claim_commands WHERE claim_id=$1 AND org_id=$2 AND kind='prompt' AND id>$3 ORDER BY id LIMIT $4`,[parsed.claimId,scope.org_id,after,parsed.limit+1]);
 let bytes=0;const page:typeof rows=[];
 for(const row of rows.slice(0,parsed.limit)){const cost=Buffer.byteLength(JSON.stringify(row));if(bytes+cost>CLAIM_INTERACTION_PAGE_BYTES)break;page.push(row);bytes+=cost;}
 return {prompts:page.map(row=>({commandId:row.id,text:row.text??'',status:row.status,messageId:row.message_id??null,createdAt:row.created_at.toISOString()})),nextCursor:rows.length>page.length&&page.length?String(page[page.length-1].id):null};
}
