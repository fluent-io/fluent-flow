/**
 * Shared mock factories for engine tests.
 * All engine modules depend on db/client, config/loader, github/*, and notifications/dispatcher.
 * This file provides reusable mock setups to keep tests DRY.
 */
import { vi } from 'vitest';
import yaml from 'js-yaml';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const defaultsPath = join(__dirname, '../../config/defaults.yml');
const DEFAULTS = yaml.load(readFileSync(defaultsPath, 'utf8'));

/**
 * Build a merged config object (defaults + overrides).
 * Matches what resolveConfig returns in production.
 */
export function buildConfig(overrides = {}) {
  return {
    ...DEFAULTS,
    project_id: 'PVT_test',
    project_ids: ['PVT_test'],
    default_agent: 'test-agent',
    delivery: { channel: '#test' },
    ...overrides,
  };
}

/** Standard test identifiers */
export const TEST_OWNER = 'test-org';
export const TEST_REPO = 'test-repo';
export const TEST_REPO_KEY = `${TEST_OWNER}/${TEST_REPO}`;

/**
 * Create a mock for db/client.query that returns configurable rows.
 * Usage: mockQuery.mockResolvedValueOnce({ rows: [...] })
 */
export function createMockQuery() {
  return vi.fn().mockResolvedValue({ rows: [] });
}

/**
 * Create a mock for config/loader.resolveConfig.
 * Returns buildConfig() by default; override per-test with mockResolvedValueOnce.
 */
export function createMockResolveConfig(overrides = {}) {
  return vi.fn().mockResolvedValue(buildConfig(overrides));
}

/**
 * Create a mock DB transition record (what INSERT...RETURNING * gives back).
 */
export function makeTransitionRecord(overrides = {}) {
  return {
    id: 1,
    repo: TEST_REPO_KEY,
    issue_number: 42,
    from_state: 'In Progress',
    to_state: 'In Review',
    trigger_type: 'webhook',
    trigger_detail: null,
    actor: null,
    metadata: null,
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

/**
 * Create a mock pause record.
 */
export function makePauseRecord(overrides = {}) {
  return {
    id: 1,
    repo: TEST_REPO_KEY,
    issue_number: 42,
    pr_number: 7,
    previous_state: 'In Review',
    reason: 'manual',
    context: null,
    checklist: '[]',
    agent_id: 'test-agent',
    paused_at: new Date().toISOString(),
    resumed_at: null,
    resumed_by: null,
    resume_instructions: null,
    resume_to_state: null,
    ...overrides,
  };
}

/**
 * Create a mock review retry record.
 */
export function makeRetryRecord(overrides = {}) {
  return {
    id: 1,
    repo: TEST_REPO_KEY,
    pr_number: 7,
    retry_count: 1,
    last_issues: null,
    last_review_sha: 'abc123',
    last_dispatch_sha: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

/**
 * Create a mock agent record.
 */
export function makeAgentRecord(overrides = {}) {
  return {
    id: 'test-agent',
    org_id: 'self-hosted',
    agent_type: 'claude-code',
    transport: 'long_poll',
    transport_meta: {},
    repos: [],
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

/**
 * Create a mock agent session record.
 */
export function makeSessionRecord(overrides = {}) {
  return {
    id: 1,
    org_id: 'self-hosted',
    agent_id: 'test-agent',
    session_meta: { hostname: 'dev-laptop' },
    status: 'online',
    registered_at: new Date().toISOString(),
    last_seen_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 300000).toISOString(),
    ...overrides,
  };
}

/**
 * Create a mock agent claim record.
 */
export function makeClaimRecord(overrides = {}) {
  return {
    id: 1,
    org_id: 'self-hosted',
    repo: TEST_REPO_KEY,
    pr_number: 7,
    attempt: 1,
    session_id: 1,
    claim_type: 'review_fix',
    status: 'claimed',
    payload: {},
    claimed_at: new Date().toISOString(),
    completed_at: null,
    expires_at: new Date(Date.now() + 900000).toISOString(),
    created_at: new Date().toISOString(),
    ...overrides,
  };
}
