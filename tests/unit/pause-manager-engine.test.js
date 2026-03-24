import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  buildConfig, TEST_OWNER, TEST_REPO, TEST_REPO_KEY,
  makePauseRecord, makeTransitionRecord,
} from '../helpers/mocks.js';

vi.mock('../../src/logger.js', () => ({
  default: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../src/db/client.js', () => ({ query: vi.fn(), audit: vi.fn() }));
vi.mock('../../src/config/loader.js', () => ({ resolveConfig: vi.fn() }));
vi.mock('../../src/engine/state-machine.js', () => ({
  executeTransition: vi.fn(),
  getCurrentState: vi.fn(),
}));
vi.mock('../../src/github/rest.js', () => ({
  postComment: vi.fn(),
  addLabel: vi.fn(),
  removeLabel: vi.fn(),
}));
vi.mock('../../src/notifications/dispatcher.js', () => ({
  notifyPause: vi.fn(),
  notifyResume: vi.fn(),
}));

import { query } from '../../src/db/client.js';
import { resolveConfig } from '../../src/config/loader.js';
import { executeTransition, getCurrentState } from '../../src/engine/state-machine.js';
import { postComment, addLabel, removeLabel } from '../../src/github/rest.js';
import { notifyPause, notifyResume } from '../../src/notifications/dispatcher.js';
import { recordPause, processResume, getActivePause } from '../../src/engine/pause-manager.js';

beforeEach(() => {
  vi.clearAllMocks();
  resolveConfig.mockResolvedValue(buildConfig());
  postComment.mockResolvedValue(undefined);
  addLabel.mockResolvedValue(undefined);
  removeLabel.mockResolvedValue(undefined);
  executeTransition.mockResolvedValue({ transition: makeTransitionRecord(), fromState: 'In Review', toState: 'Awaiting Human' });
});

describe('recordPause', () => {
  it('inserts pause record, transitions, labels, comments, and notifies', async () => {
    getCurrentState.mockResolvedValue('In Review');
    query.mockResolvedValueOnce({ rows: [makePauseRecord()] });

    const pause = await recordPause({
      owner: TEST_OWNER,
      repo: TEST_REPO,
      issueNumber: 42,
      prNumber: 7,
      reason: 'decision',
      context: 'Pick approach A or B',
      actor: 'victor',
      agentId: 'test-agent',
    });

    expect(pause.id).toBe(1);
    // Transition to Awaiting Human
    expect(executeTransition).toHaveBeenCalledWith(expect.objectContaining({
      toState: 'Awaiting Human',
      triggerType: 'pause',
    }));
    // Label added
    expect(addLabel).toHaveBeenCalledWith(TEST_OWNER, TEST_REPO, 42, 'needs-human');
    // Comment posted with checklist
    expect(postComment).toHaveBeenCalledWith(
      TEST_OWNER, TEST_REPO, 42,
      expect.stringContaining('Paused'),
    );
    // Agent notified
    expect(notifyPause).toHaveBeenCalledWith(expect.objectContaining({
      agentId: 'test-agent',
      reason: 'decision',
    }));
  });

  it('skips transition when already Awaiting Human', async () => {
    getCurrentState.mockResolvedValue('Awaiting Human');
    query.mockResolvedValueOnce({ rows: [makePauseRecord({ previous_state: 'Awaiting Human' })] });

    await recordPause({
      owner: TEST_OWNER,
      repo: TEST_REPO,
      issueNumber: 42,
      reason: 'manual',
    });

    expect(executeTransition).not.toHaveBeenCalled();
  });

  it('falls back to config.default_agent when no agentId provided', async () => {
    getCurrentState.mockResolvedValue('In Progress');
    query.mockResolvedValueOnce({ rows: [makePauseRecord()] });

    await recordPause({
      owner: TEST_OWNER,
      repo: TEST_REPO,
      issueNumber: 42,
      reason: 'agent-stuck',
    });

    expect(notifyPause).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: 'test-agent' }),
    );
  });

  it('skips notification when no agent resolved', async () => {
    resolveConfig.mockResolvedValue(buildConfig({ default_agent: undefined, agent_id: undefined }));
    getCurrentState.mockResolvedValue('In Progress');
    query.mockResolvedValueOnce({ rows: [makePauseRecord()] });

    await recordPause({
      owner: TEST_OWNER,
      repo: TEST_REPO,
      issueNumber: 42,
      reason: 'manual',
    });

    expect(notifyPause).not.toHaveBeenCalled();
  });

  it('does not fail if label add throws', async () => {
    getCurrentState.mockResolvedValue('In Progress');
    query.mockResolvedValueOnce({ rows: [makePauseRecord()] });
    addLabel.mockRejectedValueOnce(new Error('label already exists'));

    // Should not throw
    const pause = await recordPause({
      owner: TEST_OWNER,
      repo: TEST_REPO,
      issueNumber: 42,
      reason: 'manual',
    });

    expect(pause).toBeDefined();
  });
});

