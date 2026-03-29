import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/logger.js', async () => {
  const { createMockLogger } = await import('../helpers/mock-logger.js');
  return { default: createMockLogger() };
});
vi.mock('../../src/engine/pause-manager.js', () => ({ getActivePause: vi.fn() }));
vi.mock('../../src/github/rest.js', () => ({ getLinkedPR: vi.fn(), getPR: vi.fn() }));

// Mock agents registry
vi.mock('../../src/config/agents.js', () => ({
  getAgentConfig: vi.fn(),
}));

// Mock DB agent lookup and claim manager
vi.mock('../../src/agents/agent-manager.js', () => ({
  getAgent: vi.fn(),
}));
vi.mock('../../src/agents/claim-manager.js', () => ({
  getActiveClaim: vi.fn(),
}));

// Mock transports
vi.mock('../../src/notifications/transports/index.js', () => ({
  getTransport: vi.fn(),
}));

// Mock db client (audit)
vi.mock('../../src/db/client.js', () => ({ audit: vi.fn() }));

import logger from '../../src/logger.js';
import { getAgentConfig } from '../../src/config/agents.js';
import { getTransport } from '../../src/notifications/transports/index.js';
import { getAgent } from '../../src/agents/agent-manager.js';
import { getActiveClaim } from '../../src/agents/claim-manager.js';
import {
  extractAgentId,
  resolveAgentId,
  resolveAgentForIssue,
  dispatch,
  notifyReviewFailure,
  notifyPause,
  notifyResume,
  notifyPRMerged,
  formatRichMessage,
} from '../../src/notifications/dispatcher.js';
import { getActivePause } from '../../src/engine/pause-manager.js';
import { getLinkedPR, getPR } from '../../src/github/rest.js';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('extractAgentId', () => {
  it('extracts agent ID from PR body marker', () => {
    expect(extractAgentId('Fixes #42\n\n<!-- fluent-flow-agent: getonit -->')).toBe('getonit');
  });

  it('handles whitespace variations', () => {
    expect(extractAgentId('<!--fluent-flow-agent:getonit-->')).toBe('getonit');
    expect(extractAgentId('<!--  fluent-flow-agent:  getonit  -->')).toBe('getonit');
  });

  it('returns null for no marker', () => {
    expect(extractAgentId('Just a normal PR body')).toBeNull();
  });

  it('returns null for null/undefined/empty', () => {
    expect(extractAgentId(null)).toBeNull();
    expect(extractAgentId(undefined)).toBeNull();
    expect(extractAgentId('')).toBeNull();
  });

  it('extracts first match when multiple markers present', () => {
    const body = '<!-- fluent-flow-agent: first -->\n<!-- fluent-flow-agent: second -->';
    expect(extractAgentId(body)).toBe('first');
  });

  it('handles agent IDs with hyphens and underscores', () => {
    expect(extractAgentId('<!-- fluent-flow-agent: my-agent_v2 -->')).toBe('my-agent_v2');
  });
});

describe('resolveAgentId', () => {
  it('returns PR body marker first (highest priority)', () => {
    const result = resolveAgentId({
      prBody: '<!-- fluent-flow-agent: from-body -->',
      config: { default_agent: 'from-config', agent_id: 'legacy' },
    });
    expect(result).toBe('from-body');
  });

  it('falls back to config.default_agent when no marker', () => {
    const result = resolveAgentId({
      prBody: 'No marker here',
      config: { default_agent: 'from-config', agent_id: 'legacy' },
    });
    expect(result).toBe('from-config');
  });

  it('falls back to config.agent_id when no marker and no default_agent', () => {
    const result = resolveAgentId({
      prBody: 'No marker here',
      config: { agent_id: 'legacy' },
    });
    expect(result).toBe('legacy');
  });

  it('returns null when nothing available', () => {
    expect(resolveAgentId({ prBody: null, config: {} })).toBeNull();
    expect(resolveAgentId({ prBody: 'No marker', config: {} })).toBeNull();
  });

  it('handles missing prBody gracefully', () => {
    const result = resolveAgentId({
      prBody: undefined,
      config: { default_agent: 'fallback' },
    });
    expect(result).toBe('fallback');
  });
});

