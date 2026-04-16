import { desc, eq, sql } from 'drizzle-orm';
import { db, schema } from '@fluent-flow/db';
import { RepoConfigSchema } from '../config/provider-schema.js';
import logger from '../logger.js';

const { repoConfigs, repoConfigHistory, orgConfig } = schema;

/**
 * Compute a simple JSON Patch (RFC 6902) diff between two objects.
 * Only handles top-level fields (sufficient for repo config).
 */
function computePatch(oldObj, newObj) {
  const ops = [];
  const allKeys = new Set([...Object.keys(oldObj ?? {}), ...Object.keys(newObj ?? {})]);
  for (const key of allKeys) {
    const oldVal = oldObj?.[key];
    const newVal = newObj?.[key];
    if (JSON.stringify(oldVal) === JSON.stringify(newVal)) continue;
    if (oldVal === undefined) {
      ops.push({ op: 'add', path: `/${key}`, value: newVal });
    } else if (newVal === undefined) {
      ops.push({ op: 'remove', path: `/${key}` });
    } else {
      ops.push({ op: 'replace', path: `/${key}`, value: newVal });
    }
  }
  return ops;
}

/**
 * Validate, upsert repo config, and append a JSON Patch history row.
 */
export async function upsertRepoConfig(repoId, patch, actor) {
  RepoConfigSchema.parse(patch);

  const [existing] = await db
    .select()
    .from(repoConfigs)
    .where(eq(repoConfigs.repoId, repoId))
    .limit(1);
  const oldConfig = existing ?? {};

  const [newConfig] = await db
    .insert(repoConfigs)
    .values({
      repoId,
      defaultAgent: patch.default_agent ?? null,
      claimTypes: patch.claim_types ?? null,
      reviewModel: patch.review_model ?? null,
      paused: patch.paused ?? false,
      updatedBy: actor,
      updatedAt: sql`NOW()`,
    })
    .onConflictDoUpdate({
      target: repoConfigs.repoId,
      set: {
        defaultAgent: sql`COALESCE(EXCLUDED.default_agent, ${repoConfigs.defaultAgent})`,
        claimTypes: sql`COALESCE(EXCLUDED.claim_types, ${repoConfigs.claimTypes})`,
        reviewModel: sql`COALESCE(EXCLUDED.review_model, ${repoConfigs.reviewModel})`,
        paused: sql`EXCLUDED.paused`,
        updatedBy: sql`EXCLUDED.updated_by`,
        updatedAt: sql`NOW()`,
      },
    })
    .returning();

  const patchOps = computePatch(oldConfig, newConfig);

  await db.insert(repoConfigHistory).values({
    repoId,
    patch: patchOps,
    actor,
    at: sql`NOW()`,
  });

  logger.info({ msg: 'upsertRepoConfig', repoId, actor });
  return newConfig;
}

/**
 * Resolve the effective repo config by merging:
 *   built-in defaults <- org_config <- repo_configs
 */
export async function resolveRepoConfig(repoId) {
  const orgId = repoId.split('/')[0];

  const [orgRows, repoRows] = await Promise.all([
    db.select().from(orgConfig).where(eq(orgConfig.orgId, orgId)).limit(1),
    db.select().from(repoConfigs).where(eq(repoConfigs.repoId, repoId)).limit(1),
  ]);

  const org = orgRows[0] ?? {};
  const repo = repoRows[0] ?? {};

  // Drizzle returns camelCase column aliases; the rest of the app reads
  // snake_case keys. Map explicitly so repo fields actually override org
  // fields, and so we don't leak camelCase keys into the resolved config.
  const resolved = {
    paused: false,
    default_agent: org.defaultAgent ?? null,
    review_model: org.reviewModel ?? org.defaultReviewModel ?? null,
    claim_types: org.defaultClaimTypes ?? null,
  };

  if (repo.defaultAgent != null) resolved.default_agent = repo.defaultAgent;
  if (repo.reviewModel != null) resolved.review_model = repo.reviewModel;
  if (repo.claimTypes != null) resolved.claim_types = repo.claimTypes;
  if (repo.paused != null) resolved.paused = repo.paused;

  return resolved;
}

/**
 * List repo config history for a given repo, most recent first.
 */
export async function listRepoConfigHistory(repoId) {
  return db
    .select()
    .from(repoConfigHistory)
    .where(eq(repoConfigHistory.repoId, repoId))
    .orderBy(desc(repoConfigHistory.at));
}
