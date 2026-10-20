import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { PoolClient } from 'pg';
import { getPool } from '../pool.js';
import { withClientTransaction } from './tx.js';
import { authorize, getProjectCapabilities } from './authorize.js';
import { requireCurrentPrincipal } from './principals.js';
import { CollabServiceError } from './errors.js';
import type { CollabTask, RunState, ExecutionStage } from './schemas.js';

export type Run = {
  id: string;
  taskId: string;
  projectId: string;
  hostId: string;
  mappingId: string;
  profileId: string;
  model: string | null;
  instructions: string;
  state: RunState;
  stage: ExecutionStage;
  version: number;
  workspaceId: string | null;
  lastObservedAt: string | null;
  headCommit: string | null;
  dirty: boolean | null;
  progress: {text:string;percent?:number|null} | null;
  retryOfRunId: string | null;
  errorCode: string | null;
  createdAt: string;
  updatedAt: string;
  hostName: string;
  hostReachability: 'online' | 'stale' | 'offline';
  hostLastSeenAt: string | null;
};

export type CollabSession = {
  id: string;
  runId: string;
  role: 'work' | 'summary';
  title: string;
  state: RunState;
  paseoAgentId: string | null;
  providerSessionId: string | null;
  lastObservedAt: string | null;
};

export const ACTIVE_RUN_STATES = [
  'queued',
  'launching',
  'running',
  'needs_input',
  'cancel_requested',
  'reconciling',
] as const;

const startRunSchema = z.object({
  actor: z.object({ principalId: z.string().uuid(), sessionVersion: z.number().int().min(1) }),
  taskId: z.string().uuid(),
  // Optimistic confirmation against the task the operator reviewed.
  expectedVersion: z.number().int().min(1),
  idempotencyKey: z.string().min(8).max(256),
  mappingId: z.string().uuid().optional(),
  profileId: z.string().min(1).max(200).optional(),
  model: z.string().max(200).nullable().optional(),
  instructions: z.string().max(20000).optional(),
  retryOfRunId: z.string().uuid().optional(),
});

function requestHash(parts: Record<string, unknown>): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}


/** Fixed reporting capability set for agent credentials (constraint mirrors the DB). */
export const REPORTING_CAPABILITIES = [
  'report.check',
  'report.artifact',
  'report.idea',
  'report.progress',
  'report.summary',
] as const;

export type ReportingCapability = (typeof REPORTING_CAPABILITIES)[number];

export type AgentReportingContext = {
  kind: 'agent';
  projectId: string;
  runId: string;
  sessionId: string | null;
  capabilities: ReportingCapability[];
  tokenPrefix: string;
};

/**
 * Reporting credential: deterministically derived per session with the
 * server-only key (domain-separated HMAC). Restart-stable and re-derivable
 * for delivery and auth; only the sha256 hash + short prefix persist. The
 * sessionId is embedded in the token so auth re-derives without storing raw.
 */
export function reportingServerKey(): string {
  const key = process.env.FF_COLLAB_AUTH_SECRET;
  if (typeof key !== 'string' || key.length < 16) {
    throw new CollabServiceError(503, 'unavailable_configuration', 'Configuration error. Contact support.');
  }
  return key;
}

export function deriveReportingCredential(secret: string, sessionId: string): string {
  const mac = createHmac('sha256', secret).update(`fluent-flow:reporting:${sessionId}`).digest('base64url');
  return `ffag_${sessionId}_${mac.slice(0, 32)}`;
}

/**
 * Ensure the run/session-bound reporting binding row exists (scopes fixed;
 * hash of the derived token; never raw). Called in the same transaction that
 * creates the session.
 */
export async function ensureReportingBinding(
  tx: PoolClient,
  binding: { projectId: string; runId: string; sessionId: string; principalId: string },
): Promise<void> {
  const secret = reportingServerKey();
  const token = deriveReportingCredential(secret, binding.sessionId);
  const session=await tx.query(`SELECT role FROM collab_sessions s JOIN collab_runs r ON r.id=s.run_id WHERE s.id=$1 AND s.run_id=$2 AND r.project_id=$3`,[binding.sessionId,binding.runId,binding.projectId]);
  if(!session.rows.length) throw new CollabServiceError(404,'not_found','Not found.');
  const scopes=session.rows[0].role==='summary'?['report.summary']:REPORTING_CAPABILITIES.filter(cap=>cap!=='report.summary');
  await tx.query(
    `INSERT INTO collab_scoped_tokens
       (principal_id, token_hash, token_prefix, scopes, project_id, run_id, session_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (session_id) DO NOTHING`,
    [
      binding.principalId,
      createHash('sha256').update(token).digest('hex'),
      token.slice(0, 12),
      scopes,
      binding.projectId,
      binding.runId,
      binding.sessionId,
    ],
  );
}

/**
 * Resolve an agent credential to its narrowed reporting context. Unknown,
 * revoked, or misbound tokens are unauthenticated — no capability inference
 * from principal roles.
 */
export async function authenticateAgentToken(token: string): Promise<AgentReportingContext> {
  const match = /^ffag_([0-9a-fA-F-]{36})_([A-Za-z0-9_-]{32})$/.exec(token);
  const secret = reportingServerKey();
  if (match === null) {
    throw new CollabServiceError(401, 'unauthenticated', 'Authentication required.');
  }
  const sessionId = match[1];
  const expected = createHmac('sha256', secret)
    .update(`fluent-flow:reporting:${sessionId}`)
    .digest('base64url')
    .slice(0, 32);
  const presented = match[2];
  if (
    presented.length !== expected.length ||
    !timingSafeEqual(Buffer.from(presented), Buffer.from(expected))
  ) {
    throw new CollabServiceError(401, 'unauthenticated', 'Authentication required.');
  }
  const { rows } = await getPool().query(
    `SELECT token.project_id,token.run_id,token.session_id,token.scopes,token.token_prefix,s.role
     FROM collab_scoped_tokens token JOIN collab_sessions s ON s.id=token.session_id AND s.run_id=token.run_id
     JOIN collab_runs r ON r.id=s.run_id AND r.project_id=token.project_id
     WHERE token.session_id=$1 AND token.revoked_at IS NULL`,
    [sessionId],
  );
  if (rows.length === 0) {
    throw new CollabServiceError(401, 'unauthenticated', 'Authentication required.');
  }
  const row = rows[0];
  return {
    kind: 'agent',
    projectId: row.project_id,
    runId: row.run_id,
    sessionId: row.session_id,
    capabilities: row.scopes.filter((cap:ReportingCapability)=>row.role==='summary'?cap==='report.summary':cap!=='report.summary'),
    tokenPrefix: row.token_prefix,
  };
}


