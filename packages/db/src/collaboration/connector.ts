import { createHash, randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { z } from 'zod';
import type { PoolClient } from 'pg';
import { getPool } from '../pool.js';
import { withClientTransaction } from './tx.js';
import { CollabServiceError } from './errors.js';
import { getProjectCapabilities,authorize } from './authorize.js';
import { recordWorkpadPlanReport, recordUsageSample, recordCollabSummaryReport } from './evidence.js';
import { catalogV2Schema, commandExecutionCheck, getRunExecution, slotBackendSql, SLOT_BACKENDS, type CommandExecution } from './execution.js';

function commandCapability(kind: string): 'run.start' | 'run.steer' | 'run.cancel' | 'task.read' {
  if (kind === 'artifact_read') return 'task.read';
  if (kind === 'cancel') return 'run.cancel';
  if (kind === 'launch' || kind === 'create_session') return 'run.start';
  return 'run.steer';
}

async function commandWithdrawnReason(
  client: PoolClient,
  command: { kind: string; created_by_principal_id: string | null; run_id: string; session_id: string | null; payload?:Record<string,unknown> },
): Promise<'authorization_withdrawn' | null> {
  const runRows = await client.query(
    `SELECT r.project_id, r.host_id,
            m.id AS mapping_id,
            h.revoked_at AS host_revoked_at,m.repository_key,m.profile_ids,h.catalog
     FROM collab_runs r
     LEFT JOIN collab_project_host_mappings m ON m.id = r.mapping_id
     LEFT JOIN collab_hosts h ON h.id = r.host_id
     WHERE r.id = $1`,
    [command.run_id],
  );
  if (runRows.rows.length === 0) return 'authorization_withdrawn';
  const run = runRows.rows[0];
  if (run.mapping_id === null || run.host_revoked_at !== null) return 'authorization_withdrawn';

  if (command.created_by_principal_id !== null) {
    const originator = await client.query(
      `SELECT disabled_at FROM collab_principals WHERE id = $1`,
      [command.created_by_principal_id],
    );
    if (originator.rows.length === 0 || originator.rows[0].disabled_at !== null) {
      return 'authorization_withdrawn';
    }
    const caps = await getProjectCapabilities(command.created_by_principal_id, run.project_id);
    if (!caps.has(commandCapability(command.kind))) {
      return 'authorization_withdrawn';
    }
    if(command.kind==='artifact_read') {
      const artifact=await client.query(`SELECT a.visibility FROM collab_artifacts a
        JOIN collab_runs r ON r.id=a.run_id AND r.task_id=a.task_id AND r.project_id=a.project_id
        JOIN collab_sessions s ON s.id=a.session_id AND s.run_id=r.id
        WHERE a.id::text=$1 AND a.run_id=$2 AND a.reference=$3 AND a.kind='file'
          AND a.session_id=$4 AND a.provenance IN ('agent','runner') AND a.superseded_by_artifact_id IS NULL`,[command.payload?.artifactId,command.run_id,command.payload?.reference,command.session_id]);
      if(!artifact.rows.length || (artifact.rows[0].visibility==='internal'&&!caps.has('internal.read'))) return 'authorization_withdrawn';
    } else if(command.kind!=='launch'&&!caps.has('internal.read')) return 'authorization_withdrawn';
  }
  if(['launch','create_session','summarize'].includes(command.kind)) {
    const profileId=command.payload?.profileId;
    const catalog=run.catalog as {repositories?:Array<{key:string}>;profiles?:Array<{id:string}>}|null;
    if(!run.profile_ids.includes(profileId)||!catalog?.profiles?.some(p=>p.id===profileId)||!catalog.repositories?.some(r=>r.key===run.repository_key)) return 'authorization_withdrawn';
  }
  return null;
}


const HEARTBEAT_ONLINE_MS = 45_000;
const CLAIM_REDELIVER_AFTER_MS = 30_000;
const MAX_EVENTS_PER_BATCH = 100;
const MAX_BATCH_BYTES = 1024 * 1024;

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export type AuthenticatedHost = { id: string; leaseEpoch: number; connectorSessionId: string | null };

export async function authenticateHost(token: string): Promise<AuthenticatedHost> {
  const { rows } = await getPool().query(
    `SELECT id, lease_epoch, connector_session_id FROM collab_hosts
     WHERE token_hash = $1 AND revoked_at IS NULL`,
    [hashToken(token)],
  );
  if (rows.length === 0) {
    throw new CollabServiceError(401, 'unauthenticated', 'Authentication required.');
  }
  return { id: rows[0].id, leaseEpoch: Number(rows[0].lease_epoch), connectorSessionId: rows[0].connector_session_id };
}

type HostTx = { client: PoolClient; host: { id: string; leaseEpoch: number; connectorSessionId: string | null } };

async function withHostFence<T>(token: string, connectorSessionId: string, leaseEpoch: number, fn: (tx: HostTx) => Promise<T>): Promise<T> {
  const host = await authenticateHost(token);
  if (host.connectorSessionId !== connectorSessionId || host.leaseEpoch !== leaseEpoch) {
    throw new CollabServiceError(409, 'stale_lease', 'This connection is no longer active.');
  }
  return withClientTransaction(async (client) => {
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`connector:${host.id}`]);
    const current = await client.query<{ lease_epoch: string; connector_session_id: string | null; revoked_at: Date | null }>(
      `SELECT lease_epoch, connector_session_id, revoked_at FROM collab_hosts WHERE id = $1 FOR UPDATE`,
      [host.id],
    );
    if (
      current.rows.length === 0 ||
      current.rows[0].revoked_at !== null ||
      current.rows[0].connector_session_id !== connectorSessionId ||
      Number(current.rows[0].lease_epoch) !== leaseEpoch
    ) {
      throw new CollabServiceError(409, 'stale_lease', 'This connection is no longer active.');
    }
    return fn({ client, host });
  });
}

const registerSchema = z.object({
  token: z.string().min(8),
  instanceId: z.string().min(1).max(200),
  protocolVersion: z.literal(1),
  sdkVersion: z.string().min(1).max(100),
  daemonVersion: z.string().max(100).optional(),
  capabilities: z.record(z.unknown()).default({}),
  catalog: catalogV2Schema.or(z
    .object({
      formatVersion: z.undefined(),
      repositories: z.array(z.object({ key: z.string() })).max(500),
      profiles: z
        .array(
          z.object({
            id: z.string(),
            name: z.string().nullable().optional(),
            provider: z.string().nullable().optional(),
            model: z.string().nullable().optional(),
            modeId: z.string().nullable().optional(),
            thinkingOptionId: z.string().nullable().optional(),
            features: z.record(z.unknown()).nullable().optional(),
          }),
        )
        .max(200),
    }))
    .default({ repositories: [], profiles: [] }),
});

