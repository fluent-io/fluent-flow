import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock db client and logger before importing module under test
vi.mock('../../src/db/client.js', () => ({ query: vi.fn(), audit: vi.fn() }));
vi.mock('../../src/logger.js', async () => {
  const { createMockLogger } = await import('../helpers/mock-logger.js');
  return { default: createMockLogger() };
});

import { query } from '../../src/db/client.js';
import {
  upsertInstallation,
  softDeleteInstallation,
  unsuspendInstallation,
  findInstallationByExternalId,
  addRepoToInstallation,
  removeRepoFromInstallation,
} from '../../src/db/provider-installations.js';

const mockQuery = /** @type {import('vitest').MockedFunction<typeof query>} */ (query);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('upsertInstallation', () => {
  it('calls INSERT ... ON CONFLICT DO UPDATE and returns the row', async () => {
    const row = {
      id: 1,
      org_id: 'acme',
      external_installation_id: 999,
      account_login: 'acme',
      account_type: 'Organization',
      permissions: { checks: 'write' },
      events: [],
      suspended_at: null,
    };
    mockQuery.mockResolvedValueOnce({ rows: [row] });

    const result = await upsertInstallation({
      org_id: 'acme',
      external_installation_id: 999,
      account_login: 'acme',
      account_type: 'Organization',
      permissions: { checks: 'write' },
      events: [],
    });

    expect(result).toEqual(row);
    expect(mockQuery).toHaveBeenCalledOnce();
    const [sql] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/INSERT INTO provider_installations/i);
    expect(sql).toMatch(/ON CONFLICT/i);
  });
});

describe('softDeleteInstallation', () => {
  it('sets suspended_at on the installation row', async () => {
    const row = { id: 1, suspended_at: new Date() };
    mockQuery.mockResolvedValueOnce({ rows: [row] });

    const result = await softDeleteInstallation(1);
    expect(result.suspended_at).toBeDefined();
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/UPDATE provider_installations/i);
    expect(sql).toMatch(/suspended_at/i);
    expect(params).toContain(1);
  });
});

describe('unsuspendInstallation', () => {
  it('clears suspended_at on the installation row', async () => {
    const row = { id: 1, suspended_at: null };
    mockQuery.mockResolvedValueOnce({ rows: [row] });

    await unsuspendInstallation(1);
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/UPDATE provider_installations/i);
    expect(params).toContain(1);
  });
});

describe('findInstallationByExternalId', () => {
  it('queries by external_installation_id', async () => {
    const row = { id: 5, external_installation_id: 999, suspended_at: null };
    mockQuery.mockResolvedValueOnce({ rows: [row] });

    const result = await findInstallationByExternalId(999);
    expect(result).toEqual(row);
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/SELECT/i);
    expect(params).toContain(999);
  });

  it('returns null when not found', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const result = await findInstallationByExternalId(0);
    expect(result).toBeNull();
  });
});

describe('addRepoToInstallation', () => {
  it('upserts repo and re-links on cross-installation transfer', async () => {
    // The function should: soft-delete any other active link for this repo_external_id,
    // then insert/upsert a new link for this installation
    mockQuery
      .mockResolvedValueOnce({ rows: [] }) // soft-delete old links
      .mockResolvedValueOnce({ rows: [{ id: 1, installation_id: 2, repo_external_id: 42, repo_full_name: 'b/r' }] }); // insert new link

    const result = await addRepoToInstallation(2, { repo_external_id: 42, repo_full_name: 'b/r' });
    expect(result).toBeDefined();
    expect(mockQuery).toHaveBeenCalledTimes(2);
  });
});

describe('removeRepoFromInstallation', () => {
  it('sets removed_at on the matching repo link', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 1, removed_at: new Date() }] });

    await removeRepoFromInstallation(1, 42);
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/UPDATE provider_installation_repos/i);
    expect(sql).toMatch(/removed_at/i);
    expect(params).toContain(1);
    expect(params).toContain(42);
  });
});
