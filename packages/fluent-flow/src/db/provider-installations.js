import { query } from './client.js';
import logger from '../logger.js';

/**
 * Upsert a provider installation by external_installation_id.
 * Returns the inserted/updated row.
 */
export async function upsertInstallation({
  org_id,
  external_installation_id,
  account_login,
  account_type,
  permissions,
  events,
}) {
  const result = await query(
    `INSERT INTO provider_installations
       (org_id, external_installation_id, account_login, account_type, permissions, events)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (external_installation_id) DO UPDATE SET
       org_id        = EXCLUDED.org_id,
       account_login = EXCLUDED.account_login,
       account_type  = EXCLUDED.account_type,
       permissions   = EXCLUDED.permissions,
       events        = EXCLUDED.events,
       suspended_at  = NULL
     RETURNING *`,
    [org_id, external_installation_id, account_login, account_type, JSON.stringify(permissions), JSON.stringify(events)]
  );
  const row = result.rows[0];
  logger.info({ msg: 'upsertInstallation', external_installation_id, org_id });
  return row;
}

/**
 * Soft-delete (suspend) an installation by internal id.
 */
export async function softDeleteInstallation(id) {
  const result = await query(
    `UPDATE provider_installations
     SET suspended_at = NOW()
     WHERE id = $1
     RETURNING *`,
    [id]
  );
  const row = result.rows[0];
  logger.info({ msg: 'softDeleteInstallation', id });
  return row;
}

/**
 * Un-suspend an installation by internal id.
 */
export async function unsuspendInstallation(id) {
  const result = await query(
    `UPDATE provider_installations
     SET suspended_at = NULL
     WHERE id = $1
     RETURNING *`,
    [id]
  );
  const row = result.rows[0];
  logger.info({ msg: 'unsuspendInstallation', id });
  return row;
}

/**
 * Find an installation by GitHub installation id.
 * @returns {object|null}
 */
export async function findInstallationByExternalId(externalId) {
  const result = await query(
    `SELECT * FROM provider_installations WHERE external_installation_id = $1`,
    [externalId]
  );
  return result.rows[0] ?? null;
}

/**
 * Add (or re-link) a repo to an installation.
 * Soft-deletes any other active link for the same repo_external_id first (cross-org transfer).
 */
export async function addRepoToInstallation(installationId, { repo_external_id, repo_full_name }) {
  // Soft-delete existing active links for this repo on any other installation
  await query(
    `UPDATE provider_installation_repos
     SET removed_at = NOW()
     WHERE repo_external_id = $1
       AND installation_id != $2
       AND removed_at IS NULL`,
    [repo_external_id, installationId]
  );

  const result = await query(
    `INSERT INTO provider_installation_repos (installation_id, repo_external_id, repo_full_name)
     VALUES ($1, $2, $3)
     ON CONFLICT (installation_id, repo_external_id) DO UPDATE SET
       repo_full_name = EXCLUDED.repo_full_name,
       removed_at     = NULL
     RETURNING *`,
    [installationId, repo_external_id, repo_full_name]
  );
  const row = result.rows[0];
  logger.info({ msg: 'addRepoToInstallation', installationId, repo_external_id, repo_full_name });
  return row;
}

/**
 * Soft-delete a repo link from an installation.
 */
export async function removeRepoFromInstallation(installationId, repoExternalId) {
  const result = await query(
    `UPDATE provider_installation_repos
     SET removed_at = NOW()
     WHERE installation_id = $1
       AND repo_external_id = $2
       AND removed_at IS NULL
     RETURNING *`,
    [installationId, repoExternalId]
  );
  const row = result.rows[0];
  logger.info({ msg: 'removeRepoFromInstallation', installationId, repoExternalId });
  return row;
}
