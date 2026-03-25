import { describe, it, expect } from 'vitest';
import { validateDefaults, validateRepoConfig, validateMergedConfig, ReviewerConfigSchema } from '../../src/config/schema.js';

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

  it('accepts on_failure with model and thinking', () => {
    const result = validateDefaults({
      reviewer: { on_failure: { model: 'claude-sonnet-4-6', thinking: 'high' } },
    });
    expect(result.reviewer.on_failure).toEqual({ model: 'claude-sonnet-4-6', thinking: 'high' });
  });

  it('accepts on_failure with only model', () => {
    const result = validateDefaults({
      reviewer: { on_failure: { model: 'claude-sonnet-4-6' } },
    });
    expect(result.reviewer.on_failure.model).toBe('claude-sonnet-4-6');
    expect(result.reviewer.on_failure.thinking).toBeUndefined();
  });

  it('accepts on_failure with only thinking', () => {
    const result = validateDefaults({
      reviewer: { on_failure: { thinking: 'medium' } },
    });
    expect(result.reviewer.on_failure.thinking).toBe('medium');
  });

  it('rejects invalid thinking level in on_failure', () => {
    expect(() => validateDefaults({
      reviewer: { on_failure: { thinking: 'extreme' } },
    })).toThrow();
  });

  it('defaults on_failure to undefined when not provided', () => {
    const result = validateDefaults({});
    expect(result.reviewer.on_failure).toBeUndefined();
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

  it('accepts default_agent field', () => {
    const result = validateRepoConfig({ default_agent: 'getonit' });
    expect(result.default_agent).toBe('getonit');
  });

  it('accepts partial reviewer override with on_failure', () => {
    const result = validateRepoConfig({
      reviewer: { on_failure: { model: 'claude-sonnet-4-6', thinking: 'low' } },
    });
    expect(result.reviewer.on_failure).toEqual({ model: 'claude-sonnet-4-6', thinking: 'low' });
  });
});

describe('ReviewerConfigSchema trigger_check', () => {
  it('accepts optional trigger_check string', () => {
    const result = ReviewerConfigSchema.parse({ trigger_check: 'lint-and-test' });
    expect(result.trigger_check).toBe('lint-and-test');
  });

  it('defaults trigger_check to undefined when not provided', () => {
    const result = ReviewerConfigSchema.parse({});
    expect(result.trigger_check).toBeUndefined();
  });

  it('trigger_check flows through merged config', () => {
    const result = validateMergedConfig({
      reviewer: { enabled: true, trigger_check: 'ci' },
      states: ['Backlog', 'Done'],
    });
    expect(result.reviewer.trigger_check).toBe('ci');
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

  it('normalizes agent_id to default_agent (backward compat)', () => {
    const result = validateMergedConfig({ agent_id: 'getonit' });
    expect(result.default_agent).toBe('getonit');
  });

  it('prefers explicit default_agent over agent_id', () => {
    const result = validateMergedConfig({ agent_id: 'old', default_agent: 'new' });
    expect(result.default_agent).toBe('new');
  });

  it('leaves default_agent undefined when neither set', () => {
    const result = validateMergedConfig({});
    expect(result.default_agent).toBeUndefined();
  });

  it('preserves on_failure through merged config', () => {
    const result = validateMergedConfig({
      reviewer: { on_failure: { model: 'claude-sonnet-4-6', thinking: 'high' } },
    });
    expect(result.reviewer.on_failure).toEqual({ model: 'claude-sonnet-4-6', thinking: 'high' });
  });
});
