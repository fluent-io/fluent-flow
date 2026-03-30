import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createLogger } from '../../src/logger.js';

describe('logger', () => {
  let writeSpy;

  beforeEach(() => {
    writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    writeSpy.mockRestore();
  });

  it('info() writes JSON with level "info" to stdout', () => {
    const log = createLogger(false);
    log.info('hello');
    expect(writeSpy).toHaveBeenCalledOnce();
    const output = JSON.parse(writeSpy.mock.calls[0][0]);
    expect(output.level).toBe('info');
    expect(output.msg).toBe('hello');
    expect(output.time).toBeDefined();
  });

  it('error() writes JSON with level "error"', () => {
    const log = createLogger(false);
    log.error('fail');
    const output = JSON.parse(writeSpy.mock.calls[0][0]);
    expect(output.level).toBe('error');
    expect(output.msg).toBe('fail');
  });

  it('debug() is silent when verbose is false', () => {
    const log = createLogger(false);
    log.debug('hidden');
    expect(writeSpy).not.toHaveBeenCalled();
  });

  it('debug() writes when verbose is true', () => {
    const log = createLogger(true);
    log.debug('visible');
    const output = JSON.parse(writeSpy.mock.calls[0][0]);
    expect(output.level).toBe('debug');
    expect(output.msg).toBe('visible');
  });

  it('accepts object payload merged into output', () => {
    const log = createLogger(false);
    log.info('start', { sessionId: 5 });
    const output = JSON.parse(writeSpy.mock.calls[0][0]);
    expect(output.msg).toBe('start');
    expect(output.sessionId).toBe(5);
  });
});
