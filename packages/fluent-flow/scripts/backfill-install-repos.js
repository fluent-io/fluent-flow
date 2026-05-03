#!/usr/bin/env node
/**
 * Backfill `provider_installation_repos` for one or more GitHub App installs.
 *
 * Why this exists: `handleInstallationCreated` historically only materialized
 * `repos` shell rows — it never populated PIR. For `repository_selection: 'all'`
 * installs (no separate `installation_repositories.added` event), PIR stayed
 * empty, which breaks every downstream lookup that joins on PIR. The companion
 * code fix is now in place (see installation-lifecycle.js), but existing
 * installs still have the gap. Run this once per affected install to heal them.
 *
 * Usage:
 *   node scripts/backfill-install-repos.js --installation-id <internal-id>
 *   node scripts/backfill-install-repos.js --all-active   # every unsuspended install
 *
 * The script is idempotent — `addRepoToInstallation` does ON CONFLICT DO UPDATE
 * on (installation_id, repo_external_id) and resurrects tombstoned rows.
 */

import 'dotenv/config';
import { eq, isNull, sql } from 'drizzle-orm';
import { db, schema, closePool } from '@fluent-flow/db';
import { getInstallationToken } from '../src/providers/github/token-cache.js';
import { addRepoToInstallation } from '../src/db/provider-installations.js';
import logger from '../src/logger.js';

const { providerInstallations, providerInstallationRepos, repos } = schema;

function parseArgs(argv) {
  const args = { installationId: null, allActive: false };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--installation-id') args.installationId = Number(argv[++i]);
    else if (argv[i] === '--all-active') args.allActive = true;
    else if (argv[i] === '--help' || argv[i] === '-h') {
      console.log('Usage:');
      console.log('  node scripts/backfill-install-repos.js --installation-id <internal-id>');
      console.log('  node scripts/backfill-install-repos.js --all-active');
      process.exit(0);
    }
  }
  if (!args.installationId && !args.allActive) {
    console.error('error: pass --installation-id <N> or --all-active');
    process.exit(1);
  }
  return args;
}

/**
 * Fetch all repos visible to an installation via GitHub's paginated endpoint.
 * Uses the minted installation token, not any stored PAT.
 *
 * @param {string} token
 * @returns {Promise<Array<{ id: number, full_name: string }>>}
 */
async function fetchInstallationRepos(token) {
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
 * Backfill PIR for a single install. Returns count inserted / updated.
 */
async function backfillOne(internalId) {
  const [row] = await db
    .select({
      id: providerInstallations.id,
      externalId: providerInstallations.externalInstallationId,
      accountLogin: providerInstallations.accountLogin,
    })
    .from(providerInstallations)
    .where(eq(providerInstallations.id, internalId))
    .limit(1);

  if (!row) {
    logger.error({ msg: 'backfill: installation not found', internalId });
    return 0;
  }

  logger.info({ msg: 'backfill: starting', internalId, externalId: row.externalId, account: row.accountLogin });

  const token = await getInstallationToken(Number(row.externalId));
  const repos = await fetchInstallationRepos(token);
  logger.info({ msg: 'backfill: fetched repos from GitHub', count: repos.length });

  let processed = 0;
  for (const r of repos) {
    try {
      await addRepoToInstallation(row.id, {
        repo_external_id: r.id,
        repo_full_name: r.full_name,
      });
      processed++;
    } catch (err) {
      logger.error({ msg: 'backfill: failed to link repo', repo: r.full_name, error: err.message });
    }
  }
  logger.info({ msg: 'backfill: done', internalId, processed });
  return processed;
}

/**
 * Backfill `repos` shell rows for any `provider_installation_repos` entries
 * that don't have a corresponding `repos` row. This can happen when the
 * backfill script was run before the repos materialization code was added
 * to handleInstallationCreated, or when repos were added via the GitHub
 * API without triggering the full lifecycle.
 *
 * @returns {Promise<number>} Count of repos shell rows created.
 */
async function backfillReposShellRows() {
  // Find PIR rows where no matching repos row exists
  const orphanPirs = await db.execute(sql`
    SELECT pir.repo_full_name, pir.installation_id, pir.repo_external_id, pi.org_id
    FROM provider_installation_repos pir
    JOIN provider_installations pi ON pi.id = pir.installation_id
    LEFT JOIN repos r ON r.id = pir.repo_full_name
    WHERE pir.removed_at IS NULL
      AND r.id IS NULL
  `);

  const rows = orphanPirs.rows ?? orphanPirs;
  if (rows.length === 0) {
    logger.info({ msg: 'backfill: no orphan PIR rows found — all repos materialized' });
    return 0;
  }

  logger.info({ msg: 'backfill: found orphan PIR rows', count: rows.length });

  let created = 0;
  for (const row of rows) {
    try {
      const result = await db.insert(repos).values({
        id: row.repo_full_name,
        orgId: row.org_id,
        repoExternalId: row.repo_external_id,
        repoFullName: row.repo_full_name,
        provider: 'github',
        installationId: row.installation_id,
      }).onConflictDoNothing().returning();
      if (result.length > 0) created++;
    } catch (err) {
      // Safe to continue: per-row iteration — one failure shouldn't block
      // materialization of the rest.
      logger.error({ msg: 'backfill: failed to create repos shell row', repo: row.repo_full_name, error: err.message });
    }
  }

  logger.info({ msg: 'backfill: repos shell rows created', created, totalOrphans: rows.length });
  return created;
}

async function main() {
  const args = parseArgs(process.argv);

  let targets;
  if (args.allActive) {
    targets = await db
      .select({ id: providerInstallations.id })
      .from(providerInstallations)
      .where(isNull(providerInstallations.suspendedAt));
  } else {
    targets = [{ id: args.installationId }];
  }

  let total = 0;
  for (const t of targets) {
    total += await backfillOne(t.id);
  }
  logger.info({ msg: 'backfill: PIR complete', installsProcessed: targets.length, reposLinked: total });

  // Phase 2: Materialize repos shell rows for any PIR rows that don't have
  // a corresponding repos row yet.
  await backfillReposShellRows();

  logger.info({ msg: 'backfill: complete' });
}

main()
  .then(() => closePool())
  .then(() => process.exit(0))
  .catch((err) => {
    logger.error({ msg: 'backfill: fatal', error: err.message, stack: err.stack });
    closePool().finally(() => process.exit(1));
  });
