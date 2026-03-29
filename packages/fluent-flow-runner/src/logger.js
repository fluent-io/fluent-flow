/**
 * Minimal structured JSON logger for the runner.
 * @param {boolean} verbose — enable debug-level output
 * @returns {{ info, error, debug }}
 */
export function createLogger(verbose = false) {
  function write(level, msg, data = {}) {
    const entry = JSON.stringify({ level, msg, time: new Date().toISOString(), ...data }) + '\n';
    process.stdout.write(entry);
  }

  return {
    info: (msg, data) => write('info', msg, data),
    error: (msg, data) => write('error', msg, data),
    debug: (msg, data) => { if (verbose) write('debug', msg, data); },
  };
}
