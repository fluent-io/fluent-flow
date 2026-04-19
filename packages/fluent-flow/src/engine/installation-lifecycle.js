import { and, eq, inArray, sql } from 'drizzle-orm';
import { db, schema, upsertUser, linkUserToOrg } from '@fluent-flow/db';
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
 * Ensure a `repos` shell row exists for a repo linked to an installation.
 * Implements the "unknown repos get shell rows so onboarding can complete
 * async" behavior from the GitHub App provider integration design
 * (docs/specs/2026-04-13-github-app-provider-integration-design.md).
 *
 * The id column is `text` and doubles as the `owner/repo` slug so downstream
 * code (agents.repos array, agent_claims.repo) can join by string identity.
 * On conflict we re-link `installation_id` and update org/name so
 * re-installs and cross-org transfers land on the latest installation.
 *
 * @param {{ orgId: string, installationId: number|null, repoExternalId: number|null, repoFullName: string }} input
 */
async function ensureRepo({ orgId, installationId, repoExternalId, repoFullName }) {
  await db
    .insert(repos)
    .values({
      id: repoFullName,
      orgId,
      repoExternalId,
      repoFullName,
      provider: 'github',
      installationId,
    })
    .onConflictDoUpdate({
      target: repos.id,
      set: {
        installationId,
        repoFullName,
        orgId,
      },
    });
}

/**
 * Handle GitHub App installation.created event.
 * Ensures the org row exists, upserts the installation, links the installing
 * user (payload.sender) to the org as admin, and materializes a `repos` row
 * for each repository delivered in the payload so the dashboard's pipeline
 * and agent flows can resolve the repo immediately.
 *
 * Note on `payload.repositories`:
 *   - `repository_selection: 'selected'` → repositories[] lists exactly what
 *     the user picked; `installation_repositories.added` also fires
 *     separately.
 *   - `repository_selection: 'all'` → repositories[] contains what the App
 *     has access to at install time (capped by GitHub). For orgs with more
 *     repos than fit in the payload, fall back to later
 *     `installation_repositories.added` events or an API sync.
 *
 * @param {{ installation: object, sender?: object, repositories?: object[] }} payload
 * @returns {Promise<object>} The upserted installation row
 */
export async function handleInstallationCreated(payload) {
  const { installation, sender } = payload;
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

  // Link the installer so they have dashboard access to the newly-installed
  // org. Pre-creating the user row means they'll be linked even before their
  // first OAuth sign-in (upsertUser is ON CONFLICT on github_id).
  if (sender?.id && sender?.login && sender?.type !== 'Bot') {
    try {
      const user = await upsertUser({
        github_id: sender.id,
        login: sender.login,
        email: null,
        avatar_url: sender.avatar_url ?? null,
      });
      await linkUserToOrg(user.id, accountLogin, 'admin');
      logger.info({ msg: 'handleInstallationCreated: linked sender', userId: user.id, login: sender.login, orgId: accountLogin });
    } catch (err) {
      // Don't fail the whole webhook if linking fails — the install itself
      // succeeded and the user can recover via a later sign-in path.
      logger.error({ msg: 'handleInstallationCreated: failed to link sender', error: err.message, login: sender.login, orgId: accountLogin });
    }
  }

  // Materialize shell repos so later pipeline/agent queries can resolve them.
  // Errors per-repo don't fail the whole webhook — the org/installation rows
  // are already in place and missing repos can be reconciled via
  // `installation_repositories.added` redeliveries.
  const payloadRepos = Array.isArray(payload.repositories) ? payload.repositories : [];
  for (const r of payloadRepos) {
    if (!r?.full_name) continue;
    try {
      await ensureRepo({
        orgId: accountLogin,
        installationId: row.id,
        repoExternalId: r.id ?? null,
        repoFullName: r.full_name,
      });
    } catch (err) {
      logger.error({ msg: 'handleInstallationCreated: failed to ensure repo', error: err.message, repo: r.full_name });
    }
  }

  logger.info({ msg: 'handleInstallationCreated', externalId, accountLogin, reposEnsured: payloadRepos.length });
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
    // Also materialize / relink the shell row in `repos` so pipeline and
    // agent queries can resolve the repo. Scoped per-repo try/catch so a
    // single failure doesn't skip the remaining repos in the payload.
    try {
      await ensureRepo({
        orgId: inst.org_id,
        installationId: inst.id,
        repoExternalId: repo.id ?? null,
        repoFullName: repo.full_name,
      });
    } catch (err) {
      logger.error({ msg: 'handleInstallationRepositoriesAdded: failed to ensure repo', error: err.message, repo: repo.full_name });
    }
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
