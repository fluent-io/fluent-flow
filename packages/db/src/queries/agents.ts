import { getPool, query } from '../pool.js';
import { agentDetailSchema, agentListItemSchema, agentSchema } from '../schemas/agents.js';
import type { AgentDetail, AgentListItem, Agent } from '../schemas/agents.js';
import { SESSION_STATUS_AT_READ_TIME } from './_helpers.js';
import { createEnrollmentToken } from './tokens.js';

const MIN_CAPACITY = 1;
const MAX_CAPACITY = 16;

function validCapacity(meta: string): string {
  return `CASE WHEN jsonb_typeof(${meta} -> 'capacity') = 'number' THEN
            CASE WHEN (${meta} ->> 'capacity')::numeric BETWEEN ${MIN_CAPACITY} AND ${MAX_CAPACITY}
                  AND (${meta} ->> 'capacity')::numeric % 1 = 0
              THEN (${meta} ->> 'capacity')::numeric::int
            END
          END`;
}

function validDeployment(meta: string): string {
  return `CASE WHEN jsonb_typeof(${meta} -> 'deployment') = 'string'
            AND ${meta} ->> 'deployment' IN ('local', 'self_hosted', 'hosted')
          THEN ${meta} ->> 'deployment'
          END`;
}

const SLOT_AGGREGATE_LATERAL = `
    JOIN LATERAL (
      WITH slot AS (
        SELECT
          id,
          status,
          last_seen_at,
          instance_id,
          capacity,
          deployment,
          status <> 'offline' AS live,
          CASE
            WHEN instance_id IS NOT NULL AND slot_id IS NOT NULL
              THEN jsonb_build_array(instance_id, slot_id)::text
            ELSE id::text
          END AS slot_key
        FROM (
          SELECT
            id,
            ${SESSION_STATUS_AT_READ_TIME} AS status,
            last_seen_at,
            CASE WHEN jsonb_typeof(session_meta -> 'instance_id') = 'string'
              AND session_meta ->> 'instance_id' <> ''
              THEN session_meta ->> 'instance_id'
            END AS instance_id,
            CASE WHEN jsonb_typeof(session_meta -> 'slot_id') = 'number'
              THEN session_meta ->> 'slot_id'
            END AS slot_id,
            ${validCapacity('session_meta')} AS capacity,
            ${validDeployment('session_meta')} AS deployment
          FROM agent_sessions
          WHERE agent_id = a.id AND org_id = a.org_id
        ) raw
      )
      SELECT
        count(DISTINCT slot_key) FILTER (WHERE live)::int AS active_slots,
        CASE
          WHEN count(*) FILTER (WHERE status = 'busy') > 0 THEN 'busy'
          WHEN count(*) FILTER (WHERE live) > 0 THEN 'online'
          ELSE 'offline'
        END AS status,
        max(last_seen_at) AS last_seen_at,
        COALESCE(
          (
            SELECT sum(instance_capacity.capacity)::int
            FROM (
              SELECT DISTINCT ON (instance_id) capacity
              FROM slot
              WHERE live AND instance_id IS NOT NULL AND capacity IS NOT NULL
              ORDER BY instance_id, last_seen_at DESC NULLS LAST, id DESC
            ) instance_capacity
          ),
          (array_agg(capacity ORDER BY last_seen_at DESC NULLS LAST, id DESC)
            FILTER (WHERE live AND instance_id IS NULL AND capacity IS NOT NULL))[1],
          ${validCapacity('a.transport_meta')}
        ) AS capacity,
        COALESCE(
          (array_agg(deployment ORDER BY last_seen_at DESC NULLS LAST, id DESC)
            FILTER (WHERE live AND deployment IS NOT NULL))[1],
          ${validDeployment('a.transport_meta')}
        ) AS deployment
      FROM slot
    ) s ON true`;

export async function listAgents(orgIds: string[], isSuperadmin = false): Promise<AgentListItem[]> {
  if (orgIds.length === 0 && !isSuperadmin) return [];
  const isSuper = isSuperadmin && orgIds.length === 0;

  const sql = `
    SELECT a.*,
      s.status,
      s.last_seen_at,
      s.active_slots,
      s.capacity,
      s.deployment
    FROM agents a
    ${SLOT_AGGREGATE_LATERAL}
    ${isSuper ? '' : 'WHERE a.org_id = ANY($1)'}
    ORDER BY a.id
  `;

  const result = isSuper ? await query(sql) : await query(sql, [orgIds]);
  return result.rows.map((row: unknown) => agentListItemSchema.parse(row));
}