describe('processResume', () => {
  it('updates pause record, transitions, removes label, comments, wakes agent', async () => {
    // getActivePause
    query.mockResolvedValueOnce({ rows: [makePauseRecord({ previous_state: 'In Review' })] });
    // update pause record
    query.mockResolvedValueOnce({ rows: [] });

    const { pause, targetState } = await processResume({
      owner: TEST_OWNER,
      repo: TEST_REPO,
      issueNumber: 42,
      resumedBy: 'victor',
      agentId: 'test-agent',
    });

    expect(targetState).toBe('In Review'); // returns to previous_state
    expect(executeTransition).toHaveBeenCalledWith(expect.objectContaining({
      toState: 'In Review',
      triggerType: 'resume',
    }));
    expect(removeLabel).toHaveBeenCalledWith(TEST_OWNER, TEST_REPO, 42, 'needs-human');
    expect(postComment).toHaveBeenCalledWith(
      TEST_OWNER, TEST_REPO, 42,
      expect.stringContaining('Resumed'),
    );
    expect(notifyResume).toHaveBeenCalledWith(expect.objectContaining({
      agentId: 'test-agent',
      targetState: 'In Review',
    }));
  });

  it('uses explicit toState over previous_state', async () => {
    query.mockResolvedValueOnce({ rows: [makePauseRecord({ previous_state: 'In Review' })] });
    query.mockResolvedValueOnce({ rows: [] });

    const { targetState } = await processResume({
      owner: TEST_OWNER,
      repo: TEST_REPO,
      issueNumber: 42,
      toState: 'In Progress',
      resumedBy: 'victor',
    });

    expect(targetState).toBe('In Progress');
  });

  it('passes instructions to agent notification', async () => {
    query.mockResolvedValueOnce({ rows: [makePauseRecord()] });
    query.mockResolvedValueOnce({ rows: [] });

    await processResume({
      owner: TEST_OWNER,
      repo: TEST_REPO,
      issueNumber: 42,
      instructions: 'Try approach X',
      resumedBy: 'victor',
    });

    expect(notifyResume).toHaveBeenCalledWith(
      expect.objectContaining({ resumeInstructions: 'Try approach X' }),
    );
  });

  it('throws NO_ACTIVE_PAUSE when no pause found', async () => {
    query.mockResolvedValueOnce({ rows: [] });

    await expect(processResume({
      owner: TEST_OWNER,
      repo: TEST_REPO,
      issueNumber: 42,
      resumedBy: 'victor',
    })).rejects.toMatchObject({ code: 'NO_ACTIVE_PAUSE' });
  });

  it('defaults to In Progress when no toState and no previous_state', async () => {
    query.mockResolvedValueOnce({ rows: [makePauseRecord({ previous_state: null })] });
    query.mockResolvedValueOnce({ rows: [] });

    const { targetState } = await processResume({
      owner: TEST_OWNER,
      repo: TEST_REPO,
      issueNumber: 42,
      resumedBy: 'victor',
    });

    expect(targetState).toBe('In Progress');
  });
});

describe('getActivePause', () => {
  it('returns active pause', async () => {
    const pause = makePauseRecord();
    query.mockResolvedValueOnce({ rows: [pause] });
    expect(await getActivePause(TEST_REPO_KEY, 42)).toEqual(pause);
  });

  it('returns null when no active pause', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    expect(await getActivePause(TEST_REPO_KEY, 42)).toBeNull();
  });
});