function hostReachability(lastHeartbeatAt: Date | null): 'online' | 'stale' | 'offline' {
  if (lastHeartbeatAt === null) return 'offline';
  const ageMs = Date.now() - lastHeartbeatAt.getTime();
  if (ageMs < 45_000) return 'online';
  if (ageMs < 120_000) return 'stale';
  return 'offline';
}

function rowToRun(row: Record<string, unknown>): Run {
  const lastSeen = row.last_heartbeat_at as Date | null;
  return {
    id: row.id as string,
    taskId: row.task_id as string,
    projectId: row.project_id as string,
    hostId: row.host_id as string,
    mappingId: row.mapping_id as string,
    profileId: row.profile_id as string,
    model: (row.model as string | null) ?? null,
    instructions: (row.instructions as string | null) ?? '',
    state: row.state as RunState,
    stage: row.stage as ExecutionStage,
    version: row.version as number,
    workspaceId: (row.workspace_id as string | null) ?? null,
    lastObservedAt: row.last_observed_at ? (row.last_observed_at as Date).toISOString() : null,
    headCommit: (row.head_commit as string | null) ?? null,
    dirty: (row.dirty as boolean|null) ?? null,
    progress: (row.progress as Run['progress']) ?? null,
    retryOfRunId: (row.retry_of_run_id as string | null) ?? null,
    errorCode: (row.error_code as string | null) ?? null,
    createdAt: (row.created_at as Date).toISOString(),
    updatedAt: (row.updated_at as Date).toISOString(),
    hostName: row.host_name as string,
    hostReachability: hostReachability(lastSeen),
    hostLastSeenAt: lastSeen ? lastSeen.toISOString() : null,
  };
}

const RUN_SELECT = `SELECT r.*, h.name AS host_name, h.last_heartbeat_at
  FROM collab_runs r
  JOIN collab_hosts h ON h.id = r.host_id`;

export type StartRunResult =
  | { run: Run; sessionId: string; created: boolean }
  | { run: Pick<Run, 'id' | 'taskId' | 'state' | 'stage' | 'version' | 'createdAt' | 'updatedAt'>; created: boolean };

/**
 * Explicit Start. Idempotent per (principal, task, Idempotency-Key) with a
 * canonical request hash: same key+body replays the same run, same key with a
 * different body conflicts. Resolves and freezes mapping/profile against the
 * current project+host allowlist; stores the launch command durably in the
 * same transaction. Ready moves never reach this path.
 */
