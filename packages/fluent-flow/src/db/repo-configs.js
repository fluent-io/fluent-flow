import { query } from './client.js';
import { RepoConfigSchema } from '../config/provider-schema.js';
import logger from '../logger.js';

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
  // Validate input
  RepoConfigSchema.parse(patch);

  // Fetch existing config for diff
  const existing = await query(
    `SELECT * FROM repo_configs WHERE repo_id = $1`,
    [repoId]
  );
  const oldConfig = existing.rows[0] ?? {};

  // Upsert
  const result = await query(
    `INSERT INTO repo_configs (repo_id, default_agent, claim_types, review_model, paused, updated_by, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, NOW())
     ON CONFLICT (repo_id) DO UPDATE SET
       default_agent = COALESCE(EXCLUDED.default_agent, repo_configs.default_agent),
       claim_types   = COALESCE(EXCLUDED.claim_types, repo_configs.claim_types),
       review_model  = COALESCE(EXCLUDED.review_model, repo_configs.review_model),
       paused        = EXCLUDED.paused,
       updated_by    = EXCLUDED.updated_by,
       updated_at    = NOW()
     RETURNING *`,
    [
      repoId,
      patch.default_agent ?? null,
      patch.claim_types ? JSON.stringify(patch.claim_types) : null,
      patch.review_model ?? null,
      patch.paused ?? false,
      actor,
    ]
  );
  const newConfig = result.rows[0];

  // Compute JSON Patch diff for history
  const patchOps = computePatch(oldConfig, newConfig);

  // Append history row
  await query(
    `INSERT INTO repo_config_history (repo_id, patch, actor, at)
     VALUES ($1, $2, $3, NOW())`,
    [repoId, JSON.stringify(patchOps), actor]
  );

  logger.info({ msg: 'upsertRepoConfig', repoId, actor });
  return newConfig;
}

/**
 * Resolve the effective repo config by merging:
 *   built-in defaults <- org_config <- repo_configs
 */
export async function resolveRepoConfig(repoId) {
  const orgId = repoId.split('/')[0];

  const [orgResult, repoResult] = await Promise.all([
    query(`SELECT * FROM org_config WHERE org_id = $1`, [orgId]),
    query(`SELECT * FROM repo_configs WHERE repo_id = $1`, [repoId]),
  ]);

  const orgConfig = orgResult.rows[0] ?? {};
  const repoConfig = repoResult.rows[0] ?? {};

  // Merge: built-in defaults <- org_config <- repo_configs (later wins)
  return {
    paused: false,                    // built-in default
    ...orgConfig,
    default_agent: orgConfig.default_agent,
    review_model: orgConfig.review_model ?? orgConfig.default_review_model,
    claim_types: orgConfig.default_claim_types,
    ...Object.fromEntries(
      Object.entries(repoConfig).filter(([, v]) => v !== null && v !== undefined)
    ),
  };
}

/**
 * List repo config history for a given repo, most recent first.
 */
export async function listRepoConfigHistory(repoId) {
  const result = await query(
    `SELECT * FROM repo_config_history
     WHERE repo_id = $1
     ORDER BY at DESC`,
    [repoId]
  );
  return result.rows;
}
