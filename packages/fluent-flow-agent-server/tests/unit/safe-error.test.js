import { describe, expect, it } from 'vitest';
import { safeError } from '../../src/safe-error.js';

describe('safeError', () => {
  it('returns the message of an ordinary error', () => {
    expect(safeError(new Error('registration refused'))).toBe('registration refused');
  });

  it('redacts durable and enrollment tokens everywhere in the message', () => {
    const result = safeError(new Error('bad ff_durable-Token_1 then enroll_single_use_2 and ff_again'));

    expect(result).toBe('bad [REDACTED] then [REDACTED] and [REDACTED]');
  });

  it('redacts provider environment assignments', () => {
    const result = safeError(new Error(
      'spawn failed CLAUDE_CODE_OAUTH_TOKEN=oauth-secret-value CODEX_AUTH_JSON={"tokens":"x"}',
    ));

    expect(result).not.toContain('oauth-secret-value');
    expect(result).not.toContain('"tokens"');
    expect(result).toBe('spawn failed [REDACTED] [REDACTED]');
  });

  it.each(['ghp', 'gho', 'ghu', 'ghs', 'ghr'])('redacts %s_ GitHub tokens anywhere in the message', (prefix) => {
    const token = `${prefix}_${'aB3'.repeat(12)}`;
    const result = safeError(new Error(`fatal: ${token} rejected, retry with ${token}`));

    expect(result).toBe('fatal: [REDACTED] rejected, retry with [REDACTED]');
  });

  it('redacts fine-grained personal access tokens', () => {
    const result = safeError(new Error('remote: github_pat_11ABCDEFG0abc_DEFghi123 denied'));

    expect(result).toBe('remote: [REDACTED] denied');
  });

  it('redacts a Basic authorization header and its base64 value', () => {
    const encoded = Buffer.from(`x-access-token:ghs_${'q'.repeat(30)}`).toString('base64');
    const result = safeError(new Error(`git failed: Authorization: Basic ${encoded} for origin`));

    expect(result).toBe('git failed: [REDACTED] for origin');
    expect(result).not.toContain(encoded);
  });

  it('redacts the base64 form of an x-access-token credential outside a header', () => {
    const encoded = Buffer.from(`x-access-token:ghs_${'q'.repeat(30)}`).toString('base64');
    const result = safeError(new Error(`config value ${encoded} leaked`));

    expect(result).toBe('config value [REDACTED] leaked');
  });

  it('leaves unrelated words that merely resemble token prefixes', () => {
    expect(safeError(new Error('ghost_writer github_patrol'))).toBe('ghost_writer github_patrol');
  });

  it.each([undefined, null, {}, 'plain string'])('falls back to a generic message for %j', (value) => {
    expect(safeError(value)).toBe('Unknown error');
  });
});
