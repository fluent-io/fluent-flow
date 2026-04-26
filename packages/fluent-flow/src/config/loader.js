import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import yaml from 'js-yaml';
import { eq, sql } from 'drizzle-orm';
import { db, schema } from '@fluent-flow/db';
import { validateDefaults, validateRepoConfig, validateMergedConfig } from './schema.js';
import { getRepoFileContents } from '../providers/github/rest.js';
import logger from '../logger.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const CONFIG_CACHE_TTL_MS = parseInt(process.env.CONFIG_CACHE_TTL_MS || '300000', 10);

// In-memory cache: repo -> { config, expiresAt }
const memoryCache = new Map();

let defaultsConfig = null;

/**
 * Load and parse the global defaults config from disk.
 * @returns {object} Validated defaults config
 */
export function loadDefaults() {
  if (defaultsConfig) return defaultsConfig;

  const defaultsPath = join(__dirname, '../../config/defaults.yml');
  const raw = readFileSync(defaultsPath, 'utf8');
  const parsed = yaml.load(raw);
  defaultsConfig = validateDefaults(parsed);
  logger.info({ msg: 'Loaded defaults config' });
  return defaultsConfig;
}

/**
 * Deep merge two objects. Arrays from override replace arrays in base.
 * @param {object} base
 * @param {object} override
 * @returns {object}
 */
function deepMerge(base, override) {
  if (!override || typeof override !== 'object') return base;
  const result = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (
      value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      typeof result[key] === 'object' &&
      result[key] !== null &&
      !Array.isArray(result[key])
    ) {
      result[key] = deepMerge(result[key], value);
    } else if (value !== undefined) {
      result[key] = value;
    }
  }
  return result;
}

/**
 * Resolve installation context for a repo from the materialized `repos` row,
 * joined to `provider_installations` to surface the GitHub EXTERNAL id.
 *
 * `repos.installation_id` FKs to `provider_installations.id` (our internal
 * DB id), but `getInstallationToken` / `/app/installations/:id/access_tokens`
 * expects GitHub's external installation id — so we join and return that.
 *
 * Returns undefined when the repo isn't materialized (e.g. install webhook
 * never arrived), which makes `getRepoFileContents` fall back to the legacy
 * GITHUB_TOKEN PAT — acceptable for dev environments and for unknown-repo
 * probes; in prod under the App this case means the repo isn't onboarded.
 *
 * @param {string} owner
 * @param {string} repo
 * @returns {Promise<{ installation_id: number }|undefined>}
 */
async function installationCtxForRepo(owner, repo) {
  try {
    const rows = await db
      .select({ externalId: schema.providerInstallations.externalInstallationId })
      .from(schema.repos)
      .innerJoin(
        schema.providerInstallations,
        eq(schema.repos.installationId, schema.providerInstallations.id),
      )
      .where(eq(schema.repos.id, `${owner}/${repo}`))
      .limit(1);
    const externalId = rows[0]?.externalId;
    if (!externalId) return undefined;
    return { installation_id: Number(externalId) };
  } catch (err) {
    logger.error({ msg: 'Failed to resolve installation ctx for repo', owner, repo, error: err.message });
    return undefined;
  }
}

/**
 * Fetch repo config from GitHub and cache in DB.
 * @param {string} owner
 * @param {string} repo
 * @returns {object|null} Validated repo config or null if not found
 */
async function fetchRepoConfig(owner, repo) {
  try {
    const ctx = await installationCtxForRepo(owner, repo);
    const content = await getRepoFileContents(owner, repo, '.github/fluent-flow.yml', ctx);
    if (!content) return null;

    const decoded = Buffer.from(content, 'base64').toString('utf8');
    const parsed = yaml.load(decoded);
    return validateRepoConfig(parsed);
  } catch (err) {
    if (err.status === 404 || err.message?.includes('404')) {
      logger.info({ msg: 'No fluent-flow.yml in repo', owner, repo });
      return null;
    }
    logger.error({ msg: 'Failed to fetch repo config', owner, repo, error: err.message });
    return null;
  }
}

