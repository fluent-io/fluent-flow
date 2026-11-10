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

  function lines() {
    return writeSpy.mock.calls.map(([chunk]) => JSON.parse(String(chunk)));
  }

  it('info() writes one JSON line with string level, msg and ISO time to stdout', () => {
    const log = createLogger(false);
    log.info('hello');
    expect(writeSpy).toHaveBeenCalledOnce();
    expect(String(writeSpy.mock.calls[0][0]).endsWith('\n')).toBe(true);
    const [output] = lines();
    expect(output.level).toBe('info');
    expect(output.msg).toBe('hello');
    expect(output.time).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u);
    expect(new Date(output.time).toISOString()).toBe(output.time);
  });

  it('does not add process or host fields', () => {
    createLogger(false).info('hello');
    expect(Object.keys(lines()[0]).sort()).toEqual(['level', 'msg', 'time']);
  });

  it.each(['warn', 'error'])('%s() writes JSON with that string level', (level) => {
    const log = createLogger(false);
    log[level]('fail');
    const [output] = lines();
    expect(output.level).toBe(level);
    expect(output.msg).toBe('fail');
  });

  it('debug() is silent when verbose is false', () => {
    const log = createLogger(false);
    log.debug('hidden');
    expect(writeSpy).not.toHaveBeenCalled();
    expect(log.isDebug()).toBe(false);
  });

  it('debug() writes when verbose is true', () => {
    const log = createLogger(true);
    log.debug('visible');
    const [output] = lines();
    expect(output.level).toBe('debug');
    expect(output.msg).toBe('visible');
    expect(log.isDebug()).toBe(true);
  });

  it.each([
    ['trace', ['debug', 'info', 'warn', 'error'], true],
    ['debug', ['debug', 'info', 'warn', 'error'], true],
    ['info', ['info', 'warn', 'error'], false],
    ['warn', ['warn', 'error'], false],
    ['error', ['error'], false],
    ['fatal', [], false],
  ])('honours level %s', (level, written, debugEnabled) => {
    const log = createLogger(false, level);
    for (const method of ['debug', 'info', 'warn', 'error']) log[method](`${method} line`);
    expect(lines().map((line) => line.level)).toEqual(written);
    expect(log.isDebug()).toBe(debugEnabled);
  });

  it('defaults to info and reads LOG_LEVEL from the environment', () => {
    const saved = process.env.LOG_LEVEL;
    try {
      delete process.env.LOG_LEVEL;
      createLogger().debug('hidden');
      expect(writeSpy).not.toHaveBeenCalled();
      process.env.LOG_LEVEL = 'warn';
      const log = createLogger();
      log.info('hidden');
      log.warn('shown');
      expect(lines().map((line) => line.msg)).toEqual(['shown']);
    } finally {
      if (saved === undefined) delete process.env.LOG_LEVEL;
      else process.env.LOG_LEVEL = saved;
    }
  });

  it('lets verbose force debug output over a quieter level', () => {
    const log = createLogger(true, 'warn');
    log.debug('forced');
    expect(lines().map((line) => line.level)).toEqual(['debug']);
    expect(log.isDebug()).toBe(true);
  });

  it.each(['verbose', '', 'INFO', 'silent'])('rejects the invalid level %j', (level) => {
    expect(() => createLogger(false, level)).toThrow(/LOG_LEVEL/u);
  });

  it('keeps the level on child loggers', () => {
    const child = createLogger(false, 'warn').child({ slotId: 1 });
    child.info('hidden');
    child.warn('shown');
    expect(lines().map((line) => line.msg)).toEqual(['shown']);
  });

  it('accepts object payload merged into output', () => {
    const log = createLogger(false);
    log.info('start', { sessionId: 5, event: 'slot_registered' });
    const [output] = lines();
    expect(output.msg).toBe('start');
    expect(output.sessionId).toBe(5);
    expect(output.event).toBe('slot_registered');
  });

  it('redacts obvious secret keys at the top level and one level down', () => {
    const log = createLogger(false);
    log.info('secrets', {
      token: 'top-secret-token',
      githubToken: 'ghp_top_secret',
      authorization: 'Bearer top-secret-bearer',
      claim: { token: 'nested-secret-token' },
      request: { githubToken: 'ghp_nested_secret', authorization: 'Bearer nested-bearer' },
      claimId: 9,
    });
    const raw = String(writeSpy.mock.calls[0][0]);
    for (const secret of [
      'top-secret-token',
      'ghp_top_secret',
      'top-secret-bearer',
      'nested-secret-token',
      'ghp_nested_secret',
      'nested-bearer',
    ]) {
      expect(raw).not.toContain(secret);
    }
    const [output] = lines();
    expect(output.token).toBe('[REDACTED]');
    expect(output.githubToken).toBe('[REDACTED]');
    expect(output.authorization).toBe('[REDACTED]');
    expect(output.claim.token).toBe('[REDACTED]');
    expect(output.claimId).toBe(9);
  });

  it('child() binds fields to every line, keeps the shape, and honours verbose', () => {
    const quiet = createLogger(false).child({ instanceId: 'instance-1', slotId: 3 });
    quiet.info('slot message', { claimId: 4 });
    quiet.debug('hidden');
    expect(writeSpy).toHaveBeenCalledOnce();
    expect(lines()[0]).toMatchObject({
      level: 'info',
      msg: 'slot message',
      instanceId: 'instance-1',
      slotId: 3,
      claimId: 4,
    });
    for (const method of ['info', 'warn', 'error', 'debug', 'isDebug', 'child']) {
      expect(quiet[method]).toEqual(expect.any(Function));
    }
    expect(quiet.isDebug()).toBe(false);

    const verbose = createLogger(true).child({ slotId: 1 }).child({ extra: true });
    verbose.debug('deep');
    expect(lines().at(-1)).toMatchObject({ level: 'debug', msg: 'deep', slotId: 1, extra: true });
    expect(verbose.isDebug()).toBe(true);
  });

  it('redacts secret keys on child loggers', () => {
    createLogger(false).child({ slotId: 1 }).warn('child secrets', { token: 'child-secret-token' });
    expect(String(writeSpy.mock.calls[0][0])).not.toContain('child-secret-token');
  });
});
