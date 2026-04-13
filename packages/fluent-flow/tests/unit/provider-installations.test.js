import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/db/client.js', () => ({ query: vi.fn() }));

import { query } from '../../src/db/client.js';
import {
  upsertInstallation,
  softDeleteInstallation,
  unsuspendInstallation,
  findInstallationByExternalId,
  addRepoToInstallation,
  removeRepoFromInstallation,
} from '../../src/db/provider-installations.js';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('provider-installations', () => {
  it('upsertInstallation inserts on conflict update', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: 1, org_id: 'acme', external_installation_id: '42' }] });
    const row = await upsertInstallation({
      provider: 'github',
      externalInstallationId: '42',
      orgId: 'acme',
      accountLogin: 'acme-inc',
      accountType: 'Organization',
    });
    expect(row.id).toBe(1);
    const [sql, params] = query.mock.calls[0];
    expect(sql).toMatch(/INSERT INTO provider_installations/i);
    expect(sql).toMatch(/ON CONFLICT \(provider, external_installation_id\)/i);
    expect(params).toEqual(['github', '42', 'acme', 'acme-inc', 'Organization']);
  });

  it('findInstallationByExternalId returns row', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: 7 }] });
    const row = await findInstallationByExternalId('github', '99');
    expect(row.id).toBe(7);
  });

  it('findInstallationByExternalId returns null when absent', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    const row = await findInstallationByExternalId('github', '99');
    expect(row).toBeNull();
  });

  it('softDeleteInstallation sets suspended_at', async () => {
    query.mockResolvedValueOnce({ rowCount: 1 });
    await softDeleteInstallation(42);
    const [sql, params] = query.mock.calls[0];
    expect(sql).toMatch(/UPDATE provider_installations/i);
    expect(sql).toMatch(/suspended_at = NOW\(\)/i);
    expect(params).toEqual([42]);
  });

  it('unsuspendInstallation clears suspended_at', async () => {
    query.mockResolvedValueOnce({ rowCount: 1 });
    await unsuspendInstallation(42);
    const [sql] = query.mock.calls[0];
    expect(sql).toMatch(/suspended_at = NULL/i);
  });

  it('addRepoToInstallation soft-deletes any live row under another installation then inserts', async () => {
    query.mockResolvedValueOnce({ rowCount: 1 }); // soft-delete prior
    query.mockResolvedValueOnce({ rows: [{ id: 5 }] }); // insert
    const row = await addRepoToInstallation({
      installationId: 10,
      repoExternalId: '12345',
      repoFullName: 'acme/widgets',
    });
    expect(row.id).toBe(5);
    expect(query).toHaveBeenCalledTimes(2);
    const [firstSql] = query.mock.calls[0];
    expect(firstSql).toMatch(/UPDATE provider_installation_repos/i);
    expect(firstSql).toMatch(/removed_at = NOW\(\)/i);
    const [secondSql] = query.mock.calls[1];
    expect(secondSql).toMatch(/INSERT INTO provider_installation_repos/i);
  });

  it('removeRepoFromInstallation sets removed_at on live row', async () => {
    query.mockResolvedValueOnce({ rowCount: 1 });
    await removeRepoFromInstallation({ installationId: 10, repoExternalId: '12345' });
    const [sql, params] = query.mock.calls[0];
    expect(sql).toMatch(/UPDATE provider_installation_repos/i);
    expect(sql).toMatch(/removed_at = NOW\(\)/i);
    expect(sql).toMatch(/removed_at IS NULL/i);
    expect(params).toEqual([10, '12345']);
  });
});
