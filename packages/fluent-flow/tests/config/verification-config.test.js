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
  it('rejects custom framework without command (absent key)', () => {
    expect(() => RepoConfigSchema.parse({ verification: { framework: 'custom' } })).toThrow(/verification\.command \(argv\) is required when framework is custom/);
  });
  it('rejects custom framework without command (explicit null)', () => {
    expect(() => RepoConfigSchema.parse({ verification: { framework: 'custom', command: null } })).toThrow(/verification\.command \(argv\) is required when framework is custom/);
  });
  it('repo override wins via deep merge precedence', () => {
    const defaults = { verification: { enabled: true, framework: 'auto', skip_policy: 'allow_ungated', flake: { retries: 2, blocking: false }, authoring: { retries: 2, max_requirements: 25, red_reproductions: 2 }, timeouts_min: { red: 15, green: 30 } } };
    const repoOverride = { verification: { framework: 'vitest' } };
    
    // Simulate deepMerge from loader.js (lines 41-58)
    function deepMerge(base, override) {
      if (!override || typeof override !== 'object') return base;
      const result = { ...base };
      for (const [key, value] of Object.entries(override)) {
        if (
          value !== null &&
          typeof value === 'object' &&
          !Array.isArray(value) &&
          typeof result[key] === 'object' &&
          result[key] !== null &&
          !Array.isArray(result[key])
        ) {
          result[key] = deepMerge(result[key], value);
        } else if (value !== undefined) {
          result[key] = value;
        }
      }
      return result;
    }
    
    const merged = deepMerge(defaults, repoOverride);
    const validated = MergedConfigSchema.parse(merged);
    
    expect(validated.verification.framework).toBe('vitest');
    expect(validated.verification.authoring.max_requirements).toBe(25); // default preserved
    expect(validated.verification.enabled).toBe(true); // default preserved
    expect(validated.verification.skip_policy).toBe('allow_ungated'); // default preserved
  });
});