export type ConnectorRegistration = {
  hostId: string;
  connectorSessionId: string;
  leaseEpoch: number;
  heartbeatIntervalMs: number;
  staleAfterMs: number;
  offlineAfterMs: number;
  serverTime: string;
};

export async function registerConnector(input: {
  token: string;
  instanceId: string;
  protocolVersion: 1;
  sdkVersion: string;
  daemonVersion?: string;
  capabilities?: Record<string, unknown>;
  catalog?: { formatVersion?: 2; capacity?: Record<string, number | { limit: number; available: number | null; observedAt: string | null }>; repositories: Array<{ key: string }>; profiles: Array<Record<string, unknown>> };
}): Promise<ConnectorRegistration> {
  const input2 = registerSchema.parse(input);
  const host = await authenticateHost(input2.token);
  return withClientTransaction(async (client) => {
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`connector:${host.id}`]);
    const current = await client.query<{ lease_epoch: string; connector_session_id: string | null; connector_instance_id: string | null; last_heartbeat_at: Date | null; revoked_at: Date | null }>(
      `SELECT lease_epoch, connector_session_id, connector_instance_id, last_heartbeat_at, revoked_at FROM collab_hosts WHERE id = $1 FOR UPDATE`,
      [host.id],
    );
    if (current.rows.length === 0 || current.rows[0].revoked_at !== null) {
      throw new CollabServiceError(401, 'unauthenticated', 'Authentication required.');
    }
    const row = current.rows[0];
    const lastBeat = row.last_heartbeat_at;
    const sessionLive =
      row.connector_session_id !== null &&
      lastBeat !== null &&
      Date.now() - lastBeat.getTime() < HEARTBEAT_ONLINE_MS;
    if (sessionLive) {
      if (row.connector_instance_id !== input2.instanceId) {
        throw new CollabServiceError(
          409,
          'connector_active',
          'Another connector instance is active for this host.',
        );
      }
      await client.query(
        `UPDATE collab_hosts SET last_heartbeat_at = now(), catalog = CASE WHEN catalog ? 'pollAuthority' THEN $1::jsonb || jsonb_build_object('pollAuthority', catalog->'pollAuthority') ELSE $1::jsonb END, updated_at = now() WHERE id = $2`,
        [JSON.stringify(input2.catalog), host.id],
      );
      return {
        hostId: host.id,
        connectorSessionId: row.connector_session_id as string,
        leaseEpoch: Number(row.lease_epoch),
        heartbeatIntervalMs: 15_000,
        staleAfterMs: 45_000,
        offlineAfterMs: 120_000,
        serverTime: await serverClock(client, host.id),
      };
    }

    const sessionId = randomUUID();
    const nextEpoch = Number(row.lease_epoch) + 1;
    await client.query(
      `UPDATE collab_hosts
       SET connector_session_id = $1, connector_instance_id = $2, lease_epoch = $3,
           last_heartbeat_at = now(), catalog = CASE WHEN catalog ? 'pollAuthority' THEN $4::jsonb || jsonb_build_object('pollAuthority', catalog->'pollAuthority') ELSE $4::jsonb END, updated_at = now()
       WHERE id = $5`,
      [sessionId, input2.instanceId, nextEpoch, JSON.stringify(input2.catalog), host.id],
    );
    return {
      hostId: host.id,
      connectorSessionId: sessionId,
      leaseEpoch: nextEpoch,
      heartbeatIntervalMs: 15_000,
      staleAfterMs: 45_000,
      offlineAfterMs: 120_000,
      serverTime: await serverClock(client, host.id),
    };
  });
}

async function serverClock(client: Pick<PoolClient, 'query'>, hostId: string): Promise<string> {
  const { rows } = await client.query<{ t: Date }>(
    `SELECT GREATEST(clock_timestamp(), (catalog->>'pollAuthority')::timestamptz) AS t FROM collab_hosts WHERE id = $1`,
    [hostId],
  );
  return new Date(rows[0].t).toISOString();
}

export async function heartbeatConnector(input: {
  token: string;
  connectorSessionId: string;
  leaseEpoch: number;
  activeRunIds?: string[];
  observedAt?: string;
}): Promise<{ status: 'ok'; leaseEpoch: number }> {
  await withHostFence(input.token, input.connectorSessionId, input.leaseEpoch, async ({ client, host }) => {
    await client.query(`UPDATE collab_hosts SET last_heartbeat_at = now(), updated_at = now() WHERE id = $1`, [host.id]);
  });
  return { status: 'ok', leaseEpoch: input.leaseEpoch };
}

export type ConnectorCommand = {
  id: string;
  runId: string;
  sessionId: string | null;
  kind: string;
  payload: Record<string, unknown>;
  createdAt: string;
  leaseEpoch: number;
  slotGranted?: true;
  slotHeld?: true;
  nativeBackend?: 'claude-code' | 'codex';
};

export type HeldClaims = { 'claude-code': number; codex: number };

const pollSchema = z.object({
  token: z.string().min(8),
  connectorSessionId: z.string().uuid(),
  leaseEpoch: z.number().int().min(0),
  waitMs: z.number().int().min(0).max(25_000).default(25_000),
  limit: z.number().int().min(1).max(10).default(1),
  availableSlots: z.object({ 'claude-code': z.number().int().min(0).max(64).optional(), codex: z.number().int().min(0).max(64).optional() }).strict().optional(),
  notAfter: z.string().datetime().optional(),
});

const POLL_RECHECK_MS = 500;

