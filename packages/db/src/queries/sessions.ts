import { query } from '../pool.js';
import { sessionSchema } from '../schemas/sessions.js';
import type { Session } from '../schemas/sessions.js';
import { SESSION_STATUS_AT_READ_TIME } from './_helpers.js';

export async function getAgentSessions(orgId: string, agentId: string): Promise<Session[]> {
  // Compute status at read time so a session whose TTL expired without the
  // runner cleanly marking itself offline surfaces as 'offline'. Matches
  // listAgents(); writers untouched, readers don't trust stale 'online'.
  const sql = `
    SELECT
      id, org_id, agent_id, session_meta, registered_at, last_seen_at, expires_at,
      ${SESSION_STATUS_AT_READ_TIME} AS status
    FROM agent_sessions
    WHERE org_id = $1 AND agent_id = $2
    ORDER BY last_seen_at DESC
    LIMIT 50
  `;
  const result = await query(sql, [orgId, agentId]);
  return result.rows.map((row: unknown) => sessionSchema.parse(row));
}
