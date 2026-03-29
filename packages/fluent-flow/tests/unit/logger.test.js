import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

let originalLogLevel;

beforeEach(() => {
  vi.resetModules();
  originalLogLevel = process.env.LOG_LEVEL;
});

afterEach(() => {
  if (originalLogLevel === undefined) {
    delete process.env.LOG_LEVEL;
  } else {
    process.env.LOG_LEVEL = originalLogLevel;
  }
});

describe('logger', () => {
  it('exports a pino logger with info, error, warn, debug methods', async () => {
    const { default: logger } = await import('../../src/logger.js');
    expect(typeof logger.info).toBe('function');
    expect(typeof logger.error).toBe('function');
    expect(typeof logger.warn).toBe('function');
    expect(typeof logger.debug).toBe('function');
  });

  it('defaults to info level', async () => {
    delete process.env.LOG_LEVEL;
    const { default: logger } = await import('../../src/logger.js');
    expect(logger.level).toBe('info');
  });

  it('respects LOG_LEVEL env var', async () => {
    process.env.LOG_LEVEL = 'debug';
    const { default: logger } = await import('../../src/logger.js');
    expect(logger.level).toBe('debug');
  });
});
