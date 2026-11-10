#!/usr/bin/env node

import { realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { buildChildEnvironment } from '../src/environment.js';
import { loadProviderEnvironment, parseConfig } from '../src/config.js';
import { createLogger } from '../src/logger.js';
import { safeError } from '../src/safe-error.js';
import { createAgentServer } from '../src/server.js';

export function installSignalShutdown(
  server,
  processLike = process,
  log = createLogger(false),
  { platform = process.platform } = {},
) {
  let shutdownPromise = null;
  const handleSignal = () => {
    if (shutdownPromise) {
      processLike.exitCode = 1;
      return;
    }
    shutdownPromise = Promise.resolve()
      .then(() => server.shutdown())
      .catch((error) => {
        processLike.exitCode = 1;
        log.error('Agent server shutdown failed', { error: safeError(error) });
      });
  };
  processLike.on('SIGTERM', handleSignal);
  processLike.on('SIGINT', handleSignal);
  if (platform === 'win32') processLike.on('SIGBREAK', handleSignal);
  return () => shutdownPromise ?? Promise.resolve();
}

async function packageVersion() {
  const contents = await readFile(new URL('../package.json', import.meta.url), 'utf8');
  const manifest = JSON.parse(contents);
  if (typeof manifest.version !== 'string' || manifest.version.length === 0) {
    throw new Error('Agent server package version is invalid.');
  }
  return manifest.version;
}

export async function main(processLike = process) {
  const bootstrapLog = createLogger(false, 'info');
  let config;
  let providerEnvironment;
  let version;
  try {
    config = parseConfig(processLike.argv.slice(2), {
      env: processLike.env,
      cwd: processLike.cwd(),
    });
    const selectedProviderEnvironment = await loadProviderEnvironment(config);
    providerEnvironment = buildChildEnvironment({
      source: processLike.env,
      providerEnvironment: selectedProviderEnvironment,
    });
    version = await packageVersion();
  } catch (error) {
    bootstrapLog.error('Agent server configuration failed', { error: safeError(error) });
    processLike.exitCode = 1;
    return;
  }

  const log = createLogger(false, config.logLevel);

  const server = createAgentServer({
    ...config,
    packageVersion: version,
    providerEnvironment,
    log,
  });
  const waitForSignalShutdown = installSignalShutdown(server, processLike, log);

  try {
    await server.start();
    await waitForSignalShutdown();
  } catch (error) {
    log.error('Agent server startup failed', { error: safeError(error) });
    processLike.exitCode = 1;
    try {
      await server.shutdown();
    } catch (shutdownError) {
      log.error('Agent server shutdown failed', { error: safeError(shutdownError) });
    }
    await waitForSignalShutdown();
  }
}

export function isDirectRun(
  entry = process.argv[1],
  moduleUrl = import.meta.url,
  { realpath = realpathSync.native } = {},
) {
  if (!entry) return false;
  return realpath(fileURLToPath(moduleUrl)) === realpath(entry);
}

if (isDirectRun()) main();
