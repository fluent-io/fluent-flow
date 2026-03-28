import { query, audit } from '../db/client.js';
import logger from '../logger.js';

const SELF_HOSTED_ORG_ID = 'self-hosted';

/**
 * Create an org.
 * @param {string} id
 * @param {string} name
 * @param {object} [settings={}]
 * @returns {Promise<object>}
 */
export async function createOrg(id, name, settings = {}) {
  const result = await query(
    `INSERT INTO orgs (id, name, settings) VALUES ($1, $2, $3) RETURNING *`,
    [id, name, JSON.stringify(settings)]
  );
  audit('org_created', { data: { orgId: id } });
  return result.rows[0];
}

/**
 * Get an org by ID.
 * @param {string} id
 * @returns {Promise<object|null>}
 */
export async function getOrg(id) {
  const result = await query(`SELECT * FROM orgs WHERE id = $1`, [id]);
  return result.rows[0] ?? null;
}

/**
 * Bootstrap the default org for self-hosted deployments.
 * Idempotent — skips if the org already exists.
 * @returns {Promise<object>}
 */
export async function bootstrapSelfHosted() {
  const existing = await getOrg(SELF_HOSTED_ORG_ID);
  if (existing) {
    logger.info({ msg: 'Self-hosted org already exists', orgId: SELF_HOSTED_ORG_ID });
    return existing;
  }
  const org = await createOrg(SELF_HOSTED_ORG_ID, 'Self-Hosted');
  logger.info({ msg: 'Bootstrapped self-hosted org', orgId: SELF_HOSTED_ORG_ID });
  return org;
}

export { SELF_HOSTED_ORG_ID };
