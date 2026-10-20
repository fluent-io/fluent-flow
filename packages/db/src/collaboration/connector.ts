import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { PoolClient } from 'pg';
import { getPool } from '../pool.js';
import { withClientTransaction } from './tx.js';
import { CollabServiceError } from './errors.js';
import { getProjectCapabilities,authorize } from './authorize.js';
import { recordWorkpadPlanReport, recordUsageSample, recordCollabSummaryReport } from './evidence.js';

/** Capability that authorized a command kind at creation time. */
function commandCapability(kind: string): 'run.start' | 'run.steer' | 'run.cancel' | 'task.read' {
  if (kind === 'artifact_read') return 'task.read';
  if (kind === 'cancel') return 'run.cancel';
  if (kind === 'launch' || kind === 'create_session') return 'run.start';
  return 'run.steer';
}

/**
 * Delivery-time authorization recheck (contract: queued work rechecks actor,
 * mapping and host grant before execution — withdrawal while the PC is
 * offline must not execute previously queued work). Returns 'withdrawn' when
 * the originator is disabled/revoked, the capability is gone, or the
 * mapping/host grant no longer exists. The command payload is NEVER mutated —
 * no rerouting under the same command id.
 */
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

/**
 * Connector protocol (host-side). The Bearer token is hashed and bound to the
 * route host — there is no hostId body override, ever. Lease fencing rejects
 * stale epochs; command IDs are re-delivered as the SAME command, never
 * re-created.
 */

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
    // Revoked and unknown tokens are indistinguishable.
    throw new CollabServiceError(401, 'unauthenticated', 'Authentication required.');
  }
  return { id: rows[0].id, leaseEpoch: Number(rows[0].lease_epoch), connectorSessionId: rows[0].connector_session_id };
}

type HostTx = { client: PoolClient; host: { id: string; leaseEpoch: number; connectorSessionId: string | null } };

