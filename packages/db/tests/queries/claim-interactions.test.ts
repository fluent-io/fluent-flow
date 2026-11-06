import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ackClaimCommand,
  appendClaimEvents,
  cancelOpenClaimInteractions,
  cancelClaimRequest,
  dismissClaim,
  dismissPipelineClaims,
  dismissStaleClaims,
  enqueueClaimCommand,
  renewClaimCommand,
  leaseClaimCommands,
  reserveClaimRequestAnswer,
  resolveClaimRequest,
  upsertClaimRequest,
} from '../../src/queries/index.js';
import { closePool, getPool } from '../../src/pool.js';
import { runMigrations } from '../../src/migrate.js';
import {
  resetCollabSchema,
  resolveCollabTestDatabaseUrl,
} from '../helpers/collab-db.js';

process.env.DATABASE_URL = resolveCollabTestDatabaseUrl();
const databaseUrl = process.env.DATABASE_URL;
const orgId = 'claim-interactions-test';
let attempt = 0;

async function createClaim() {
  attempt += 1;
  const { rows } = await getPool().query<{ id: number }>(
    `INSERT INTO agent_claims (org_id, repo, pr_number, attempt, claim_type, status, payload)
     VALUES ($1, $2, $3, $4, 'build', 'claimed', '{}'::jsonb)
     RETURNING id`,
    [orgId, 'fluent-io/claim-interactions', 127, attempt],
  );
  return rows[0].id;
}

async function commandStatus(commandId: number) {
  const { rows } = await getPool().query<{ status: string }>(
    'SELECT status FROM agent_claim_commands WHERE id = $1',
    [commandId],
  );
  return rows[0]?.status ?? null;
}

