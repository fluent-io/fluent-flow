import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/logger.js', async () => {
  const { createMockLogger } = await import('../helpers/mock-logger.js');
  return { default: createMockLogger() };
});

// Track all db.insert calls so we can assert on repos row creation.
const mockInsertCalls = [];
const mockSelectResults = {};

vi.mock('@fluent-flow/db', () => ({
  db: {
    insert: vi.fn().mockImplementation(() => ({
      values: vi.fn().mockImplementation((values) => ({
        onConflictDoNothing: vi.fn().mockImplementation(() => {
          mockInsertCalls.push(values);
          return Promise.resolve([]);
        }),
        onConflictDoUpdate: vi.fn().mockImplementation(() => {
          mockInsertCalls.push(values);
          return Promise.resolve([]);
        }),
      })),
    })),
    select: vi.fn().mockImplementation(() => ({
      from: vi.fn().mockImplementation(() => ({
        where: vi.fn().mockImplementation(() => ({
          limit: vi.fn().mockImplementation(() => Promise.resolve(mockSelectResults.selectResult ?? [])),
        })),
      })),
    })),
  },
  schema: {
    repos: { id: 'repos.id' },
    providerInstallations: { id: 'providerInstallations.id', orgId: 'providerInstallations.orgId', suspendedAt: 'providerInstallations.suspendedAt' },
  },
}));

vi.mock('../../src/config/loader.js', () => ({
  resolveConfig: vi.fn().mockRejectedValue(new Error('no config')),
  invalidateConfig: vi.fn(),
  resolveOrgId: vi.fn().mockResolvedValue('self-hosted'),
}));

vi.mock('../../src/db/client.js', () => ({
  query: vi.fn(),
  audit: vi.fn(),
}));

vi.mock('../../src/engine/state-machine.js', () => ({
  executeTransition: vi.fn(),
  autoTransition: vi.fn(),
  getCurrentState: vi.fn(),
}));

vi.mock('../../src/engine/pause-manager.js', () => ({
  recordPause: vi.fn(),
  processResume: vi.fn(),
  parseResumeCommand: vi.fn().mockReturnValue({ isResume: false }),
  getActivePause: vi.fn(),
}));

vi.mock('../../src/engine/review-manager.js', () => ({
  dispatchReview: vi.fn(),
  handleReviewResult: vi.fn(),
  getRetryRecord: vi.fn(),
  resetRetries: vi.fn(),
}));

vi.mock('../../src/notifications/dispatcher.js', () => ({
  resolveAgentId: vi.fn(),
  notifyPRMerged: vi.fn(),
  resolveAgentForIssue: vi.fn(),
}));

vi.mock('../../src/providers/github/rest.js', () => ({
  getLinkedPR: vi.fn(),
  getPR: vi.fn(),
}));

vi.mock('../../src/providers/github/check-run-handler.js', () => ({
  handleCheckRun: vi.fn(),
}));

vi.mock('../../src/providers/github/webhook-verify.js', () => ({
  webhookSignatureMiddleware: (req, res, next) => next(),
}));

const { routeWebhookEvent } = await import('../../src/routes/webhook.js');

// Helper: reset and configure mock select to return a specific result.
// The `db.select()` mock reads from mockSelectResults.selectResult.
function setSelectResult(rows) {
  mockSelectResults.selectResult = rows;
}

function buildPushPayload(repoFullName, overrides = {}) {
  return {
    action: 'completed',
    repository: {
      id: 55555,
      full_name: repoFullName,
      name: repoFullName.split('/')[1],
      owner: { login: repoFullName.split('/')[0] },
    },
    sender: { login: 'test-user' },
    commits: [],
    ...overrides,
  };
}

describe('routeWebhookEvent — lazy onboarding', () => {
  beforeEach(() => {
    mockInsertCalls.length = 0;
    mockSelectResults.selectResult = [];
  });

  it('creates a repos shell row when no repos row exists but an active installation matches', async () => {
    // First select (repos lookup) → no existing row
    // Second select (installations lookup) → active install found
    const { db } = await import('@fluent-flow/db');
    let selectCallIndex = 0;
    db.select.mockImplementation(() => ({
      from: vi.fn().mockImplementation(() => ({
        where: vi.fn().mockImplementation(() => ({
          limit: vi.fn().mockImplementation(() => {
            selectCallIndex++;
            // First call: repos lookup → empty (no repos row)
            // Second call: installations lookup → active install found
            if (selectCallIndex === 1) return Promise.resolve([]);
            return Promise.resolve([{ id: 42, orgId: 'acme' }]);
          }),
        })),
      })),
    }));

    await routeWebhookEvent('push', buildPushPayload('acme/my-repo'));

    // repos INSERT happened (shell row created)
    expect(mockInsertCalls.length).toBeGreaterThanOrEqual(1);
    const insertValues = mockInsertCalls[0];
    expect(insertValues).toMatchObject({
      id: 'acme/my-repo',
      orgId: 'acme',
      repoExternalId: 55555,
      repoFullName: 'acme/my-repo',
      provider: 'github',
      installationId: 42,
    });
  });

  it('does NOT create a repos shell row when one already exists', async () => {
    const { db } = await import('@fluent-flow/db');
    let selectCallIndex = 0;
    db.select.mockImplementation(() => ({
      from: vi.fn().mockImplementation(() => ({
        where: vi.fn().mockImplementation(() => ({
          limit: vi.fn().mockImplementation(() => {
            selectCallIndex++;
            // First call: repos lookup → row already exists
            if (selectCallIndex === 1) return Promise.resolve([{ id: 'acme/my-repo' }]);
            return Promise.resolve([]);
          }),
        })),
      })),
    }));

    await routeWebhookEvent('push', buildPushPayload('acme/my-repo'));

    // No INSERT happened because repos row already existed
    expect(mockInsertCalls).toHaveLength(0);
  });

  it('does NOT create a repos shell row when no active installation matches', async () => {
    const { db } = await import('@fluent-flow/db');
    let selectCallIndex = 0;
    db.select.mockImplementation(() => ({
      from: vi.fn().mockImplementation(() => ({
        where: vi.fn().mockImplementation(() => ({
          limit: vi.fn().mockImplementation(() => {
            selectCallIndex++;
            // First call: repos lookup → empty
            // Second call: installations lookup → no active install
            if (selectCallIndex === 1) return Promise.resolve([]);
            return Promise.resolve([]);
          }),
        })),
      })),
    }));

    await routeWebhookEvent('push', buildPushPayload('unknown-org/some-repo'));

    // No INSERT happened because no installation matched
    expect(mockInsertCalls).toHaveLength(0);
  });
});
