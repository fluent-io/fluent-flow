import { query } from '../pool.js';
import { agentListItemSchema, agentSchema } from '../schemas/agents.js';
import type { AgentListItem, Agent } from '../schemas/agents.js';

export async function listAgents(orgIds: string[]): Promise<AgentListItem[]> {
  const isSuper = orgIds.length === 0;

  // Status is computed at read time: a stored 'online'/'busy' that has
  // outlived its TTL surfaces as 'offline'. Writers keep setting status
  // directly; readers don't trust stale 'online' rows left behind when a
  // runner dies without hitting the /offline endpoint.
  const sql = `
    SELECT a.*,
      s.status,
      s.last_seen_at
    FROM agents a
    LEFT JOIN LATERAL (
      SELECT
        CASE
          WHEN status <> 'offline' AND expires_at > NOW() THEN status
          ELSE 'offline'
        END AS status,
        last_seen_at
      FROM agent_sessions
      WHERE agent_id = a.id AND org_id = a.org_id
      ORDER BY last_seen_at DESC NULLS LAST
      LIMIT 1
    ) s ON true
    ${isSuper ? '' : 'WHERE a.org_id = ANY($1)'}
    ORDER BY a.id
  `;

  const result = isSuper ? await query(sql) : await query(sql, [orgIds]);
  return result.rows.map((row: unknown) => agentListItemSchema.parse(row));
}

export async function getAgentDetail(orgIds: string[], agentId: string): Promise<Agent | null> {
  const isSuper = orgIds.length === 0;

  const sql = isSuper
    ? `SELECT * FROM agents WHERE id = $1`
    : `SELECT * FROM agents WHERE id = $1 AND org_id = ANY($2)`;

  const params = isSuper ? [agentId] : [agentId, orgIds];
  const result = await query(sql, params);

  if (result.rows.length === 0) return null;
  return agentSchema.parse(result.rows[0]);
}

export interface CreateAgentInput {
  id: string;
  orgId: string;
  agentType: string;
  transport: string;
  transportMeta?: Record<string, unknown>;
  repos?: string[];
}

/**
 * Insert an agent row. Used by both the dashboard's session-authed "+ New
 * agent" flow and the fluent-flow server's MCP admin API (which wraps this
 * with audit + logging).
 */
export async function createAgent(input: CreateAgentInput): Promise<Agent> {
  const sql = `
    INSERT INTO agents (id, org_id, agent_type, transport, transport_meta, repos)
    VALUES ($1, $2, $3, $4, $5, $6)
    RETURNING *
  `;
  const result = await query(sql, [
    input.id,
    input.orgId,
    input.agentType,
    input.transport,
    input.transportMeta ?? {},
    input.repos ?? [],
  ]);
  return agentSchema.parse(result.rows[0]);
}
