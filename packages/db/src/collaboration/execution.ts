import { z } from 'zod';
import type { PoolClient } from 'pg';
import { CollabServiceError } from './errors.js';
import { REPORTING_CAPABILITIES } from './runs.js';

export type ExecutionBackend = 'claude-code' | 'codex' | 'paseo';
export type ReadinessState =
  | 'ready'
  | 'incomplete'
  | 'not_installed'
  | 'incompatible'
  | 'invalid_config'
  | 'sign_in_required'
  | 'platform_unsupported';

const BACKENDS = ['claude-code', 'codex', 'paseo'] as const;

export const READINESS_STATES: readonly ReadinessState[] = Object.freeze([
  'ready',
  'incomplete',
  'not_installed',
  'incompatible',
  'invalid_config',
  'sign_in_required',
  'platform_unsupported',
] as const);

export type CatalogProfileV2 = {
  id: string;
  name: string | null;
  backend: ExecutionBackend;
  model: string | null;
  revision: string;
  capabilities: string[];
  readiness: { state: ReadinessState };
  harness: { name: string; version: string } | null;
  policy: Record<string, unknown> | null;
  authExpectation: 'claude-subscription' | 'chatgpt-subscription' | 'paseo';
  limits: { maxActiveSessions: number } | null;
};

export type ExecutionSnapshotProfile = {
  profileId: string;
  revision: string;
  model: string | null;
  harness: CatalogProfileV2['harness'];
  policy: Record<string, unknown> | null;
  authExpectation: CatalogProfileV2['authExpectation'];
  capabilities: string[];
};

export type RunExecution = {
  runId: string;
  schemaVersion: 2;
  backend: ExecutionBackend;
  hostId: string;
  profileId: string;
  profileRevision: string;
  snapshot: {
    harness: CatalogProfileV2['harness'];
    model: string | null;
    policy: Record<string, unknown> | null;
    authExpectation: CatalogProfileV2['authExpectation'];
    capabilities: string[];
    summary: ExecutionSnapshotProfile | null;
    reporting: { scopes: string[] };
  };
  workspaceRef: string | null;
};

export type CommandExecution = { schemaVersion: 2; backend: ExecutionBackend; profileId: string; profileRevision: string };

const CLAUDE_CODE_CAPABILITIES = [
  'timeline', 'permissions', 'questions', 'local_answers', 'steer', 'cancel',
  'usage', 'summary', 'artifacts', 'wrapup', 'reporting',
] as const;

export const REQUIRED_CAPABILITIES: Record<ExecutionBackend, readonly string[]> = Object.freeze({
  'claude-code': Object.freeze([...CLAUDE_CODE_CAPABILITIES]),
  codex: Object.freeze([...CLAUDE_CODE_CAPABILITIES, 'secret_questions']),
  paseo: Object.freeze(['timeline', 'permissions', 'cancel', 'artifacts', 'wrapup']),
});

const AUTH_EXPECTATION: Record<ExecutionBackend, CatalogProfileV2['authExpectation']> = {
  'claude-code': 'claude-subscription',
  codex: 'chatgpt-subscription',
  paseo: 'paseo',
};

const POLICY_FIELDS: Record<ExecutionBackend, Record<string, 'string' | 'boolean'>> = {
  'claude-code': { permissionMode: 'string' },
  codex: { approvalPolicy: 'string', sandbox: 'string', networkAccess: 'boolean' },
  paseo: { modeId: 'string', thinkingOptionId: 'string' },
};

export function sanitizePolicy(backend: ExecutionBackend, policy: unknown): Record<string, unknown> | null {
  if (policy === null || typeof policy !== 'object' || Array.isArray(policy)) return null;
  const out: Record<string, unknown> = {};
  for (const [key, type] of Object.entries(POLICY_FIELDS[backend])) {
    const value = (policy as Record<string, unknown>)[key];
    if (type === 'string' && typeof value === 'string' && value.length > 0 && value.length <= 200) out[key] = value;
    if (type === 'boolean' && typeof value === 'boolean') out[key] = value;
  }
  return Object.keys(out).length > 0 ? out : null;
}

export const catalogProfileV2Schema = z
  .object({
    id: z.string().min(1).max(200),
    name: z.string().max(200).nullable().default(null),
    backend: z.enum(BACKENDS),
    model: z.string().min(1).max(200).nullable(),
    revision: z.string().min(1).max(200),
    capabilities: z
      .array(z.string().min(1).max(100))
      .max(100)
      .refine((caps) => new Set(caps).size === caps.length, { message: 'duplicate capability' }),
    readiness: z.object({ state: z.enum(READINESS_STATES as [ReadinessState, ...ReadinessState[]]) }),
    harness: z.object({ name: z.string().min(1).max(100), version: z.string().min(1).max(100) }).nullable().default(null),
    policy: z.record(z.unknown()).nullable().default(null),
    authExpectation: z.enum(['claude-subscription', 'chatgpt-subscription', 'paseo']),
    limits: z.object({ maxActiveSessions: z.number().int().min(1) }).nullable().default(null),
  })
  .refine((entry) => entry.authExpectation === AUTH_EXPECTATION[entry.backend], { message: 'auth expectation does not match backend' })
  .transform((entry): CatalogProfileV2 => ({ ...entry, policy: sanitizePolicy(entry.backend, entry.policy) }));