function waitUnlessAborted(ms: number, signal: AbortSignal | undefined): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve(false);
    const onAbort = () => {
      clearTimeout(timer);
      resolve(false);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve(true);
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export async function pollConnectorCommands(input: {
  token: string;
  connectorSessionId: string;
  leaseEpoch: number;
  waitMs?: number;
  limit?: number;
  availableSlots?: { 'claude-code'?: number; codex?: number };
  notAfter?: string;
  signal?: AbortSignal;
  beforeClaim?: () => Promise<void>;
}): Promise<{ commands: ConnectorCommand[]; heldClaims?: HeldClaims; serverTime?: string }> {
  const { signal, beforeClaim, ...fields } = input;
  const input2 = pollSchema.parse(fields);
  const deadline = performance.now() + input2.waitMs;
  let first = true;
  for (;;) {
    if (signal?.aborted) return { commands: [] };
    if (beforeClaim) await beforeClaim();
    const claimed = await claimConnectorCommands(input2, first);
    first = false;
    const remainingMs = deadline - performance.now();
    if (claimed.commands.length > 0 || remainingMs <= 0) return claimed;
    if (!(await waitUnlessAborted(Math.min(POLL_RECHECK_MS, remainingMs), signal))) return { commands: [] };
  }
}

async function claimConnectorCommands(input2: z.infer<typeof pollSchema>, validateWaiting: boolean): Promise<{ commands: ConnectorCommand[]; heldClaims: HeldClaims; serverTime: string }> {
  return (await withHostFence(input2.token, input2.connectorSessionId, input2.leaseEpoch, async ({ client, host }) => {
    const serverTime = await serverClock(client, host.id);
    await client.query(
      `UPDATE collab_hosts SET last_heartbeat_at = now(), updated_at = now(),
         catalog = jsonb_set(COALESCE(catalog, '{}'::jsonb), '{pollAuthority}', to_jsonb($2::text)) WHERE id = $1`,
      [host.id, serverTime],
    );
    const deliverable = `(c.state = 'pending'
           OR (c.state = 'claimed' AND c.claimed_at < now() - make_interval(secs => $2))
           OR (c.state = 'accepted' AND c.acked_at < now() - make_interval(secs => 5)))`;
    const expired = input2.notAfter !== undefined && Date.parse(serverTime) > Date.parse(input2.notAfter);
    const slots = expired ? {} : input2.availableSlots ?? {};
    const hostCatalog = (await client.query<{ catalog: unknown }>(`SELECT catalog FROM collab_hosts WHERE id = $1`, [host.id])).rows[0]?.catalog ?? null;
    const invalidated = async (row: Record<string, any>, execution: Awaited<ReturnType<typeof getRunExecution>>): Promise<boolean> => {
      const changed = commandExecutionCheck(execution, (row.payload?.execution as CommandExecution | undefined) ?? null, hostCatalog);
      if (changed !== null) {
        await client.query(
          `UPDATE collab_connector_commands SET state = 'failed', error_code = $1, updated_at = now() WHERE id = $2`,
          [changed, row.id],
        );
        await projectCommandOutcome(client, row, 'failed', changed);
        return true;
      }
      const withdrawn = await commandWithdrawnReason(client, row as Parameters<typeof commandWithdrawnReason>[1]);
      if (withdrawn !== null) {
        await client.query(
          `UPDATE collab_connector_commands
           SET state = 'cancelled', error_code = $1, updated_at = now() WHERE id = $2`,
          [withdrawn, row.id],
        );
        await projectCommandOutcome(client,row,'failed','authorization_withdrawn');
        return true;
      }
      return false;
    };
    if (validateWaiting) {
      const waiting = await client.query(
        `SELECT c.id, c.run_id, c.session_id, c.kind, c.payload, c.created_by_principal_id
         FROM collab_connector_commands c LEFT JOIN collab_sessions s ON s.id = c.session_id
         WHERE c.host_id = $1 AND ${slotBackendSql('c', 's')} IS NOT NULL
         ORDER BY c.created_at, c.id
         FOR UPDATE OF c SKIP LOCKED`,
        [host.id],
      );
      for (const row of waiting.rows) await invalidated(row, await getRunExecution(client, row.run_id));
    }
    const candidates = await client.query<{ id: string }>(
      `WITH eligible AS (
         SELECT c.id, c.created_at, ${slotBackendSql('c', 's')} AS slot_backend
         FROM collab_connector_commands c LEFT JOIN collab_sessions s ON s.id = c.session_id
         WHERE c.host_id = $1 AND ${deliverable}
       ), ranked AS (
         SELECT id, created_at, slot_backend, row_number() OVER (PARTITION BY slot_backend ORDER BY created_at, id) AS slot_rank FROM eligible
       )
       SELECT id FROM ranked
       WHERE slot_backend IS NULL OR slot_rank <= COALESCE(($4::jsonb ->> slot_backend)::int, 0)
       ORDER BY created_at, id
       LIMIT $3`,
      [host.id, CLAIM_REDELIVER_AFTER_MS / 1000, input2.limit, JSON.stringify(slots)],
    );
    const { rows } = await client.query(
      `SELECT c.id, c.run_id, c.session_id, c.kind, c.payload, c.created_at, c.created_by_principal_id, ${slotBackendSql('c', 's')} AS slot_backend,
              ${heldBackendSql('c')} AS held_backend
       FROM collab_connector_commands c LEFT JOIN collab_sessions s ON s.id = c.session_id
       WHERE c.id = ANY($1::uuid[]) AND ${deliverable}
       ORDER BY c.created_at, c.id
       FOR UPDATE OF c SKIP LOCKED`,
      [candidates.rows.map((r) => r.id), CLAIM_REDELIVER_AFTER_MS / 1000],
    );
    const granted: Record<string, number> = {};
    const commands: ConnectorCommand[] = [];
    for (const row of rows) {
      const execution = await getRunExecution(client, row.run_id);
      if (await invalidated(row, execution)) continue;
      const wasClaimed = (await client.query<{ state: string }>(`SELECT state FROM collab_connector_commands WHERE id = $1`, [row.id])).rows[0]?.state === 'claimed';
      await client.query(
        `UPDATE collab_connector_commands
         SET state = CASE WHEN state = 'accepted' THEN 'accepted' ELSE 'claimed' END,
             lease_epoch = $1, claimed_at = now(), updated_at = now()
         WHERE id = $2`,
        [input2.leaseEpoch, row.id],
      );
      if (row.slot_backend) granted[row.slot_backend] = (granted[row.slot_backend] ?? 0) + 1;
      commands.push({
        id: row.id,
        runId: row.run_id,
        sessionId: row.session_id,
        kind: row.kind,
        payload: row.payload,
        createdAt: new Date(row.created_at).toISOString(),
        leaseEpoch: input2.leaseEpoch,
        ...(row.slot_backend ? { slotGranted: true as const } : {}),
        ...(wasClaimed && row.held_backend ? { slotHeld: true as const } : {}),
        ...(row.payload?.execution === undefined && execution !== null && (SLOT_BACKENDS as readonly string[]).includes(execution.backend) ? { nativeBackend: execution.backend as 'claude-code' | 'codex' } : {}),
      });
    }
    const secret = process.env.FF_COLLAB_AUTH_SECRET;
    for (const command of commands) {
      if (command.sessionId === null) continue;
      const nativePrompt = command.kind === 'prompt' && ['claude-code', 'codex'].includes(String((command.payload.execution as CommandExecution | undefined)?.backend));
      if (!['launch','create_session','summarize'].includes(command.kind) && !nativePrompt) continue;
      const binding = await client.query<{ revoked_at: Date | null }>(
        `SELECT revoked_at FROM collab_scoped_tokens WHERE session_id = $1`,
        [command.sessionId],
      );
      if (binding.rows.length === 0 || binding.rows[0].revoked_at !== null) continue;
      if (typeof secret !== 'string' || secret.length < 16) continue;
      const { deriveReportingCredential } = await import('./runs.js');
      command.payload = {
        ...command.payload,
        reportingCredential: deriveReportingCredential(secret, command.sessionId),
      };
    }
    const observedAt = new Date().toISOString();
    for (const backend of SLOT_BACKENDS) {
      const reported = slots[backend];
      if (reported === undefined) continue;
      await client.query(
        `UPDATE collab_hosts SET catalog = jsonb_set(catalog, ARRAY['capacity', $2::text],
           jsonb_build_object('limit', lim, 'available', LEAST(lim, $3::int), 'observedAt', $4::text))
         FROM (SELECT CASE jsonb_typeof(catalog->'capacity'->$2::text) WHEN 'number' THEN (catalog->'capacity'->>$2::text)::int
                 ELSE (catalog->'capacity'->$2::text->>'limit')::int END AS lim FROM collab_hosts WHERE id = $1) cap
         WHERE id = $1 AND catalog->>'formatVersion' = '2' AND cap.lim IS NOT NULL`,
        [host.id, backend, Math.max(0, reported - (granted[backend] ?? 0)), observedAt],
      );
    }
    const held = await client.query<{ backend: string; n: number }>(
      `SELECT ${heldBackendSql('c')} AS backend, count(*)::int AS n FROM collab_connector_commands c
       WHERE c.host_id = $1 AND c.state = 'claimed' AND ${heldBackendSql('c')} IS NOT NULL AND NOT (c.id = ANY($2::uuid[]))
       GROUP BY 1`,
      [host.id, commands.map((command) => command.id)],
    );
    const heldClaims: HeldClaims = { 'claude-code': 0, codex: 0 };
    for (const r of held.rows) heldClaims[r.backend as keyof HeldClaims] = r.n;
    return { commands, heldClaims, serverTime };
  })) as { commands: ConnectorCommand[]; heldClaims: HeldClaims; serverTime: string };
}

function heldBackendSql(c: string): string {
  return `CASE WHEN ${c}.payload->'execution'->>'backend' IN ('claude-code', 'codex')
    AND ${c}.kind IN ('launch', 'create_session', 'summarize', 'prompt') THEN ${c}.payload->'execution'->>'backend' END`;
}

const ackSchema = z.object({
  token: z.string().min(8),
  connectorSessionId: z.string().uuid(),
  leaseEpoch: z.number().int().min(0),
  commandId: z.string().uuid(),
  state: z.enum(['accepted', 'applied', 'failed', 'ambiguous']),
  result: z.record(z.unknown()).optional(),
  errorCode: z.string().max(100).optional(),
});

export async function ackConnectorCommand(input: {
  token: string;
  connectorSessionId: string;
  leaseEpoch: number;
  commandId: string;
  state: 'accepted' | 'applied' | 'failed' | 'ambiguous';
  result?: Record<string, unknown>;
  errorCode?: string;
}): Promise<{ state: string }> {
  const input2 = ackSchema.parse(input);
  return withHostFence(input2.token, input2.connectorSessionId, input2.leaseEpoch, async ({ client, host }): Promise<{ state: string }> => {
    const command = await client.query(
      `SELECT * FROM collab_connector_commands WHERE id = $1 AND host_id = $2 FOR UPDATE`,
      [input2.commandId, host.id],
    );
    if (command.rows.length === 0) {
      throw new CollabServiceError(404, 'not_found', 'Not found.');
    }
    const commandRow = command.rows[0];
    const terminal = ['applied', 'failed', 'ambiguous'];
    if (terminal.includes(commandRow.state)) {
      if (commandRow.state === input2.state) return { state: commandRow.state };
      throw new CollabServiceError(409, 'state_conflict', 'This command already reached a terminal state.');
    }

    const withdrawn =
      input2.state === 'accepted' || input2.state === 'applied'
        ? await commandWithdrawnReason(client, {
            kind: commandRow.kind,
            created_by_principal_id: commandRow.created_by_principal_id,
            run_id: commandRow.run_id,
            session_id: commandRow.session_id,
            payload: commandRow.payload,
          })
        : null;
    let finalState = input2.state;
    let errorCode = input2.errorCode ?? null;
    if (withdrawn !== null) {
      finalState = input2.state === 'accepted' ? 'ambiguous' : input2.state === 'applied' ? 'ambiguous' : input2.state;
      errorCode = withdrawn;
    }

    await client.query(
      `UPDATE collab_connector_commands
       SET state = $1, acked_at = now(), result = $2, error_code = $3, updated_at = now()
       WHERE id = $4`,
      [finalState, input2.result ? JSON.stringify(input2.result) : null, errorCode, commandRow.id],
    );
    await projectCommandOutcome(client,commandRow,finalState,errorCode);
    return { state: finalState };
  });
}

const observationsSchema = z.object({
  token: z.string().min(8),
  connectorSessionId: z.string().uuid(),
  leaseEpoch: z.number().int().min(0),
  events: z
    .array(
      z.object({
        eventId: z.string().min(1).max(200),
        commandId: z.string().uuid().optional(),
        runId: z.string().uuid(),
        sessionId: z.string().uuid().nullable().default(null),
        observedAt: z.string().datetime(),
        kind: z.enum([
          'workspace_bound',
          'session_bound',
          'state',
          'timeline',
          'attention',
          'usage',
          'check',
          'artifact',
          'idea',
          'summary',
          'wrapup',
        ]),
        payload: z.record(z.unknown()),
        providerCursor: z.object({ epoch: z.string().min(1).max(200), seq: z.string().regex(/^\d{1,19}$/).refine(seq=>BigInt(seq)<=9223372036854775807n) }).optional(),
      }),
    )
    .max(MAX_EVENTS_PER_BATCH),
});

const NATIVE_BACKENDS = new Set(['claude-code', 'codex']);
const NATIVE_EVENT_ID = /^(claude-code|codex):/;
const MAX_FRAGMENTS = 4096;
const fragmentSchema = z
  .object({
    fragmentOf: z.string().min(1).max(190).regex(NATIVE_EVENT_ID),
    index: z.number().int().min(0),
    count: z.number().int().min(2).max(MAX_FRAGMENTS),
    encoding: z.literal('base64'),
    data: z.string().min(1).regex(/^[A-Za-z0-9+/]+={0,2}$/),
  })
  .strict();
type Fragment = z.infer<typeof fragmentSchema>;

function supervisorWorkerLoss(event: { kind: string; payload: Record<string, unknown> }): { backend: string; generation: number } | null {
  if (event.kind !== 'state') return null;
  const { state, errorCode, reason, stop, source } = event.payload;
  if (state !== 'reconciling' || errorCode !== 'reconciling' || reason !== 'worker_lost') return null;
  if (stop !== 'quiesced' && stop !== 'uncertain') return null;
  if (source === null || typeof source !== 'object' || Array.isArray(source)) return null;
  const backend = (source as Record<string, unknown>).backend;
  const generation = (source as Record<string, unknown>).generation;
  const nativeEventId = (source as Record<string, unknown>).nativeEventId;
  if (typeof backend !== 'string' || !NATIVE_BACKENDS.has(backend)) return null;
  if (!Number.isSafeInteger(generation) || (generation as number) < 1) return null;
  if (nativeEventId !== `ff:worker_lost:${generation}`) return null;
  return { backend, generation: generation as number };
}

function nativeFragment(event: { eventId: string; payload: Record<string, unknown> }): Fragment | null | 'invalid' {
  if (!Object.hasOwn(event.payload, 'fragmentOf')) return null;
  const parsed = fragmentSchema.safeParse(event.payload);
  if (!parsed.success) return 'invalid';
  const f = parsed.data;
  if (f.index >= f.count || event.eventId !== `${f.fragmentOf}#f${f.index}/${f.count}`) return 'invalid';
  return f;
}

async function reassembleFragments<E extends { eventId: string; commandId?: string; runId: string; sessionId: string | null; observedAt: string; kind: string; payload: Record<string, unknown>; providerCursor?: unknown }>(
  client: PoolClient,
  hostId: string,
  event: E,
  fragment: Fragment,
): Promise<null | (E & { reassembled: true })> {
  const { rows } = await client.query<{ index: number; data: string }>(
    `SELECT (payload->>'index')::int AS index, payload->>'data' AS data FROM collab_connector_observations
     WHERE host_id = $1 AND run_id = $2 AND session_id IS NOT DISTINCT FROM $3 AND kind = $4
       AND payload->>'fragmentOf' = $5 AND (payload->>'count')::int = $6
     ORDER BY (payload->>'index')::int`,
    [hostId, event.runId, event.sessionId, event.kind, fragment.fragmentOf, fragment.count],
  );
  if (rows.length !== fragment.count || rows.some((row, i) => row.index !== i)) return null;
  let payload: Record<string, unknown>;
  try {
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(rows.map((row) => Buffer.from(row.data, 'base64')))));
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('not an object');
    payload = value as Record<string, unknown>;
  } catch {
    payload = { unavailable: true, reason: 'fragment_reassembly_failed', originalKind: event.kind };
  }
  return { ...event, eventId: fragment.fragmentOf, payload, providerCursor: undefined, reassembled: true };
}