describe('dispatch', () => {
  it('routes to correct transport based on agent config', async () => {
    const mockSend = vi.fn();
    getAgentConfig.mockReturnValue({ transport: 'webhook', url: 'http://test.com' });
    getTransport.mockReturnValue({ send: mockSend });

    await dispatch({ agentId: 'test-agent', event: 'review_failed', payload: { message: 'hello' } });

    expect(getAgentConfig).toHaveBeenCalledWith('test-agent');
    expect(getTransport).toHaveBeenCalledWith('webhook');
    expect(mockSend).toHaveBeenCalledWith(
      { transport: 'webhook', url: 'http://test.com' },
      expect.objectContaining({ agentId: 'test-agent', event: 'review_failed', message: 'hello' }),
    );
  });

  it('merges agent delivery config into payload', async () => {
    const mockSend = vi.fn();
    getAgentConfig.mockReturnValue({
      transport: 'webhook',
      url: 'http://test.com',
      delivery: { channel: '#ops', to: 'victor' },
    });
    getTransport.mockReturnValue({ send: mockSend });

    await dispatch({ agentId: 'test-agent', event: 'paused', payload: { message: 'hi' } });

    expect(mockSend).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ channel: '#ops', to: 'victor' }),
    );
  });

  it('skips when agentId is null', async () => {
    await dispatch({ agentId: null, event: 'review_failed', payload: {} });
    expect(getAgentConfig).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ msg: 'No agent ID — skipping notification' }),
    );
  });

  it('skips when agent not in registry or DB', async () => {
    getAgentConfig.mockReturnValue(null);
    getAgent.mockResolvedValueOnce(null);
    await dispatch({ agentId: 'unknown', event: 'review_failed', payload: {} });
    expect(getTransport).not.toHaveBeenCalled();
  });

  it('falls back to DB agent when YAML returns null', async () => {
    const mockSend = vi.fn();
    getAgentConfig.mockReturnValue(null);
    getAgent.mockResolvedValueOnce({ id: 'db-agent', transport: 'webhook', transport_meta: { url: 'http://db-test.com' } });
    getTransport.mockReturnValue({ send: mockSend });

    await dispatch({ agentId: 'db-agent', event: 'review_failed', payload: { repo: 'o/r' } });

    expect(mockSend).toHaveBeenCalled();
  });

  it('includes session_id in payload for long_poll agents', async () => {
    const mockSend = vi.fn();
    getAgentConfig.mockReturnValue(null);
    getAgent.mockResolvedValueOnce({ id: 'poll-agent', transport: 'long_poll', transport_meta: {} });
    getTransport.mockReturnValue({ send: mockSend });
    getActiveClaim.mockResolvedValueOnce({ session_id: 5 });

    await dispatch({ agentId: 'poll-agent', event: 'review_failed', payload: { repo: 'o/r', prNumber: 7, orgId: 'acme' } });

    expect(mockSend).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ session_id: 5 }),
    );
  });

  it('does not include session_id for non-long_poll agents', async () => {
    const mockSend = vi.fn();
    getAgentConfig.mockReturnValue({ transport: 'webhook', url: 'http://test.com' });
    getTransport.mockReturnValue({ send: mockSend });

    await dispatch({ agentId: 'test', event: 'review_failed', payload: { repo: 'o/r', prNumber: 7 } });

    const payload = mockSend.mock.calls[0][1];
    expect(payload).not.toHaveProperty('session_id');
  });

  it('skips when transport not found', async () => {
    getAgentConfig.mockReturnValue({ transport: 'carrier_pigeon' });
    getTransport.mockReturnValue(null);
    await dispatch({ agentId: 'test', event: 'test', payload: {} });
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ msg: 'Unknown transport' }),
    );
  });
});

