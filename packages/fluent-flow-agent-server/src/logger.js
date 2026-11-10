import pino from 'pino';

export const LOG_LEVELS = Object.freeze(['trace', 'debug', 'info', 'warn', 'error', 'fatal']);

const REDACT_PATHS = [
  'token',
  'githubToken',
  'authorization',
  '*.token',
  '*.githubToken',
  '*.authorization',
];

function wrap(logger) {
  return {
    info: (msg, data) => logger.info(data ?? {}, msg),
    warn: (msg, data) => logger.warn(data ?? {}, msg),
    error: (msg, data) => logger.error(data ?? {}, msg),
    debug: (msg, data) => logger.debug(data ?? {}, msg),
    isDebug: () => logger.isLevelEnabled('debug'),
    child: (bindings) => wrap(logger.child(bindings)),
  };
}

export function assertLogLevel(level) {
  if (!LOG_LEVELS.includes(level)) {
    throw new Error(`LOG_LEVEL must be one of ${LOG_LEVELS.join(', ')}.`);
  }
  return level;
}

/**
 * Structured JSON logger: one pino line per event on standard output.
 * @param {boolean} verbose — force at least debug-level output
 * @param {string} level — minimum level, defaults to LOG_LEVEL or info
 * @returns {{ info, warn, error, debug, isDebug, child }}
 */
export function createLogger(verbose = false, level = process.env.LOG_LEVEL ?? 'info') {
  assertLogLevel(level);
  return wrap(pino({
    level: verbose && level !== 'trace' ? 'debug' : level,
    messageKey: 'msg',
    base: null,
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: { level: (label) => ({ level: label }) },
    redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
  }, process.stdout));
}
