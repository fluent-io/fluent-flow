import { query } from '../pool';
import { agentListItemSchema, agentSchema } from '../schemas/agents';
import type { AgentListItem, Agent } from '../schemas/agents';

export async function listAgents(orgIds: string[]): Promise<AgentListItem[]> {
  const isSuper = orgIds.length === 0;

  const sql = `
    SELECT a.*,
      s.status,
      s.last_seen_at
    FROM agents a
    LEFT JOIN LATERAL (
      SELECT status, last_seen_at
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
