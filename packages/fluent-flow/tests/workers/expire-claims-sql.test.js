import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock logger so claim-manager doesn't fail on log calls
vi.mock('../../src/logger.js', async () => {
  const { createMockLogger } = await import('../helpers/mock-logger.js');
  return { default: createMockLogger() };
});

// Mock audit to avoid DB dependency
vi.mock('../../src/db/client.js', () => ({
  audit: vi.fn(),
}));

// Mock session manager so freeSession doesn't hit real DB
vi.mock('../../src/agents/session-manager.js', () => ({
  setSessionStatus: vi.fn().mockResolvedValue(undefined),
}));

// Holder for the captured .set() args — populated inside the mock factory below.
// Using an indirection object so the hoisted factory can reference it.
const captured = { setArgs: [], tableName: null };

// Build chainable mock inside the async factory
vi.mock('@fluent-flow/db', async (importOriginal) => {
  // Import the real schema so Drizzle column references (agentClaims.status,
  // agentClaims.expiresAt) are actual pg-column objects, not placeholders.
  const real = await importOriginal();
  const { agentClaims } = real.schema;

  // Chain: db.update(table).set(args).where(cond).returning()
  const returning = vi.fn().mockResolvedValue([]);
  const where = vi.fn().mockReturnValue({ returning });
  const set = vi.fn().mockImplementation((args) => {
    captured.setArgs.push(args);
    return { where };
  });
  const update = vi.fn().mockImplementation((table) => {
    captured.tableName = table;
    return { set };
  });

  return {
    db: { update, set, where, returning },
    schema: real.schema,
  };
});

import { db } from '@fluent-flow/db';
import { expireClaims } from '../../src/agents/claim-manager.js';

beforeEach(() => {
  vi.clearAllMocks();
  captured.setArgs = [];
  captured.tableName = null;
  // Reset returning to resolve with empty array by default
  db.returning.mockResolvedValue([]);
});

describe('expireClaims() SQL behavior', () => {
  it('must NOT set archivedAt — only status + completedAt', async () => {
    // archivedAt is reserved for explicit dismiss/cancel operations.
    // Expiry uses status='expired' + completedAt only, so pipeline views
    // (archived_at IS NULL) continue to show the claim until explicitly dismissed.
    //
    // This test calls the real expireClaims() with a mocked db, capturing the
    // .set() args to verify archivedAt is absent — real regression protection.
    await expireClaims();

    // db.update was called
    expect(db.update).toHaveBeenCalledTimes(1);

    // .set() was called exactly once
    expect(db.set).toHaveBeenCalledTimes(1);

    const setCall = captured.setArgs[0];

    // Must set status to 'expired'
    expect(setCall).toHaveProperty('status', 'expired');

    // Must set completedAt
    expect(setCall).toHaveProperty('completedAt');

    // Must NOT set archivedAt — this is the critical regression check
    expect(setCall).not.toHaveProperty('archivedAt');
  });
});