export async function submitConnectorObservations(input: {
  token: string;
  connectorSessionId: string;
  leaseEpoch: number;
  events: Array<{
    eventId: string;
    commandId?: string;
    runId: string;
    sessionId?: string | null;
    observedAt: string;
    kind: string;
    payload: Record<string, unknown>;
    providerCursor?: { epoch: string; seq: string };
  }>;
}): Promise<{ acceptedEventIds: string[]; rejectedEventIds: string[]; highWatermarks: Record<string, string> }> {
  const serialized = Buffer.byteLength(JSON.stringify(input.events ?? []), 'utf8');
  if (serialized > MAX_BATCH_BYTES) {
    throw new CollabServiceError(422, 'batch_too_large', 'Observation batch exceeds limits.');
  }
  const input2 = observationsSchema.parse(input);
  const host = await authenticateHost(input2.token);
  const accepted: string[] = [];
  const rejected: string[] = [];
  const highWatermarks: Record<string, string> = {};

  await withHostFence(input2.token, input2.connectorSessionId, input2.leaseEpoch, async ({ client }) => {
    const projects=await client.query(`SELECT DISTINCT project_id FROM collab_runs WHERE id=ANY($1::uuid[]) AND host_id=$2 ORDER BY project_id`,[input2.events.map(e=>e.runId),host.id]);
    for(const project of projects.rows) await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',[`board:${project.project_id}`]);
    const queue: Array<(typeof input2.events)[number] & { reassembled?: true }> = [...input2.events];
    for (let position = 0; position < queue.length; position += 1) {
      const event = queue[position];
      const bound = await client.query(
        `SELECT r.task_id,r.project_id,r.state FROM collab_runs r JOIN collab_tasks t ON t.id=r.task_id
         WHERE r.id = $1 AND r.host_id = $2 FOR UPDATE OF t`,
        [event.runId, host.id],
      );
      if (bound.rows.length === 0) continue;
      let sessionOk = true;
      let sessionRole: string|null = null;
      let sessionProjection:{state:string;timeline_epoch:string|null;timeline_seq:string|null;last_observed_at:Date|null}|null=null;
      if (event.sessionId !== null) {
        const sessionBound = await client.query(
          `SELECT role,state,timeline_epoch,timeline_seq,last_observed_at FROM collab_sessions WHERE id = $1 AND run_id = $2`,
          [event.sessionId, event.runId],
        );
        sessionOk = sessionBound.rows.length > 0;
        sessionRole=sessionBound.rows[0]?.role??null;
        sessionProjection=sessionBound.rows[0]??null;
      }
      if (!sessionOk) continue;

      const fragment = event.reassembled ? null : nativeFragment(event);
      if (fragment === 'invalid') {
        rejected.push(event.eventId);
        continue;
      }

      const inserted = await client.query(
        `INSERT INTO collab_connector_observations
           (event_id, host_id, run_id, session_id, kind, payload, provider_epoch, provider_seq, observed_at, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, GREATEST(clock_timestamp(), COALESCE(
           (SELECT max(created_at) FROM collab_connector_observations WHERE run_id = $3 AND session_id IS NOT DISTINCT FROM $4),
           '-infinity'::timestamptz) + interval '1 microsecond'))
         ON CONFLICT (event_id) DO NOTHING
         RETURNING id`,
        [
          event.eventId,
          host.id,
          event.runId,
          event.sessionId,
          event.kind,
          JSON.stringify(event.payload),
          event.providerCursor?.epoch ?? null,
          event.providerCursor?.seq ?? null,
          new Date(event.observedAt),
        ],
      );
      if (inserted.rows.length === 0) {
        const existing = await client.query(
          `SELECT 1 FROM collab_connector_observations
           WHERE event_id = $1
             AND host_id = $2
             AND run_id = $3
             AND session_id IS NOT DISTINCT FROM $4
             AND kind = $5
             AND payload = $6::jsonb`,
          [event.eventId, host.id, event.runId, event.sessionId, event.kind, JSON.stringify(event.payload)],
        );
        if (existing.rows.length === 0) {
          if (!event.reassembled) rejected.push(event.eventId);
          continue;
        }
        if (event.reassembled) continue;
        accepted.push(event.eventId);
        if (fragment) {
          const whole = await reassembleFragments(client, host.id, event, fragment);
          if (whole) queue.splice(position + 1, 0, whole);
        }
        continue;
      }
      if (!event.reassembled) accepted.push(event.eventId);
      if (fragment) {
        const whole = await reassembleFragments(client, host.id, event, fragment);
        if (whole) queue.splice(position + 1, 0, whole);
        continue;
      }

      if(event.providerCursor&&sessionProjection) {
        const cursor=event.providerCursor;
        const prior=sessionProjection;
        const late=prior.timeline_epoch===cursor.epoch&&prior.timeline_seq!==null&&BigInt(cursor.seq)<BigInt(prior.timeline_seq);
        const oldEpoch=prior.timeline_epoch!==null&&prior.timeline_epoch!==cursor.epoch&&prior.last_observed_at!==null&&new Date(event.observedAt)<new Date(prior.last_observed_at);
        if(late||oldEpoch) continue;
        await client.query(`UPDATE collab_sessions SET timeline_epoch=$1,timeline_seq=$2,
          last_observed_at=GREATEST(last_observed_at,$3::timestamptz),updated_at=now() WHERE id=$4`,[cursor.epoch,cursor.seq,event.observedAt,event.sessionId]);
      }

      const currentState=sessionProjection?.state??bound.rows[0].state;
      if(event.kind==='state'&&['idle','failed','cancelled'].includes(currentState)
        &&typeof event.payload.state==='string'&&event.payload.state!==currentState) {
        const loss = currentState === 'idle' && event.sessionId !== null ? supervisorWorkerLoss(event) : null;
        if (loss === null) continue;
        const currentBinding = await client.query(
          `SELECT 1 FROM collab_session_execution
           WHERE session_id = $1 AND run_id = $2 AND backend = $3 AND binding_generation = $4`,
          [event.sessionId, event.runId, loss.backend, loss.generation],
        );
        if (currentBinding.rows.length === 0) continue;
      }
      if(event.kind==='state'&&event.payload.state==='cancel_requested'&&event.commandId) {
        const currentCancel=await client.query(`SELECT cancel.id FROM collab_connector_commands cancel
          WHERE cancel.id=$1 AND cancel.run_id=$2 AND cancel.session_id IS NOT DISTINCT FROM $3 AND cancel.kind='cancel'
            AND NOT EXISTS(SELECT 1 FROM collab_connector_commands resume
              WHERE resume.run_id=cancel.run_id AND resume.session_id IS NOT DISTINCT FROM cancel.session_id
                AND resume.kind='prompt' AND resume.created_at>cancel.created_at)`,[event.commandId,event.runId,event.sessionId]);
        if(!currentCancel.rows.length) continue;
      }

      const reportContext = { taskId:bound.rows[0].task_id,runId:event.runId,sessionId:event.sessionId };
      if (event.kind === 'state' && event.payload.plan && sessionRole==='work') {
        const plan = z.object({ items:z.array(z.object({text:z.string().min(1).max(500),status:z.enum(['pending','in_progress','completed'])})).min(1).max(50) }).parse(event.payload.plan);
        await recordWorkpadPlanReport({ ...reportContext,items:plan.items },client);
      }
      if (event.kind === 'usage') {
        const usage = z.object({ sampleKey:z.string().min(1).max(300),tokensIn:z.number().int().min(0).nullable().optional(),tokensOut:z.number().int().min(0).nullable().optional(),costUsd:z.number().min(0).nullable().optional(),reason:z.string().max(300).nullable().optional() }).parse(event.payload);
        await recordUsageSample({ ...reportContext,providerTurnId:usage.sampleKey,tokensIn:usage.tokensIn??null,tokensOut:usage.tokensOut??null,costUsd:usage.costUsd??null,unavailableReason:usage.reason??null },client);
      }
      if (event.kind === 'summary') {
        const summary = z.object({body:z.string().min(1).max(100000),model:z.string().max(200).nullable().optional(),sourceCursor:z.object({epoch:z.string().max(200),seq:z.string().max(200)}).nullable().optional()}).parse(event.payload);
        await recordCollabSummaryReport({...reportContext,body:summary.body,model:summary.model??null,sourceEpoch:summary.sourceCursor?.epoch??null,sourceSeq:summary.sourceCursor?.seq??null,visibility:'internal'},client);
      }
      if (event.kind === 'state' && ('headCommit' in event.payload || 'dirty' in event.payload || 'progress' in event.payload)) {
        const sample = z.object({headCommit:z.string().regex(/^[a-f0-9]{40,64}$/i).nullable().optional(),dirty:z.boolean().nullable().optional(),progress:z.object({text:z.string().max(1000),percent:z.number().min(0).max(100).nullable().optional()}).nullable().optional()}).parse(event.payload);
        await client.query(`UPDATE collab_runs SET
          head_commit=CASE WHEN $1 THEN $2 ELSE head_commit END,
          dirty=CASE WHEN $3 THEN $4 ELSE dirty END,
          progress=CASE WHEN $5 THEN $6::jsonb ELSE progress END WHERE id=$7`,
          ['headCommit' in sample,sample.headCommit??null,'dirty' in sample,sample.dirty??null,'progress' in sample,sample.progress?JSON.stringify(sample.progress):null,event.runId]);
      }

      if (event.kind === 'attention' || (event.kind === 'state' && ['queued','launching','running','needs_input','idle','failed','cancel_requested','cancelled','reconciling'].includes(String(event.payload.state)))) {
        await client.query(
          `INSERT INTO collab_task_events(task_id,project_id,kind,payload,visibility,created_at)
           VALUES($1,$2,$3,$4,$5,clock_timestamp())`,
          [bound.rows[0].task_id,bound.rows[0].project_id,event.kind === 'attention' ? 'attention' : 'run_state',
            JSON.stringify(event.kind === 'attention' ? { ...event.payload,runId:event.runId,sessionId:event.sessionId } : {runId:event.runId,state:event.payload.state}),
            event.kind === 'attention' ? 'internal' : 'client'],
        );
      }

      if (event.providerCursor) {
        const key = `${event.runId}:${event.sessionId ?? ''}:${event.providerCursor.epoch}`;
        const prev = highWatermarks[key];
        if (prev === undefined || BigInt(event.providerCursor.seq) > BigInt(prev)) {
          highWatermarks[key] = event.providerCursor.seq;
        }
      }

      const nativeBackend = typeof event.payload.backend === 'string' && NATIVE_BACKENDS.has(event.payload.backend) ? event.payload.backend : null;
      if (event.kind === 'workspace_bound' && nativeBackend !== null) {
        const ref = typeof event.payload.workspaceRef === 'string' && /^ffw_[0-9a-f]{16}$/.test(event.payload.workspaceRef) ? event.payload.workspaceRef : null;
        const owned = ref === null ? { rows: [] } : await client.query(
          `UPDATE collab_run_execution SET workspace_ref = $1, updated_at = now() WHERE run_id = $2 AND backend = $3 RETURNING run_id`,
          [ref, event.runId, nativeBackend],
        );
        if (owned.rows.length) {
          await client.query(
            `UPDATE collab_runs SET workspace_id = $1, state = CASE WHEN state = 'queued' THEN 'launching' ELSE state END,
               last_observed_at = $2, updated_at = now() WHERE id = $3`,
            [ref, new Date(event.observedAt), event.runId],
          );
        }
      } else if (event.kind === 'session_bound' && event.sessionId !== null && nativeBackend !== null) {
        const nativeSessionId = typeof event.payload.nativeSessionId === 'string' && event.payload.nativeSessionId.length > 0 && event.payload.nativeSessionId.length <= 200 ? event.payload.nativeSessionId : null;
        const generation = Number.isSafeInteger(event.payload.generation) && (event.payload.generation as number) >= 1 ? event.payload.generation : null;
        if (nativeSessionId !== null && generation !== null) {
          await client.query(
            `UPDATE collab_session_execution SET native_session_id = $1, binding_generation = $2, updated_at = now()
             WHERE session_id = $3 AND run_id = $4 AND backend = $5 AND binding_generation < $2`,
            [nativeSessionId, generation, event.sessionId, event.runId, nativeBackend],
          );
        }
        await client.query(`UPDATE collab_sessions SET last_observed_at = GREATEST(last_observed_at, $1::timestamptz), updated_at = now() WHERE id = $2`, [event.observedAt, event.sessionId]);
      } else if (event.kind === 'workspace_bound' && typeof event.payload.workspaceId === 'string') {
        await client.query(
          `UPDATE collab_runs SET workspace_id = $1, state = CASE WHEN state = 'queued' THEN 'launching' ELSE state END,
             last_observed_at = $2, updated_at = now() WHERE id = $3`,
          [event.payload.workspaceId, new Date(event.observedAt), event.runId],
        );
      } else if (event.kind === 'session_bound' && event.sessionId !== null) {
        await client.query(
          `UPDATE collab_sessions
           SET paseo_agent_id = COALESCE($1, paseo_agent_id),
               provider_session_id = COALESCE($2, provider_session_id),
               last_observed_at = $3, updated_at = now()
           WHERE id = $4`,
          [
            typeof event.payload.paseoAgentId === 'string' ? event.payload.paseoAgentId : null,
            typeof event.payload.providerSessionId === 'string' ? event.payload.providerSessionId : null,
            new Date(event.observedAt),
            event.sessionId,
          ],
        );
      } else if (event.kind === 'state' && typeof event.payload.state === 'string') {
        const allowed = ['queued', 'launching', 'running', 'needs_input', 'idle', 'failed', 'cancel_requested', 'cancelled', 'reconciling'];
        if (allowed.includes(event.payload.state)) {
          const observedAt=new Date(event.observedAt);
          if(event.sessionId!==null) {
            await client.query(`UPDATE collab_sessions SET state=$1,last_observed_at=GREATEST(last_observed_at,$2::timestamptz),updated_at=now() WHERE id=$3`,[event.payload.state,observedAt,event.sessionId]);
            if(event.payload.state==='failed'&&event.payload.errorCode==='account_limited') await client.query(`UPDATE collab_runs SET error_code='account_limited',updated_at=now() WHERE id=$1`,[event.runId]);
          }
          if (event.sessionId === null) {
            await client.query(
              `UPDATE collab_runs SET state = $1, last_observed_at = $2, updated_at = now() WHERE id = $3`,
              [event.payload.state, observedAt, event.runId],
            );
            continue;
          }
          const aggregate = await client.query<{ state: string | null }>(
            `SELECT CASE
               WHEN count(*) FILTER (WHERE role = 'work' AND state = 'running') > 0 THEN 'running'
               WHEN count(*) FILTER (WHERE role = 'work' AND state = 'needs_input') > 0 THEN 'needs_input'
               WHEN count(*) FILTER (WHERE role = 'work' AND state = 'cancel_requested') > 0 THEN 'cancel_requested'
               WHEN count(*) FILTER (WHERE role = 'work') > 0
                 THEN (SELECT state FROM collab_sessions WHERE run_id = $1 AND role = 'work' ORDER BY created_at DESC LIMIT 1)
               ELSE NULL
             END AS state
             FROM collab_sessions WHERE run_id = $1`,
            [event.runId],
          );
          const runState = aggregate.rows[0]?.state ?? null;
          if (runState !== null) {
            await client.query(
              `UPDATE collab_runs SET state = $1, last_observed_at = $2, updated_at = now()
               WHERE id = $3
                 AND (state <> 'cancelled' AND state <> 'failed')`,
              [runState, observedAt, event.runId],
            );
            if(runState==='running') {
              const advanced=await client.query(`UPDATE collab_tasks SET status='in_progress',version=version+1,updated_at=now()
                WHERE id=$1 AND status IN ('backlog','ready') RETURNING project_id`,[bound.rows[0].task_id]);
              if(advanced.rows.length) {
                await client.query('UPDATE collab_projects SET board_version=board_version+1,updated_at=now() WHERE id=$1',[bound.rows[0].project_id]);
                await client.query(`INSERT INTO collab_task_events(task_id,project_id,kind,payload,visibility,created_at) VALUES($1,$2,'task_moved','{"status":"in_progress"}','client',clock_timestamp())`,[bound.rows[0].task_id,bound.rows[0].project_id]);
              }
            }
          }
        }
      } else {
        await client.query(
          `UPDATE collab_runs SET last_observed_at = $1, updated_at = now() WHERE id = $2`,
          [new Date(event.observedAt), event.runId],
        );
      }
    }
  });
  return { acceptedEventIds: accepted, rejectedEventIds: rejected, highWatermarks };
}

