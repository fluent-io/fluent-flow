import { describe, it, expect } from 'vitest';
import { resolvePrompt, CLAIM_TYPES } from '../../src/prompts.js';

describe('prompts', () => {
  describe('CLAIM_TYPES', () => {
    it('defines spec, build, review_fix, test_verify', () => {
      expect(CLAIM_TYPES).toEqual(['spec', 'build', 'review_fix', 'test_verify']);
    });
  });

  describe('resolvePrompt()', () => {
    const baseWork = {
      repo: 'fluent-io/fluent-flow',
      prNumber: 42,
      attempt: 1,
      branch: 'feature/test',
    };

    it('returns a non-empty string for review_fix with message', () => {
      const prompt = resolvePrompt({ claimType: 'review_fix', work: { ...baseWork, message: 'Fix the bug at src/index.js:5' } });
      expect(typeof prompt).toBe('string');
      expect(prompt.length).toBeGreaterThan(0);
      expect(prompt).toContain('Fix the bug at src/index.js:5');
    });

    it('returns a non-empty string for spec', () => {
      const prompt = resolvePrompt({ claimType: 'spec', work: baseWork });
      expect(typeof prompt).toBe('string');
      expect(prompt).toContain('fluent-io/fluent-flow');
      expect(prompt).toContain('docs/specs/');
    });

    it('returns a non-empty string for build', () => {
      const prompt = resolvePrompt({ claimType: 'build', work: baseWork });
      expect(typeof prompt).toBe('string');
      expect(prompt).toContain('fluent-io/fluent-flow');
      expect(prompt).toContain('docs/plans/');
    });

    it('returns a non-empty string for test_verify', () => {
      const prompt = resolvePrompt({ claimType: 'test_verify', work: { ...baseWork, message: 'Previous issues: ...' } });
      expect(typeof prompt).toBe('string');
      expect(prompt).toContain('test');
    });

    it('throws for unknown claim_type', () => {
      expect(() => resolvePrompt({ claimType: 'unknown', work: baseWork }))
        .toThrow(/unknown claim_type/);
    });

    it('review_fix template includes repo and PR context', () => {
      const prompt = resolvePrompt({
        claimType: 'review_fix',
        work: { ...baseWork, message: 'Fix the login bug' },
      });
      expect(prompt).toContain('fluent-io/fluent-flow');
      expect(prompt).toContain('42');
      expect(prompt).toContain('Fix the login bug');
    });
  });
});
