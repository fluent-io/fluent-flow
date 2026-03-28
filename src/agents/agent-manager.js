import { query, audit } from '../db/client.js';
import logger from '../logger.js';

/**
 * Create an agent.
 * @param {object} opts
 * @param {string} opts.id
 * @param {string} opts.orgId
 * @param {string} opts.agentType
 * @param {string} opts.transport
 * @param {object} [opts.transportMeta={}]
 * @param {string[]} [opts.repos=[]]
 * @returns {Promise<object>}
 */
export async function createAgent({ id, orgId, agentType, transport, transportMeta = {}, repos = [] }) {
  const result = await query(
    `INSERT INTO agents (id, org_id, agent_type, transport, transport_meta, repos)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [id, orgId, agentType, transport, JSON.stringify(transportMeta), repos]
  );
  audit('agent_created', { data: { orgId, agentId: id } });
  logger.info({ msg: 'Agent created', orgId, agentId: id, agentType, transport });
  return result.rows[0];
}

/**
 * Get an agent by org + id.
 * @param {string} orgId
 * @param {string} agentId
 * @returns {Promise<object|null>}
 */
export async function getAgent(orgId, agentId) {
  const result = await query(
    `SELECT * FROM agents WHERE org_id = $1 AND id = $2`,
    [orgId, agentId]
  );
  return result.rows[0] ?? null;
}

/**
 * List all agents for an org.
 * @param {string} orgId
 * @returns {Promise<Array>}
 */
export async function listAgents(orgId) {
  const result = await query(
    `SELECT * FROM agents WHERE org_id = $1 ORDER BY created_at`,
    [orgId]
  );
  return result.rows;
}

/**
 * Update agent fields.
 * @param {string} orgId
 * @param {string} agentId
 * @param {object} fields
 * @returns {Promise<object|null>}
 */
export async function updateAgent(orgId, agentId, fields) {
  const setClauses = [];
  const params = [];
  let idx = 1;

  if (fields.agentType !== undefined) { setClauses.push(`agent_type = $${idx++}`); params.push(fields.agentType); }
  if (fields.transport !== undefined) { setClauses.push(`transport = $${idx++}`); params.push(fields.transport); }
  if (fields.transportMeta !== undefined) { setClauses.push(`transport_meta = $${idx++}`); params.push(JSON.stringify(fields.transportMeta)); }
  if (fields.repos !== undefined) { setClauses.push(`repos = $${idx++}`); params.push(fields.repos); }
  setClauses.push(`updated_at = NOW()`);

  params.push(orgId, agentId);
  const result = await query(
    `UPDATE agents SET ${setClauses.join(', ')} WHERE org_id = $${idx++} AND id = $${idx} RETURNING *`,
    params
  );
  if (result.rows[0]) {
    audit('agent_updated', { data: { orgId, agentId, fields: Object.keys(fields) } });
  }
  return result.rows[0] ?? null;
}

/**
 * Delete an agent.
 * @param {string} orgId
 * @param {string} agentId
 * @returns {Promise<boolean>}
 */
export async function deleteAgent(orgId, agentId) {
  const result = await query(
    `DELETE FROM agents WHERE org_id = $1 AND id = $2`,
    [orgId, agentId]
  );
  if (result.rowCount > 0) {
    audit('agent_deleted', { data: { orgId, agentId } });
  }
  return result.rowCount > 0;
}
