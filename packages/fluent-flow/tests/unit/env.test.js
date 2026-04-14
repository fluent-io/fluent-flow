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
    GITHUB_TOKEN: 'ghp_test',
    GITHUB_APP_ID: '123',
    GITHUB_APP_PRIVATE_KEY_PATH: '/path/to/key.pem',
    GITHUB_APP_WEBHOOK_SECRET: 'secret',
    MCP_AUTH_TOKEN: 'token',
    GITHUB_APP_CLIENT_ID: 'cid',
    GITHUB_APP_CLIENT_SECRET: 'csec',
  };

  it('returns no errors when all required vars set', () => {
    const env = {
      DATABASE_URL: 'postgres://localhost/test',
      GITHUB_APP_ID: '123',
      GITHUB_APP_PRIVATE_KEY_PATH: '/path/to/key.pem',
      GITHUB_APP_WEBHOOK_SECRET: 'secret',
    };
    expect(validateEnv(env)).toEqual([]);
  });

  it('returns error for missing DATABASE_URL', () => {
    const env = { GITHUB_APP_ID: '123', GITHUB_APP_PRIVATE_KEY_PATH: '/k.pem', GITHUB_APP_WEBHOOK_SECRET: 's' };
    const errors = validateEnv(env);
    expect(errors).toContainEqual(expect.stringContaining('DATABASE_URL'));
  });

  it('returns error for missing GITHUB_APP_ID', () => {
    const env = { DATABASE_URL: 'pg://', GITHUB_APP_PRIVATE_KEY_PATH: '/k.pem', GITHUB_APP_WEBHOOK_SECRET: 's' };
    const errors = validateEnv(env);
    expect(errors).toContainEqual(expect.stringContaining('GITHUB_APP_ID'));
  });

  it('returns error for missing GITHUB_APP_PRIVATE_KEY_PATH', () => {
    const env = { DATABASE_URL: 'pg://', GITHUB_APP_ID: '1', GITHUB_APP_WEBHOOK_SECRET: 's' };
    const errors = validateEnv(env);
    expect(errors).toContainEqual(expect.stringContaining('GITHUB_APP_PRIVATE_KEY_PATH'));
  });

  it('returns error for missing GITHUB_APP_WEBHOOK_SECRET', () => {
    const env = { DATABASE_URL: 'pg://', GITHUB_APP_ID: '1', GITHUB_APP_PRIVATE_KEY_PATH: '/k.pem' };
    const errors = validateEnv(env);
    expect(errors).toContainEqual(expect.stringContaining('GITHUB_APP_WEBHOOK_SECRET'));
  });

  it('returns multiple errors when multiple vars missing', () => {
    const errors = validateEnv({});
    expect(errors.length).toBe(4);
  });

  it('warns but does not error for missing GITHUB_TOKEN', () => {
    const env = { DATABASE_URL: 'pg://', GITHUB_APP_ID: '1', GITHUB_APP_PRIVATE_KEY_PATH: '/k.pem', GITHUB_APP_WEBHOOK_SECRET: 's' };
    const errors = validateEnv(env);
    expect(errors).toEqual([]);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ msg: expect.stringContaining('GITHUB_TOKEN') })
    );
  });

  it('does not warn when all optional vars are set', () => {
    validateEnv(fullEnv);
    expect(logger.warn).not.toHaveBeenCalled();
  });
});
