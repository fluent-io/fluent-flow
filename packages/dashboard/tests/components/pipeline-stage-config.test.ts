import { describe, it, expect } from 'vitest';
import { getStageConfig } from '../../src/components/pipelines/pipeline-stage-config';

describe('getStageConfig', () => {
  it('labels verify claims by red or green phase', () => {
    expect(getStageConfig('verify', 'red')).toEqual({ label: 'Verify Red', color: 'red' });
    expect(getStageConfig('verify', 'GREEN')).toEqual({ label: 'Verify Green', color: 'green' });
  });

  it('keeps historical test_verify display support', () => {
    expect(getStageConfig('test_verify')).toEqual({ label: 'Test Verify', color: 'cyan' });
  });

  it('falls back to the claim type for unknown stages', () => {
    expect(getStageConfig('custom_gate')).toEqual({ label: 'custom_gate', color: 'zinc' });
  });
});