export type CapacityEntry = { limit: number; available: number | null; observedAt: string | null };

export const SLOT_BACKENDS = ['claude-code', 'codex'] as const;

export function slotBackendSql(c = 'c', s = 's'): string {
  return `CASE WHEN ${c}.state = 'pending'
    AND ${c}.payload->'execution'->>'backend' IN ('claude-code', 'codex')
    AND (${c}.kind IN ('launch', 'create_session', 'summarize')
      OR (${c}.kind = 'prompt' AND (${s}.state IS NULL OR ${s}.state NOT IN ('running', 'needs_input'))))
    THEN ${c}.payload->'execution'->>'backend' END`;
}

export const capacityEntrySchema = z.union([
  z.number().int().min(1).transform((limit): CapacityEntry => ({ limit, available: null, observedAt: null })),
  z
    .object({
      limit: z.number().int().min(1),
      available: z.number().int().min(0).nullable(),
      observedAt: z.string().datetime().nullable(),
    })
    .strict()
    .refine((c) => (c.available === null) === (c.observedAt === null), { message: 'availability and its observation time go together' })
    .refine((c) => c.available === null || c.available <= c.limit, { message: 'availability exceeds the limit' }),
]);

export const catalogV2Schema = z
  .object({
    formatVersion: z.literal(2),
    capacity: z.object({ 'claude-code': capacityEntrySchema, codex: capacityEntrySchema }),
    repositories: z.array(z.object({ key: z.string() })).max(500),
    profiles: z.array(catalogProfileV2Schema).max(200),
  })
  .superRefine((catalog, ctx) => {
    const ids = catalog.profiles.map((p) => p.id);
    if (new Set(ids).size !== ids.length) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'duplicate profile id', path: ['profiles'] });
  });

function settingsChanged(): CollabServiceError {
  return new CollabServiceError(422, 'execution_settings_changed', 'Execution settings changed. Ask a project administrator to select an available profile.');
}

export function selectCatalogProfile(catalog: unknown, profileId: string): { format: 'v1' } | { format: 'v2'; entry: CatalogProfileV2 } {
  const record = catalog !== null && typeof catalog === 'object' ? (catalog as Record<string, unknown>) : {};
  if (record.formatVersion === undefined) return { format: 'v1' };
  if (record.formatVersion !== 2 || !Array.isArray(record.profiles)) throw settingsChanged();
  const matches = record.profiles.filter((p) => p !== null && typeof p === 'object' && (p as { id?: unknown }).id === profileId);
  if (matches.length !== 1) throw settingsChanged();
  const parsed = catalogProfileV2Schema.safeParse(matches[0]);
  if (!parsed.success) throw settingsChanged();
  return { format: 'v2', entry: parsed.data };
}

export function assertStartable(entry: CatalogProfileV2): void {
  const state = entry.readiness.state;
  if (state === 'incomplete') {
    throw new CollabServiceError(422, 'profile_incomplete', 'Choose a complete execution profile before starting.');
  }
  if (state === 'sign_in_required') {
    throw new CollabServiceError(422, 'sign_in_required', 'Sign in to the selected tool on the execution host, then try again.');
  }
  if (state !== 'ready') {
    throw new CollabServiceError(422, 'profile_unavailable', 'This execution profile is unavailable. Contact the execution host owner.');
  }
  if (!REQUIRED_CAPABILITIES[entry.backend].every((cap) => entry.capabilities.includes(cap))) throw settingsChanged();
}

export function commandExecution(entry: CatalogProfileV2): CommandExecution {
  return { schemaVersion: 2, backend: entry.backend, profileId: entry.id, profileRevision: entry.revision };
}

function snapshotProfile(entry: CatalogProfileV2): ExecutionSnapshotProfile {
  return {
    profileId: entry.id,
    revision: entry.revision,
    model: entry.model,
    harness: entry.harness,
    policy: entry.policy,
    authExpectation: entry.authExpectation,
    capabilities: [...entry.capabilities],
  };
}

export async function recordRunExecution(
  tx: PoolClient,
  input: { runId: string; hostId: string; entry: CatalogProfileV2; summaryEntry: CatalogProfileV2 | null },
): Promise<void> {
  const parent = await tx.query(`SELECT 1 FROM collab_runs WHERE id = $1 AND host_id = $2 AND profile_id = $3`, [input.runId, input.hostId, input.entry.id]);
  if (parent.rows.length === 0) throw new CollabServiceError(404, 'not_found', 'Not found.');
  if (input.summaryEntry && input.summaryEntry.backend !== input.entry.backend) throw settingsChanged();
  const snapshot: RunExecution['snapshot'] = {
    harness: input.entry.harness,
    model: input.entry.model,
    policy: input.entry.policy,
    authExpectation: input.entry.authExpectation,
    capabilities: [...input.entry.capabilities],
    summary: input.summaryEntry ? snapshotProfile(input.summaryEntry) : null,
    reporting: { scopes: REPORTING_CAPABILITIES.filter((cap) => cap !== 'report.summary') },
  };
  await tx.query(
    `INSERT INTO collab_run_execution (run_id, schema_version, backend, host_id, profile_id, profile_revision, snapshot)
     VALUES ($1, 2, $2, $3, $4, $5, $6)`,
    [input.runId, input.entry.backend, input.hostId, input.entry.id, input.entry.revision, JSON.stringify(snapshot)],
  );
}

