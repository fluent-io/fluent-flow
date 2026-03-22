import { describe, it, expect } from 'vitest';
import { validateDefaults, validateRepoConfig, validateMergedConfig } from '../../src/config/schema.js';

describe('validateDefaults', () => {
  it('accepts empty object and fills all defaults', () => {
    const result = validateDefaults({});
    expect(result.reviewer.enabled).toBe(true);
    expect(result.reviewer.model).toBe('claude-haiku');
    expect(result.reviewer.max_retries).toBe(3);
    expect(result.reviewer.diff_limit_kb).toBe(65);
    expect(result.reviewer.severity_tiers).toBe(true);
    expect(result.states).toContain('Backlog');
    expect(result.states).toContain('Done');
    expect(result.pause.reminder_hours).toBe(24);
    expect(result.notifications.stale_days).toBe(3);
  });

  it('overrides specific defaults', () => {
    const result = validateDefaults({ reviewer: { max_retries: 5, enabled: false } });
    expect(result.reviewer.max_retries).toBe(5);
    expect(result.reviewer.enabled).toBe(false);
    expect(result.reviewer.model).toBe('claude-haiku'); // still default
  });

  it('rejects max_retries out of range', () => {
    expect(() => validateDefaults({ reviewer: { max_retries: 11 } })).toThrow();
    expect(() => validateDefaults({ reviewer: { max_retries: -1 } })).toThrow();
  });

  it('rejects non-integer max_retries', () => {
    expect(() => validateDefaults({ reviewer: { max_retries: 2.5 } })).toThrow();
  });
});

describe('validateRepoConfig', () => {
  it('accepts minimal config with project_id and agent_id', () => {
    const result = validateRepoConfig({ project_id: 'PVT_xxx', agent_id: 'getonit' });
    expect(result.project_id).toBe('PVT_xxx');
    expect(result.agent_id).toBe('getonit');
  });

  it('accepts empty object (all fields optional)', () => {
    const result = validateRepoConfig({});
    expect(result).toBeDefined();
  });

  it('accepts project_ids array', () => {
    const result = validateRepoConfig({ project_ids: ['PVT_1', 'PVT_2'] });
    expect(result.project_ids).toEqual(['PVT_1', 'PVT_2']);
  });

  it('accepts partial reviewer override', () => {
    const result = validateRepoConfig({ reviewer: { max_retries: 5 } });
    expect(result.reviewer.max_retries).toBe(5);
  });

  // Bug 1: delivery field must be preserved
  it('preserves delivery config (Bug 1 regression)', () => {
    const result = validateRepoConfig({
      project_id: 'PVT_xxx',
      agent_id: 'getonit',
      delivery: { channel: '#builds', to: 'victor' },
    });
    expect(result.delivery).toEqual({ channel: '#builds', to: 'victor' });
  });

  it('preserves delivery with only channel', () => {
    const result = validateRepoConfig({ delivery: { channel: '#ops' } });
    expect(result.delivery).toEqual({ channel: '#ops' });
  });

  it('preserves delivery with only to', () => {
    const result = validateRepoConfig({ delivery: { to: 'team-lead' } });
    expect(result.delivery).toEqual({ to: 'team-lead' });
  });
});

describe('validateMergedConfig', () => {
  it('normalizes project_id into project_ids array', () => {
    const result = validateMergedConfig({ project_id: 'PVT_single' });
    expect(result.project_ids).toContain('PVT_single');
  });

  it('merges project_id into existing project_ids without duplicates', () => {
    const result = validateMergedConfig({
      project_id: 'PVT_1',
      project_ids: ['PVT_1', 'PVT_2'],
    });
    expect(result.project_ids).toEqual(['PVT_1', 'PVT_2']);
  });

  it('adds project_id when not already in project_ids', () => {
    const result = validateMergedConfig({
      project_id: 'PVT_3',
      project_ids: ['PVT_1', 'PVT_2'],
    });
    expect(result.project_ids).toEqual(['PVT_1', 'PVT_2', 'PVT_3']);
  });

  it('returns undefined project_ids when neither project_id nor project_ids set', () => {
    const result = validateMergedConfig({});
    expect(result.project_ids).toBeUndefined();
  });

  it('fills all defaults for merged config', () => {
    const result = validateMergedConfig({});
    expect(result.reviewer.enabled).toBe(true);
    expect(result.states.length).toBe(7);
  });

  // Bug 1: delivery must survive merge validation
  it('preserves delivery through merged config (Bug 1 regression)', () => {
    const result = validateMergedConfig({
      project_id: 'PVT_xxx',
      agent_id: 'getonit',
      delivery: { channel: '#builds', to: 'victor' },
    });
    expect(result.delivery).toEqual({ channel: '#builds', to: 'victor' });
  });
});
