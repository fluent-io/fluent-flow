import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/db/client.js', () => ({ query: vi.fn(), audit: vi.fn() }));
vi.mock('../../src/logger.js', async () => {
  const { createMockLogger } = await import('../helpers/mock-logger.js');
  return { default: createMockLogger() };
});

import { query } from '../../src/db/client.js';
import {
  upsertRepoConfig,
  resolveRepoConfig,
  listRepoConfigHistory,
} from '../../src/db/repo-configs.js';

const mockQuery = /** @type {import('vitest').MockedFunction<typeof query>} */ (query);

const BUILT_IN_DEFAULTS = {
  default_agent: undefined,
  claim_types: undefined,
  review_model: undefined,
  paused: false,
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('upsertRepoConfig', () => {
  it('validates via RepoConfigSchema and writes to repo_configs', async () => {
    const patch = { default_agent: 'getonit', claim_types: ['review'], review_model: 'claude-opus-4-6', paused: false };
    // SELECT existing for diff, then UPSERT, then INSERT history
    mockQuery
      .mockResolvedValueOnce({ rows: [] })                  // SELECT existing config
      .mockResolvedValueOnce({ rows: [{ repo_id: 'acme/repo', ...patch }] }) // UPSERT
      .mockResolvedValueOnce({ rows: [{ id: 1 }] });        // INSERT history

    const result = await upsertRepoConfig('acme/repo', patch, 'admin-user');
    expect(result.default_agent).toBe('getonit');
    expect(mockQuery).toHaveBeenCalledTimes(3);
  });

  it('throws on invalid claim_types', async () => {
    await expect(
      upsertRepoConfig('acme/repo', { claim_types: ['not-valid'] }, 'admin')
    ).rejects.toThrow();
  });

  it('appends a repo_config_history row on upsert', async () => {
    const patch = { paused: true };
    mockQuery
      .mockResolvedValueOnce({ rows: [] })                  // SELECT existing
      .mockResolvedValueOnce({ rows: [{ repo_id: 'r', paused: true }] }) // UPSERT
      .mockResolvedValueOnce({ rows: [{ id: 2 }] });        // INSERT history

    await upsertRepoConfig('acme/repo', patch, 'user1');
    const historySql = mockQuery.mock.calls[2][0];
    expect(historySql).toMatch(/INSERT INTO repo_config_history/i);
  });
});

describe('resolveRepoConfig', () => {
  it('merges defaults <- org_config <- repo_configs (repo wins)', async () => {
    // Queries: SELECT org_config, SELECT repo_configs
    mockQuery
      .mockResolvedValueOnce({ rows: [{ default_agent: 'org-agent', review_model: 'claude-haiku' }] }) // org_config
      .mockResolvedValueOnce({ rows: [{ default_agent: 'repo-agent', review_model: null, paused: false }] }); // repo_configs

    const result = await resolveRepoConfig('acme/repo');
    // repo_configs.default_agent overrides org_config.default_agent
    expect(result.default_agent).toBe('repo-agent');
    // org_config review_model used when repo doesn't override
    expect(result.review_model).toBe('claude-haiku');
    expect(result.paused).toBe(false);
  });

  it('falls back to org_config when no repo config', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ default_agent: 'org-agent', review_model: 'claude-haiku', default_claim_types: ['review'] }] }) // org_config
      .mockResolvedValueOnce({ rows: [] }); // no repo_configs

    const result = await resolveRepoConfig('acme/repo');
    expect(result.default_agent).toBe('org-agent');
  });

  it('falls back to built-in defaults when neither org nor repo config exists', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [] }) // no org_config
      .mockResolvedValueOnce({ rows: [] }); // no repo_configs

    const result = await resolveRepoConfig('acme/repo');
    expect(result.paused).toBe(false);
  });
});

describe('listRepoConfigHistory', () => {
  it('returns patches in reverse chronological order', async () => {
    const rows = [
      { id: 2, patch: [{ op: 'replace', path: '/paused', value: true }], actor: 'u1', at: new Date() },
      { id: 1, patch: [{ op: 'add', path: '/default_agent', value: 'bot' }], actor: 'u2', at: new Date() },
    ];
    mockQuery.mockResolvedValueOnce({ rows });

    const result = await listRepoConfigHistory('acme/repo');
    expect(result).toHaveLength(2);
    expect(result[0].id).toBe(2);

    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/SELECT.*FROM repo_config_history/i);
    expect(sql).toMatch(/ORDER BY at DESC/i);
    expect(params).toContain('acme/repo');
  });
});
