import { and, eq, sql } from 'drizzle-orm';
import { db, schema, createAgent as dbCreateAgent } from '@fluent-flow/db';
import { audit } from '../db/client.js';
import logger from '../logger.js';

const { agents } = schema;

/**
 * Normalize a Drizzle camelCase agent row to the snake_case shape the rest of
 * the app reads. The legacy raw-pg code returned postgres-native snake_case,
 * and consumers like `notifications/dispatcher.js` (which reads
 * `dbAgent.agent_type` and spreads `dbAgent.transport_meta`) + the HTTP API
 * surface (routes/agents.js uses snake_case request bodies, so responses
 * should match) rely on that shape.
 */
function toSnakeAgent(row) {
  if (!row) return row;
  return {
    id: row.id,
    org_id: row.orgId,
    agent_type: row.agentType,
    transport: row.transport,
    transport_meta: row.transportMeta,
    repos: row.repos,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  };
}

/**
 * Create an agent. Delegates the insert to @fluent-flow/db and keeps the
 * audit + logging side-effects here — the dashboard calls the db version
 * directly (different auth surface) so audits must live at the server's
 * write boundary, not in the db package.
 */
export async function createAgent({ id, orgId, agentType, transport, transportMeta = {}, repos = [] }) {
  const row = await dbCreateAgent({ id, orgId, agentType, transport, transportMeta, repos });
  audit('agent_created', { data: { orgId, agentId: id } });
  logger.info({ msg: 'Agent created', orgId, agentId: id, agentType, transport });
  return row;
}

/**
 * Get an agent by org + id.
 */
export async function getAgent(orgId, agentId) {
  const [row] = await db
    .select()
    .from(agents)
    .where(and(eq(agents.orgId, orgId), eq(agents.id, agentId)))
    .limit(1);
  return toSnakeAgent(row) ?? null;
}

/**
 * List all agents for an org.
 */
export async function listAgents(orgId) {
  const rows = await db.select().from(agents).where(eq(agents.orgId, orgId)).orderBy(agents.createdAt);
  return rows.map(toSnakeAgent);
}

/**
 * Update agent fields.
 */
export async function updateAgent(orgId, agentId, fields) {
  const set = { updatedAt: sql`NOW()` };
  const appliedFields = [];
  if (fields.agentType !== undefined) { set.agentType = fields.agentType; appliedFields.push('agentType'); }
  if (fields.transport !== undefined) { set.transport = fields.transport; appliedFields.push('transport'); }
  if (fields.transportMeta !== undefined) { set.transportMeta = fields.transportMeta; appliedFields.push('transportMeta'); }
  if (fields.repos !== undefined) { set.repos = fields.repos; appliedFields.push('repos'); }

  const [row] = await db
    .update(agents)
    .set(set)
    .where(and(eq(agents.orgId, orgId), eq(agents.id, agentId)))
    .returning();
  if (row) audit('agent_updated', { data: { orgId, agentId, fields: appliedFields } });
  return toSnakeAgent(row) ?? null;
}

/**
 * Delete an agent.
 */
export async function deleteAgent(orgId, agentId) {
  const result = await db
    .delete(agents)
    .where(and(eq(agents.orgId, orgId), eq(agents.id, agentId)));
  const deleted = (result.rowCount ?? 0) > 0;
  if (deleted) audit('agent_deleted', { data: { orgId, agentId } });
  return deleted;
}
