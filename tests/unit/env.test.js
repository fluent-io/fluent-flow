import { describe, it, expect, vi } from 'vitest';
import { validateEnv } from '../../src/config/env.js';

describe('validateEnv', () => {
  it('returns no errors when all required vars set', () => {
    const env = {
      DATABASE_URL: 'postgres://localhost/test',
      GITHUB_TOKEN: 'ghp_test',
      GITHUB_WEBHOOK_SECRET: 'secret',
    };
    expect(validateEnv(env)).toEqual([]);
  });

  it('returns error for missing DATABASE_URL', () => {
    const env = { GITHUB_TOKEN: 'ghp_test' };
    const errors = validateEnv(env);
    expect(errors).toContainEqual(expect.stringContaining('DATABASE_URL'));
  });

  it('returns error for missing GITHUB_TOKEN', () => {
    const env = { DATABASE_URL: 'postgres://localhost/test' };
    const errors = validateEnv(env);
    expect(errors).toContainEqual(expect.stringContaining('GITHUB_TOKEN'));
  });

  it('returns multiple errors when multiple vars missing', () => {
    const errors = validateEnv({});
    expect(errors.length).toBe(2);
  });

  it('warns but does not error for missing GITHUB_WEBHOOK_SECRET', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const env = { DATABASE_URL: 'postgres://localhost/test', GITHUB_TOKEN: 'ghp_test' };
    const errors = validateEnv(env);
    expect(errors).toEqual([]);
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({ msg: expect.stringContaining('GITHUB_WEBHOOK_SECRET') })
    );
    spy.mockRestore();
  });

  it('does not warn when all optional vars are set', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const env = {
      DATABASE_URL: 'postgres://localhost/test',
      GITHUB_TOKEN: 'ghp_test',
      GITHUB_WEBHOOK_SECRET: 'secret',
      MCP_AUTH_TOKEN: 'token',
    };
    validateEnv(env);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