export async function reconcileConnectorCommand(input: {
  actor: { principalId: string; sessionVersion: number }; commandId: string; action: 'redeliver'|'cancel';
}):Promise<{state:string}> {
  const parsed=z.object({commandId:z.string().uuid(),action:z.enum(['redeliver','cancel'])}).parse(input);
  const {rows}=await getPool().query(`SELECT r.project_id,c.host_id FROM collab_connector_commands c JOIN collab_runs r ON r.id=c.run_id WHERE c.id=$1`,[parsed.commandId]);
  if(!rows.length) throw new CollabServiceError(404,'not_found','Not found.');
  await authorize(input.actor,{projectId:rows[0].project_id},['internal.read','run.steer']);
  return withClientTransaction(async(client)=>{
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',[`connector:${rows[0].host_id}`]);
    const command=await client.query('SELECT * FROM collab_connector_commands WHERE id=$1 FOR UPDATE',[parsed.commandId]);
    const row=command.rows[0];
    if(row.state!=='ambiguous') throw new CollabServiceError(409,'not_ambiguous','Only ambiguous holds can be reconciled.');
    const next=parsed.action==='redeliver'?'pending':'cancelled';
    await client.query(`UPDATE collab_connector_commands SET state=$1,error_code=$2,lease_epoch=NULL,claimed_at=NULL,acked_at=NULL,updated_at=now() WHERE id=$3`,[next,parsed.action==='redeliver'?'reconciliation_redelivery':'reconciliation_cancelled',parsed.commandId]);
    if(parsed.action==='redeliver') {
      const run=await client.query(`SELECT t.id FROM collab_tasks t JOIN collab_runs r ON r.task_id=t.id WHERE r.id=$1 FOR UPDATE OF t`,[row.run_id]);
      void run;
      if(['launch','create_session'].includes(row.kind)) {
        await client.query(`UPDATE collab_sessions SET state='queued',updated_at=now() WHERE id=$1 AND state='reconciling'`,[row.session_id]);
        await client.query(`UPDATE collab_runs SET state='queued',error_code=NULL,version=version+1,updated_at=now() WHERE id=$1 AND state='reconciling'`,[row.run_id]);
      }
    } else {
      await projectCommandOutcome(client,row,'ambiguous','reconciliation_cancelled');
    }
    return {state:next};
  });
}

