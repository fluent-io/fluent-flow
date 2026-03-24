import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/logger.js', async () => {
  const { createMockLogger } = await import('../helpers/mock-logger.js');
  return { default: createMockLogger() };
});
vi.mock('../../src/db/client.js', () => ({ query: vi.fn(), audit: vi.fn() }));

import { query } from '../../src/db/client.js';
import { getPendingActions } from '../../src/mcp/tools/pending.js';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('getPendingActions', () => {
  it('returns review failures', async () => {
    query.mockResolvedValueOnce({
      rows: [{ action_type: 'review_failed', repo: 'org/repo', pr_number: 7, retry_count: 2 }],
    });

    const actions = await getPendingActions('test-agent');
    expect(actions).toHaveLength(1);
    expect(actions[0].action_type).toBe('review_failed');
    expect(actions[0].pr_number).toBe(7);
  });

  it('returns active pauses', async () => {
    query.mockResolvedValueOnce({
      rows: [{ action_type: 'paused', repo: 'org/repo', issue_number: 42, detail: { reason: 'agent-stuck' } }],
    });

    const actions = await getPendingActions('test-agent');
    expect(actions).toHaveLength(1);
    expect(actions[0].action_type).toBe('paused');
  });

  it('returns resumed pauses and auto-acknowledges', async () => {
    query
      .mockResolvedValueOnce({
        rows: [{ action_type: 'resumed', repo: 'org/repo', issue_number: 42, detail: { target_state: 'In Review', instructions: 'Fix it' } }],
      })
      .mockResolvedValueOnce({ rows: [] }); // acknowledge update

    const actions = await getPendingActions('test-agent');
    expect(actions).toHaveLength(1);
    expect(actions[0].action_type).toBe('resumed');
    // Verify acknowledge query was fired
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('returns empty array when no pending actions', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    const actions = await getPendingActions('test-agent');
    expect(actions).toEqual([]);
  });

  it('returns mixed action types', async () => {
    query.mockResolvedValueOnce({
      rows: [
        { action_type: 'review_failed', repo: 'org/repo', pr_number: 7 },
        { action_type: 'paused', repo: 'org/repo', issue_number: 42 },
        { action_type: 'resumed', repo: 'org/other', issue_number: 10 },
      ],
    }).mockResolvedValueOnce({ rows: [] }); // acknowledge

    const actions = await getPendingActions('test-agent');
    expect(actions).toHaveLength(3);
  });

  it('passes repo filter to query when provided', async () => {
    query.mockResolvedValueOnce({ rows: [] });

    await getPendingActions('test-agent', 'org/specific-repo');

    const sql = query.mock.calls[0][0];
    expect(sql).toContain('$2');
    expect(query.mock.calls[0][1]).toEqual(['test-agent', 'org/specific-repo']);
  });

  it('does not pass repo param when not filtered', async () => {
    query.mockResolvedValueOnce({ rows: [] });

    await getPendingActions('test-agent');

    expect(query.mock.calls[0][1]).toEqual(['test-agent']);
  });
});
