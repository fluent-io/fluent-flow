#!/usr/bin/env node

import { createClient } from '../src/client.js';
import { resolveCommand } from '../src/commands.js';
import { createRunner } from '../src/runner.js';
import { createLogger } from '../src/logger.js';
import { parseArgs } from '../src/parse-args.js';
import { getAgentCredentials, setAgentCredentials } from '../src/credentials.js';
import { bootstrap } from '../src/bootstrap.js';

/**
 * Resolve the agent token using the startup flow:
 * 1. If --token provided → use directly (backward compat)
 * 2. If no --token:
 *    a. Look up credentials file for the agent
 *    b. If found and server matches → use saved token
 *    c. If not found → bootstrap using MCP_AUTH_TOKEN
 *
 * @param {object} opts — parsed CLI options
 * @param {object} log — logger instance
 * @returns {Promise<string>} resolved token
 */
async function resolveToken(opts, log) {
  // Case 1: explicit token — backward compat
  if (opts.token) return opts.token;

  const agentId = opts.agent;

  // Case 2a: look up saved credentials
  const saved = getAgentCredentials(agentId);
  if (saved && saved.server === opts.server) {
    log.info('Using saved credentials', { agent: agentId });
    return saved.token;
  }

  // Case 2c: bootstrap with MCP_AUTH_TOKEN
  const mcpAuthToken = opts.mcpAuthToken || process.env.MCP_AUTH_TOKEN;
  if (!mcpAuthToken) {
    throw new Error('No saved credentials for agent "' + agentId + '". Provide --mcp-auth-token or set MCP_AUTH_TOKEN env var to bootstrap.');
  }

  log.info('Bootstrapping agent', { agent: agentId });
  const { token } = await bootstrap({
    server: opts.server,
    agentId,
    mcpAuthToken,
  });

  setAgentCredentials(agentId, { token, server: opts.server });
  log.info('Credentials saved', { agent: agentId });

  return token;
}

/**
 * Main entry point. Only runs when executed directly (not imported for testing).
 */
async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`Error: ${err.message}\n\nUsage: fluent-flow-runner --token <token> --server <url> [--agent <id>] [--mcp-auth-token <token>] [--command <cmd>] [--cwd <path>] [--verbose]`);
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
