import { query } from './client.js';
import logger from '../logger.js';

export async function upsertInstallation({
  provider,
  externalInstallationId,
  orgId,
  accountLogin,
  accountType,
}) {
  const result = await query(
    `INSERT INTO provider_installations
       (provider, external_installation_id, org_id, account_login, account_type)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (provider, external_installation_id) DO UPDATE
       SET org_id = EXCLUDED.org_id,
           account_login = EXCLUDED.account_login,
           account_type = EXCLUDED.account_type,
           suspended_at = NULL
     RETURNING *`,
    [provider, externalInstallationId, orgId, accountLogin, accountType]
  );
  const row = result.rows[0];
  logger.info({ msg: 'provider installation upserted', id: row.id, provider, orgId });
  return row;
}

export async function findInstallationByExternalId(provider, externalInstallationId) {
  const result = await query(
    `SELECT * FROM provider_installations
     WHERE provider = $1 AND external_installation_id = $2`,
    [provider, externalInstallationId]
  );
  return result.rows[0] ?? null;
}

export async function softDeleteInstallation(id) {
  await query(
    `UPDATE provider_installations SET suspended_at = NOW() WHERE id = $1`,
    [id]
  );
  logger.info({ msg: 'provider installation suspended', id });
}

export async function unsuspendInstallation(id) {
  await query(
    `UPDATE provider_installations SET suspended_at = NULL WHERE id = $1`,
    [id]
  );
  logger.info({ msg: 'provider installation unsuspended', id });
}

export async function addRepoToInstallation({ installationId, repoExternalId, repoFullName }) {
  await query(
    `UPDATE provider_installation_repos
       SET removed_at = NOW()
     WHERE repo_external_id = $1
       AND installation_id <> $2
       AND removed_at IS NULL`,
    [repoExternalId, installationId]
  );
  const result = await query(
    `INSERT INTO provider_installation_repos
       (installation_id, repo_external_id, repo_full_name)
     VALUES ($1, $2, $3)
     RETURNING *`,
    [installationId, repoExternalId, repoFullName]
  );
  const row = result.rows[0];
  logger.info({ msg: 'repo added to installation', installationId, repoExternalId, repoFullName });
  return row;
}

export async function removeRepoFromInstallation({ installationId, repoExternalId }) {
  await query(
    `UPDATE provider_installation_repos
       SET removed_at = NOW()
     WHERE installation_id = $1
       AND repo_external_id = $2
       AND removed_at IS NULL`,
    [installationId, repoExternalId]
  );
  logger.info({ msg: 'repo removed from installation', installationId, repoExternalId });
}
