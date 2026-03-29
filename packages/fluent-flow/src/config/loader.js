import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import yaml from 'js-yaml';
import { query } from '../db/client.js';
import { validateDefaults, validateRepoConfig, validateMergedConfig } from './schema.js';
import { getRepoFileContents } from '../github/rest.js';
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
 * Fetch repo config from GitHub and cache in DB.
 * @param {string} owner
 * @param {string} repo
 * @returns {object|null} Validated repo config or null if not found
 */
async function fetchRepoConfig(owner, repo) {
  try {
    const content = await getRepoFileContents(owner, repo, '.github/fluent-flow.yml');
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
    const result = await query(
      'SELECT config FROM config_cache WHERE repo = $1 AND expires_at > NOW()',
      [repoKey]
    );
    if (result.rows.length > 0) {
      return result.rows[0].config;
    }
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
    await query(
      `INSERT INTO config_cache (repo, config, fetched_at, expires_at)
       VALUES ($1, $2, NOW(), NOW() + $3::interval)
       ON CONFLICT (repo) DO UPDATE
         SET config = $2, fetched_at = NOW(), expires_at = NOW() + $3::interval`,
      [repoKey, JSON.stringify(config), `${CONFIG_CACHE_TTL_MS} milliseconds`]
    );
  } catch (err) {
    logger.error({ msg: 'Failed to write config cache to DB', error: err.message });
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
    await query('DELETE FROM config_cache WHERE repo = $1', [repoKey]);
  } catch (err) {
    logger.error({ msg: 'Failed to invalidate config cache', error: err.message });
  }
}
