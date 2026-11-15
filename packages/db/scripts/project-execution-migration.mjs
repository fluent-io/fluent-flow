#!/usr/bin/env node

import { closeSync, constants as fsConstants, fstatSync, openSync, readSync } from 'node:fs';

const args = process.argv.slice(2);

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}

function writeResult(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function readPrivateInput(filePath) {
  if (typeof process.getuid !== 'function' || !Number.isInteger(fsConstants.O_NOFOLLOW) || !Number.isInteger(fsConstants.O_NONBLOCK)) return null;
  let descriptor;
  try {
    descriptor = openSync(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
  } catch {
    return null;
  }
  try {
    const stats = fstatSync(descriptor);
    if (!stats.isFile() || (stats.mode & 0o077) !== 0) return null;
    if (stats.uid !== process.getuid()) return null;
    const buffer = Buffer.allocUnsafe(stats.size > 0 ? stats.size : 1);
    let position = 0;
    while (position < stats.size) {
      const read = readSync(descriptor, buffer, position, stats.size - position, position);
      if (read <= 0) return null;
      position += read;
    }
    const parsed = JSON.parse(buffer.subarray(0, stats.size).toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed;
  } catch {
    return null;
  } finally {
    closeSync(descriptor);
  }
}

async function main(services) {
  const [name, ...rest] = args;
  const flags = {};
  for (let index = 0; index < rest.length; index += 2) {
    const flag = rest[index];
    const value = rest[index + 1];
    const key = typeof flag === 'string' ? flag.slice(2) : '';
    if (!flag?.startsWith('--') || key === '' || value === undefined || key in flags) {
      fail('Invalid arguments.');
      return;
    }
    flags[key] = value;
  }
  if (name === 'inspect') {
    const workspaceId = flags['workspace-id'];
    const projectId = flags['project-id'];
    const principalId = flags['principal-id'];
    const sessionVersion = Number(flags['session-version']);
    if (
      Object.keys(flags).length !== 4 ||
      !workspaceId ||
      !projectId ||
      !principalId ||
      !Number.isInteger(sessionVersion) ||
      sessionVersion < 1
    ) {
      fail('Invalid arguments.');
      return;
    }
    writeResult(
      await services.inspect({
        actor: { principalId, sessionVersion },
        workspaceId,
        projectId,
      }),
    );
    return;
  }
  if (name === 'preview' || name === 'apply') {
    if (!flags.input || Object.keys(flags).length !== 1) {
      fail('Invalid arguments.');
      return;
    }
    const input = readPrivateInput(flags.input);
    if (!input || 'apply' in input) {
      fail('Invalid input file.');
      return;
    }
    writeResult(await services.migrate({ ...input, apply: name === 'apply' }));
    return;
  }
  fail('Invalid arguments.');
}

async function run() {
  const { inspectLegacyProjectExecutionDefaults, migrateLegacyProjectExecutionDefaults } = await import(
    '../dist/collaboration/project-execution-migration.js'
  );
  const { closePool } = await import('../dist/pool.js');
  try {
    await main({ inspect: inspectLegacyProjectExecutionDefaults, migrate: migrateLegacyProjectExecutionDefaults });
  } catch {
    fail('Operation failed.');
  } finally {
    try {
      await closePool();
    } catch {
      fail('Operation failed.');
    }
  }
}

try {
  await run();
} catch {
  fail('Operation failed.');
}