export async function startCollabRun(input: {
  actor: { principalId: string; sessionVersion: number };
  taskId: string;
  expectedVersion: number;
  idempotencyKey: string;
  mappingId?: string;
  profileId?: string;
  model?: string | null;
  instructions?: string;
  retryOfRunId?: string;
}): Promise<StartRunResult> {
  const input2 = startRunSchema.parse(input);
  const principal = await requireCurrentPrincipal(input2.actor);
  const projectId = await projectIdForTask(input2.taskId);
  await authorize(input2.actor, { projectId }, ['run.start']);

  const canonical = {
    expectedVersion: input2.expectedVersion,
    mappingId: input2.mappingId ?? null,
    profileId: input2.profileId ?? null,
    model: input2.model ?? null,
    instructions: input2.instructions ?? '',
    retryOfRunId: input2.retryOfRunId ?? null,
  };
  const hash = requestHash(canonical);

  const result = await withClientTransaction(async (tx) => {
    await tx.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`run-start:${input2.taskId}`]);

    const existing = await tx.query(
      `SELECT request_hash, resource_id FROM collab_idempotency_records
       WHERE principal_id = $1 AND scope_key = $2 AND idempotency_key = $3`,
      [principal.id, `run:${input2.taskId}`, input2.idempotencyKey],
    );
    if (existing.rows.length > 0) {
      if (existing.rows[0].request_hash !== hash) {
        throw new CollabServiceError(
          409,
          'idempotency_conflict',
          'This request identity was already used with a different payload.',
        );
      }
      const run = await tx.query(`${RUN_SELECT} WHERE r.id = $1`, [existing.rows[0].resource_id]);
      const session = await tx.query<{ id: string }>(
        `SELECT id FROM collab_sessions WHERE run_id = $1 AND role = 'work' ORDER BY created_at LIMIT 1`,
        [existing.rows[0].resource_id],
      );
      return { run: rowToRun(run.rows[0]), sessionId: session.rows[0].id, created: false };
    }

    // Stale operator confirmation → 409 (replays above use the ORIGINAL
    // request identity and are unaffected by later task edits).
    const taskNow = await tx.query(
      `SELECT version FROM collab_tasks WHERE id = $1 FOR UPDATE`,
      [input2.taskId],
    );
    if (taskNow.rows.length === 0 || taskNow.rows[0].version !== input2.expectedVersion) {
      throw new CollabServiceError(
        409,
        'version_conflict',
        'This item changed. Refresh before saving.',
        { currentVersion: taskNow.rows[0]?.version },
      );
    }

    const project = await tx.query<{ execution_defaults: Record<string, unknown> | null }>('SELECT execution_defaults FROM collab_projects WHERE id=$1', [projectId]);
    const defaults = project.rows[0]?.execution_defaults ?? {};
    const instructions = input2.instructions ?? (typeof defaults.instructions === 'string' ? defaults.instructions : '');
    const model = input2.model !== undefined ? input2.model : typeof defaults.model === 'string' ? defaults.model : null;

    // Resolve mapping: explicit → project default → the project's single
    // active mapping (multiple mappings without a default is ambiguous).
    const mappingRows = input2.mappingId
      ? await tx.query(
          `SELECT m.id, m.host_id, m.repository_key, m.base_ref, m.profile_ids, m.default_profile_id,
                  h.revoked_at AS host_revoked_at
           FROM collab_project_host_mappings m
           JOIN collab_hosts h ON h.id = m.host_id
           WHERE m.id = $1 AND m.project_id = $2`,
          [input2.mappingId, projectId],
        )
      : await tx.query(
          `SELECT m.id, m.host_id, m.repository_key, m.base_ref, m.profile_ids, m.default_profile_id,
                  h.revoked_at AS host_revoked_at
           FROM collab_projects p
           JOIN collab_project_host_mappings m ON m.id = (p.execution_defaults->>'mappingId')::uuid AND m.project_id=p.id
           JOIN collab_hosts h ON h.id = m.host_id
           WHERE p.id = $1`,
          [projectId],
        );
    if (mappingRows.rows.length === 0 && !input2.mappingId) {
      const candidates = await tx.query(
        `SELECT m.id, m.host_id, m.repository_key, m.base_ref, m.profile_ids, m.default_profile_id,
                h.revoked_at AS host_revoked_at
         FROM collab_project_host_mappings m
         JOIN collab_hosts h ON h.id = m.host_id
         WHERE m.project_id = $1`,
        [projectId],
      );
      const usable = candidates.rows.filter((r) => r.host_revoked_at === null);
      if (usable.length === 1) {
        mappingRows.rows.push(usable[0]);
      } else if (usable.length > 1) {
        throw new CollabServiceError(
          422,
          'select_mapping',
          'Choose which execution mapping to use for this project.',
        );
      }
    }
    if (mappingRows.rows.length === 0 || mappingRows.rows[0].host_revoked_at !== null) {
      throw new CollabServiceError(
        503,
        'execution_not_configured',
        'Execution is not configured for this project.',
      );
    }
    const mapping = mappingRows.rows[0];
    const profileId = input2.profileId ?? (typeof defaults.profileId === 'string' ? defaults.profileId : mapping.default_profile_id);
    if (!profileId || !mapping.profile_ids.includes(profileId)) {
      throw new CollabServiceError(422, 'invalid_profile', 'The selected profile is not allowlisted for this project.');
    }
    const catalog = await tx.query<{ catalog: unknown }>(
      `SELECT catalog FROM collab_hosts WHERE id = $1`,
      [mapping.host_id],
    );
    const hostCatalog = (catalog.rows[0]?.catalog ?? {}) as {
      profiles?: Array<{ id: string; name?: string; provider?: string; model?: string | null }>;
    };
    const profileSnapshot: { id: string; model?: string | null } =
      (hostCatalog.profiles ?? []).find((p) => p.id === profileId) ?? { id: profileId, model: null };
    // Model enforcement at Start (contract): a profile that pins a model only
    // accepts that exact model — never queue an override C must reject later.
    if (model && profileSnapshot.model && model !== profileSnapshot.model) {
      throw new CollabServiceError(
        422,
        'model_not_allowed',
        'The selected model is not allowed for this profile.',
      );
    }

    // Retry only from a known-terminal predecessor.
    if (input2.retryOfRunId) {
      const prior = await tx.query(
        `SELECT state FROM collab_runs WHERE id = $1 AND task_id = $2`,
        [input2.retryOfRunId, input2.taskId],
      );
      if (prior.rows.length === 0 || !['failed', 'cancelled', 'idle'].includes(prior.rows[0].state)) {
        throw new CollabServiceError(
          409,
          'retry_not_terminal',
          'The previous execution has not reached a known terminal state.',
        );
      }
    }

    const active = await tx.query(
      `SELECT 1 FROM collab_runs WHERE task_id = $1 AND state = ANY($2)`,
      [input2.taskId, ACTIVE_RUN_STATES],
    );
    if (active.rows.length > 0) {
      throw new CollabServiceError(
        409,
        'active_run_exists',
        'This task already has an active execution run.',
      );
    }

    // Canonical task-context prompt, FROZEN at start: task identity/content +
    // acceptance criteria + operator instructions clearly separated. Task text
    // is untrusted work content — it never routes cwd/host/credentials. The
    // command row persists this snapshot; later task edits do not mutate it.
    const taskSnapshot = await tx.query(
      `SELECT id, title, description FROM collab_tasks WHERE id = $1`,
      [input2.taskId],
    );
    const task = taskSnapshot.rows[0];
    const criteria = await tx.query(
      `SELECT text, state FROM collab_criteria WHERE task_id = $1 ORDER BY created_at`,
      [input2.taskId],
    );
    const header = `[fluent-flow task ${task.id}] ${task.title}`;
    const operatorSection = [
      '',
      '--- operator instructions (trusted, from the requesting operator) ---',
      instructions === '' ? '(none)' : instructions,
    ].join('\n');
    const criteriaSection =
      criteria.rows.length > 0
        ? ['--- acceptance criteria ---', ...criteria.rows.map((c) => `- [${c.state}] ${c.text}`)].join('\n')
        : '';
    const fixedOverhead = header.length + operatorSection.length + criteriaSection.length + 64;
    const descriptionBudget = Math.max(40_000 - fixedOverhead, 0);
    const promptTruncated = (task.description?.length ?? 0) > descriptionBudget;
    const descriptionText = promptTruncated ? task.description.slice(0, descriptionBudget) : task.description ?? '';
    const prompt = [
      header,
      descriptionText ? '' : null,
      descriptionText || null,
      promptTruncated ? '[task description truncated — see task detail for the full text]' : null,
      criteriaSection ? criteriaSection : null,
      operatorSection,
    ]
      .filter((part) => part !== null)
      .join('\n');

    const insertedRun = await tx.query(
      `INSERT INTO collab_runs
         (task_id, project_id, host_id, mapping_id, profile_id, model, instructions, retry_of_run_id, created_by_principal_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING id`,
      [
        input2.taskId,
        projectId,
        mapping.host_id,
        mapping.id,
        profileId,
        model,
        instructions,
        input2.retryOfRunId ?? null,
        principal.id,
      ],
    );
    const runId = insertedRun.rows[0].id;

    // Primary work session: created queued; launch binds workspace+agent via
    // session_bound observation before any prompt is delivered.
    const session = await tx.query<{ id: string }>(
      `INSERT INTO collab_sessions (run_id, title) VALUES ($1, 'Work session') RETURNING id`,
      [runId],
    );
    const sessionId = session.rows[0].id;
    await ensureReportingBinding(tx, {
      projectId,
      runId,
      sessionId,
      principalId: principal.id,
    });

    const branchName = `ff/run-${runId}`;
    await tx.query(
      `INSERT INTO collab_connector_commands (host_id, run_id, session_id, kind, payload, created_by_principal_id)
       VALUES ($1, $2, $3, 'launch', $4, $5)`,
      [
        mapping.host_id,
        runId,
        sessionId,
        JSON.stringify({
          repositoryKey: mapping.repository_key,
          profileId,
          profileSnapshot,
          model,
          instructions,
          prompt,
          promptTruncated,
          workspace: { mode: 'worktree', branchName, baseRef: mapping.base_ref },
          labels: { 'fluent-flow.run': runId, 'fluent-flow.session': sessionId },
        }),
        principal.id,
      ],
    );

    await tx.query(
      `INSERT INTO collab_idempotency_records (principal_id, scope_key, idempotency_key, request_hash, resource_id)
       VALUES ($1, $2, $3, $4, $5)`,
      [principal.id, `run:${input2.taskId}`, input2.idempotencyKey, hash, runId],
    );

    const run = await tx.query(`${RUN_SELECT} WHERE r.id = $1`, [runId]);
    return { run: rowToRun(run.rows[0]), sessionId, created: true };
  });
  if ((await getProjectCapabilities(principal.id, projectId)).has('internal.read')) return result;
  const { id, taskId, state, stage, version, createdAt, updatedAt } = result.run;
  return { run: { id, taskId, state, stage, version, createdAt, updatedAt }, created: result.created };
}

