#!/usr/bin/env node
import { createConnectorRuntime } from '../src/connector/runtime.js';

const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== '--config') {
  console.error('Usage: fluent-flow-connector --config <private-local-config.json>');
  process.exitCode = 1;
} else {
  let runtime;
  try {
    runtime = await createConnectorRuntime({ file: args[1],
      log: (record) => console.error(JSON.stringify(record)),
      onFatal: () => { console.error('Connector authorization or connection failed. Check the private host configuration.'); process.exitCode = 1; },
    });
    const shutdown = () => runtime.loop.stop();
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
    try { await runtime.start(); } finally {
      process.removeListener('SIGINT', shutdown);
      process.removeListener('SIGTERM', shutdown);
      await runtime.close();
    }
  } catch {
    console.error('Connector startup failed. Check the local configuration, Node 22 runtime, and Paseo daemon.');
    process.exitCode = 1;
  }
}
