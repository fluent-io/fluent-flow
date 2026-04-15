import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/logger.js', async () => {
  const { createMockLogger } = await import('../helpers/mock-logger.js');
  return { default: createMockLogger() };
});

import logger from '../../src/logger.js';
import { validateEnv } from '../../src/config/env.js';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('validateEnv', () => {
  const fullEnv = {
    DATABASE_URL: 'postgres://localhost/test',
    FF_GITHUB_APP_ID: '123',
    FF_GITHUB_APP_PRIVATE_KEY: 'base64pem',
    FF_GITHUB_APP_WEBHOOK_SECRET: 'secret',
    MCP_AUTH_TOKEN: 'token',
    GITHUB_CLIENT_ID: 'cid',
    GITHUB_CLIENT_SECRET: 'csec',
  };

  it('returns no errors when all required vars set', () => {
    const env = {
      DATABASE_URL: 'postgres://localhost/test',
      FF_GITHUB_APP_ID: '123',
      FF_GITHUB_APP_PRIVATE_KEY: 'base64pem',
      FF_GITHUB_APP_WEBHOOK_SECRET: 'secret',
    };
    expect(validateEnv(env)).toEqual([]);
  });

  it('returns error for missing DATABASE_URL', () => {
    const env = {
      FF_GITHUB_APP_ID: '123',
      FF_GITHUB_APP_PRIVATE_KEY: 'k',
      FF_GITHUB_APP_WEBHOOK_SECRET: 's',
    };
    const errors = validateEnv(env);
    expect(errors).toContainEqual(expect.stringContaining('DATABASE_URL'));
  });

  it('returns error for missing FF_GITHUB_APP_ID', () => {
    const env = {
      DATABASE_URL: 'pg://',
      FF_GITHUB_APP_PRIVATE_KEY: 'k',
      FF_GITHUB_APP_WEBHOOK_SECRET: 's',
    };
    const errors = validateEnv(env);
    expect(errors).toContainEqual(expect.stringContaining('FF_GITHUB_APP_ID'));
  });

  it('returns error for missing FF_GITHUB_APP_PRIVATE_KEY', () => {
    const env = {
      DATABASE_URL: 'pg://',
      FF_GITHUB_APP_ID: '1',
      FF_GITHUB_APP_WEBHOOK_SECRET: 's',
    };
    const errors = validateEnv(env);
    expect(errors).toContainEqual(expect.stringContaining('FF_GITHUB_APP_PRIVATE_KEY'));
  });

  it('returns error for missing FF_GITHUB_APP_WEBHOOK_SECRET', () => {
    const env = {
      DATABASE_URL: 'pg://',
      FF_GITHUB_APP_ID: '1',
      FF_GITHUB_APP_PRIVATE_KEY: 'k',
    };
    const errors = validateEnv(env);
    expect(errors).toContainEqual(expect.stringContaining('FF_GITHUB_APP_WEBHOOK_SECRET'));
  });

  it('returns multiple errors when multiple vars missing', () => {
    const errors = validateEnv({});
    expect(errors.length).toBe(4);
  });

  it('warns but does not error for missing GITHUB_CLIENT_ID', () => {
    const env = {
      DATABASE_URL: 'pg://',
      FF_GITHUB_APP_ID: '1',
      FF_GITHUB_APP_PRIVATE_KEY: 'k',
      FF_GITHUB_APP_WEBHOOK_SECRET: 's',
    };
    const errors = validateEnv(env);
    expect(errors).toEqual([]);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ msg: expect.stringContaining('GITHUB_CLIENT_ID') })
    );
  });

  it('does not warn when all optional vars are set', () => {
    validateEnv(fullEnv);
    expect(logger.warn).not.toHaveBeenCalled();
  });
});