async function projectCommandOutcome(client:PoolClient,command:Record<string,any>,state:string,errorCode:string|null):Promise<void> {
  if(!['failed','ambiguous'].includes(state)) return;
  const {rows}=await client.query(`SELECT r.*,t.id AS locked_task_id FROM collab_runs r JOIN collab_tasks t ON t.id=r.task_id WHERE r.id=$1 FOR UPDATE OF t`,[command.run_id]);
  const run=rows[0];
  if(!run) return;
  const safeError=state==='ambiguous'?'execution_ambiguous':errorCode==='authorization_withdrawn'||errorCode==='execution_settings_changed'?errorCode:'command_failed';
  if(['launch','create_session'].includes(command.kind)) {
    await client.query(`UPDATE collab_sessions SET state=$1,updated_at=now() WHERE id=$2 AND state IN ('queued','launching','reconciling')`,[state==='ambiguous'?'reconciling':'failed',command.session_id]);
    const aggregate=await client.query(`SELECT CASE
      WHEN count(*) FILTER(WHERE role='work' AND state='running')>0 THEN 'running'
      WHEN count(*) FILTER(WHERE role='work' AND state='needs_input')>0 THEN 'needs_input'
      WHEN count(*) FILTER(WHERE role='work' AND state='reconciling')>0 THEN 'reconciling'
      WHEN count(*) FILTER(WHERE role='work' AND state IN ('queued','launching'))>0 THEN 'queued'
      ELSE $2 END AS state FROM collab_sessions WHERE run_id=$1`,[run.id,state==='ambiguous'?'reconciling':'failed']);
    await client.query(`UPDATE collab_runs SET state=$1,error_code=$2,version=version+1,updated_at=now() WHERE id=$3 AND state NOT IN ('cancelled','idle')`,[aggregate.rows[0].state,safeError,run.id]);
  } else await client.query('UPDATE collab_runs SET error_code=$1,updated_at=now() WHERE id=$2',[safeError,run.id]);
  await client.query(`INSERT INTO collab_task_events(task_id,project_id,kind,payload,visibility,created_at)
    VALUES($1,$2,'attention',$3,'internal',clock_timestamp())`,[run.task_id,run.project_id,JSON.stringify({commandId:command.id,runId:run.id,sessionId:command.session_id,state:state==='ambiguous'?'reconciling':'failed'})]);
  await client.query(`INSERT INTO collab_task_events(task_id,project_id,kind,payload,visibility,created_at)
    SELECT task_id,project_id,'run_state',jsonb_build_object('runId',id,'state',state),'client',clock_timestamp() FROM collab_runs WHERE id=$1`,[run.id]);
}
