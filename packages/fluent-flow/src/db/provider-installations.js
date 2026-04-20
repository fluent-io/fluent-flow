import { and, eq, isNull, ne, sql } from 'drizzle-orm';
import { db, schema } from '@fluent-flow/db';
import logger from '../logger.js';

const { providerInstallations, providerInstallationRepos } = schema;

/**
 * Upsert a provider installation. Matches the composite UNIQUE constraint
 * (provider, external_installation_id) that actually exists in prod.
 */
export async function upsertInstallation({
  org_id,
  external_installation_id,
  account_login,
  account_type,
  permissions,
  events,
}) {
  const [row] = await db
    .insert(providerInstallations)
    .values({
      orgId: org_id,
      externalInstallationId: external_installation_id,
      accountLogin: account_login,
      accountType: account_type,
      permissions,
      events,
    })
    .onConflictDoUpdate({
      target: [providerInstallations.provider, providerInstallations.externalInstallationId],
      set: {
        orgId: sql`EXCLUDED.org_id`,
        accountLogin: sql`EXCLUDED.account_login`,
        accountType: sql`EXCLUDED.account_type`,
        permissions: sql`EXCLUDED.permissions`,
        events: sql`EXCLUDED.events`,
        suspendedAt: null,
      },
    })
    .returning();

  logger.info({ msg: 'upsertInstallation', external_installation_id, org_id });
  return row;
}

/**
 * Soft-delete (suspend) an installation by internal id.
 */
export async function softDeleteInstallation(id) {
  const [row] = await db
    .update(providerInstallations)
    .set({ suspendedAt: sql`NOW()` })
    .where(eq(providerInstallations.id, id))
    .returning();
  logger.info({ msg: 'softDeleteInstallation', id });
  return row;
}

/**
 * Un-suspend an installation by internal id.
 */
export async function unsuspendInstallation(id) {
  const [row] = await db
    .update(providerInstallations)
    .set({ suspendedAt: null })
    .where(eq(providerInstallations.id, id))
    .returning();
  logger.info({ msg: 'unsuspendInstallation', id });
  return row;
}

/**
 * Find an installation by GitHub installation id.
 * @returns {object|null}
 */
export async function findInstallationByExternalId(externalId) {
  const [row] = await db
    .select()
    .from(providerInstallations)
    .where(eq(providerInstallations.externalInstallationId, externalId))
    .limit(1);
  return row ?? null;
}

/**
 * Add (or re-link) a repo to an installation.
 * Soft-deletes any other active link for the same repo_external_id first (cross-org transfer).
 *
 * The UNIQUE is a PARTIAL index on (installation_id, repo_external_id) WHERE removed_at IS NULL,
 * so the ON CONFLICT target must include the same WHERE clause (`targetWhere`).
 */
export async function addRepoToInstallation(installationId, { repo_external_id, repo_full_name }) {
  await db
    .update(providerInstallationRepos)
    .set({ removedAt: sql`NOW()` })
    .where(
      and(
        eq(providerInstallationRepos.repoExternalId, repo_external_id),
        ne(providerInstallationRepos.installationId, installationId),
        isNull(providerInstallationRepos.removedAt),
      ),
    );

  const [row] = await db
    .insert(providerInstallationRepos)
    .values({
      installationId,
      repoExternalId: repo_external_id,
      repoFullName: repo_full_name,
    })
    .onConflictDoUpdate({
      target: [providerInstallationRepos.installationId, providerInstallationRepos.repoExternalId],
      targetWhere: isNull(providerInstallationRepos.removedAt),
      set: {
        repoFullName: sql`EXCLUDED.repo_full_name`,
        removedAt: null,
      },
    })
    .returning();

  logger.info({ msg: 'addRepoToInstallation', installationId, repo_external_id, repo_full_name });
  return row;
}

/**
 * Soft-delete a repo link from an installation.
 */
export async function removeRepoFromInstallation(installationId, repoExternalId) {
  const [row] = await db
    .update(providerInstallationRepos)
    .set({ removedAt: sql`NOW()` })
    .where(
      and(
        eq(providerInstallationRepos.installationId, installationId),
        eq(providerInstallationRepos.repoExternalId, repoExternalId),
        isNull(providerInstallationRepos.removedAt),
      ),
    )
    .returning();
  logger.info({ msg: 'removeRepoFromInstallation', installationId, repoExternalId });
  return row;
}

/**
 * Bulk soft-delete: mark every still-active provider_installation_repos row
 * for this installation as removed. Used on installation.deleted (full
 * uninstall) to cascade the tombstone to the repo links.
 *
 * Uses raw `db.execute` so we get a rowCount without transferring one row
 * per affected link back to the client — matters for installs with many
 * repos.
 *
 * Returns the count of rows soft-deleted.
 */
export async function softDeleteAllReposForInstallation(installationId) {
  const result = await db.execute(sql`
    UPDATE provider_installation_repos
    SET removed_at = NOW()
    WHERE installation_id = ${installationId}
      AND removed_at IS NULL
  `);
  const count = result.rowCount ?? 0;
  logger.info({ msg: 'softDeleteAllReposForInstallation', installationId, count });
  return count;
}
