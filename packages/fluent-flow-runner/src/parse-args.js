/**
 * Parse CLI arguments into an options object.
 * @param {string[]} argv — process.argv.slice(2) equivalent
 * @returns {object}
 */
export function parseArgs(argv) {
  const opts = { verbose: false };

  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--token':          opts.token = argv[++i]; break;
      case '--server':         opts.server = argv[++i]; break;
      case '--command':        opts.command = argv[++i]; break;
      case '--cwd':            opts.cwd = argv[++i]; break;
      case '--verbose':        opts.verbose = true; break;
      case '--agent':          opts.agent = argv[++i]; break;
      case '--mcp-auth-token': opts.mcpAuthToken = argv[++i]; break;
    }
  }

  if (!opts.token && !opts.agent) throw new Error('--token or --agent is required');
  if (opts.agent && !opts.token && !opts.mcpAuthToken) {
    throw new Error('--agent requires --mcp-auth-token or --token');
  }
  if (!opts.server) throw new Error('--server is required');

  return opts;
}
