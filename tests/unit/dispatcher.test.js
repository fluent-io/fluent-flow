import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock agents registry
vi.mock('../../src/config/agents.js', () => ({
  getAgentConfig: vi.fn(),
}));

// Mock transports
vi.mock('../../src/notifications/transports/index.js', () => ({
  getTransport: vi.fn(),
}));

// Mock db client (audit)
vi.mock('../../src/db/client.js', () => ({ audit: vi.fn() }));

import { getAgentConfig } from '../../src/config/agents.js';
import { getTransport } from '../../src/notifications/transports/index.js';
import {
  extractAgentId,
  resolveAgentId,
  dispatch,
  notifyReviewFailure,
  notifyPause,
  notifyResume,
  notifyPRMerged,
} from '../../src/notifications/dispatcher.js';

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
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await dispatch({ agentId: null, event: 'review_failed', payload: {} });
    expect(getAgentConfig).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('skips when agent not in registry', async () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    getAgentConfig.mockReturnValue(null);
    await dispatch({ agentId: 'unknown', event: 'review_failed', payload: {} });
    expect(getTransport).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('skips when transport not found', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    getAgentConfig.mockReturnValue({ transport: 'carrier_pigeon' });
    getTransport.mockReturnValue(null);
    await dispatch({ agentId: 'test', event: 'test', payload: {} });
    spy.mockRestore();
  });
});

describe('notifyReviewFailure', () => {
  it('dispatches review_failed event with correct message', async () => {
    const mockSend = vi.fn();
    getAgentConfig.mockReturnValue({ transport: 'webhook', url: 'http://test.com' });
    getTransport.mockReturnValue({ send: mockSend });

    await notifyReviewFailure({
      agentId: 'getonit',
      repo: 'owner/repo',
      prNumber: 7,
      attempt: 2,
      issues: [{ severity: 'blocking', issue: 'bug' }, { severity: 'advisory', issue: 'style' }],
    });

    expect(mockSend).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        event: 'review_failed',
        message: 'Review FAILED: owner/repo#7 (attempt 2) — 1 blocking issue(s)',
        wakeMode: 'now',
        prNumber: 7,
        attempt: 2,
      }),
    );
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
