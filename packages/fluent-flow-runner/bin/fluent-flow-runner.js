#!/usr/bin/env node

import { createClient } from '../src/client.js';
import { resolveCommand } from '../src/commands.js';
import { createRunner } from '../src/runner.js';
import { createLogger } from '../src/logger.js';
import { parseArgs } from '../src/parse-args.js';
import { resolveToken } from '../src/resolve-token.js';

/**
 * Main entry point. Only runs when executed directly (not imported for testing).
 */
async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`Error: ${err.message}\n\nUsage: fluent-flow-runner --server <url>\n  Legacy: --token <token>\n  Agent:  --agent <id> --mcp-auth-token <token>\nOptions: [--command <cmd>] [--cwd <path>] [--verbose]`);
    process.exit(1);
  }

  const log = createLogger(opts.verbose);

  let token;
  try {
    token = await resolveToken(opts, log);
  } catch (err) {
    log.error('Failed to resolve token', { error: err.message });
    process.exit(1);
  }

  const client = createClient({ serverUrl: opts.server, token });
  const runner = createRunner({
    client,
    log,
    resolveCommand: (cmdOpts) => resolveCommand({ ...cmdOpts, commandOverride: opts.command }),
    cwd: opts.cwd,
  });

  const shutdown = () => runner.shutdown();
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  try {
    await runner.start();
  } catch (err) {
    log.error('Runner failed', { error: err.message });
    process.exit(1);
  }
}

// Run main only when executed directly
const isDirectRun = process.argv[1]?.endsWith('fluent-flow-runner.js') && !process.env.VITEST;
if (isDirectRun) {
  main();
}
