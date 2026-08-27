import { describe, it, expect } from 'vitest';
import { RepoConfigSchema, MergedConfigSchema } from '../../src/config/schema.js';

describe('verification config', () => {
  it('applies defaults on merge', () => {
    const merged = MergedConfigSchema.parse({});
    expect(merged.verification).toMatchObject({
      enabled: true, framework: 'auto', skip_policy: 'allow_ungated',
      flake: { retries: 2, blocking: false },
      authoring: { retries: 2, max_requirements: 25, red_reproductions: 2 },
      timeouts_min: { red: 15, green: 30 },
    });
  });
  it('repo override wins and rejects unknown framework', () => {
    const repo = RepoConfigSchema.parse({ verification: { framework: 'custom', command: ['pytest', '-q'], skip_policy: 'require' } });
    expect(repo.verification.framework).toBe('custom');
    expect(() => RepoConfigSchema.parse({ verification: { framework: 'playwright' } })).toThrow();
    expect(() => RepoConfigSchema.parse({ verification: { command: 'npm test' } })).toThrow(); // must be argv array
  });
});