describe('formatRichMessage', () => {
  it('formats blocking issues with fix suggestions', () => {
    const msg = formatRichMessage({
      repo: 'owner/repo', prNumber: 7, attempt: 2,
      blocking: [
        { file: 'src/foo.ts', line: 42, issue: 'Missing null check', fix: 'Add if (!x) return' },
      ],
      advisory: [],
    });
    expect(msg).toContain('Review FAILED: owner/repo#7 (attempt 2)');
    expect(msg).toContain('1 blocking issue(s)');
    expect(msg).toContain('Fix the following blocking issues');
    expect(msg).toContain('- src/foo.ts:42 — Missing null check');
    expect(msg).toContain('> Fix: Add if (!x) return');
  });

  it('formats advisory issues with suggestions', () => {
    const msg = formatRichMessage({
      repo: 'owner/repo', prNumber: 7, attempt: 1,
      blocking: [],
      advisory: [
        { file: 'src/bar.ts', line: 10, issue: 'Could use const', suggestion: 'Change let to const' },
      ],
    });
    expect(msg).toContain('0 blocking issue(s)');
    expect(msg).not.toContain('Fix the following blocking issues');
    expect(msg).toContain('Advisory (non-blocking):');
    expect(msg).toContain('- src/bar.ts:10 — Could use const');
    expect(msg).toContain('> Suggestion: Change let to const');
  });

  it('formats both blocking and advisory issues', () => {
    const msg = formatRichMessage({
      repo: 'owner/repo', prNumber: 3, attempt: 2,
      blocking: [
        { file: 'a.js', line: 1, issue: 'Bug', fix: 'Fix it' },
        { file: 'b.js', line: 2, issue: 'Error' },
      ],
      advisory: [
        { file: 'c.js', line: 3, issue: 'Style', suggestion: 'Rename' },
      ],
    });
    expect(msg).toContain('2 blocking issue(s)');
    expect(msg).toContain('- a.js:1 — Bug');
    expect(msg).toContain('> Fix: Fix it');
    expect(msg).toContain('- b.js:2 — Error');
    expect(msg).not.toContain('> Fix: undefined');
    expect(msg).toContain('Advisory (non-blocking):');
    expect(msg).toContain('- c.js:3 — Style');
  });

  it('returns summary only when no issues', () => {
    const msg = formatRichMessage({
      repo: 'owner/repo', prNumber: 1, attempt: 1,
      blocking: [], advisory: [],
    });
    expect(msg).toBe('Review FAILED: owner/repo#1 (attempt 1) — 0 blocking issue(s)');
  });

  it('handles undefined blocking and advisory', () => {
    const msg = formatRichMessage({
      repo: 'owner/repo', prNumber: 1, attempt: 1,
    });
    expect(msg).toContain('Review FAILED: owner/repo#1 (attempt 1)');
  });

  it('omits fix/suggestion line when field is absent', () => {
    const msg = formatRichMessage({
      repo: 'owner/repo', prNumber: 1, attempt: 1,
      blocking: [{ file: 'x.js', line: 5, issue: 'Problem' }],
      advisory: [{ file: 'y.js', line: 10, issue: 'Note' }],
    });
    expect(msg).toContain('- x.js:5 — Problem');
    expect(msg).not.toContain('> Fix:');
    expect(msg).toContain('- y.js:10 — Note');
    expect(msg).not.toContain('> Suggestion:');
  });
});

describe('notifyReviewFailure', () => {
  it('dispatches review_failed event with rich message', async () => {
    const mockSend = vi.fn();
    getAgentConfig.mockReturnValue({ transport: 'webhook', url: 'http://test.com' });
    getTransport.mockReturnValue({ send: mockSend });

    await notifyReviewFailure({
      agentId: 'getonit',
      repo: 'owner/repo',
      prNumber: 7,
      attempt: 2,
      issues: [
        { severity: 'blocking', file: 'x.js', line: 10, issue: 'SQL injection', fix: 'Use parameterized queries' },
        { severity: 'advisory', file: 'y.js', line: 5, issue: 'naming', suggestion: 'Use camelCase' },
      ],
    });

    const payload = mockSend.mock.calls[0][1];
    expect(payload.event).toBe('review_failed');
    expect(payload.message).toContain('Review FAILED: owner/repo#7 (attempt 2)');
    expect(payload.message).toContain('- x.js:10 — SQL injection');
    expect(payload.message).toContain('> Fix: Use parameterized queries');
    expect(payload.message).toContain('- y.js:5 — naming');
    expect(payload.wakeMode).toBe('now');
    expect(payload.prNumber).toBe(7);
    expect(payload.attempt).toBe(2);
    // Structured issues array still present
    expect(payload.issues).toHaveLength(2);
  });

  it('forwards on_failure model and thinking to payload', async () => {
    const mockSend = vi.fn();
    getAgentConfig.mockReturnValue({ transport: 'webhook', url: 'http://test.com' });
    getTransport.mockReturnValue({ send: mockSend });

    await notifyReviewFailure({
      agentId: 'getonit',
      repo: 'owner/repo',
      prNumber: 7,
      attempt: 1,
      issues: [{ severity: 'blocking', file: 'x.js', line: 1, issue: 'bug' }],
      onFailure: { model: 'claude-sonnet-4-6', thinking: 'high' },
    });

    const payload = mockSend.mock.calls[0][1];
    expect(payload.model).toBe('claude-sonnet-4-6');
    expect(payload.thinking).toBe('high');
  });

  it('omits model and thinking when on_failure is undefined', async () => {
    const mockSend = vi.fn();
    getAgentConfig.mockReturnValue({ transport: 'webhook', url: 'http://test.com' });
    getTransport.mockReturnValue({ send: mockSend });

    await notifyReviewFailure({
      agentId: 'getonit',
      repo: 'owner/repo',
      prNumber: 7,
      attempt: 1,
      issues: [],
    });

    const payload = mockSend.mock.calls[0][1];
    expect(payload).not.toHaveProperty('model');
    expect(payload).not.toHaveProperty('thinking');
  });

  it('omits model when only thinking is set in on_failure', async () => {
    const mockSend = vi.fn();
    getAgentConfig.mockReturnValue({ transport: 'webhook', url: 'http://test.com' });
    getTransport.mockReturnValue({ send: mockSend });

    await notifyReviewFailure({
      agentId: 'getonit',
      repo: 'owner/repo',
      prNumber: 7,
      attempt: 1,
      issues: [],
      onFailure: { thinking: 'medium' },
    });

    const payload = mockSend.mock.calls[0][1];
    expect(payload).not.toHaveProperty('model');
    expect(payload.thinking).toBe('medium');
  });
});

