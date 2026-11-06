#!/usr/bin/env node

import { createClient } from '../src/client.js';
import { createAcpRuntime } from '../src/acp/runtime.js';
import { createRunner } from '../src/runner.js';
import { createLogger } from '../src/logger.js';
import { parseArgs } from '../src/parse-args.js';
import { resolveToken } from '../src/resolve-token.js';

export function installSignalShutdown(runner, processLike = process) {
  let shutdownPromise = null;
  const handleSignal = () => {
    if (shutdownPromise) {
      processLike.exitCode = 1;
      return;
    }
    shutdownPromise = Promise.resolve()
      .then(() => runner.shutdown())
      .catch(() => {
        processLike.exitCode = 1;
      });
  };
  processLike.on('SIGTERM', handleSignal);
  processLike.on('SIGINT', handleSignal);
  return () => shutdownPromise ?? Promise.resolve();
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`Error: ${error.message}\n\nUsage: fluent-flow-runner --server <url>\n  Legacy: --token <token>\n  Agent:  --agent <id> --mcp-auth-token <token>\nOptions: [--acp-command <cmd>] [--acp-arg <arg>]... [--cwd <path>] [--verbose]`);
    process.exit(1);
  }

  const log = createLogger(opts.verbose);

  let token;
  try {
    token = await resolveToken(opts, log);
  } catch (error) {
    log.error('Failed to resolve runner credentials', { error: error.message });
    process.exit(1);
  }

  const client = createClient({ serverUrl: opts.server, token });
  const runner = createRunner({
    client,
    log,
    createAcpRuntime,
    acpCommand: opts.acpCommand,
    acpArgs: opts.acpArgs,
    runnerToken: token,
    cwd: opts.cwd,
  });

  const waitForSignalShutdown = installSignalShutdown(runner);

  try {
    await runner.start();
    await waitForSignalShutdown();
  } catch (error) {
    log.error('Runner failed', { error: error.message });
    process.exitCode = 1;
    try {
      await runner.shutdown();
    } catch (shutdownError) {
      log.error('Runner shutdown failed', { error: shutdownError.message });
    }
    await waitForSignalShutdown();
  }
}

const isDirectRun = process.argv[1]?.endsWith('fluent-flow-runner.js') && !process.env.VITEST;
if (isDirectRun) main();
