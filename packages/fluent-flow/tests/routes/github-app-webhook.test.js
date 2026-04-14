import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/logger.js', async () => {
  const { createMockLogger } = await import('../helpers/mock-logger.js');
  return { default: createMockLogger() };
});

vi.mock('../../src/db/client.js', () => ({ query: vi.fn(), audit: vi.fn() }));

vi.mock('../../src/db/provider-installations.js', () => ({
  upsertInstallation: vi.fn(),
  softDeleteInstallation: vi.fn(),
  unsuspendInstallation: vi.fn(),
  findInstallationByExternalId: vi.fn(),
  addRepoToInstallation: vi.fn(),
  removeRepoFromInstallation: vi.fn(),
}));

vi.mock('../../src/db/outbound-queue.js', () => ({
  parkForInstallation: vi.fn(),
  unparkForInstallation: vi.fn(),
}));

import { query } from '../../src/db/client.js';
import {
  upsertInstallation,
  softDeleteInstallation,
  unsuspendInstallation,
  findInstallationByExternalId,
} from '../../src/db/provider-installations.js';
import { parkForInstallation, unparkForInstallation } from '../../src/db/outbound-queue.js';

import {
  handleInstallationCreated,
  handleInstallationSuspended,
  handleInstallationUnsuspended,
  handleInstallationRepositoriesAdded,
  handleInstallationRepositoriesRemoved,
} from '../../src/engine/installation-lifecycle.js';

const ACCOUNT_LOGIN = 'acme-org';
const EXTERNAL_INSTALLATION_ID = 42;

const installationPayload = {
  installation: {
    id: EXTERNAL_INSTALLATION_ID,
    account: { login: ACCOUNT_LOGIN, type: 'Organization' },
    permissions: { pull_requests: 'write', checks: 'write' },
    events: ['pull_request', 'check_run'],
  },
};

const mockInstallationRow = { id: 7, external_installation_id: EXTERNAL_INSTALLATION_ID };

beforeEach(() => {
  vi.clearAllMocks();
  upsertInstallation.mockResolvedValue(mockInstallationRow);
  softDeleteInstallation.mockResolvedValue(mockInstallationRow);
  unsuspendInstallation.mockResolvedValue(mockInstallationRow);
  findInstallationByExternalId.mockResolvedValue(mockInstallationRow);
  parkForInstallation.mockResolvedValue(undefined);
  unparkForInstallation.mockResolvedValue(undefined);
  // query mock for ensureOrg (INSERT INTO orgs) and cancel claims
  query.mockResolvedValue({ rows: [] });
});

describe('handleInstallationCreated', () => {
  it('ensures org exists and upserts installation', async () => {
    await handleInstallationCreated(installationPayload);

    // Should create/ensure the org row
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO orgs'),
      expect.arrayContaining([ACCOUNT_LOGIN])
    );

    // Should upsert the installation with correct fields
    expect(upsertInstallation).toHaveBeenCalledWith(
      expect.objectContaining({
        org_id: ACCOUNT_LOGIN,
        external_installation_id: EXTERNAL_INSTALLATION_ID,
        account_login: ACCOUNT_LOGIN,
        account_type: 'Organization',
      })
    );
  });
});

describe('handleInstallationSuspended', () => {
  it('soft-deletes installation, cancels in-flight claims, parks queue', async () => {
    await handleInstallationSuspended(EXTERNAL_INSTALLATION_ID);

    expect(findInstallationByExternalId).toHaveBeenCalledWith(EXTERNAL_INSTALLATION_ID);
    expect(softDeleteInstallation).toHaveBeenCalledWith(mockInstallationRow.id);

    // Should cancel in-flight claims for the installation
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE agent_claims'),
      expect.any(Array)
    );

    // Should park queue rows for the installation
    expect(parkForInstallation).toHaveBeenCalledWith(mockInstallationRow.id);
  });

  it('is a no-op if installation not found', async () => {
    findInstallationByExternalId.mockResolvedValue(null);
    await handleInstallationSuspended(999);

    expect(softDeleteInstallation).not.toHaveBeenCalled();
    expect(parkForInstallation).not.toHaveBeenCalled();
  });
});

describe('handleInstallationUnsuspended', () => {
  it('unsuspends installation and unparks queue rows', async () => {
    await handleInstallationUnsuspended(EXTERNAL_INSTALLATION_ID);

    expect(findInstallationByExternalId).toHaveBeenCalledWith(EXTERNAL_INSTALLATION_ID);
    expect(unsuspendInstallation).toHaveBeenCalledWith(mockInstallationRow.id);
    expect(unparkForInstallation).toHaveBeenCalledWith(mockInstallationRow.id, expect.any(Number));
  });

  it('is a no-op if installation not found', async () => {
    findInstallationByExternalId.mockResolvedValue(null);
    await handleInstallationUnsuspended(999);

    expect(unsuspendInstallation).not.toHaveBeenCalled();
    expect(unparkForInstallation).not.toHaveBeenCalled();
  });
});

describe('handleInstallationRepositoriesAdded', () => {
  it('adds each repo to the installation', async () => {
    const { addRepoToInstallation } = await import('../../src/db/provider-installations.js');
    const payload = {
      installation: { id: EXTERNAL_INSTALLATION_ID },
      repositories_added: [
        { id: 101, full_name: 'acme-org/repo-a' },
        { id: 102, full_name: 'acme-org/repo-b' },
      ],
    };

    await handleInstallationRepositoriesAdded(payload);

    expect(findInstallationByExternalId).toHaveBeenCalledWith(EXTERNAL_INSTALLATION_ID);
    expect(addRepoToInstallation).toHaveBeenCalledWith(
      mockInstallationRow.id,
      { repo_external_id: 101, repo_full_name: 'acme-org/repo-a' }
    );
    expect(addRepoToInstallation).toHaveBeenCalledWith(
      mockInstallationRow.id,
      { repo_external_id: 102, repo_full_name: 'acme-org/repo-b' }
    );
  });

  it('is a no-op if installation not found', async () => {
    const { addRepoToInstallation } = await import('../../src/db/provider-installations.js');
    findInstallationByExternalId.mockResolvedValue(null);
    await handleInstallationRepositoriesAdded({
      installation: { id: 999 },
      repositories_added: [{ id: 1, full_name: 'a/b' }],
    });
    expect(addRepoToInstallation).not.toHaveBeenCalled();
  });
});

describe('handleInstallationRepositoriesRemoved', () => {
  it('soft-deletes each repo link from the installation', async () => {
    const { removeRepoFromInstallation } = await import('../../src/db/provider-installations.js');
    const payload = {
      installation: { id: EXTERNAL_INSTALLATION_ID },
      repositories_removed: [
        { id: 101, full_name: 'acme-org/repo-a' },
      ],
    };

    await handleInstallationRepositoriesRemoved(payload);

    expect(findInstallationByExternalId).toHaveBeenCalledWith(EXTERNAL_INSTALLATION_ID);
    expect(removeRepoFromInstallation).toHaveBeenCalledWith(mockInstallationRow.id, 101);
  });

  it('is a no-op if installation not found', async () => {
    const { removeRepoFromInstallation } = await import('../../src/db/provider-installations.js');
    findInstallationByExternalId.mockResolvedValue(null);
    await handleInstallationRepositoriesRemoved({
      installation: { id: 999 },
      repositories_removed: [{ id: 1, full_name: 'a/b' }],
    });
    expect(removeRepoFromInstallation).not.toHaveBeenCalled();
  });
});
