import { query } from '../pool.js';
import { sessionSchema } from '../schemas/sessions.js';
import type { Session } from '../schemas/sessions.js';

export async function getAgentSessions(orgId: string, agentId: string): Promise<Session[]> {
  const sql = `
    SELECT * FROM agent_sessions
    WHERE org_id = $1 AND agent_id = $2
    ORDER BY last_seen_at DESC
    LIMIT 50
  `;
  const result = await query(sql, [orgId, agentId]);
  return result.rows.map((row: unknown) => sessionSchema.parse(row));
}