async function projectIdForTask(taskId: string): Promise<string> {
  const { rows } = await getPool().query(
    `SELECT project_id FROM collab_tasks WHERE id = $1`,
    [taskId],
  );
  if (rows.length === 0) {
    throw new CollabServiceError(404, 'not_found', 'Not found.');
  }
  return rows[0].project_id;
}

function authorizeRunRead(
  actor: { principalId: string; sessionVersion: number },
  projectId: string,
): Promise<void> {
  return authorize(actor, { projectId }, ['task.read']);
}

/** Client-safe execution badge: no instructions, mapping, profile or session IDs. */
export type RunBadge = {
  id: string;
  taskId: string;
  state: RunState;
  stage: ExecutionStage;
  hostName: string;
  hostReachability: 'online' | 'stale' | 'offline';
  hostLastSeenAt: string | null;
  lastObservedAt: string | null;
};

function runBadge(row: Record<string, unknown>): RunBadge {
  const full = rowToRun(row);
  return {
    id: full.id,
    taskId: full.taskId,
    state: full.state,
    stage: full.stage,
    hostName: full.hostName,
    hostReachability: full.hostReachability,
    hostLastSeenAt: full.hostLastSeenAt,
    lastObservedAt: full.lastObservedAt,
  };
}

export async function getCollabRun(
  actor: { principalId: string; sessionVersion: number },
  runId: string,
): Promise<{ run: Run | RunBadge; sessions: CollabSession[];unresolvedCommands:Array<{id:string;kind:string;state:string;errorCode:string|null;createdAt:string;safeActions:Array<'redeliver'|'cancel'>}> }> {
  if (!z.string().uuid().safeParse(runId).success) {
    throw new CollabServiceError(404, 'not_found', 'Not found.');
  }
  const { rows } = await getPool().query(`${RUN_SELECT} WHERE r.id = $1`, [runId]);
  if (rows.length === 0) {
    throw new CollabServiceError(404, 'not_found', 'Not found.');
  }
  // Raw run/session detail (instructions, mapping, profile, provider IDs) is
  // INTERNAL: internal.read required. task.read gets the badge projection only.
  await authorizeRunRead(actor, rows[0].project_id);
  const capabilities = await getProjectCapabilities(actor.principalId, rows[0].project_id);
  if (!capabilities.has('internal.read')) {
    return { run: runBadge(rows[0]), sessions: [],unresolvedCommands:[] };
  }
  const sessions = await getPool().query(
    `SELECT * FROM collab_sessions WHERE run_id = $1 ORDER BY created_at`,
    [runId],
  );
  const commands=await getPool().query(`SELECT id,kind,state,error_code,created_at FROM collab_connector_commands
    WHERE run_id=$1 AND state IN ('pending','claimed','accepted','ambiguous','failed') ORDER BY created_at DESC,id DESC LIMIT 100`,[runId]);
  return {
    run: rowToRun(rows[0]),
    unresolvedCommands:commands.rows.map(command=>({id:command.id,kind:command.kind,state:command.state,
      errorCode:typeof command.error_code==='string'&&/^[a-z][a-z0-9_]{0,99}$/.test(command.error_code)?command.error_code:command.error_code?'execution_error':null,
      createdAt:new Date(command.created_at).toISOString(),safeActions:command.state==='ambiguous'&&capabilities.has('run.steer')?['redeliver','cancel']:[]})),
    sessions: sessions.rows.map((s) => ({
      id: s.id,
      runId: s.run_id,
      role: s.role,
      title: s.title,
      state: s.state,
      paseoAgentId: s.paseo_agent_id,
      providerSessionId: s.provider_session_id,
      lastObservedAt: s.last_observed_at ? new Date(s.last_observed_at).toISOString() : null,
    })),
  };
}

export async function listCollabRuns(input: {
  actor: { principalId: string; sessionVersion: number };
  taskId: string;
  cursor?: string;
  limit?: number;
}): Promise<{ runs: Array<Run | RunBadge>; nextCursor: string | null }> {
  const limit = Math.min(Math.max(input.limit ?? 50, 1), 100);
  const task = await getPool().query(`SELECT project_id FROM collab_tasks WHERE id = $1`, [input.taskId]);
  if (task.rows.length === 0) {
    throw new CollabServiceError(404, 'not_found', 'Not found.');
  }
  await authorizeRunRead(input.actor, task.rows[0].project_id);
  const capabilities = await getProjectCapabilities(input.actor.principalId, task.rows[0].project_id);
  const { rows } = await getPool().query(
    `${RUN_SELECT} WHERE r.task_id = $1 ORDER BY r.created_at DESC, r.id LIMIT $2`,
    [input.taskId, limit + 1],
  );
  const page = rows.slice(0, limit);
  const nextCursor = rows.length > limit && page.length > 0 ? page[page.length - 1].id : null;
  if (!capabilities.has('internal.read')) {
    return { runs: page.map((row) => runBadge(row)), nextCursor };
  }
  return { runs: page.map(rowToRun), nextCursor };
}

/** Execution-stage edit (run.steer): never touches the business task status. */
export async function updateRunStage(input: {
  actor: { principalId: string; sessionVersion: number };
  runId: string;
  expectedVersion: number;
  stage: ExecutionStage;
}): Promise<Run> {
  if (!z.string().uuid().safeParse(input.runId).success) {
    throw new CollabServiceError(404, 'not_found', 'Not found.');
  }
  const { rows } = await getPool().query(`SELECT project_id FROM collab_runs WHERE id = $1`, [input.runId]);
  if (rows.length === 0) {
    throw new CollabServiceError(404, 'not_found', 'Not found.');
  }
  await authorize(input.actor, { projectId: rows[0].project_id }, ['run.steer']);
  const updated = await getPool().query(
    `UPDATE collab_runs SET stage = $1, version = version + 1, updated_at = now()
     WHERE id = $2 AND version = $3
     RETURNING id`,
    [input.stage, input.runId, input.expectedVersion],
  );
  if (updated.rowCount === 0) {
    const current = await getPool().query(`SELECT version FROM collab_runs WHERE id = $1`, [input.runId]);
    throw new CollabServiceError(409, 'version_conflict', 'This item changed. Refresh before saving.', {
      currentVersion: current.rows[0]?.version,
    });
  }
  const run = await getPool().query(`${RUN_SELECT} WHERE r.id = $1`, [input.runId]);
  return rowToRun(run.rows[0]);
}

