import { describe, it, expect } from 'vitest';
import { derivePipelineStatus, getLatestAttemptClaims, getPipelineHeaderClaim } from '../../src/components/pipelines/pipeline-summary';

const baseClaim = {
  id: 1,
  attempt: 1,
  status: 'completed',
  agent_id: null,
  created_at: new Date('2026-08-27T10:00:00Z'),
  completed_at: new Date('2026-08-27T10:01:00Z'),
};

describe('pipeline summary helpers', () => {
  it('derives header status from the latest attempt only', () => {
    const claims = [
      { ...baseClaim, id: 1, attempt: 1, status: 'expired' },
      { ...baseClaim, id: 2, attempt: 2, status: 'completed' },
      { ...baseClaim, id: 3, attempt: 2, status: 'completed' },
    ];

    const status = derivePipelineStatus(getLatestAttemptClaims(claims));

    expect(status.label).toBe('completed');
    expect(status.className).toContain('green');
  });

  it('keeps dismissed latest attempts cancelled even when history completed', () => {
    const claims = [
      { ...baseClaim, id: 1, attempt: 1, status: 'completed' },
      { ...baseClaim, id: 2, attempt: 2, status: 'cancelled' },
      { ...baseClaim, id: 3, attempt: 2, status: 'cancelled' },
    ];

    const status = derivePipelineStatus(getLatestAttemptClaims(claims));

    expect(status.label).toBe('cancelled');
  });

  it('selects the latest attempt and newest available agent for the header', () => {
    const claims = [
      { ...baseClaim, id: 1, attempt: 1, agent_id: 'old-runner', created_at: new Date('2026-08-27T10:00:00Z') },
      { ...baseClaim, id: 2, attempt: 4, agent_id: null, created_at: new Date('2026-08-27T10:05:00Z') },
      { ...baseClaim, id: 3, attempt: 4, agent_id: 'current-runner', created_at: new Date('2026-08-27T10:06:00Z') },
    ];

    const headerClaim = getPipelineHeaderClaim(claims);

    expect(headerClaim?.attempt).toBe(4);
    expect(headerClaim?.agent_id).toBe('current-runner');
  });
});
