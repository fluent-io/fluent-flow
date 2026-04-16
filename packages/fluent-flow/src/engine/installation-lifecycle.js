import { and, eq, inArray, sql } from 'drizzle-orm';
import { db, schema } from '@fluent-flow/db';
import {
  upsertInstallation,
  softDeleteInstallation,
  unsuspendInstallation,
  findInstallationByExternalId,
  addRepoToInstallation,
  removeRepoFromInstallation,
} from '../db/provider-installations.js';
import { parkForInstallation, unparkForInstallation } from '../db/outbound-queue.js';
import logger from '../logger.js';

const { orgs, agentClaims, repos } = schema;

// Unpark rows created within this many hours on unsuspend
const UNPARK_HOURS = 24;

/**
 * Ensure an org shell row exists for the given GitHub account login.
 * Uses INSERT ... ON CONFLICT DO NOTHING so it's idempotent.
 * @param {string} login
 */
async function ensureOrg(login) {
  await db.insert(orgs).values({ id: login, name: login }).onConflictDoNothing();
}

/**
 * Handle GitHub App installation.created event.
 * Ensures the org row exists, then upserts the installation.
 *
 * @param {{ installation: object }} payload
 * @returns {Promise<object>} The upserted installation row
 */
export async function handleInstallationCreated(payload) {
  const { installation } = payload;
  const { id: externalId, account, permissions, events } = installation;
  const accountLogin = account.login;
  const accountType = account.type;

  await ensureOrg(accountLogin);

  const row = await upsertInstallation({
    org_id: accountLogin,
    external_installation_id: externalId,
    account_login: accountLogin,
    account_type: accountType,
    permissions: permissions ?? {},
    events: events ?? [],
  });

  logger.info({ msg: 'handleInstallationCreated', externalId, accountLogin });
  return row;
}

/**
 * Handle GitHub App installation.suspend event.
 * Soft-deletes the installation, cancels in-flight claims, and parks the queue.
 *
 * @param {number} externalInstallationId
 */
export async function handleInstallationSuspended(externalInstallationId) {
  const installation = await findInstallationByExternalId(externalInstallationId);
  if (!installation) {
    logger.warn({ msg: 'handleInstallationSuspended: installation not found', externalInstallationId });
    return;
  }

  await softDeleteInstallation(installation.id);

  // Cancel in-flight claims for repos belonging to this installation.
  const affectedRepos = db
    .select({ id: repos.id })
    .from(repos)
    .where(eq(repos.installationId, installation.id));
  await db
    .update(agentClaims)
    .set({
      status: 'cancelled',
      completedAt: sql`NOW()`,
      payload: sql`${agentClaims.payload} || ${{ cancel_reason: 'installation_suspended' }}::jsonb`,
    })
    .where(
      and(
        inArray(agentClaims.status, ['pending', 'claimed']),
        inArray(agentClaims.repo, affectedRepos),
      ),
    );

  await parkForInstallation(installation.id);

  logger.info({ msg: 'handleInstallationSuspended', installationId: installation.id, externalInstallationId });
}

/**
 * Handle GitHub App installation.unsuspend event.
 * Unsuspends the installation and unparks recent queue rows.
 *
 * @param {number} externalInstallationId
 */
export async function handleInstallationUnsuspended(externalInstallationId) {
  const installation = await findInstallationByExternalId(externalInstallationId);
  if (!installation) {
    logger.warn({ msg: 'handleInstallationUnsuspended: installation not found', externalInstallationId });
    return;
  }

  await unsuspendInstallation(installation.id);
  await unparkForInstallation(installation.id, UNPARK_HOURS);

  logger.info({ msg: 'handleInstallationUnsuspended', installationId: installation.id, externalInstallationId });
}

/**
 * Handle GitHub App installation_repositories.added event.
 * Links each new repo to the installation.
 *
 * @param {{ installation: object, repositories_added: Array }} payload
 */
export async function handleInstallationRepositoriesAdded(payload) {
  const { installation, repositories_added = [] } = payload;
  const inst = await findInstallationByExternalId(installation.id);
  if (!inst) {
    logger.warn({ msg: 'handleInstallationRepositoriesAdded: installation not found', externalId: installation.id });
    return;
  }

  for (const repo of repositories_added) {
    await addRepoToInstallation(inst.id, {
      repo_external_id: repo.id,
      repo_full_name: repo.full_name,
    });
  }

  logger.info({ msg: 'handleInstallationRepositoriesAdded', installationId: inst.id, count: repositories_added.length });
}

/**
 * Handle GitHub App installation_repositories.removed event.
 * Soft-deletes each repo link from the installation.
 *
 * @param {{ installation: object, repositories_removed: Array }} payload
 */
export async function handleInstallationRepositoriesRemoved(payload) {
  const { installation, repositories_removed = [] } = payload;
  const inst = await findInstallationByExternalId(installation.id);
  if (!inst) {
    logger.warn({ msg: 'handleInstallationRepositoriesRemoved: installation not found', externalId: installation.id });
    return;
  }

  for (const repo of repositories_removed) {
    await removeRepoFromInstallation(inst.id, repo.id);
  }

  logger.info({ msg: 'handleInstallationRepositoriesRemoved', installationId: inst.id, count: repositories_removed.length });
}