export type { CollabTask };

/**
 * Create an additional session inside an active run (contract: multiple
 * sessions per run). Durably queued as a create_session command; the
 * session_bound observation later binds real agent IDs.
 */
export async function createRunSession(input: {
  actor: { principalId: string; sessionVersion: number };
  runId: string;
  idempotencyKey: string;
  title: string;
  profileId?: string;
  model?: string | null;
  instructions: string;
}): Promise<{ session: CollabSession; commandId: string; created: boolean }> {
  if (!z.string().uuid().safeParse(input.runId).success) {
    throw new CollabServiceError(404, 'not_found', 'Not found.');
  }
  const principal = await requireCurrentPrincipal(input.actor);
  const runRows = await getPool().query(`SELECT project_id,task_id FROM collab_runs WHERE id = $1`, [input.runId]);
  if (runRows.rows.length === 0) {
    throw new CollabServiceError(404, 'not_found', 'Not found.');
  }
  await authorize(input.actor, { projectId: runRows.rows[0].project_id }, ['run.start']);

  z.object({title:z.string().trim().min(1).max(300),instructions:z.string().max(20000),profileId:z.string().min(1).max(200).optional(),model:z.string().max(200).nullable().optional()}).parse(input);
  const hash = requestHash({
    title: input.title,
    profileId: input.profileId ?? null,
    model: input.model ?? null,
    instructions: input.instructions,
  });

  return withClientTransaction(async (tx: PoolClient) => {
    await tx.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`run-start:${runRows.rows[0].task_id}`]);
    await tx.query('SELECT id FROM collab_tasks WHERE id=$1 FOR UPDATE',[runRows.rows[0].task_id]);
    await tx.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`run-cmds:${input.runId}`]);
    const existing = await tx.query(
      `SELECT request_hash, resource_id FROM collab_idempotency_records
       WHERE principal_id = $1 AND scope_key = $2 AND idempotency_key = $3`,
      [principal.id, `session:${input.runId}`, input.idempotencyKey],
    );
    if (existing.rows.length > 0) {
      if (existing.rows[0].request_hash !== hash) {
        throw new CollabServiceError(
          409,
          'idempotency_conflict',
          'This request identity was already used with a different payload.',
        );
      }
      const session = await tx.query(`SELECT * FROM collab_sessions WHERE id = $1`, [existing.rows[0].resource_id]);
      const command = await tx.query<{ id: string }>(
        `SELECT id FROM collab_connector_commands WHERE session_id = $1 ORDER BY created_at LIMIT 1`,
        [existing.rows[0].resource_id],
      );
      return { session: rowToSession(session.rows[0]), commandId: command.rows[0].id, created: false };
    }

    const run = await tx.query(`SELECT * FROM collab_runs WHERE id = $1 FOR UPDATE`, [input.runId]);
    if (run.rows.length === 0) {
      throw new CollabServiceError(404, 'not_found', 'Not found.');
    }
    await reserveRunContinuation(tx,run.rows[0]);
    const frozen=await sessionLaunchPayload(tx,run.rows[0],input);
    const session = await tx.query(
      `INSERT INTO collab_sessions (run_id, title) VALUES ($1, $2) RETURNING *`,
      [input.runId, input.title],
    );
    await ensureReportingBinding(tx, {
      projectId: runRows.rows[0].project_id,
      runId: input.runId,
      sessionId: session.rows[0].id,
      principalId: principal.id,
    });
    frozen.labels={...(frozen.labels as Record<string,string>),'fluent-flow.session':session.rows[0].id};
    const command = await tx.query<{ id: string }>(
      `INSERT INTO collab_connector_commands (host_id, run_id, session_id, kind, payload, created_by_principal_id)
       VALUES ($1, $2, $3, 'create_session', $4, $5) RETURNING id`,
      [
        run.rows[0].host_id,
        input.runId,
        session.rows[0].id,
        JSON.stringify(frozen),
        principal.id,
      ],
      /* session binding ensured above */
    );
    await tx.query(
      `INSERT INTO collab_idempotency_records (principal_id, scope_key, idempotency_key, request_hash, resource_id)
       VALUES ($1, $2, $3, $4, $5)`,
      [principal.id, `session:${input.runId}`, input.idempotencyKey, hash, session.rows[0].id],
    );
    return { session: rowToSession(session.rows[0]), commandId: command.rows[0].id, created: true };
  });
}

function rowToSession(row: Record<string, unknown>): CollabSession {
  return {
    id: row.id as string,
    runId: row.run_id as string,
    role: row.role as 'work' | 'summary',
    title: row.title as string,
    state: row.state as RunState,
    paseoAgentId: (row.paseo_agent_id as string | null) ?? null,
    providerSessionId: (row.provider_session_id as string | null) ?? null,
    lastObservedAt: row.last_observed_at ? new Date(row.last_observed_at as Date).toISOString() : null,
  };
}

const sessionCommandSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('prompt'), text: z.string().min(1).max(20000), behavior: z.enum(['steer', 'interrupt']) }),
  z.object({
    kind: z.literal('permission'),
    requestId: z.string().min(1).max(200),
    response: z.object({
      behavior: z.enum(['allow', 'deny']),
      selectedActionId: z.string().max(200).optional(),
      answers: z.record(z.string()).optional(),
    }),
  }),
  z.object({ kind: z.literal('cancel') }),
]);

/**
 * Steer/answer/cancel inside a session. Requires internal.read plus the
 * matching execution capability; payload shapes are the contract's — the
 * connector adapts them to the provider.
 */
