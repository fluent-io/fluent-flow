import pg from 'pg';
import { getPool } from '../pool.js';

export type QueryExecutor = Pick<pg.Pool, 'query'> | Pick<pg.PoolClient, 'query'>;
export const MAX_CLAIM_EVENT_BYTES = 16 * 1024 * 1024;

export interface ClaimRequest {
  orgId: string;
  claimId: number;
  requestKey: string;
  kind: 'permission' | 'elicitation';
  payload: unknown;
  status: 'open' | 'answer_queued' | 'resolved' | 'uncertain' | 'cancelled';
  response: unknown | null;
  createdAt: Date;
  resolvedAt: Date | null;
}

export interface ClaimCommand {
  id: number;
  orgId: string;
  claimId: number;
  idempotencyKey: string;
  requestKey: string | null;
  kind: 'prompt' | 'cancel' | 'permission' | 'elicitation';
  payload: unknown;
  status: 'pending' | 'delivered' | 'acked' | 'failed' | 'uncertain' | 'cancelled';
  result: unknown | null;
  createdAt: Date;
  deliveredAt: Date | null;
  ackedAt: Date | null;
}

async function atomic<T>(executor: QueryExecutor | undefined, operation: (client: QueryExecutor) => Promise<T>): Promise<T> {
  const selected = executor ?? getPool();
  if (!(selected instanceof pg.Pool)) return operation(selected);
  const client = await selected.connect();
  try {
    await client.query('BEGIN');
    const result = await operation(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

function requestFromRow(row: Record<string, unknown>): ClaimRequest {
  return {
    orgId: row.org_id as string,
    claimId: row.claim_id as number,
    requestKey: row.request_key as string,
    kind: row.kind as ClaimRequest['kind'],
    payload: row.payload,
    status: row.status as ClaimRequest['status'],
    response: row.response ?? null,
    createdAt: row.created_at as Date,
    resolvedAt: (row.resolved_at as Date | null) ?? null,
  };
}

function commandFromRow(row: Record<string, unknown>): ClaimCommand {
  return {
    id: row.id as number,
    orgId: row.org_id as string,
    claimId: row.claim_id as number,
    idempotencyKey: row.idempotency_key as string,
    requestKey: (row.request_key as string | null) ?? null,
    kind: row.kind as ClaimCommand['kind'],
    payload: row.payload,
    status: row.status as ClaimCommand['status'],
    result: row.result ?? null,
    createdAt: row.created_at as Date,
    deliveredAt: (row.delivered_at as Date | null) ?? null,
    ackedAt: (row.acked_at as Date | null) ?? null,
  };
}

export async function appendClaimEvents(input: {
  orgId: string;
  claimId: number;
  events: Array<{ seq: number; kind: string; payload: unknown }>;
}, executor?: QueryExecutor): Promise<{ inserted: number; lastSeq: number | null }> {
  if (input.events.length === 0) return { inserted: 0, lastSeq: null };
  return atomic(executor, async (client) => {
    await client.query(
      `SELECT pg_advisory_xact_lock(hashtext($1))`,
      [`claim-events:${input.orgId}:${input.claimId}`],
    );
    const existing = await client.query<{ payload_bytes: string }>(
      `SELECT COALESCE(SUM(payload_bytes), 0)::text AS payload_bytes
       FROM agent_claim_events
       WHERE org_id = $1 AND claim_id = $2`,
      [input.orgId, input.claimId],
    );
    let payloadBytes = Number(existing.rows[0].payload_bytes);
    let inserted = 0;
    for (const event of input.events) {
      const serializedPayload = JSON.stringify(event.payload);
      const result = await client.query<{ inserted: boolean; payload_bytes: number }>(
        `INSERT INTO agent_claim_events (org_id, claim_id, seq, kind, payload)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (org_id, claim_id, seq) DO UPDATE
           SET kind = agent_claim_events.kind
         WHERE agent_claim_events.kind = EXCLUDED.kind
           AND agent_claim_events.payload = EXCLUDED.payload
         RETURNING xmax = 0 AS inserted, payload_bytes`,
        [input.orgId, input.claimId, event.seq, event.kind, serializedPayload],
      );
      if (result.rows.length === 0) throw new Error('Interaction conflict.');
      if (result.rows[0].inserted) {
        inserted += 1;
        payloadBytes += result.rows[0].payload_bytes;
      }
    }
    if (payloadBytes > MAX_CLAIM_EVENT_BYTES) {
      throw new Error('Claim event payload limit exceeded.');
    }
    return { inserted, lastSeq: Math.max(...input.events.map((event) => event.seq)) };
  });
}

export async function upsertClaimRequest(input: {
  orgId: string;
  claimId: number;
  requestKey: string;
  kind: 'permission' | 'elicitation';
  payload: unknown;
}, executor?: QueryExecutor): Promise<ClaimRequest> {
  const result = await (executor ?? getPool()).query(
    `INSERT INTO agent_claim_requests (org_id, claim_id, request_key, kind, payload)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (org_id, claim_id, request_key) DO UPDATE
       SET kind = agent_claim_requests.kind
     WHERE agent_claim_requests.kind = EXCLUDED.kind
       AND agent_claim_requests.payload = EXCLUDED.payload
     RETURNING *`,
    [input.orgId, input.claimId, input.requestKey, input.kind, JSON.stringify(input.payload)],
  );
  if (result.rows.length === 0) throw new Error('Interaction conflict.');
  return requestFromRow(result.rows[0]);
}

export async function resolveClaimRequest(input: {
  orgId: string;
  claimId: number;
  requestKey: string;
  response: unknown;
}, executor?: QueryExecutor): Promise<ClaimRequest | null> {
  const result = await (executor ?? getPool()).query(
    `UPDATE agent_claim_requests
     SET status = 'resolved', response = $4, resolved_at = now()
     WHERE org_id = $1 AND claim_id = $2 AND request_key = $3
       AND status IN ('open', 'answer_queued')
     RETURNING *`,
    [input.orgId, input.claimId, input.requestKey, JSON.stringify(input.response)],
  );
  return result.rows.length === 0 ? null : requestFromRow(result.rows[0]);
}

export async function enqueueClaimCommand(input: {
  orgId: string;
  claimId: number;
  idempotencyKey: string;
  kind: 'prompt' | 'cancel' | 'permission' | 'elicitation';
  payload: unknown;
  requestKey?: string | null;
}, executor?: QueryExecutor): Promise<{ command: ClaimCommand; created: boolean }> {
  const result = await (executor ?? getPool()).query(
    `INSERT INTO agent_claim_commands (org_id, claim_id, idempotency_key, kind, payload, request_key)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (org_id, claim_id, idempotency_key) DO UPDATE
       SET kind = agent_claim_commands.kind
     WHERE agent_claim_commands.kind = EXCLUDED.kind
       AND agent_claim_commands.payload = EXCLUDED.payload
       AND agent_claim_commands.request_key IS NOT DISTINCT FROM EXCLUDED.request_key
     RETURNING *, xmax = 0 AS inserted`,
    [input.orgId, input.claimId, input.idempotencyKey, input.kind, JSON.stringify(input.payload), input.requestKey ?? null],
  );
  if (result.rows.length === 0) throw new Error('Interaction conflict.');
  return { command: commandFromRow(result.rows[0]), created: Boolean(result.rows[0].inserted) };
}

export async function reserveClaimRequestAnswer(input: {
  orgId: string;
  claimId: number;
  requestKey: string;
  idempotencyKey: string;
  kind: 'permission' | 'elicitation';
  payload: unknown;
}, executor?: QueryExecutor): Promise<{ command: ClaimCommand; created: boolean } | null> {
  return atomic(executor, async (client) => {
    const locked = await client.query(
      `SELECT * FROM agent_claim_requests
       WHERE org_id = $1 AND claim_id = $2 AND request_key = $3
       FOR UPDATE`,
      [input.orgId, input.claimId, input.requestKey],
    );
    if (locked.rows.length === 0) return null;
    const request = locked.rows[0];
    if (request.kind !== input.kind) throw new Error('Interaction conflict.');
    if (request.status === 'answer_queued') {
      const existing = await client.query(
        `SELECT *, kind = $5 AND payload = $6::jsonb AS body_matches
         FROM agent_claim_commands
         WHERE org_id = $1 AND claim_id = $2 AND request_key = $3
           AND idempotency_key = $4`,
        [input.orgId, input.claimId, input.requestKey, input.idempotencyKey, input.kind, JSON.stringify(input.payload)],
      );
      if (existing.rows.length === 0) return null;
      if (!existing.rows[0].body_matches) throw new Error('Interaction conflict.');
      return { command: commandFromRow(existing.rows[0]), created: false };
    }
    if (request.status !== 'open') return null;
    const queued = await enqueueClaimCommand({ ...input, requestKey: input.requestKey }, client);
    await client.query(
      `UPDATE agent_claim_requests
       SET status = 'answer_queued'
       WHERE org_id = $1 AND claim_id = $2 AND request_key = $3`,
      [input.orgId, input.claimId, input.requestKey],
    );
    return queued;
  });
}

export async function leaseClaimCommands(input: {
  orgId: string;
  claimId: number;
  limit: number;
}, executor?: QueryExecutor): Promise<ClaimCommand[]> {
  return atomic(executor, async (client) => {
    const expired = await client.query(
      `UPDATE agent_claim_commands
       SET status = 'uncertain', acked_at = now()
       WHERE org_id = $1 AND claim_id = $2 AND status = 'delivered'
         AND delivered_at < now() - interval '30 seconds'
       RETURNING request_key, result`,
      [input.orgId, input.claimId],
    );
    for (const row of expired.rows) {
      await client.query(
        `UPDATE agent_claim_requests
         SET status = 'uncertain', response = $4, resolved_at = now()
         WHERE org_id = $1 AND claim_id = $2 AND status = 'answer_queued'
           AND request_key = $3`,
        [input.orgId, input.claimId, row.request_key, JSON.stringify(row.result)],
      );
    }
    const result = await client.query(
      `WITH selected AS (
         SELECT id FROM agent_claim_commands
         WHERE org_id = $1 AND claim_id = $2 AND status = 'pending'
         ORDER BY created_at, id
         FOR UPDATE SKIP LOCKED
         LIMIT $3
       )
       UPDATE agent_claim_commands AS command
       SET status = 'delivered', delivered_at = now()
       FROM selected
       WHERE command.id = selected.id
       RETURNING command.*`,
      [input.orgId, input.claimId, Math.max(0, input.limit)],
    );
    return result.rows.map(commandFromRow);
  });
}

export async function ackClaimCommand(input: {
  orgId: string;
  claimId: number;
  commandId: number;
  status: 'acked' | 'failed' | 'uncertain';
  result: unknown;
}, executor?: QueryExecutor): Promise<ClaimCommand | null> {
  return atomic(executor, async (client) => {
    const updated = await client.query(
      `UPDATE agent_claim_commands
       SET status = $4, result = $5, acked_at = now()
       WHERE org_id = $1 AND claim_id = $2 AND id = $3 AND status = 'delivered'
       RETURNING *`,
      [input.orgId, input.claimId, input.commandId, input.status, JSON.stringify(input.result)],
    );
    if (updated.rows.length === 0) return null;
    const command = updated.rows[0];
    if (command.kind === 'permission' || command.kind === 'elicitation') {
      const requestStatus = input.status === 'acked' ? 'resolved' : input.status === 'failed' ? 'open' : 'uncertain';
      const response = input.status === 'failed' ? null : JSON.stringify(input.result);
      const resolvedAt = input.status === 'failed' ? null : new Date();
      await client.query(
        `UPDATE agent_claim_requests
         SET status = $4, response = $5, resolved_at = $6
         WHERE org_id = $1 AND claim_id = $2 AND status = 'answer_queued'
           AND request_key = $3`,
        [input.orgId, input.claimId, command.request_key, requestStatus, response, resolvedAt],
      );
    }
    return commandFromRow(command);
  });
}

export async function cancelOpenClaimInteractions(input: {
  orgId: string;
  claimId: number;
}, executor?: QueryExecutor): Promise<void> {
  await atomic(executor, async (client) => {
    await client.query(
      `UPDATE agent_claim_requests
       SET status = 'cancelled', resolved_at = now()
       WHERE org_id = $1 AND claim_id = $2 AND status IN ('open', 'answer_queued')`,
      [input.orgId, input.claimId],
    );
    await client.query(
      `UPDATE agent_claim_commands
       SET status = 'cancelled', acked_at = now()
       WHERE org_id = $1 AND claim_id = $2 AND status = 'pending'`,
      [input.orgId, input.claimId],
    );
  });
}
