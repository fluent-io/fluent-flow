import { query } from '../pool.js';
import { claimSchema } from '../schemas/claims.js';
import type { Claim } from '../schemas/claims.js';

export async function getAgentClaims(orgId: string, agentId: string): Promise<Claim[]> {
  const sql = `
    SELECT c.* FROM agent_claims c
    JOIN agent_sessions s ON c.session_id = s.id
    WHERE c.org_id = $1 AND s.agent_id = $2
    ORDER BY c.created_at DESC
    LIMIT 100
  `;
  const result = await query(sql, [orgId, agentId]);
  return result.rows.map((row: unknown) => claimSchema.parse(row));
}