describe('claim interaction persistence', () => {
  beforeAll(async () => {
    await resetCollabSchema(databaseUrl);
    await runMigrations();
    await getPool().query('INSERT INTO orgs (id, name) VALUES ($1, $2)', [orgId, 'Claim interactions']);
  });

  afterAll(async () => {
    await closePool();
  });

  it('replays an identical event batch without inserting duplicates', async () => {
    const claimId = await createClaim();
    const input = {
      orgId,
      claimId,
      events: [
        { seq: 1, kind: 'user_message', payload: { text: 'hello' } },
        { seq: 2, kind: 'agent_message', payload: { text: 'world' } },
      ],
    };

    await expect(appendClaimEvents(input)).resolves.toEqual({ inserted: 2, lastSeq: 2 });
    await expect(appendClaimEvents(input)).resolves.toEqual({ inserted: 0, lastSeq: 2 });

    const { rows } = await getPool().query(
      'SELECT seq, kind, payload FROM agent_claim_events WHERE org_id = $1 AND claim_id = $2 ORDER BY seq',
      [orgId, claimId],
    );
    expect(rows).toEqual([
      { seq: 1, kind: 'user_message', payload: { text: 'hello' } },
      { seq: 2, kind: 'agent_message', payload: { text: 'world' } },
    ]);
  });

  it('repairs a legacy null byte count during an exact event replay', async () => {
    const claimId = await createClaim();
    const payload = { text: 'legacy event' };
    await getPool().query(
      'ALTER TABLE agent_claim_events DROP CONSTRAINT agent_claim_events_payload_bytes_not_null',
    );
    await getPool().query(
      `INSERT INTO agent_claim_events (org_id, claim_id, seq, kind, payload, payload_bytes)
       VALUES ($1, $2, 1, 'notice', $3, NULL)`,
      [orgId, claimId, JSON.stringify(payload)],
    );
    await getPool().query(
      `ALTER TABLE agent_claim_events
       ADD CONSTRAINT agent_claim_events_payload_bytes_not_null
       CHECK (payload_bytes IS NOT NULL) NOT VALID`,
    );

    await expect(appendClaimEvents({
      orgId,
      claimId,
      events: [{ seq: 1, kind: 'notice', payload }],
    })).resolves.toEqual({ inserted: 0, lastSeq: 1 });

    const { rows } = await getPool().query<{ payload_bytes: number; canonical_bytes: number }>(
      `SELECT payload_bytes, octet_length(payload::text) AS canonical_bytes
       FROM agent_claim_events
       WHERE org_id = $1 AND claim_id = $2 AND seq = 1`,
      [orgId, claimId],
    );
    expect(rows[0].payload_bytes).toBe(rows[0].canonical_bytes);
  });

  it('rejects a sequence replayed with a different kind or payload', async () => {
    const claimId = await createClaim();
    await appendClaimEvents({
      orgId,
      claimId,
      events: [{ seq: 1, kind: 'notice', payload: { text: 'first' } }],
    });

    await expect(appendClaimEvents({
      orgId,
      claimId,
      events: [{ seq: 1, kind: 'notice', payload: { text: 'changed' } }],
    })).rejects.toThrow();
    await expect(appendClaimEvents({
      orgId,
      claimId,
      events: [{ seq: 1, kind: 'agent_message', payload: { text: 'first' } }],
    })).rejects.toThrow();
  });

  it('returns the existing request for an exact request replay', async () => {
    const claimId = await createClaim();
    const input = {
      orgId,
      claimId,
      requestKey: 'permission-1',
      kind: 'permission' as const,
      payload: { title: 'Allow edit?', options: ['allow', 'deny'] },
    };

    const first = await upsertClaimRequest(input);
    const replay = await upsertClaimRequest(input);

    expect(replay).toEqual(first);
    const { rows } = await getPool().query(
      'SELECT request_key FROM agent_claim_requests WHERE org_id = $1 AND claim_id = $2',
      [orgId, claimId],
    );
    expect(rows).toEqual([{ request_key: 'permission-1' }]);
  });

  it('atomically reserves one answer and creates one command', async () => {
    const claimId = await createClaim();
    await upsertClaimRequest({
      orgId,
      claimId,
      requestKey: 'question-1',
      kind: 'elicitation',
      payload: { prompt: 'Choose one' },
    });

    const [first, second] = await Promise.all([
      reserveClaimRequestAnswer({
        orgId,
        claimId,
        requestKey: 'question-1',
        idempotencyKey: 'answer-a',
        kind: 'elicitation',
        payload: { answer: 'A' },
      }),
      reserveClaimRequestAnswer({
        orgId,
        claimId,
        requestKey: 'question-1',
        idempotencyKey: 'answer-b',
        kind: 'elicitation',
        payload: { answer: 'B' },
      }),
    ]);

    expect([first, second].filter(Boolean)).toHaveLength(1);
    expect([first, second].filter((value) => value === null)).toHaveLength(1);
    const { rows: requests } = await getPool().query(
      'SELECT status, response FROM agent_claim_requests WHERE org_id = $1 AND claim_id = $2',
      [orgId, claimId],
    );
    const { rows: commands } = await getPool().query(
      'SELECT idempotency_key, request_key, status FROM agent_claim_commands WHERE org_id = $1 AND claim_id = $2',
      [orgId, claimId],
    );
    expect(requests).toEqual([{ status: 'answer_queued', response: null }]);
    expect(commands).toHaveLength(1);
    expect(commands[0]).toEqual(expect.objectContaining({
      request_key: 'question-1',
      status: 'pending',
    }));
  });

  it('replays an identical command and rejects the same key with a changed body', async () => {
    const claimId = await createClaim();
    const input = {
      orgId,
      claimId,
      idempotencyKey: 'prompt-1',
      kind: 'prompt' as const,
      payload: { text: 'Do the work' },
    };

    const first = await enqueueClaimCommand(input);
    const replay = await enqueueClaimCommand(input);
    expect(first.created).toBe(true);
    expect(replay).toEqual({ command: first.command, created: false });

    await expect(enqueueClaimCommand({
      ...input,
      payload: { text: 'Do different work' },
    })).rejects.toThrow();
    await expect(enqueueClaimCommand({
      ...input,
      kind: 'cancel',
    })).rejects.toThrow();
  });

  it('leases only pending commands', async () => {
    const claimId = await createClaim();
    const first = await enqueueClaimCommand({
      orgId,
      claimId,
      idempotencyKey: 'pending-1',
      kind: 'prompt',
      payload: { text: 'first' },
    });
    const second = await enqueueClaimCommand({
      orgId,
      claimId,
      idempotencyKey: 'pending-2',
      kind: 'cancel',
      payload: {},
    });

    const leased = await leaseClaimCommands({ orgId, claimId, limit: 1 });
    expect(leased).toHaveLength(1);
    expect(leased[0].id).toBe(first.command.id);
    expect(leased[0].status).toBe('delivered');

    const next = await leaseClaimCommands({ orgId, claimId, limit: 10 });
    expect(next.map((command) => command.id)).toEqual([second.command.id]);
    expect(await commandStatus(first.command.id)).toBe('delivered');
  });

  it('marks a delivered answer and its request uncertain after the acknowledgement deadline', async () => {
    const claimId = await createClaim();
    await upsertClaimRequest({
      orgId,
      claimId,
      requestKey: 'lost-answer-request',
      kind: 'permission',
      payload: { action: 'write' },
    });
    const reserved = await reserveClaimRequestAnswer({
      orgId,
      claimId,
      requestKey: 'lost-answer-request',
      idempotencyKey: 'lost-answer',
      kind: 'permission',
      payload: { behavior: 'allow' },
    });
    await leaseClaimCommands({ orgId, claimId, limit: 1 });
    await getPool().query(
      `UPDATE agent_claim_commands SET delivered_at = NOW() - INTERVAL '91 seconds' WHERE id = $1`,
      [reserved!.command.id],
    );

    await expect(leaseClaimCommands({ orgId, claimId, limit: 10 })).resolves.toEqual([]);
    expect(await commandStatus(reserved!.command.id)).toBe('uncertain');
    const { rows } = await getPool().query(
      'SELECT status FROM agent_claim_requests WHERE org_id = $1 AND claim_id = $2 AND request_key = $3',
      [orgId, claimId, 'lost-answer-request'],
    );
    expect(rows).toEqual([{ status: 'uncertain' }]);
  });

  it('renews only a command whose acknowledgement deadline is still active', async () => {
    const claimId = await createClaim();
    const fresh = await enqueueClaimCommand({
      orgId,
      claimId,
      idempotencyKey: 'renew-fresh',
      kind: 'prompt',
      payload: { text: 'fresh' },
    });
    const stale = await enqueueClaimCommand({
      orgId,
      claimId,
      idempotencyKey: 'renew-stale',
      kind: 'prompt',
      payload: { text: 'stale' },
    });
    await leaseClaimCommands({ orgId, claimId, limit: 2 });
    await getPool().query(
      `UPDATE agent_claim_commands SET delivered_at = NOW() - INTERVAL '91 seconds' WHERE id = $1`,
      [stale.command.id],
    );

    await expect(renewClaimCommand({ orgId, claimId, commandId: fresh.command.id }))
      .resolves.toMatchObject({ id: fresh.command.id, status: 'delivered' });
    await expect(renewClaimCommand({ orgId, claimId, commandId: stale.command.id }))
      .resolves.toBeNull();
    expect(await commandStatus(stale.command.id)).toBe('uncertain');
  });

  it('resolves its request when an answer command is acknowledged', async () => {
    const claimId = await createClaim();
    await upsertClaimRequest({
      orgId,
      claimId,
      requestKey: 'ack-request',
      kind: 'permission',
      payload: { action: 'write' },
    });
    const reserved = await reserveClaimRequestAnswer({
      orgId,
      claimId,
      requestKey: 'ack-request',
      idempotencyKey: 'ack-answer',
      kind: 'permission',
      payload: { behavior: 'allow' },
    });
    await leaseClaimCommands({ orgId, claimId, limit: 1 });

    const command = await ackClaimCommand({
      orgId,
      claimId,
      commandId: reserved!.command.id,
      status: 'acked',
      result: { accepted: true },
    });
    const { rows } = await getPool().query(
      'SELECT status, response, resolved_at FROM agent_claim_requests WHERE org_id = $1 AND claim_id = $2',
      [orgId, claimId],
    );

    expect(command?.status).toBe('acked');
    expect(rows[0]).toEqual(expect.objectContaining({ status: 'resolved', response: { accepted: true } }));
    expect(rows[0].resolved_at).toBeInstanceOf(Date);
  });

  it('reopens a request after definite answer failure', async () => {
    const claimId = await createClaim();
    await upsertClaimRequest({
      orgId,
      claimId,
      requestKey: 'failed-request',
      kind: 'elicitation',
      payload: { prompt: 'Answer' },
    });
    const reserved = await reserveClaimRequestAnswer({
      orgId,
      claimId,
      requestKey: 'failed-request',
      idempotencyKey: 'failed-answer',
      kind: 'elicitation',
      payload: { answer: 'value' },
    });
    await leaseClaimCommands({ orgId, claimId, limit: 1 });

    await ackClaimCommand({
      orgId,
      claimId,
      commandId: reserved!.command.id,
      status: 'failed',
      result: { applied: false },
    });
    const { rows } = await getPool().query(
      'SELECT status, response, resolved_at FROM agent_claim_requests WHERE org_id = $1 AND claim_id = $2',
      [orgId, claimId],
    );
    expect(rows).toEqual([{ status: 'open', response: null, resolved_at: null }]);
  });

  it('makes a request uncertain after ambiguous answer delivery', async () => {
    const claimId = await createClaim();
    await upsertClaimRequest({
      orgId,
      claimId,
      requestKey: 'uncertain-request',
      kind: 'permission',
      payload: { action: 'execute' },
    });
    const reserved = await reserveClaimRequestAnswer({
      orgId,
      claimId,
      requestKey: 'uncertain-request',
      idempotencyKey: 'uncertain-answer',
      kind: 'permission',
      payload: { behavior: 'allow' },
    });
    await leaseClaimCommands({ orgId, claimId, limit: 1 });

    await ackClaimCommand({
      orgId,
      claimId,
      commandId: reserved!.command.id,
      status: 'uncertain',
      result: { reason: 'connection_lost' },
    });
    const { rows } = await getPool().query(
      'SELECT status, response FROM agent_claim_requests WHERE org_id = $1 AND claim_id = $2',
      [orgId, claimId],
    );
    expect(rows).toEqual([{ status: 'uncertain', response: { reason: 'connection_lost' } }]);
    await expect(reserveClaimRequestAnswer({
      orgId,
      claimId,
      requestKey: 'uncertain-request',
      idempotencyKey: 'replacement-answer',
      kind: 'permission',
      payload: { behavior: 'deny' },
    })).resolves.toBeNull();
  });

  it('cancels a persisted ACP request and makes a late failed answer acknowledgement terminal', async () => {
    const claimId = await createClaim();
    await upsertClaimRequest({
      orgId,
      claimId,
      requestKey: 'cancelled-request',
      kind: 'permission',
      payload: { action: 'write' },
    });
    const reserved = await reserveClaimRequestAnswer({
      orgId,
      claimId,
      requestKey: 'cancelled-request',
      idempotencyKey: 'cancelled-answer',
      kind: 'permission',
      payload: { behavior: 'allow' },
    });
    await leaseClaimCommands({ orgId, claimId, limit: 1 });

    await expect(cancelClaimRequest({ orgId, claimId, requestKey: 'cancelled-request' }))
      .resolves.toMatchObject({ status: 'cancelled' });
    await ackClaimCommand({
      orgId,
      claimId,
      commandId: reserved!.command.id,
      status: 'failed',
      result: { error: 'request closed' },
    });
    const { rows } = await getPool().query(
      'SELECT status FROM agent_claim_requests WHERE org_id = $1 AND claim_id = $2 AND request_key = $3',
      [orgId, claimId, 'cancelled-request'],
    );
    expect(rows).toEqual([{ status: 'cancelled' }]);
  });

  it('cancels an answer command that has not reached a runner when its ACP request closes', async () => {
    const claimId = await createClaim();
    await upsertClaimRequest({
      orgId,
      claimId,
      requestKey: 'cancelled-pending-request',
      kind: 'elicitation',
      payload: { prompt: 'Choose' },
    });
    const reserved = await reserveClaimRequestAnswer({
      orgId,
      claimId,
      requestKey: 'cancelled-pending-request',
      idempotencyKey: 'cancelled-pending-answer',
      kind: 'elicitation',
      payload: { answer: 'A' },
    });

    await cancelClaimRequest({ orgId, claimId, requestKey: 'cancelled-pending-request' });
    expect(await commandStatus(reserved!.command.id)).toBe('cancelled');
  });

  it('cancels only open interactions at terminal transition', async () => {
    const claimId = await createClaim();
    await upsertClaimRequest({
      orgId,
      claimId,
      requestKey: 'open-request',
      kind: 'permission',
      payload: { action: 'open' },
    });
    await upsertClaimRequest({
      orgId,
      claimId,
      requestKey: 'resolved-request',
      kind: 'elicitation',
      payload: { prompt: 'done' },
    });
    await resolveClaimRequest({
      orgId,
      claimId,
      requestKey: 'resolved-request',
      response: { answer: 'done' },
    });
    const pending = await enqueueClaimCommand({
      orgId,
      claimId,
      idempotencyKey: 'pending-at-terminal',
      kind: 'cancel',
      payload: {},
    });
    const acknowledged = await enqueueClaimCommand({
      orgId,
      claimId,
      idempotencyKey: 'acked-at-terminal',
      kind: 'prompt',
      payload: { text: 'already handled' },
    });
    await leaseClaimCommands({ orgId, claimId, limit: 2 });
    await ackClaimCommand({
      orgId,
      claimId,
      commandId: acknowledged.command.id,
      status: 'acked',
      result: { messageId: 'message-1' },
    });
    await getPool().query(
      `UPDATE agent_claim_commands SET status = 'pending', delivered_at = NULL WHERE id = $1`,
      [pending.command.id],
    );

    await cancelOpenClaimInteractions({ orgId, claimId });
    const { rows: requests } = await getPool().query(
      'SELECT request_key, status FROM agent_claim_requests WHERE org_id = $1 AND claim_id = $2 ORDER BY request_key',
      [orgId, claimId],
    );
    expect(requests).toEqual([
      { request_key: 'open-request', status: 'cancelled' },
      { request_key: 'resolved-request', status: 'resolved' },
    ]);
    expect(await commandStatus(pending.command.id)).toBe('cancelled');
    expect(await commandStatus(acknowledged.command.id)).toBe('acked');
  });

  it('closes pending interactions atomically when a legacy claim is dismissed', async () => {
    const claimId = await createClaim();
    await upsertClaimRequest({
      orgId,
      claimId,
      requestKey: 'single-dismiss-request',
      kind: 'permission',
      payload: { action: 'write' },
    });
    const command = await enqueueClaimCommand({
      orgId,
      claimId,
      idempotencyKey: 'single-dismiss-command',
      kind: 'cancel',
      payload: {},
    });

    await expect(dismissClaim(claimId, [orgId])).resolves.toBe(true);
    const { rows: requests } = await getPool().query(
      'SELECT status FROM agent_claim_requests WHERE org_id = $1 AND claim_id = $2',
      [orgId, claimId],
    );
    expect(requests).toEqual([{ status: 'cancelled' }]);
    expect(await commandStatus(command.command.id)).toBe('cancelled');
  });

  it('makes delivered answers uncertain when stale legacy claims are dismissed', async () => {
    const claimId = await createClaim();
    await upsertClaimRequest({
      orgId,
      claimId,
      requestKey: 'stale-dismiss-request',
      kind: 'permission',
      payload: { action: 'write' },
    });
    const reserved = await reserveClaimRequestAnswer({
      orgId,
      claimId,
      requestKey: 'stale-dismiss-request',
      idempotencyKey: 'stale-dismiss-answer',
      kind: 'permission',
      payload: { behavior: 'allow' },
    });
    await leaseClaimCommands({ orgId, claimId, limit: 1 });
    await getPool().query(
      `UPDATE agent_claims SET created_at = NOW() - INTERVAL '2 days' WHERE id = $1`,
      [claimId],
    );

    await expect(dismissStaleClaims([orgId], 1)).resolves.toBeGreaterThan(0);
    expect(await commandStatus(reserved!.command.id)).toBe('uncertain');
    const { rows: requests } = await getPool().query(
      'SELECT status FROM agent_claim_requests WHERE org_id = $1 AND claim_id = $2',
      [orgId, claimId],
    );
    expect(requests).toEqual([{ status: 'uncertain' }]);
  });

  it('closes pending interactions when a legacy pipeline is dismissed', async () => {
    const claimId = await createClaim();
    const command = await enqueueClaimCommand({
      orgId,
      claimId,
      idempotencyKey: 'pipeline-dismiss-command',
      kind: 'prompt',
      payload: { text: 'run later' },
    });

    await expect(dismissPipelineClaims([orgId], 'fluent-io/claim-interactions', 127))
      .resolves.toBeGreaterThan(0);
    expect(await commandStatus(command.command.id)).toBe('cancelled');
  });

  it('uses an optional external executor so its writes roll back with the caller', async () => {
    const claimId = await createClaim();
    const client = await getPool().connect();
    try {
      await client.query('BEGIN');
      await appendClaimEvents({
        orgId,
        claimId,
        events: [{ seq: 91, kind: 'notice', payload: { text: 'rolled back' } }],
      }, client);
      await enqueueClaimCommand({
        orgId,
        claimId,
        idempotencyKey: 'rolled-back-command',
        kind: 'prompt',
        payload: { text: 'rolled back' },
      }, client);
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }

    const { rows: events } = await getPool().query(
      'SELECT seq FROM agent_claim_events WHERE org_id = $1 AND claim_id = $2 AND seq = 91',
      [orgId, claimId],
    );
    const { rows: commands } = await getPool().query(
      'SELECT id FROM agent_claim_commands WHERE org_id = $1 AND claim_id = $2 AND idempotency_key = $3',
      [orgId, claimId, 'rolled-back-command'],
    );
    expect(events).toEqual([]);
    expect(commands).toEqual([]);
  });
});
