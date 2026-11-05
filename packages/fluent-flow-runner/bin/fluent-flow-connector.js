#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { createConnectorRuntime } from '../src/connector/runtime.js';
import { ConnectorConfigError } from '../src/connector/config.js';

const USAGE = 'Usage: fluent-flow-connector --config <private-local-config.json> [--enable-integration paseo]';
const ANSWER_USAGE = 'Usage: fluent-flow-connector answer --local --config <private-local-config.json> [--request <id>]';
const COMMAND_USAGE = 'Usage: fluent-flow-connector status|list|stop --config <private-local-config.json>';
const INTEGRATIONS = ['paseo'];
const COMMANDS = ['status', 'list', 'stop'];

if (COMMANDS.includes(process.argv[2])) {
  let parsed;
  try {
    parsed = parseArgs({ args: process.argv.slice(3), options: { config: { type: 'string' } }, strict: true }).values;
  } catch {
    parsed = null; // Invalid arguments are reported as usage below.
  }
  if (!parsed?.config) {
    console.error(COMMAND_USAGE);
    process.exitCode = 1;
  } else {
    const { runSupervisorCommand, savedInstance } = await import('../src/supervisor/cli.js');
    let instance = null;
    try {
      instance = savedInstance(parsed.config);
    } catch {
      instance = null; // The saved configuration is the operator's own file; the message names no internals.
    }
    if (!instance) {
      console.error('The saved connector configuration could not be read.');
      process.exitCode = 1;
    } else {
      process.exitCode = await runSupervisorCommand({ command: process.argv[2], ...instance, options: {}, io: { input: process.stdin, output: process.stderr } });
    }
  }
} else if (process.argv[2] === 'answer') {
  let answer;
  try {
    answer = parseArgs({ args: process.argv.slice(3), options: { local: { type: 'boolean' }, config: { type: 'string' }, request: { type: 'string' } }, strict: true }).values;
  } catch {
    answer = null; // Invalid arguments are reported as usage below.
  }
  if (!answer?.local || !answer.config) {
    console.error(ANSWER_USAGE);
    process.exitCode = 1;
  } else {
    const { runLocalAnswer } = await import('../src/supervisor/cli.js');
    process.exitCode = await runLocalAnswer({ configFile: answer.config, requestId: answer.request, input: process.stdin, output: process.stderr });
  }
} else {
  let args;
  try {
    args = parseArgs({ options: { config: { type: 'string' }, 'enable-integration': { type: 'string', multiple: true } }, strict: true }).values;
  } catch {
    args = null; // Invalid arguments are reported as usage below.
  }
  const enableIntegrations = args?.['enable-integration'] ?? [];
  if (!args?.config || !enableIntegrations.every((name) => INTEGRATIONS.includes(name))) {
    console.error(USAGE);
    process.exitCode = 1;
  } else {
    let runtime;
    const log = (record) => console.error(JSON.stringify(record));
    try {
      runtime = await createConnectorRuntime({ file: args.config, enableIntegrations, log,
        onFatal: () => { console.error('Connector authorization or connection failed. Check the private host configuration.'); process.exitCode = 1; },
      });
      let intentional = false;
      const shutdown = () => { intentional = true; runtime.loop.stop(); };
      process.once('SIGINT', shutdown);
      process.once('SIGTERM', shutdown);
      try { await runtime.start(); } finally {
        process.removeListener('SIGINT', shutdown);
        process.removeListener('SIGTERM', shutdown);
        const { stop } = await runtime.close({ intentional });
        if (stop === 'uncertain') {
          const { SHUTDOWN_UNCERTAIN } = await import('../src/supervisor/cli.js');
          console.error(SHUTDOWN_UNCERTAIN);
          process.exitCode = 1;
        }
      }
    } catch (error) {
      if (error instanceof ConnectorConfigError) {
        console.error(error.message);
      } else {
        log({ msg: 'connector startup failed', error: error instanceof Error ? error.message : String(error) });
        console.error('Connector startup failed. Check the local configuration and Node 22 runtime.');
      }
      process.exitCode = 1;
    }
  }
}
