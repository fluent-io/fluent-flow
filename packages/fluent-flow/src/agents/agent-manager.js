import { and, eq, sql } from 'drizzle-orm';
import { db, schema } from '@fluent-flow/db';
import { audit } from '../db/client.js';
import logger from '../logger.js';

const { agents } = schema;

/**
 * Create an agent.
 */
export async function createAgent({ id, orgId, agentType, transport, transportMeta = {}, repos = [] }) {
  const [row] = await db
    .insert(agents)
    .values({ id, orgId, agentType, transport, transportMeta, repos })
    .returning();
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
  return row ?? null;
}

/**
 * List all agents for an org.
 */
export async function listAgents(orgId) {
  return db.select().from(agents).where(eq(agents.orgId, orgId)).orderBy(agents.createdAt);
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
  return row ?? null;
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
