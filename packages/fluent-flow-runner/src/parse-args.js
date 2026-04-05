/**
 * Parse CLI arguments into an options object.
 * @param {string[]} argv — process.argv.slice(2) equivalent
 * @returns {object}
 */
export function parseArgs(argv) {
  const opts = { verbose: false };

  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--token':    opts.token = argv[++i]; break;
      case '--server':   opts.server = argv[++i]; break;
      case '--command':  opts.command = argv[++i]; break;
      case '--cwd':      opts.cwd = argv[++i]; break;
      case '--verbose':  opts.verbose = true; break;
    }
  }

  if (!opts.token) throw new Error('--token is required');
  if (!opts.server) throw new Error('--server is required');

  return opts;
}