/** Session + epoch fence inside a transaction; throws 409 stale_lease on mismatch. */
async function withHostFence<T>(token: string, connectorSessionId: string, leaseEpoch: number, fn: (tx: HostTx) => Promise<T>): Promise<T> {
  const host = await authenticateHost(token);
  if (host.connectorSessionId !== connectorSessionId || host.leaseEpoch !== leaseEpoch) {
    throw new CollabServiceError(409, 'stale_lease', 'This connection is no longer active.');
  }
  return withClientTransaction(async (client) => {
    // Serialize protocol mutations per host.
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
  catalog: z
    .object({
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
    })
    .default({ repositories: [], profiles: [] }),
});

export type ConnectorRegistration = {
  hostId: string;
  connectorSessionId: string;
  leaseEpoch: number;
  heartbeatIntervalMs: number;
  staleAfterMs: number;
  offlineAfterMs: number;
};

export async function registerConnector(input: {
  token: string;
  instanceId: string;
  protocolVersion: 1;
  sdkVersion: string;
  daemonVersion?: string;
  capabilities?: Record<string, unknown>;
  catalog?: { repositories: Array<{ key: string }>; profiles: Array<Record<string, unknown>> };
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
    // An unexpired active session is authoritative: a DIFFERENT instance is
    // rejected (409, safe waiting); the SAME instance re-registering (lost
    // response) gets its existing session and epoch back — idempotent, no
    // fencing ping-pong. A STALE session recovers with a new epoch.
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
        `UPDATE collab_hosts SET last_heartbeat_at = now(), catalog = $1, updated_at = now() WHERE id = $2`,
        [JSON.stringify(input2.catalog), host.id],
      );
      return {
        hostId: host.id,
        connectorSessionId: row.connector_session_id as string,
        leaseEpoch: Number(row.lease_epoch),
        heartbeatIntervalMs: 15_000,
        staleAfterMs: 45_000,
        offlineAfterMs: 120_000,
      };
    }

    const sessionId = randomUUID();
    const nextEpoch = Number(row.lease_epoch) + 1;
    await client.query(
      `UPDATE collab_hosts
       SET connector_session_id = $1, connector_instance_id = $2, lease_epoch = $3,
           last_heartbeat_at = now(), catalog = $4, updated_at = now()
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
    };
  });
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
};

const pollSchema = z.object({
  token: z.string().min(8),
  connectorSessionId: z.string().uuid(),
  leaseEpoch: z.number().int().min(0),
  waitMs: z.number().int().min(0).max(25_000).default(25_000),
  limit: z.number().int().min(1).max(10).default(1),
});

export async function pollConnectorCommands(input: {
  token: string;
  connectorSessionId: string;
  leaseEpoch: number;
  waitMs?: number;
  limit?: number;
}): Promise<{ commands: ConnectorCommand[] }> {
  const input2 = pollSchema.parse(input);
  return (await withHostFence(input2.token, input2.connectorSessionId, input2.leaseEpoch, async ({ client, host }) => {
    await client.query(`UPDATE collab_hosts SET last_heartbeat_at = now(), updated_at = now() WHERE id = $1`, [host.id]);
    // Atomic claim: pending commands, or claimed ones whose delivery lease
    // lapsed (re-delivery of the SAME command id, never a new command).
    const { rows } = await client.query(
      `SELECT id, run_id, session_id, kind, payload, created_at, created_by_principal_id FROM collab_connector_commands
       WHERE host_id = $1
         AND (
           state = 'pending'
           OR (state = 'claimed' AND claimed_at < now() - make_interval(secs => $2))
           -- Lost-ack resume: an ACCEPTED command whose response never reached
           -- the connector is re-delivered AS THE SAME COMMAND (C dedupes by
           -- id; no new run), after a short settle.
           OR (state = 'accepted' AND acked_at < now() - make_interval(secs => 5))
         )
       ORDER BY created_at
       LIMIT $3
       FOR UPDATE SKIP LOCKED`,
      [host.id, CLAIM_REDELIVER_AFTER_MS / 1000, input2.limit],
    );
    const commands: ConnectorCommand[] = [];
    for (const row of rows) {
      // Delivery-time recheck: authorization withdrawn while queued (actor
      // disabled/revoked, mapping/host grant gone) → typed cancellation with
      // preserved history. Payload is never mutated or rerouted.
      const withdrawn = await commandWithdrawnReason(client, row);
      if (withdrawn !== null) {
        await client.query(
          `UPDATE collab_connector_commands
           SET state = 'cancelled', error_code = $1, updated_at = now() WHERE id = $2`,
          [withdrawn, row.id],
        );
        await projectCommandOutcome(client,row,'failed','authorization_withdrawn');
        continue;
      }
      await client.query(
        `UPDATE collab_connector_commands
         SET state = CASE WHEN state = 'accepted' THEN 'accepted' ELSE 'claimed' END,
             lease_epoch = $1, claimed_at = now(), updated_at = now()
         WHERE id = $2`,
        [input2.leaseEpoch, row.id],
      );
      commands.push({
        id: row.id,
        runId: row.run_id,
        sessionId: row.session_id,
        kind: row.kind,
        payload: row.payload,
        createdAt: new Date(row.created_at).toISOString(),
        leaseEpoch: input2.leaseEpoch,
      });
    }
    // Reporting credentials attach ONLY at delivery — the raw token is never
    // stored in the command payload. It is deterministically derived from the
    // server key + session (restart-stable), and re-attached identically on
    // re-delivery of the SAME command id. create_session gets its own.
    const secret = process.env.FF_COLLAB_AUTH_SECRET;
    for (const command of commands) {
      if (command.sessionId === null) continue;
      if (!['launch','create_session','summarize'].includes(command.kind)) continue;
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
    return { commands };
  })) as { commands: ConnectorCommand[] };
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
      // Another host's (or unknown) command is indistinguishable from missing.
      throw new CollabServiceError(404, 'not_found', 'Not found.');
    }
    const commandRow = command.rows[0];
    const terminal = ['applied', 'failed', 'ambiguous'];
    if (terminal.includes(commandRow.state)) {
      // Terminal replay is idempotent; a DIFFERENT terminal outcome conflicts.
      if (commandRow.state === input2.state) return { state: commandRow.state };
      throw new CollabServiceError(409, 'state_conflict', 'This command already reached a terminal state.');
    }

    // Authorization withdrawal (actor disabled/revoked, mapping/host grant
    // gone) after queuing: the response reports the RECORDED state — a
    // claimed-but-unconfirmed command never earns an accepted grant, and an
    // applied confirmation becomes ambiguous for truthful reconciliation.
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
    for (const event of input2.events) {
      // Every event is bound to a run (and session) owned by THIS host.
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

      const inserted = await client.query(
        `INSERT INTO collab_connector_observations
           (event_id, host_id, run_id, session_id, kind, payload, provider_epoch, provider_seq, observed_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
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
        // Replay of an ALREADY-DURABLE event (C resends its pending set after
        // reconnect until acked): identical binding consumes the pending entry
        // (accepted) WITHOUT re-projecting. A changed payload or a foreign
        // binding is rejected so a replay can never smuggle new meaning.
        // Canonical comparison: jsonb equality ignores key order, so a
        // structurally identical replay is accepted (consumed) without
        // re-projection; a changed payload or foreign binding is rejected.
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
          rejected.push(event.eventId);
          continue;
        }
        accepted.push(event.eventId);
        continue;
      }
      accepted.push(event.eventId);

      if(event.providerCursor&&sessionProjection) {
        const cursor=event.providerCursor;
        const prior=sessionProjection;
        const late=prior.timeline_epoch===cursor.epoch&&prior.timeline_seq!==null&&BigInt(cursor.seq)<BigInt(prior.timeline_seq);
        const oldEpoch=prior.timeline_epoch!==null&&prior.timeline_epoch!==cursor.epoch&&prior.last_observed_at!==null&&new Date(event.observedAt)<new Date(prior.last_observed_at);
        // Retain and acknowledge late history without regressing projections.
        // Distinct fanout events on the SAME cursor remain valid.
        if(late||oldEpoch) continue;
        await client.query(`UPDATE collab_sessions SET timeline_epoch=$1,timeline_seq=$2,
          last_observed_at=GREATEST(last_observed_at,$3::timestamptz),updated_at=now() WHERE id=$4`,[cursor.epoch,cursor.seq,event.observedAt,event.sessionId]);
      }

      const currentState=sessionProjection?.state??bound.rows[0].state;
      if(event.kind==='state'&&['idle','failed','cancelled'].includes(currentState)
        &&typeof event.payload.state==='string'&&event.payload.state!==currentState) {
        // stopAgent may publish a terminal native event before the executor's
        // cancellation intent arrives. Retain that late event as history;
        // only an authorized new prompt can reserve and reopen the session.
        continue;
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

      // Projection: persist observation and state change in one transaction.
      if (event.kind === 'workspace_bound' && typeof event.payload.workspaceId === 'string') {
        await client.query(
          `UPDATE collab_runs SET workspace_id = $1, state = CASE WHEN state = 'queued' THEN 'launching' ELSE state END,
             last_observed_at = $2, updated_at = now() WHERE id = $3`,
          [event.payload.workspaceId, new Date(event.observedAt), event.runId],
        );
      } else if (event.kind === 'session_bound' && event.sessionId !== null) {
        // C threads arrive in pieces (agent ID first, providerSessionId later
        // on thread_started): MERGE partial bindings, never null out a bound
        // value. Binding alone does not mean running.
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
            // Cursor ordering is checked once for every projection above;
            // uncursored snapshots must not erase that persisted watermark.
            await client.query(`UPDATE collab_sessions SET state=$1,last_observed_at=GREATEST(last_observed_at,$2::timestamptz),updated_at=now() WHERE id=$3`,[event.payload.state,observedAt,event.sessionId]);
          }
          if (event.sessionId === null) {
            // Run-level state event (no session): apply directly.
            await client.query(
              `UPDATE collab_runs SET state = $1, last_observed_at = $2, updated_at = now() WHERE id = $3`,
              [event.payload.state, observedAt, event.runId],
            );
            continue;
          }
          // Session-scoped state: the run aggregates CURRENT WORK sessions —
          // a summary (or second) session going idle never finishes the work.
          // Run state = truthful aggregate of CURRENT WORK sessions only:
          // running wins, then needs_input, then cancel_requested; summary
          // sessions can never finish or steer the primary work.
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

/**
 * Operator reconciliation for an AMBIGUOUS hold: 'redeliver' re-queues the
 * SAME command (same id/payload/host/session — never a new run; delivery-time
 * authorization is re-checked), 'cancel' closes the hold as cancelled.
 */
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
      // Cancelling the delivery request cannot prove a remote native turn
      // stopped. Keep the uncertainty visible until an observation resolves it.
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
  const safeError=state==='ambiguous'?'execution_ambiguous':errorCode==='authorization_withdrawn'?'authorization_withdrawn':'command_failed';
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