export async function recordSessionExecution(
  tx: PoolClient,
  input: { sessionId: string; runId: string; backend: ExecutionBackend },
): Promise<void> {
  const parent = await tx.query<{ backend: ExecutionBackend }>(
    `SELECT e.backend FROM collab_sessions s JOIN collab_run_execution e ON e.run_id = s.run_id WHERE s.id = $1 AND s.run_id = $2`,
    [input.sessionId, input.runId],
  );
  if (parent.rows.length === 0) throw new CollabServiceError(404, 'not_found', 'Not found.');
  if (parent.rows[0].backend !== input.backend) throw settingsChanged();
  // ON CONFLICT DO NOTHING keeps the operation idempotent across retries. The row's
  // (run_id, backend) are covered by the parent SELECT above (session.run_id is immutable
  // and the run's backend is frozen in collab_run_execution), so a prior row for this
  // session_id already carries the same (run_id, backend) — nothing to reconcile.
  await tx.query(
    `INSERT INTO collab_session_execution (session_id, run_id, backend) VALUES ($1, $2, $3)
     ON CONFLICT (session_id) DO NOTHING`,
    [input.sessionId, input.runId, input.backend],
  );
}

export async function getRunExecution(q: Pick<PoolClient, 'query'>, runId: string): Promise<RunExecution | null> {
  const { rows } = await q.query(`SELECT * FROM collab_run_execution WHERE run_id = $1`, [runId]);
  if (rows.length === 0) return null;
  const row = rows[0];
  return {
    runId: row.run_id,
    schemaVersion: 2,
    backend: row.backend,
    hostId: row.host_id,
    profileId: row.profile_id,
    profileRevision: row.profile_revision,
    snapshot: row.snapshot,
    workspaceRef: row.workspace_ref ?? null,
  };
}

export function executionView(execution: RunExecution | null): { backend: ExecutionBackend; profileId: string; model: string | null; harness: { name: string; version: string } | null; policy: Record<string, unknown> | null } | null {
  if (execution === null) return null;
  const harness = execution.snapshot.harness;
  return {
    backend: execution.backend,
    profileId: execution.profileId,
    model: typeof execution.snapshot.model === 'string' ? execution.snapshot.model : null,
    harness: harness && typeof harness.name === 'string' && typeof harness.version === 'string' ? { name: harness.name, version: harness.version } : null,
    policy: sanitizePolicy(execution.backend, execution.snapshot.policy),
  };
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  const left = new Set(a);
  const right = new Set(b);
  return left.size === right.size && [...left].every((cap) => right.has(cap));
}

function checkEntry(execution: RunExecution, target: CommandExecution, catalog: unknown): null | 'execution_settings_changed' {
  let selected: ReturnType<typeof selectCatalogProfile>;
  try {
    selected = selectCatalogProfile(catalog, target.profileId);
  } catch (err) {
    if (err instanceof CollabServiceError && err.code === 'execution_settings_changed') return 'execution_settings_changed';
    throw err;
  }
  if (selected.format !== 'v2') return 'execution_settings_changed';
  const entry = selected.entry;
  if (entry.backend !== execution.backend || target.backend !== execution.backend || entry.revision !== target.profileRevision) {
    return 'execution_settings_changed';
  }
  if (entry.readiness.state !== 'ready') return 'execution_settings_changed';
  const frozen =
    target.profileId === execution.profileId
      ? execution.snapshot.capabilities
      : execution.snapshot.summary?.profileId === target.profileId
        ? execution.snapshot.summary.capabilities
        : null;
  if (frozen !== null) return sameSet(frozen, entry.capabilities) ? null : 'execution_settings_changed';
  return REQUIRED_CAPABILITIES[entry.backend].every((cap) => entry.capabilities.includes(cap)) ? null : 'execution_settings_changed';
}

export function commandExecutionCheck(
  execution: RunExecution | null,
  payloadExecution: CommandExecution | null,
  catalog: unknown,
): null | 'execution_settings_changed' {
  if (execution === null) return null;
  if (payloadExecution === null) {
    const formatVersion = catalog !== null && typeof catalog === 'object' ? (catalog as Record<string, unknown>).formatVersion : undefined;
    return formatVersion === 2 ? null : 'execution_settings_changed';
  }
  return checkEntry(execution, payloadExecution, catalog);
}

export function deliveryExecutionCheck(execution: RunExecution | null, catalog: unknown): null | 'execution_settings_changed' {
  if (execution === null) return null;
  return checkEntry(execution, { schemaVersion: 2, backend: execution.backend, profileId: execution.profileId, profileRevision: execution.profileRevision }, catalog);
}