describe('notifyPause', () => {
  it('dispatches paused event', async () => {
    const mockSend = vi.fn();
    getAgentConfig.mockReturnValue({ transport: 'webhook', url: 'http://test.com' });
    getTransport.mockReturnValue({ send: mockSend });

    await notifyPause({
      agentId: 'getonit',
      repo: 'owner/repo',
      issueNumber: 42,
      reason: 'agent-stuck',
      context: 'Cannot parse config',
    });

    expect(mockSend).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        event: 'paused',
        wakeMode: 'next-heartbeat',
        issueNumber: 42,
        reason: 'agent-stuck',
      }),
    );
  });
});

describe('notifyResume', () => {
  it('dispatches resumed event', async () => {
    const mockSend = vi.fn();
    getAgentConfig.mockReturnValue({ transport: 'webhook', url: 'http://test.com' });
    getTransport.mockReturnValue({ send: mockSend });

    await notifyResume({
      agentId: 'getonit',
      repo: 'owner/repo',
      issueNumber: 42,
      targetState: 'In Review',
      resumeInstructions: 'Try approach X',
    });

    expect(mockSend).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        event: 'resumed',
        wakeMode: 'now',
        targetState: 'In Review',
        instructions: 'Try approach X',
      }),
    );
  });
});

describe('notifyPRMerged', () => {
  it('dispatches pr_merged event', async () => {
    const mockSend = vi.fn();
    getAgentConfig.mockReturnValue({ transport: 'webhook', url: 'http://test.com' });
    getTransport.mockReturnValue({ send: mockSend });

    await notifyPRMerged({
      agentId: 'getonit',
      repo: 'owner/repo',
      prNumber: 7,
      issueNumber: 42,
    });

    expect(mockSend).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        event: 'pr_merged',
        message: expect.stringContaining('PR merged'),
        prNumber: 7,
        issueNumber: 42,
      }),
    );
  });
});

describe('resolveAgentForIssue', () => {
  const config = { default_agent: 'default-bot', agent_id: 'legacy-bot' };

  it('returns agent_id from active pause when one exists', async () => {
    getActivePause.mockResolvedValue({ id: 1, agent_id: 'pause-agent' });

    const result = await resolveAgentForIssue('test-org', 'test-repo', 42, config);

    expect(result).toBe('pause-agent');
    expect(getLinkedPR).not.toHaveBeenCalled();
  });

  it('resolves agent from linked PR body when no active pause', async () => {
    getActivePause.mockResolvedValue(null);
    getLinkedPR.mockResolvedValue(7);
    getPR.mockResolvedValue({ body: '<!-- fluent-flow-agent: pr-agent -->' });

    const result = await resolveAgentForIssue('test-org', 'test-repo', 42, config);

    expect(result).toBe('pr-agent');
  });

  it('falls back to config.default_agent when no pause and no linked PR', async () => {
    getActivePause.mockResolvedValue(null);
    getLinkedPR.mockResolvedValue(null);

    const result = await resolveAgentForIssue('test-org', 'test-repo', 42, config);

    expect(result).toBe('default-bot');
    expect(getPR).not.toHaveBeenCalled();
  });

  it('falls back to config.default_agent when linked PR has no agent marker', async () => {
    getActivePause.mockResolvedValue(null);
    getLinkedPR.mockResolvedValue(7);
    getPR.mockResolvedValue({ body: 'Fixes #42 — no marker here' });

    const result = await resolveAgentForIssue('test-org', 'test-repo', 42, config);

    expect(result).toBe('default-bot');
  });

  it('falls back to config.agent_id when no default_agent', async () => {
    getActivePause.mockResolvedValue(null);
    getLinkedPR.mockResolvedValue(null);

    const result = await resolveAgentForIssue('test-org', 'test-repo', 42, { agent_id: 'legacy-bot' });

    expect(result).toBe('legacy-bot');
  });

  it('returns null when nothing available', async () => {
    getActivePause.mockResolvedValue(null);
    getLinkedPR.mockResolvedValue(null);

    const result = await resolveAgentForIssue('test-org', 'test-repo', 42, {});

    expect(result).toBeNull();
  });

  it('handles getActivePause returning pause with null agent_id', async () => {
    getActivePause.mockResolvedValue({ id: 1, agent_id: null });
    getLinkedPR.mockResolvedValue(7);
    getPR.mockResolvedValue({ body: '<!-- fluent-flow-agent: pr-agent -->' });

    const result = await resolveAgentForIssue('test-org', 'test-repo', 42, config);

    expect(result).toBe('pr-agent');
  });
});
