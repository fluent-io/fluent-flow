import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/logger.js', async () => {
  const { createMockLogger } = await import('../helpers/mock-logger.js');
  return { default: createMockLogger() };
});

const mockUpsertUser = vi.fn();
const mockLinkUserToOrg = vi.fn();
const mockInsertChain = vi.fn().mockResolvedValue([]);

vi.mock('@fluent-flow/db', () => ({
  db: {
    insert: () => ({ values: () => ({ onConflictDoNothing: mockInsertChain }) }),
  },
  schema: { orgs: {}, agentClaims: {}, repos: {} },
  upsertUser: (...args) => mockUpsertUser(...args),
  linkUserToOrg: (...args) => mockLinkUserToOrg(...args),
}));

const mockUpsertInstallation = vi.fn().mockResolvedValue({ id: 999 });
vi.mock('../../src/db/provider-installations.js', () => ({
  upsertInstallation: (...args) => mockUpsertInstallation(...args),
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

const { handleInstallationCreated } = await import('../../src/engine/installation-lifecycle.js');

function buildPayload(overrides = {}) {
  return {
    installation: {
      id: 12345,
      account: { login: 'acme', type: 'Organization' },
      permissions: { contents: 'read' },
      events: ['push'],
    },
    sender: { id: 777, login: 'victor', type: 'User', avatar_url: 'https://a.b/c.png' },
    ...overrides,
  };
}

describe('handleInstallationCreated', () => {
  beforeEach(() => {
    mockUpsertUser.mockReset();
    mockLinkUserToOrg.mockReset();
    mockUpsertInstallation.mockClear();
    mockUpsertInstallation.mockResolvedValue({ id: 999 });
  });

  it('links a human sender to the org as admin', async () => {
    mockUpsertUser.mockResolvedValue({ id: 42 });
    mockLinkUserToOrg.mockResolvedValue(undefined);

    await handleInstallationCreated(buildPayload());

    expect(mockUpsertUser).toHaveBeenCalledWith({
      github_id: 777,
      login: 'victor',
      email: null,
      avatar_url: 'https://a.b/c.png',
    });
    expect(mockLinkUserToOrg).toHaveBeenCalledWith(42, 'acme', 'admin');
  });

  it('skips linking when sender is a Bot', async () => {
    await handleInstallationCreated(buildPayload({
      sender: { id: 1, login: 'some-bot', type: 'Bot' },
    }));

    expect(mockUpsertUser).not.toHaveBeenCalled();
    expect(mockLinkUserToOrg).not.toHaveBeenCalled();
  });

  it('skips linking when sender is missing', async () => {
    await handleInstallationCreated(buildPayload({ sender: undefined }));

    expect(mockUpsertUser).not.toHaveBeenCalled();
    expect(mockLinkUserToOrg).not.toHaveBeenCalled();
  });

  it('does not throw when linking fails — webhook completes installation anyway', async () => {
    mockUpsertUser.mockResolvedValue({ id: 42 });
    mockLinkUserToOrg.mockRejectedValue(new Error('db blew up'));

    await expect(handleInstallationCreated(buildPayload())).resolves.toBeDefined();
    expect(mockUpsertInstallation).toHaveBeenCalled();
  });
});
