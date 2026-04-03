import { WorkQueueAdapter } from './adapter.js';
import { GitHubProjectsAdapter } from './adapters/github-projects.js';
import logger from '../logger.js';

const ADAPTERS = {
  'github-projects': GitHubProjectsAdapter
};

/**
 * Get work queue adapter instance.
 * @param {string} type - Adapter type (github-projects, linear, jira, etc.)
 * @param {object} config - Adapter-specific config
 * @returns {WorkQueueAdapter}
 */
export function getAdapter(type, config) {
  const AdapterClass = ADAPTERS[type];

  if (!AdapterClass) {
    throw new Error(`Unknown work queue adapter: ${type}`);
  }

  logger.info({ msg: 'Loaded work queue adapter', type });
  return new AdapterClass(config);
}

/**
 * Register a new adapter.
 * @param {string} type
 * @param {class} AdapterClass
 */
export function registerAdapter(type, AdapterClass) {
  ADAPTERS[type] = AdapterClass;
  logger.info({ msg: 'Registered work queue adapter', type });
}

export { WorkQueueAdapter } from './adapter.js';

/**
 * Reset the adapter registry to defaults (for testing).
 */
export function resetAdapters() {
  for (const key of Object.keys(ADAPTERS)) {
    delete ADAPTERS[key];
  }
  ADAPTERS['github-projects'] = GitHubProjectsAdapter;
}