export async function submitSessionCommand(input: {
  actor: { principalId: string; sessionVersion: number };
  sessionId: string;
  idempotencyKey: string;
  command: { kind: 'prompt'; text: string; behavior: 'steer' | 'interrupt' } | {
    kind: 'permission';
    requestId: string;
    response: { behavior: 'allow' | 'deny'; selectedActionId?: string; answers?: Record<string, string> };
  } | { kind: 'cancel' };
},existingTx?:PoolClient): Promise<{ commandId: string; created: boolean }> {
  if (!z.string().uuid().safeParse(input.sessionId).success) {
    throw new CollabServiceError(404, 'not_found', 'Not found.');
  }
  const command = sessionCommandSchema.parse(input.command);
  const principal = await requireCurrentPrincipal(input.actor);
  const sessionRows = await getPool().query(
    `SELECT s.run_id, r.project_id,r.task_id FROM collab_sessions s JOIN collab_runs r ON r.id = s.run_id WHERE s.id = $1`,
    [input.sessionId],
  );
  if (sessionRows.rows.length === 0) {
    throw new CollabServiceError(404, 'not_found', 'Not found.');
  }
  const capabilities: Array<'internal.read' | 'run.steer' | 'run.cancel'> =
    command.kind === 'cancel' ? ['internal.read', 'run.cancel'] : ['internal.read', 'run.steer'];
  await authorize(input.actor, { projectId: sessionRows.rows[0].project_id }, capabilities);

  const hash = requestHash(command);
  const queue=async(tx:PoolClient)=>{
    await tx.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`run-start:${sessionRows.rows[0].task_id}`]);
    await tx.query('SELECT id FROM collab_tasks WHERE id=$1 FOR UPDATE',[sessionRows.rows[0].task_id]);
    await tx.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`run-cmds:${sessionRows.rows[0].run_id}`]);
    const existing = await tx.query(
      `SELECT request_hash, resource_id FROM collab_idempotency_records
       WHERE principal_id = $1 AND scope_key = $2 AND idempotency_key = $3`,
      [principal.id, `command:${input.sessionId}`, input.idempotencyKey],
    );
    if (existing.rows.length > 0) {
      if (existing.rows[0].request_hash !== hash) {
        throw new CollabServiceError(
          409,
          'idempotency_conflict',
          'This request identity was already used with a different payload.',
        );
      }
      return { commandId: existing.rows[0].resource_id, created: false };
    }
    const run = await tx.query(`SELECT * FROM collab_runs WHERE id = $1 FOR UPDATE`, [
      sessionRows.rows[0].run_id,
    ]);
    if(command.kind==='prompt') {
      await reserveRunContinuation(tx,run.rows[0],true);
      const session=await tx.query('SELECT state FROM collab_sessions WHERE id=$1 AND run_id=$2 FOR UPDATE',[input.sessionId,run.rows[0].id]);
      if(!session.rows.length||['failed','reconciling','cancel_requested'].includes(session.rows[0].state)) throw new CollabServiceError(409,'session_not_active','This session is not available for a follow-up.');
      await tx.query("UPDATE collab_sessions SET state='queued',updated_at=now() WHERE id=$1 AND state IN ('idle','cancelled')",[input.sessionId]);
    }
    else if(!['queued','launching','running','needs_input','idle','cancel_requested'].includes(run.rows[0].state)) throw new CollabServiceError(409,'run_not_active','This run is no longer active.');
    const inserted = await tx.query<{ id: string }>(
      `INSERT INTO collab_connector_commands (host_id, run_id, session_id, kind, payload, created_by_principal_id, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, clock_timestamp()) RETURNING id`,
      [
        run.rows[0].host_id,
        sessionRows.rows[0].run_id,
        input.sessionId,
        command.kind,
        JSON.stringify(command),
        principal.id,
      ],
    );
    await tx.query(
      `INSERT INTO collab_idempotency_records (principal_id, scope_key, idempotency_key, request_hash, resource_id)
       VALUES ($1, $2, $3, $4, $5)`,
      [principal.id, `command:${input.sessionId}`, input.idempotencyKey, hash, inserted.rows[0].id],
    );
    return { commandId: inserted.rows[0].id, created: true };
  };
  return existingTx?queue(existingTx):withClientTransaction(queue);
}

export async function getConnectorCommand(
  actor: { principalId: string; sessionVersion: number },
  commandId: string,
): Promise<Record<string, unknown>> {
  if (!z.string().uuid().safeParse(commandId).success) {
    throw new CollabServiceError(404, 'not_found', 'Not found.');
  }
  const { rows } = await getPool().query(
    `SELECT c.*, r.project_id, r.created_by_principal_id AS run_owner
     FROM collab_connector_commands c JOIN collab_runs r ON r.id = c.run_id
     WHERE c.id = $1`,
    [commandId],
  );
  if (rows.length === 0) {
    throw new CollabServiceError(404, 'not_found', 'Not found.');
  }
  // Historic authorship never bypasses current internal access.
  const { getProjectCapabilities } = await import('./authorize.js');
  const caps = await getProjectCapabilities(actor.principalId, rows[0].project_id);
  if (!(caps.has('run.steer') && caps.has('internal.read'))) {
    throw new CollabServiceError(404, 'not_found', 'Not found.');
  }
  await authorize(actor, { projectId: rows[0].project_id }, ['task.read']);
  return {
    id: rows[0].id,
    runId: rows[0].run_id,
    sessionId: rows[0].session_id,
    kind: rows[0].kind,
    state: rows[0].state,
    result: rows[0].result ?? null,
    errorCode: rows[0].error_code ?? null,
    createdAt: new Date(rows[0].created_at).toISOString(),
  };
}

export type PendingRequest = {
  requestId: string;
  kind: 'permission' | 'question';
  promptText: string;
  choices: Array<{ id: string; label: string }> | null;
  inputSchema: Record<string, unknown> | null;
  expiresAt: string | null;
};

/**
 * Authoritative current request for a session, derived from attention
 * observations (permission_resolved / expiry clears it). B renders from this
 * instead of scraping raw timelines.
 */
export async function getSessionPendingRequest(
  actor: { principalId: string; sessionVersion: number },
  sessionId: string,
): Promise<PendingRequest | null> {
  if (!z.string().uuid().safeParse(sessionId).success) {
    throw new CollabServiceError(404, 'not_found', 'Not found.');
  }
  const { rows } = await getPool().query(
    `SELECT r.project_id FROM collab_sessions s JOIN collab_runs r ON r.id = s.run_id WHERE s.id = $1`,
    [sessionId],
  );
  if (rows.length === 0) {
    throw new CollabServiceError(404, 'not_found', 'Not found.');
  }
  await authorize(actor, { projectId: rows[0].project_id }, ['internal.read']);
  const { rows: attention } = await getPool().query(
    `SELECT o.payload,o.observed_at FROM collab_connector_observations o
     WHERE o.session_id=$1 AND o.kind='attention' AND o.payload->>'attention'='permission'
       AND COALESCE(o.payload->>'requestId','')<>''
       AND (o.payload->>'expiresAt' IS NULL OR (o.payload->>'expiresAt')::timestamptz>now())
       AND NOT EXISTS (SELECT 1 FROM collab_connector_observations resolved
         WHERE resolved.session_id=o.session_id AND resolved.kind='attention'
           AND resolved.payload->>'requestId'=o.payload->>'requestId'
           AND (resolved.payload->>'attention'='permission_resolved' OR resolved.payload->>'resolved'='true'))
     ORDER BY o.observed_at DESC,o.created_at DESC LIMIT 1`, [sessionId],
  );
  const payload = attention[0]?.payload as Record<string, unknown> | undefined;
  if (payload) {
    return {
      requestId: String(payload.requestId),
      kind: payload.permissionKind === 'question' ? 'question' : 'permission',
      promptText: typeof payload.promptText === 'string' ? payload.promptText : '',
      choices: Array.isArray(payload.actions) ? payload.actions.map((a) => ({ id:String(a.id ?? ''), label:String(a.label ?? a.id ?? '') })) : null,
      inputSchema: (payload.input as Record<string,unknown> | undefined) ?? null,
      expiresAt: typeof payload.expiresAt === 'string' ? payload.expiresAt : null,
    };
  }
  return null;
}

