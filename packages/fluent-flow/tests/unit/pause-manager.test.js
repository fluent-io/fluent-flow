import { describe, it, expect } from 'vitest';
import { parseResumeCommand } from '../../src/engine/pause-manager.js';

describe('parseResumeCommand', () => {
  it('returns isResume: false for null/undefined/empty input', () => {
    expect(parseResumeCommand(null)).toEqual({ isResume: false, toState: null, instructions: null });
    expect(parseResumeCommand(undefined)).toEqual({ isResume: false, toState: null, instructions: null });
    expect(parseResumeCommand('')).toEqual({ isResume: false, toState: null, instructions: null });
  });

  it('returns isResume: false for non-resume comments', () => {
    expect(parseResumeCommand('hello world')).toEqual({ isResume: false, toState: null, instructions: null });
    expect(parseResumeCommand('please resume this')).toEqual({ isResume: false, toState: null, instructions: null });
    expect(parseResumeCommand('/restart')).toEqual({ isResume: false, toState: null, instructions: null });
  });

  it('parses bare /resume', () => {
    expect(parseResumeCommand('/resume')).toEqual({ isResume: true, toState: null, instructions: null });
  });

  it('parses /resume with leading/trailing whitespace', () => {
    expect(parseResumeCommand('  /resume  ')).toEqual({ isResume: true, toState: null, instructions: null });
  });

  it('is case-insensitive', () => {
    expect(parseResumeCommand('/Resume')).toEqual({ isResume: true, toState: null, instructions: null });
    expect(parseResumeCommand('/RESUME')).toEqual({ isResume: true, toState: null, instructions: null });
    expect(parseResumeCommand('/rEsUmE')).toEqual({ isResume: true, toState: null, instructions: null });
  });

  it('parses /resume with free-text instructions', () => {
    const result = parseResumeCommand('/resume Try approach X instead');
    expect(result.isResume).toBe(true);
    expect(result.toState).toBeNull();
    expect(result.instructions).toBe('Try approach X instead');
  });

  // to:state variants
  it('parses /resume to:review → In Review', () => {
    const result = parseResumeCommand('/resume to:review');
    expect(result).toEqual({ isResume: true, toState: 'In Review', instructions: null });
  });

  it('parses /resume to:progress → In Progress', () => {
    const result = parseResumeCommand('/resume to:progress');
    expect(result).toEqual({ isResume: true, toState: 'In Progress', instructions: null });
  });

  it('parses /resume to:in-progress → In Progress', () => {
    const result = parseResumeCommand('/resume to:in-progress');
    expect(result).toEqual({ isResume: true, toState: 'In Progress', instructions: null });
  });

  it('parses /resume to:in-review → In Review', () => {
    const result = parseResumeCommand('/resume to:in-review');
    expect(result).toEqual({ isResume: true, toState: 'In Review', instructions: null });
  });

  it('parses /resume to:backlog → Backlog', () => {
    const result = parseResumeCommand('/resume to:backlog');
    expect(result).toEqual({ isResume: true, toState: 'Backlog', instructions: null });
  });

  it('parses /resume to:ready → Ready', () => {
    const result = parseResumeCommand('/resume to:ready');
    expect(result).toEqual({ isResume: true, toState: 'Ready', instructions: null });
  });

  it('parses /resume to:awaiting-human → Awaiting Human', () => {
    const result = parseResumeCommand('/resume to:awaiting-human');
    expect(result).toEqual({ isResume: true, toState: 'Awaiting Human', instructions: null });
  });

  it('parses /resume to:done → Done', () => {
    const result = parseResumeCommand('/resume to:done');
    expect(result).toEqual({ isResume: true, toState: 'Done', instructions: null });
  });

  it('parses /resume to:cancelled → Cancelled', () => {
    const result = parseResumeCommand('/resume to:cancelled');
    expect(result).toEqual({ isResume: true, toState: 'Cancelled', instructions: null });
  });

  it('to:state is case-insensitive', () => {
    expect(parseResumeCommand('/resume to:Review').toState).toBe('In Review');
    expect(parseResumeCommand('/resume to:PROGRESS').toState).toBe('In Progress');
  });

  it('parses /resume to:review with trailing instructions', () => {
    const result = parseResumeCommand('/resume to:review Re-run the review please');
    expect(result.isResume).toBe(true);
    expect(result.toState).toBe('In Review');
    expect(result.instructions).toBe('Re-run the review please');
  });
});
