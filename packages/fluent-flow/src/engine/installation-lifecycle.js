import { and, eq, inArray, sql } from 'drizzle-orm';
import { db, schema, upsertUser, linkUserToOrg } from '@fluent-flow/db';
import {
  upsertInstallation,
  softDeleteInstallation,
  unsuspendInstallation,
  findInstallationByExternalId,
  addRepoToInstallation,
  removeRepoFromInstallation,
  softDeleteAllReposForInstallation,
} from '../db/provider-installations.js';
import { parkForInstallation, unparkForInstallation } from '../db/outbound-queue.js';
import { getInstallationToken } from '../providers/github/token-cache.js';
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
        repoExternalId,
        repoFullName,
        orgId,
      },
    });
}

/**
 * Fetch ALL repos visible to an installation via GitHub's paginated API.
 * Used for repository_selection: 'all' installs where the webhook payload
 * may be incomplete.
 *
 * @param {string} token - Installation access token
 * @returns {Promise<Array<{ id: number, full_name: string }>>}
 */
async function fetchAllInstallationRepos(token) {
  const all = [];
  let page = 1;
  const perPage = 100;
  while (true) {
    const res = await fetch(
      `https://api.github.com/installation/repositories?per_page=${perPage}&page=${page}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
      },
    );
    if (!res.ok) {
      throw new Error(`GET /installation/repositories failed: ${res.status} ${await res.text().catch(() => '')}`);
    }
    const body = await res.json();
    const repos = body.repositories ?? [];
    all.push(...repos.map((r) => ({ id: r.id, full_name: r.full_name })));
    if (repos.length < perPage) break;
    page++;
  }
  return all;
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
    repository_selection: installation.repository_selection ?? undefined,
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
      // Safe to continue: the install itself succeeded and the user can
      // recover via a later sign-in path. This is a best-effort convenience
      // link, not a prerequisite for the installation.
      logger.error({ msg: 'handleInstallationCreated: failed to link sender', error: err.message, login: sender.login, orgId: accountLogin });
    }
  }

  // Materialize shell repos so later pipeline/agent queries can resolve them.
  // Errors per-repo don't fail the whole webhook — the org/installation rows
  // are already in place and missing repos can be reconciled via
  // `installation_repositories.added` redeliveries.
  const payloadRepos = Array.isArray(payload.repositories) ? payload.repositories : [];
  let reposEnsured = 0;
  for (const r of payloadRepos) {
    if (!r?.full_name) continue;
    try {
      // Populate both the denormalized repos shell row AND the PIR join row.
      // `repository_selection: 'all'` installs don't fire a separate
      // installation_repositories.added event, so this is the only chance to
      // seed PIR for those installs.
      await addRepoToInstallation(row.id, {
        repo_external_id: r.id ?? null,
        repo_full_name: r.full_name,
      });
      await ensureRepo({
        orgId: accountLogin,
        installationId: row.id,
        repoExternalId: r.id ?? null,
        repoFullName: r.full_name,
      });
      reposEnsured++;
    } catch (err) {
      // Safe to continue: per-repo iteration — missing repos can be
      // reconciled via `installation_repositories.added` redeliveries.
      // If ALL repos fail, the installation is still valid but will have
      // no linked repos until reconciled.
      logger.error({ msg: 'handleInstallationCreated: failed to ensure repo', error: err.message, repo: r.full_name });
    }
  }

  // API backfill for repository_selection: 'all' installs.
  // When the user grants access to ALL repos, the payload.repositories array
  // is capped by GitHub. We need to call the paginated API to get the rest.
  const repositorySelection = installation.repository_selection;
  if (repositorySelection === 'all') {
    try {
      const token = await getInstallationToken(externalId);
      const payloadRepoIds = new Set(payloadRepos.map((r) => r?.id).filter(Boolean));
      const apiRepos = await fetchAllInstallationRepos(token);
      const newRepos = apiRepos.filter((r) => !payloadRepoIds.has(r.id));

      let apiEnsured = 0;
      for (const r of newRepos) {
        try {
          await addRepoToInstallation(row.id, {
            repo_external_id: r.id,
            repo_full_name: r.full_name,
          });
          await ensureRepo({
            orgId: accountLogin,
            installationId: row.id,
            repoExternalId: r.id,
            repoFullName: r.full_name,
          });
          apiEnsured++;
        } catch (err) {
          // Safe to continue: per-repo iteration — missing repos can be
          // reconciled via later API sync or redelivery.
          logger.error({ msg: 'handleInstallationCreated: failed to ensure API repo', error: err.message, repo: r.full_name });
        }
      }
      logger.info({
        msg: 'handleInstallationCreated: API backfill for all-repo install',
        externalId,
        apiReposTotal: apiRepos.length,
        apiReposNew: newRepos.length,
        apiEnsured,
      });
    } catch (err) {
      // Safe to continue: API backfill failure — repos already in the payload
      // are materialized. The remaining repos can be reconciled via later
      // installation_repositories events or a manual backfill script.
      logger.error({ msg: 'handleInstallationCreated: API backfill failed for all-repo install', error: err.message, externalId });
    }
  }

  logger.info({
    msg: 'handleInstallationCreated',
    externalId,
    accountLogin,
    repositorySelection,
    reposInPayload: payloadRepos.length,
    reposEnsured,
  });
  return row;
}

/**
 * Handle GitHub App installation.suspend event.
 * Soft-deletes the installation, cancels in-flight claims, and parks the queue.
 *
 * Also reused by handleInstallationDeleted — pass a different
 * `cancelReason` so the audit trail distinguishes temporary suspends from
 * permanent uninstalls.
 *
 * @param {number} externalInstallationId
 * @param {{ cancelReason?: string }} [options]
 * @param {string} [options.cancelReason='installation_suspended'] — tag
 *   written onto each cancelled claim's payload.
 * @returns {Promise<object|null>} The installation row (for reuse by
 *   downstream handlers), or `null` when no installation matched the
 *   external id.
 */
export async function handleInstallationSuspended(externalInstallationId, { cancelReason = 'installation_suspended' } = {}) {
  const installation = await findInstallationByExternalId(externalInstallationId);
  if (!installation) {
    logger.warn({ msg: 'handleInstallationSuspended: installation not found', externalInstallationId });
    return null;
  }

  await softDeleteInstallation(installation.id);

  // Cancel in-flight claims for repos belonging to this installation.
  // `cancelReason` is recorded on each claim's payload so audit readers can
  // distinguish a recoverable suspend from a permanent delete.
  const affectedRepos = db
    .select({ id: repos.id })
    .from(repos)
    .where(eq(repos.installationId, installation.id));
  await db
    .update(agentClaims)
    .set({
      status: 'cancelled',
      completedAt: sql`NOW()`,
      payload: sql`${agentClaims.payload} || ${{ cancel_reason: cancelReason }}::jsonb`,
    })
    .where(
      and(
        inArray(agentClaims.status, ['pending', 'claimed']),
        inArray(agentClaims.repo, affectedRepos),
      ),
    );

  await parkForInstallation(installation.id);

  logger.info({ msg: 'handleInstallationSuspended', installationId: installation.id, externalInstallationId, cancelReason });
  return installation;
}

/**
 * Handle GitHub App installation.deleted event (full uninstall).
 *
 * Stronger than suspend: in addition to marking the installation suspended,
 * cancelling in-flight claims, and parking the outbound queue (all done by
 * handleInstallationSuspended), we also cascade the tombstone to
 * provider_installation_repos so individual repo links are marked removed.
 * That keeps the DB consistent with GitHub's view — a user who uninstalls
 * shouldn't see active repo links for the installation they just removed.
 *
 * On reinstall GitHub generates a new installation id, so we don't clear
 * repos.installation_id here — ensureRepo will re-link to the new
 * installation on the next install-created webhook, and the old (deleted)
 * id stays as a historical breadcrumb.
 *
 * @param {number} externalInstallationId
 * @returns {Promise<object|null>} The installation row, or `null` when no
 *   installation matched the external id.
 */
export async function handleInstallationDeleted(externalInstallationId) {
  // Reuse suspend behavior first — mark suspended_at, cancel claims, park
  // queue. `deleted` is stronger-than-suspend, not a separate pipeline.
  // Pass the accurate cancel reason so claims don't get tagged as merely
  // suspended when the install was permanently removed.
  const installation = await handleInstallationSuspended(externalInstallationId, { cancelReason: 'installation_deleted' });
  if (!installation) return null;

  await softDeleteAllReposForInstallation(installation.id);
  logger.info({ msg: 'handleInstallationDeleted', installationId: installation.id, externalInstallationId });
  return installation;
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

  // Per-repo try/catch wraps BOTH the installation link write AND the
  // repos shell-row upsert — if either throws for one repo, remaining
  // repos in the payload still get processed.
  let processed = 0;
  for (const repo of repositories_added) {
    if (!repo?.full_name) continue;
    try {
      await addRepoToInstallation(inst.id, {
        repo_external_id: repo.id ?? null,
        repo_full_name: repo.full_name,
      });
      await ensureRepo({
        orgId: inst.org_id,
        installationId: inst.id,
        repoExternalId: repo.id ?? null,
        repoFullName: repo.full_name,
      });
      processed++;
    } catch (err) {
      // Safe to continue: per-repo iteration — remaining repos still get
      // processed. Failed repos can be reconciled via redelivery of the
      // installation_repositories.added event.
      logger.error({
        msg: 'handleInstallationRepositoriesAdded: failed to process repo',
        error: err.message,
        repo: repo.full_name,
      });
    }
  }

  logger.info({
    msg: 'handleInstallationRepositoriesAdded',
    installationId: inst.id,
    attempted: repositories_added.length,
    processed,
  });
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