/**
 * Shared durable command-queue helper (B summaries, wrap-ups, artifact
 * reads). Authorizes internal.read + the mapped execution capability,
 * idempotent per (principal, run, Idempotency-Key), requires an active run,
 * and stores the command durably before delivery.
 */
export async function queueRunCommand(input: {
  actor: { principalId: string; sessionVersion: number };
  runId: string;
  sessionId: string | null;
  idempotencyKey: string;
  kind: 'summarize' | 'wrapup_preflight' | 'wrapup' | 'artifact_read';
  payload: Record<string, unknown>;
  capability?: 'run.steer' | 'run.cancel' | 'task.read';
}, existingTx?:PoolClient): Promise<{ commandId: string; created: boolean }> {
  if (!z.string().uuid().safeParse(input.runId).success) {
    throw new CollabServiceError(404, 'not_found', 'Not found.');
  }
  const principal = await requireCurrentPrincipal(input.actor);
  const runRows = await getPool().query(
    `SELECT project_id, host_id, state FROM collab_runs WHERE id = $1`,
    [input.runId],
  );
  if (runRows.rows.length === 0) {
    throw new CollabServiceError(404, 'not_found', 'Not found.');
  }
  const capability = input.capability ?? 'run.steer';
  if (capability === 'task.read') {
    if (input.kind !== 'artifact_read') throw new CollabServiceError(403,'forbidden','You do not have permission to perform this action.');
    await authorize(input.actor,{projectId:runRows.rows[0].project_id},['task.read']);
    await requireArtifactCommandAccess(input.actor,input.runId,input.payload,existingTx);
  } else await authorize(input.actor, { projectId: runRows.rows[0].project_id }, ['internal.read', capability]);
  const hash = requestHash({ kind: input.kind, payload: input.payload });

  const queue = async (tx:PoolClient) => {
    await tx.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`run-cmds:${input.runId}`]);
    const existing = await tx.query(
      `SELECT request_hash, resource_id FROM collab_idempotency_records
       WHERE principal_id = $1 AND scope_key = $2 AND idempotency_key = $3`,
      [principal.id, `command:${input.runId}`, input.idempotencyKey],
    );
    if (existing.rows.length > 0) {
      if (existing.rows[0].request_hash !== hash) {
        throw new CollabServiceError(
          409,
          'idempotency_conflict',
          'This request identity was already used with a different payload.',
        );
      }
      return { commandId: existing.rows[0].resource_id, created: false };
    }
    if (input.sessionId !== null) {
      const session=await tx.query('SELECT id FROM collab_sessions WHERE id=$1 AND run_id=$2',[input.sessionId,input.runId]);
      if(!session.rows.length) throw new CollabServiceError(404,'not_found','Not found.');
    }
    if(input.kind==='wrapup') {
      const payload=z.object({preflightId:z.string().uuid(),mode:z.enum(['archive_sessions','archive_owned_workspace'])}).parse(input.payload);
      const preflight=await tx.query(`SELECT id FROM collab_connector_commands WHERE id=$1 AND run_id=$2 AND kind='wrapup_preflight' AND state='applied' AND acked_at>now()-interval '60 seconds'`,[payload.preflightId,input.runId]);
      if(!preflight.rows.length) throw new CollabServiceError(409,'preflight_required','Run a fresh wrap-up preflight first.');
    }
    const inserted = await tx.query<{ id: string }>(
      `INSERT INTO collab_connector_commands (host_id, run_id, session_id, kind, payload, created_by_principal_id)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [
        runRows.rows[0].host_id,
        input.runId,
        input.sessionId,
        input.kind,
        JSON.stringify(input.payload),
        principal.id,
      ],
    );
    await tx.query(
      `INSERT INTO collab_idempotency_records (principal_id, scope_key, idempotency_key, request_hash, resource_id)
       VALUES ($1, $2, $3, $4, $5)`,
      [principal.id, `command:${input.runId}`, input.idempotencyKey, hash, inserted.rows[0].id],
    );
    return { commandId: inserted.rows[0].id, created: true };
  };
  return existingTx ? queue(existingTx) : withClientTransaction(queue);
}

const timelineSchema = z.object({
  actor: z.object({ principalId: z.string().uuid(), sessionVersion: z.number().int().min(1) }),
  sessionId: z.string().uuid(),
  cursor: z.string().max(256).optional(),
  limit: z.number().int().min(1).max(200).default(100),
});

/** Normalized persisted timeline (internal.read; bounded keyset pagination). */
export async function getSessionTimeline(input: {
  actor: { principalId: string; sessionVersion: number };
  sessionId: string;
  cursor?: string;
  limit?: number;
}): Promise<{
  entries: Array<{
    eventId: string;
    kind: string;
    payload: Record<string, unknown>;
    observedAt: string;
    providerCursor: { epoch: string; seq: string } | null;
  }>;
  nextCursor: string | null;
  cursor: string | null;
}> {
  const input2 = timelineSchema.parse(input);
  await authorize(input2.actor, { projectId: await projectOfSession(input2.sessionId) }, ['internal.read']);
  let after:{t:string;i:string}|null=null;
  if(input2.cursor) {
    try { after=z.object({t:z.string().datetime(),i:z.string().uuid()}).parse(JSON.parse(Buffer.from(input2.cursor,'base64url').toString('utf8'))); }
    catch { throw new CollabServiceError(400,'invalid_cursor','The timeline cursor is invalid. Refresh and try again.'); }
  }
  const params:unknown[]=[input2.sessionId];
  let cursorClause='';
  if(after) {
    params.push(after.t,after.i);
    cursorClause=`AND (created_at,id)>($2::timestamptz,$3::uuid)`;
  }
  params.push(input2.limit + 1);
  const limitIdx = params.length;
  const { rows } = await getPool().query(
    `SELECT id,event_id,kind,payload,observed_at,provider_epoch,provider_seq,
       to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_at
     FROM collab_connector_observations
     WHERE session_id = $1 AND kind IN ('timeline','attention') ${cursorClause}
     ORDER BY created_at, id
     LIMIT $${limitIdx}`,
    params,
  );
  const page = rows.slice(0, input2.limit);
  const last = page[page.length - 1];
  return {
    entries: page.map((r) => ({
      eventId: r.event_id,
      kind: r.kind,
      payload: r.payload,
      observedAt: new Date(r.observed_at).toISOString(),
      providerCursor:
        r.provider_epoch !== null && r.provider_seq !== null
          ? { epoch: r.provider_epoch, seq: r.provider_seq }
          : null,
    })),
    nextCursor:
      rows.length > input2.limit && last
        ? Buffer.from(JSON.stringify({t:last.cursor_at,i:last.id})).toString('base64url')
        : null,
    cursor:last?Buffer.from(JSON.stringify({t:last.cursor_at,i:last.id})).toString('base64url'):input2.cursor??null,
  };
}

async function projectOfSession(sessionId: string): Promise<string> {
  const { rows } = await getPool().query(
    `SELECT r.project_id FROM collab_sessions s JOIN collab_runs r ON r.id = s.run_id WHERE s.id = $1`,
    [sessionId],
  );
  if (rows.length === 0) {
    throw new CollabServiceError(404, 'not_found', 'Not found.');
  }
  return rows[0].project_id;
}


async function requireArtifactCommandAccess(actor:{principalId:string;sessionVersion:number},runId:string,payload:Record<string,unknown>,tx?:PoolClient) {
  const parsed=z.object({artifactId:z.string().uuid(),reference:z.string(),maxBytes:z.literal(524288)}).parse(payload);
  const query=tx??getPool();
  const {rows}=await query.query(`SELECT a.id,a.project_id,a.visibility FROM collab_artifacts a
    JOIN collab_runs r ON r.id=a.run_id AND r.task_id=a.task_id AND r.project_id=a.project_id
    JOIN collab_sessions s ON s.id=a.session_id AND s.run_id=r.id
    WHERE a.id=$1 AND a.run_id=$2 AND a.kind='file' AND a.reference=$3
      AND a.provenance IN ('agent','runner') AND a.superseded_by_artifact_id IS NULL`,[parsed.artifactId,runId,parsed.reference]);
  if(!rows.length) throw new CollabServiceError(404,'not_found','Not found.');
  await authorize(actor,{projectId:rows[0].project_id},rows[0].visibility==='internal'?['task.read','internal.read']:['task.read']);
}

export async function queueArtifactRead(input:{actor:{principalId:string;sessionVersion:number};artifactId:string;idempotencyKey:string}) {
  const parsed=z.object({artifactId:z.string().uuid(),idempotencyKey:z.string().min(8).max(256)}).parse(input);
  const {rows}=await getPool().query(`SELECT run_id,session_id,reference FROM collab_artifacts WHERE id=$1 AND kind='file'
    AND provenance IN ('agent','runner') AND session_id IS NOT NULL AND superseded_by_artifact_id IS NULL`,[parsed.artifactId]);
  if(!rows.length||!rows[0].run_id) throw new CollabServiceError(404,'not_found','Not found.');
  const payload={artifactId:parsed.artifactId,reference:rows[0].reference,maxBytes:524288};
  await requireArtifactCommandAccess(input.actor,rows[0].run_id,payload);
  return queueRunCommand({actor:input.actor,runId:rows[0].run_id,sessionId:rows[0].session_id,idempotencyKey:parsed.idempotencyKey,kind:'artifact_read',payload,capability:'task.read'});
}


async function reserveRunContinuation(tx:PoolClient,run:Record<string,any>,allowCancelled=false):Promise<void> {
  if(!['queued','launching','running','needs_input','idle',...(allowCancelled?['cancelled']:[])].includes(run.state)) throw new CollabServiceError(409,'run_not_active','This run is no longer active.');
  const task=await tx.query('SELECT status FROM collab_tasks WHERE id=$1',[run.task_id]);
  if(!task.rows.length||['done','cancelled'].includes(task.rows[0].status)) throw new CollabServiceError(409,'task_closed','Reopen the task before requesting more work.');
  const active=await tx.query('SELECT id FROM collab_runs WHERE task_id=$1 AND id<>$2 AND state=ANY($3)',[run.task_id,run.id,ACTIVE_RUN_STATES]);
  if(active.rows.length) throw new CollabServiceError(409,'active_run_exists','This task already has an active execution run.');
  if(run.state==='idle'||(allowCancelled&&run.state==='cancelled')) await tx.query("UPDATE collab_runs SET state='queued',version=version+1,updated_at=now() WHERE id=$1",[run.id]);
}

async function sessionLaunchPayload(tx:PoolClient,run:Record<string,any>,input:{title:string;profileId?:string;model?:string|null;instructions:string}):Promise<Record<string,unknown>> {
  const mapping=await tx.query(`SELECT m.*,h.catalog,h.revoked_at FROM collab_project_host_mappings m JOIN collab_hosts h ON h.id=m.host_id WHERE m.id=$1 AND m.project_id=$2`,[run.mapping_id,run.project_id]);
  const m=mapping.rows[0];
  const profileId=input.profileId??run.profile_id;
  const profileSnapshot=m?.catalog?.profiles?.find((p:{id:string})=>p.id===profileId);
  if(!m||m.revoked_at||!m.profile_ids.includes(profileId)||!profileSnapshot||!m.catalog.repositories?.some((r:{key:string})=>r.key===m.repository_key)) throw new CollabServiceError(422,'profile_not_allowed','The selected execution profile is not available.');
  const model=input.model??run.model??profileSnapshot.model??null;
  if(model&&profileSnapshot.model&&model!==profileSnapshot.model) throw new CollabServiceError(422,'model_not_allowed','The selected model is not allowed for this profile.');
  const launch=await tx.query("SELECT payload FROM collab_connector_commands WHERE run_id=$1 AND kind='launch' ORDER BY created_at LIMIT 1",[run.id]);
  const initial=launch.rows[0]?.payload;
  const prompt=[initial?.prompt??`Task ${run.task_id}`,`--- additional session: ${input.title} ---`,input.instructions||'(continue the task using the frozen context above)'].join('\n').slice(0,60000);
  return {repositoryKey:m.repository_key,profileId,profileSnapshot,model,title:input.title,instructions:input.instructions,prompt,workspace:initial?.workspace??{mode:'worktree'},labels:{'fluent-flow.run':run.id,'fluent-flow.task':run.task_id}};
}
