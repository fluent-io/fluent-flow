import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  buildConfig, TEST_OWNER, TEST_REPO, TEST_REPO_KEY,
  createMockQuery, makeTransitionRecord,
} from '../helpers/mocks.js';

// Mock all external dependencies
vi.mock('../../src/db/client.js', () => ({ query: vi.fn() }));
vi.mock('../../src/config/loader.js', () => ({ resolveConfig: vi.fn() }));
vi.mock('../../src/github/graphql.js', () => ({
  moveProjectItem: vi.fn(),
  findProjectItem: vi.fn(),
}));
vi.mock('../../src/github/rest.js', () => ({
  postComment: vi.fn(),
  getIssue: vi.fn(),
}));

import { query } from '../../src/db/client.js';
import { resolveConfig } from '../../src/config/loader.js';
import { moveProjectItem, findProjectItem } from '../../src/github/graphql.js';
import { postComment } from '../../src/github/rest.js';
import { executeTransition, autoTransition, attemptTransitionToDone } from '../../src/engine/state-machine.js';

beforeEach(() => {
  vi.clearAllMocks();
  resolveConfig.mockResolvedValue(buildConfig());
});

/** Helper: mock getCurrentState by making query return a specific state */
function mockCurrentState(state) {
  query.mockResolvedValueOnce({ rows: state ? [{ to_state: state }] : [] });
}

/** Helper: mock recordTransition insert */
function mockRecordTransition(overrides = {}) {
  query.mockResolvedValueOnce({ rows: [makeTransitionRecord(overrides)] });
}

describe('executeTransition', () => {
  it('records valid transition and returns result', async () => {
    mockCurrentState('In Progress');
    mockRecordTransition({ from_state: 'In Progress', to_state: 'In Review' });
    // project_items query (for updateProjectCard)
    query.mockResolvedValueOnce({ rows: [{ item_node_id: 'NODE_1' }] });
    moveProjectItem.mockResolvedValue(undefined);
    query.mockResolvedValue({ rows: [] }); // update cache

    const result = await executeTransition({
      owner: TEST_OWNER,
      repo: TEST_REPO,
      issueNumber: 42,
      toState: 'In Review',
      triggerType: 'webhook',
      context: { linked_pr: 7 },
    });

    expect(result.fromState).toBe('In Progress');
    expect(result.toState).toBe('In Review');
    expect(result.transition).toBeDefined();
  });

  it('throws INVALID_TRANSITION for disallowed transitions', async () => {
    mockCurrentState('Backlog');

    await expect(executeTransition({
      owner: TEST_OWNER,
      repo: TEST_REPO,
      issueNumber: 42,
      toState: 'Done',
      triggerType: 'api',
    })).rejects.toMatchObject({ code: 'INVALID_TRANSITION' });
  });

  it('throws REQUIREMENTS_NOT_MET when context missing', async () => {
    mockCurrentState('Ready');

    await expect(executeTransition({
      owner: TEST_OWNER,
      repo: TEST_REPO,
      issueNumber: 42,
      toState: 'In Progress',
      triggerType: 'api',
      context: {}, // missing assignee
    })).rejects.toMatchObject({ code: 'REQUIREMENTS_NOT_MET', missing: ['assignee'] });
  });

  it('enforces merged_pr for Done even if not in transition config', async () => {
    mockCurrentState('In Review');

    await expect(executeTransition({
      owner: TEST_OWNER,
      repo: TEST_REPO,
      issueNumber: 42,
      toState: 'Done',
      triggerType: 'webhook',
      context: {}, // missing merged_pr
    })).rejects.toMatchObject({ code: 'REQUIREMENTS_NOT_MET', missing: ['merged_pr'] });
  });

  it('allows transition to Done with merged_pr', async () => {
    mockCurrentState('In Review');
    mockRecordTransition({ from_state: 'In Review', to_state: 'Done' });
    query.mockResolvedValue({ rows: [] }); // project queries

    const result = await executeTransition({
      owner: TEST_OWNER,
      repo: TEST_REPO,
      issueNumber: 42,
      toState: 'Done',
      triggerType: 'webhook',
      context: { merged_pr: 7 },
    });

    expect(result.toState).toBe('Done');
  });

  it('allows wildcard transition to Cancelled', async () => {
    mockCurrentState('In Progress');
    mockRecordTransition({ from_state: 'In Progress', to_state: 'Cancelled' });
    query.mockResolvedValue({ rows: [] });

    const result = await executeTransition({
      owner: TEST_OWNER,
      repo: TEST_REPO,
      issueNumber: 42,
      toState: 'Cancelled',
      triggerType: 'api',
    });

    expect(result.toState).toBe('Cancelled');
  });

  it('skips project update when skipProjectUpdate is true', async () => {
    mockCurrentState('Backlog');
    mockRecordTransition({ from_state: 'Backlog', to_state: 'Ready' });

    await executeTransition({
      owner: TEST_OWNER,
      repo: TEST_REPO,
      issueNumber: 42,
      toState: 'Ready',
      triggerType: 'api',
      skipProjectUpdate: true,
    });

    // query called only for getCurrentState + recordTransition, not project
    expect(query).toHaveBeenCalledTimes(2);
  });
});

describe('autoTransition', () => {
  it('executes matching auto transition on review_rejected', async () => {
    // autoTransition: getCurrentState
    mockCurrentState('In Review');
    // executeTransition (called internally): resolveConfig is already mocked, getCurrentState again
    mockCurrentState('In Review');
    // recordTransition
    mockRecordTransition({ from_state: 'In Review', to_state: 'In Progress' });
    query.mockResolvedValue({ rows: [] }); // project queries

    const result = await autoTransition(TEST_OWNER, TEST_REPO, 42, 'review_rejected', 'bot');

    expect(result.fromState).toBe('In Review');
    expect(result.toState).toBe('In Progress');
  });

  it('returns null when no matching auto transition', async () => {
    mockCurrentState('Backlog');

    const result = await autoTransition(TEST_OWNER, TEST_REPO, 42, 'nonexistent_event');

    expect(result).toBeNull();
  });

  it('returns null when event matches but state does not', async () => {
    mockCurrentState('In Progress'); // review_rejected only fires from In Review

    const result = await autoTransition(TEST_OWNER, TEST_REPO, 42, 'review_rejected');

    expect(result).toBeNull();
  });
});

describe('attemptTransitionToDone', () => {
  it('reverts and posts comment when merged_pr missing', async () => {
    mockCurrentState('In Review');
    postComment.mockResolvedValue(undefined);
    // project card queries
    query.mockResolvedValue({ rows: [{ item_node_id: 'NODE_1' }] });
    moveProjectItem.mockResolvedValue(undefined);

    const result = await attemptTransitionToDone({
      owner: TEST_OWNER,
      repo: TEST_REPO,
      issueNumber: 42,
    });

    expect(result.reverted).toBe(true);
    expect(postComment).toHaveBeenCalledWith(
      TEST_OWNER, TEST_REPO, 42,
      expect.stringContaining('Transition to Done blocked'),
    );
  });

  it('succeeds when merged_pr is provided', async () => {
    // getCurrentState for attemptTransitionToDone (via executeTransition)
    mockCurrentState('In Review');
    // recordTransition
    mockRecordTransition({ from_state: 'In Review', to_state: 'Done' });
    query.mockResolvedValue({ rows: [] });

    const result = await attemptTransitionToDone({
      owner: TEST_OWNER,
      repo: TEST_REPO,
      issueNumber: 42,
      context: { merged_pr: 7 },
    });

    expect(result.reverted).toBe(false);
    expect(result.transition).toBeDefined();
  });
});