/**
 * Get cached repo config from DB.
 * @param {string} repoKey - "owner/repo"
 * @returns {object|null}
 */
async function getDbCache(repoKey) {
  try {
    const rows = await db
      .select({ config: schema.configCache.config })
      .from(schema.configCache)
      .where(
        sql`${schema.configCache.repo} = ${repoKey} AND ${schema.configCache.expiresAt} > NOW()`,
      )
      .limit(1);
    if (rows.length > 0) return rows[0].config;
  } catch (err) {
    logger.error({ msg: 'Failed to read config cache from DB', error: err.message });
  }
  return null;
}

/**
 * Save merged config to DB cache.
 * @param {string} repoKey
 * @param {object} config
 */
async function setDbCache(repoKey, config) {
  try {
    const ttl = sql`NOW() + (${CONFIG_CACHE_TTL_MS} * interval '1 millisecond')`;
    await db
      .insert(schema.configCache)
      .values({ repo: repoKey, config, fetchedAt: sql`NOW()`, expiresAt: ttl })
      .onConflictDoUpdate({
        target: schema.configCache.repo,
        set: { config, fetchedAt: sql`NOW()`, expiresAt: ttl },
      });
  } catch (err) {
    logger.error({ msg: 'Failed to write config cache to DB', error: err.message });
  }
}

/**
 * Resolve the org_id for a repo by joining repos → provider_installations.
 *
 * Falls back to 'self-hosted' when no installation row exists (e.g. dev
 * environments, repos not yet onboarded via the App).
 *
 * @param {string} owner
 * @param {string} repo
 * @returns {Promise<string>}
 */
export async function resolveOrgId(owner, repo) {
  try {
    const rows = await db
      .select({ orgId: schema.providerInstallations.orgId })
      .from(schema.repos)
      .innerJoin(
        schema.providerInstallations,
        eq(schema.repos.installationId, schema.providerInstallations.id),
      )
      .where(eq(schema.repos.id, `${owner}/${repo}`))
      .limit(1);
    return rows[0]?.orgId ?? 'self-hosted';
  } catch (err) {
    logger.error({ msg: 'Failed to resolve org_id for repo', owner, repo, error: err.message });
    return 'self-hosted';
  }
}

/**
 * Resolve the merged config for a repo.
 * Uses memory cache → DB cache → GitHub API, in that order.
 * @param {string} owner
 * @param {string} repo
 * @returns {object} Merged and validated config
 */
export async function resolveConfig(owner, repo) {
  const repoKey = `${owner}/${repo}`;
  const now = Date.now();

  // Check memory cache first
  const cached = memoryCache.get(repoKey);
  if (cached && cached.expiresAt > now) {
    return cached.config;
  }

  // Check DB cache
  const dbCached = await getDbCache(repoKey);
  if (dbCached) {
    memoryCache.set(repoKey, {
      config: dbCached,
      expiresAt: now + CONFIG_CACHE_TTL_MS,
    });
    return dbCached;
  }

  // Fetch from GitHub
  const defaults = loadDefaults();
  const repoOverride = await fetchRepoConfig(owner, repo);

  let merged;
  if (repoOverride) {
    merged = deepMerge(defaults, repoOverride);
  } else {
    merged = { ...defaults };
  }

  const validated = validateMergedConfig(merged);

  // Cache in memory and DB
  memoryCache.set(repoKey, { config: validated, expiresAt: now + CONFIG_CACHE_TTL_MS });
  await setDbCache(repoKey, validated);

  return validated;
}

/**
 * Invalidate the config cache for a repo.
 * @param {string} owner
 * @param {string} repo
 */
export async function invalidateConfig(owner, repo) {
  const repoKey = `${owner}/${repo}`;
  memoryCache.delete(repoKey);
  try {
    await db.delete(schema.configCache).where(eq(schema.configCache.repo, repoKey));
  } catch (err) {
    logger.error({ msg: 'Failed to invalidate config cache', error: err.message });
  }
}