export async function getAgentDetail(orgIds: string[], agentId: string, isSuperadmin = false): Promise<AgentDetail | null> {
  if (orgIds.length === 0 && !isSuperadmin) return null;
  const isSuper = isSuperadmin && orgIds.length === 0;

  const sql = `
    SELECT a.*,
      s.status,
      s.last_seen_at,
      s.active_slots,
      s.capacity,
      s.deployment
    FROM agents a
    ${SLOT_AGGREGATE_LATERAL}
    WHERE a.id = $1${isSuper ? '' : ' AND a.org_id = ANY($2)'}
  `;

  const params = isSuper ? [agentId] : [agentId, orgIds];
  const result = await query(sql, params);

  if (result.rows.length === 0) return null;
  return agentDetailSchema.parse(result.rows[0]);
}

export interface CreateAgentInput {
  id: string;
  orgId: string;
  agentType: string;
  transport: string;
  transportMeta?: Record<string, unknown>;
  repos?: string[];
}

async function insertAgent(
  input: CreateAgentInput,
  execute: (text: string, params?: unknown[]) => Promise<{ rows: unknown[] }>,
): Promise<Agent> {
  const result = await execute(
    `INSERT INTO agents (id, org_id, agent_type, transport, transport_meta, repos)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [
      input.id,
      input.orgId,
      input.agentType,
      input.transport,
      input.transportMeta ?? {},
      input.repos ?? [],
    ],
  );
  return agentSchema.parse(result.rows[0]);
}

export async function createAgent(input: CreateAgentInput): Promise<Agent> {
  return insertAgent(input, query);
}

export async function createAgentWithEnrollment(
  agentInput: CreateAgentInput,
  enrollmentExpiresAt?: Date,
): Promise<{
  agent: Agent;
  enrollment: { plaintext: string; id: number };
}> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const agent = await insertAgent(
      agentInput,
      (text, params) => client.query(text, params),
    );
    const enrollment = await createEnrollmentToken(
      {
        orgId: agentInput.orgId,
        agentId: agentInput.id,
        ...(enrollmentExpiresAt === undefined ? {} : { expiresAt: enrollmentExpiresAt }),
      },
      client,
    );
    await client.query('COMMIT');
    return { agent, enrollment };
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackError) {
      throw new AggregateError([err, rollbackError], 'Agent enrollment failed and rollback also failed');
    }
    throw err;
  } finally {
    client.release();
  }
}

export async function deleteAgentIfNoCollaborationClaims(
  orgId: string,
  agentId: string,
): Promise<'deleted' | 'not_found' | 'protected'> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const agent = await client.query(
      `SELECT id FROM agents WHERE org_id = $1 AND id = $2 FOR UPDATE`,
      [orgId, agentId],
    );
    if (agent.rows.length === 0) {
      await client.query('COMMIT');
      return 'not_found';
    }
    const claims = await client.query<{ id: number }>(
      `SELECT claim.id
       FROM agent_claims claim
       JOIN agent_sessions session ON session.id = claim.session_id AND session.org_id = claim.org_id
       WHERE session.org_id = $1 AND session.agent_id = $2
       FOR UPDATE OF claim`,
      [orgId, agentId],
    );
    const claimIds = claims.rows.map((claim) => claim.id);
    if (claimIds.length > 0) {
      const linked = await client.query<{ linked: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM collab_claim_executions WHERE claim_id = ANY($1::integer[])
         ) AS linked`,
        [claimIds],
      );
      if (linked.rows[0].linked) {
        await client.query('COMMIT');
        return 'protected';
      }
      await client.query(`DELETE FROM agent_claims WHERE id = ANY($1::integer[])`, [claimIds]);
    }
    await client.query(`DELETE FROM agents WHERE org_id = $1 AND id = $2`, [orgId, agentId]);
    await client.query('COMMIT');
    return 'deleted';
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
