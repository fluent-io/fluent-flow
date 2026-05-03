import { eq } from 'drizzle-orm';
import { db, schema } from '@fluent-flow/db';
import { audit } from '../db/client.js';
import logger from '../logger.js';

const { orgs } = schema;
const SELF_HOSTED_ORG_ID = 'self-hosted';

/**
 * Create an org.
 */
export async function createOrg(id, name, settings = {}) {
  const [row] = await db
    .insert(orgs)
    .values({ id, name, settings })
    .returning();
  audit('org_created', { data: { orgId: id } });
  return row;
}

/**
 * Get an org by ID.
 */
export async function getOrg(id) {
  const [row] = await db.select().from(orgs).where(eq(orgs.id, id)).limit(1);
  return row ?? null;
}

/**
 * Bootstrap the default org for self-hosted deployments. Idempotent.
 */
export async function bootstrapSelfHosted() {
  const existing = await getOrg(SELF_HOSTED_ORG_ID);
  if (existing) {
    logger.info({ msg: 'Self-hosted org already exists', orgId: SELF_HOSTED_ORG_ID });
    return existing;
  }
  try {
    const org = await createOrg(SELF_HOSTED_ORG_ID, 'Self-Hosted');
    logger.info({ msg: 'Bootstrapped self-hosted org', orgId: SELF_HOSTED_ORG_ID });
    return org;
  } catch (err) {
    // Safe to continue: unique_violation (23505) means another concurrent
    // request already inserted this org — idempotent bootstrap. Re-read and
    // return the existing row. Any other error propagates.
    if (err?.code === '23505') {
      const org = await getOrg(SELF_HOSTED_ORG_ID);
      if (org) return org;
    }
    throw err;
  }
}

export { SELF_HOSTED_ORG_ID };
