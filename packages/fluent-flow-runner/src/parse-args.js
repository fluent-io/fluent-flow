const VALUE_FLAGS = new Map([
  ['--token', 'token'],
  ['--server', 'server'],
  ['--cwd', 'cwd'],
  ['--agent', 'agent'],
  ['--mcp-auth-token', 'mcpAuthToken'],
  ['--acp-command', 'acpCommand'],
]);

export function parseArgs(argv) {
  const opts = { verbose: false, acpArgs: [] };

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--verbose') {
      opts.verbose = true;
      continue;
    }
    if (flag === '--command') {
      throw new Error('--command was removed; use --acp-command with repeatable --acp-arg values');
    }
    if (flag === '--acp-arg') {
      if (index + 1 >= argv.length) throw new Error('--acp-arg requires a value');
      opts.acpArgs.push(argv[index + 1]);
      index += 1;
      continue;
    }
    const property = VALUE_FLAGS.get(flag);
    if (!property) throw new Error(`Unknown option: ${flag}`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`${flag} requires a value`);
    opts[property] = value;
    index += 1;
  }

  if (!opts.token && !opts.agent) throw new Error('--token or --agent is required');
  if (!opts.server) throw new Error('--server is required');

  return opts;
}
