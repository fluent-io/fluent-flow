import { describe, it, expect } from 'vitest';
import { resolvePrompt, CLAIM_TYPES } from '../../src/prompts.js';

describe('prompts', () => {
  describe('CLAIM_TYPES', () => {
    it('includes verify alongside spec, build, review, review_fix, test_verify', () => {
      expect(CLAIM_TYPES).toEqual(['spec', 'build', 'review', 'review_fix', 'test_verify', 'verify']);
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

    it('verify template includes the red authoring contract', () => {
      const prompt = resolvePrompt({
        claimType: 'verify',
        work: {
          ...baseWork,
          issue_number: 7,
          pr_body: 'Fix the login bug',
          payload: {
            phase: 'red',
            findings: [
              { id: 'F-1', severity: 'high', blocking: true, title: 'Login fails', body: 'Broken flow' },
            ],
            verification: {
              framework: 'auto',
              authoring: { max_requirements: 3 },
            },
          },
        },
      });
      expect(prompt).toContain('DO NOT read any fix — author against the current (broken) state only.');
      expect(prompt).toContain('"id": "F-1"');
      expect(prompt).toContain('manifest.json');
      expect(prompt).toContain('spec.md');
      expect(prompt).toContain('repo-relative');
      expect(prompt).toContain('EARS');
      expect(prompt).toContain('issue #7');
      expect(prompt).toContain('Fix the login bug');
      expect(prompt).toContain('max_requirements');
    });

    it('review template instructs the harness to post a review comment with the reviewer-result marker', () => {
      const prompt = resolvePrompt({
        claimType: 'review',
        work: { ...baseWork, priorIssues: [] },
      });
      expect(typeof prompt).toBe('string');
      expect(prompt).toContain('fluent-io/fluent-flow');
      expect(prompt).toContain('42');
      // The harness must emit a result the server can parse via handleReviewResult.
      expect(prompt).toContain('reviewer-result:');
      expect(prompt).toMatch(/PASS|FAIL/);
    });

    it('review template carries prior issues when the retry path runs', () => {
      const prompt = resolvePrompt({
        claimType: 'review',
        work: { ...baseWork, priorIssues: [{ file: 'src/index.js', line: 5, issue: 'Null deref' }] },
      });
      expect(prompt).toContain('src/index.js');
      expect(prompt).toContain('Null deref');
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

    it('review_fix template threads findings and pinned verifier immutability', () => {
      const prompt = resolvePrompt({
        claimType: 'review_fix',
        work: {
          ...baseWork,
          findings: [{ id: 'F-1', file: 'src/auth.js', line: 12, issue: 'Missing authorization check' }],
          immutability: ['test/verify/req-1.test.js', 'package-lock.json'],
          source_claim_id: 41,
        },
      });
      expect(prompt).toContain('"id": "F-1"');
      expect(prompt).toContain('Missing authorization check');
      expect(prompt).toContain('Source verify claim: 41');
      expect(prompt).toContain('Pinned verifier files are immutable');
      expect(prompt).toContain('test/verify/req-1.test.js');
      expect(prompt).toContain('package-lock.json');
      expect(prompt).toContain('Do not create, modify, rename, or delete tests or framework files');
      expect(prompt).not.toContain('Add tests that verify the fixes.');
    });
  });
});

describe('review_fix push instructions', () => {
  it('includes an explicit detached-HEAD push command when branch is known', () => {
    const prompt = resolvePrompt({
      claimType: 'review_fix',
      work: { repo: 'o/r', prNumber: 5, message: 'fix it', branch: 'fix/thing' },
    });
    expect(prompt).toContain('git push origin HEAD:fix/thing');
    expect(prompt).toContain('DETACHED HEAD');
    expect(prompt).toContain('pushed');
  });

  it('falls back to a generic push hint without a branch', () => {
    const prompt = resolvePrompt({
      claimType: 'review_fix',
      work: { repo: 'o/r', prNumber: 5, message: 'fix it' },
    });
    expect(prompt).toContain('git push origin HEAD:<pr-branch>');
    expect(prompt).not.toContain('DETACHED HEAD checkout — a plain');
  });
});
