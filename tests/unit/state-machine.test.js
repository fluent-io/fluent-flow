import { describe, it, expect } from 'vitest';
import { buildTransitionMap, checkTransitionAllowed, validateRequirements } from '../../src/engine/state-machine.js';

// Mirrors config/defaults.yml transitions
const DEFAULT_TRANSITIONS = {
  'Backlog -> Ready': {},
  'Ready -> In Progress': { require: ['assignee'] },
  'Ready -> Backlog': {},
  'In Progress -> In Review': { require: ['linked_pr'] },
  'In Progress -> Awaiting Human': {},
  'In Progress -> Ready': {},
  'In Review -> Done': { require: ['merged_pr'] },
  'In Review -> In Progress': { auto: true, on: 'review_rejected' },
  'In Review -> Awaiting Human': {},
  'Awaiting Human -> In Progress': {},
  'Awaiting Human -> In Review': { require: ['open_pr'] },
  '* -> Cancelled': {},
  'Cancelled -> Backlog': {},
};

describe('buildTransitionMap', () => {
  it('parses transitions into nested Map<from, Map<to, requirements>>', () => {
    const map = buildTransitionMap(DEFAULT_TRANSITIONS);

    expect(map).toBeInstanceOf(Map);
    expect(map.get('Backlog')).toBeInstanceOf(Map);
    expect(map.get('Backlog').get('Ready')).toEqual({});
  });

  it('preserves requirements on transitions', () => {
    const map = buildTransitionMap(DEFAULT_TRANSITIONS);

    expect(map.get('Ready').get('In Progress')).toEqual({ require: ['assignee'] });
    expect(map.get('In Progress').get('In Review')).toEqual({ require: ['linked_pr'] });
    expect(map.get('In Review').get('Done')).toEqual({ require: ['merged_pr'] });
  });

  it('preserves auto-transition metadata', () => {
    const map = buildTransitionMap(DEFAULT_TRANSITIONS);

    expect(map.get('In Review').get('In Progress')).toEqual({ auto: true, on: 'review_rejected' });
  });

  it('handles wildcard source (*) as a literal key', () => {
    const map = buildTransitionMap(DEFAULT_TRANSITIONS);

    expect(map.get('*')).toBeInstanceOf(Map);
    expect(map.get('*').get('Cancelled')).toEqual({});
  });

  it('returns empty map for empty input', () => {
    const map = buildTransitionMap({});
    expect(map.size).toBe(0);
  });

  it('skips malformed keys without arrow separator', () => {
    const map = buildTransitionMap({ 'NoArrow': {}, 'Valid -> Target': {} });
    expect(map.has('NoArrow')).toBe(false);
    expect(map.get('Valid').get('Target')).toEqual({});
  });

  it('treats null requirements as empty object', () => {
    const map = buildTransitionMap({ 'A -> B': null });
    expect(map.get('A').get('B')).toEqual({});
  });
});

describe('checkTransitionAllowed', () => {
  const map = buildTransitionMap(DEFAULT_TRANSITIONS);

  it('allows valid direct transitions', () => {
    expect(checkTransitionAllowed(map, 'Backlog', 'Ready')).toEqual({
      valid: true,
      requirements: {},
    });
  });

  it('returns requirements for transitions that have them', () => {
    const result = checkTransitionAllowed(map, 'Ready', 'In Progress');
    expect(result.valid).toBe(true);
    expect(result.requirements).toEqual({ require: ['assignee'] });
  });

  it('blocks transitions from terminal states (Done)', () => {
    expect(checkTransitionAllowed(map, 'Done', 'Backlog')).toEqual({
      valid: false,
      requirements: null,
    });
    expect(checkTransitionAllowed(map, 'Done', 'Cancelled')).toEqual({
      valid: false,
      requirements: null,
    });
  });

  it('allows wildcard transition to Cancelled from any non-terminal state', () => {
    const states = ['Backlog', 'Ready', 'In Progress', 'In Review', 'Awaiting Human', 'Cancelled'];
    for (const state of states) {
      const result = checkTransitionAllowed(map, state, 'Cancelled');
      expect(result.valid).toBe(true);
      expect(result.requirements).toEqual({});
    }
  });

  it('blocks undefined transitions', () => {
    expect(checkTransitionAllowed(map, 'Backlog', 'Done')).toEqual({
      valid: false,
      requirements: null,
    });
    expect(checkTransitionAllowed(map, 'Ready', 'Done')).toEqual({
      valid: false,
      requirements: null,
    });
  });

  it('allows Cancelled -> Backlog (reopen)', () => {
    const result = checkTransitionAllowed(map, 'Cancelled', 'Backlog');
    expect(result.valid).toBe(true);
  });

  it('blocks non-existent source state', () => {
    expect(checkTransitionAllowed(map, 'NonExistent', 'Ready')).toEqual({
      valid: false,
      requirements: null,
    });
  });
});

describe('validateRequirements', () => {
  it('passes when no requirements defined', () => {
    expect(validateRequirements({}, {})).toEqual({ ok: true, missing: [] });
    expect(validateRequirements(null, {})).toEqual({ ok: true, missing: [] });
    expect(validateRequirements(undefined, {})).toEqual({ ok: true, missing: [] });
  });

  it('passes when all requirements met', () => {
    const result = validateRequirements(
      { require: ['assignee', 'linked_pr'] },
      { assignee: 'victor', linked_pr: 42 }
    );
    expect(result).toEqual({ ok: true, missing: [] });
  });

  it('fails when requirements missing from context', () => {
    const result = validateRequirements(
      { require: ['assignee', 'linked_pr'] },
      { assignee: 'victor' }
    );
    expect(result.ok).toBe(false);
    expect(result.missing).toEqual(['linked_pr']);
  });

  it('fails when context is empty and requirements exist', () => {
    const result = validateRequirements({ require: ['merged_pr'] }, {});
    expect(result.ok).toBe(false);
    expect(result.missing).toEqual(['merged_pr']);
  });

  it('fails when context value is falsy (0, empty string, null, undefined)', () => {
    expect(validateRequirements({ require: ['a'] }, { a: 0 }).ok).toBe(false);
    expect(validateRequirements({ require: ['a'] }, { a: '' }).ok).toBe(false);
    expect(validateRequirements({ require: ['a'] }, { a: null }).ok).toBe(false);
    expect(validateRequirements({ require: ['a'] }, { a: undefined }).ok).toBe(false);
  });

  it('passes with truthy values including true and non-empty strings', () => {
    expect(validateRequirements({ require: ['a'] }, { a: true }).ok).toBe(true);
    expect(validateRequirements({ require: ['a'] }, { a: 'yes' }).ok).toBe(true);
    expect(validateRequirements({ require: ['a'] }, { a: 1 }).ok).toBe(true);
  });

  it('defaults context to empty object', () => {
    const result = validateRequirements({ require: ['x'] });
    expect(result.ok).toBe(false);
    expect(result.missing).toEqual(['x']);
  });

  it('handles empty require array', () => {
    expect(validateRequirements({ require: [] }, {})).toEqual({ ok: true, missing: [] });
  });
});
