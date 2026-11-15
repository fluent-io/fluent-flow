#!/usr/bin/env node

import { createReadStream } from 'node:fs';
import { lstat, open, rm } from 'node:fs/promises';
import path from 'node:path';

const args = process.argv.slice(2);
const command = args[0];

function argValue(name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function hasFlag(name) {
  return args.includes(name);
}

function usage() {
  console.error('Usage: execution-archive.mjs capture --workspace-id <uuid> --run-id <uuid>');
  console.error('       execution-archive.mjs verify --workspace-id <uuid> --archive-id <uuid> [--compare-source]');
  console.error('       execution-archive.mjs artifacts --workspace-id <uuid> --archive-id <uuid>');
  console.error('       execution-archive.mjs export --workspace-id <uuid> --archive-id <uuid> --output <file>');
  console.error('       execution-archive.mjs import --workspace-id <uuid> --input <file>');
  process.exit(1);
}

if (!['capture', 'verify', 'artifacts', 'export', 'import'].includes(command)) usage();
if (!process.env.DATABASE_URL) {
  console.error('Execution archive operations require DATABASE_URL.');
  process.exit(1);
}

const workspaceId = argValue('--workspace-id');
if (!workspaceId) usage();

const archives = await import('../dist/collaboration/execution-archives.js');
const { CollabServiceError } = await import('../dist/collaboration/errors.js');
const { closePool } = await import('../dist/pool.js');
const { ZodError } = await import('zod');

async function* readDumpEntries(inputPath) {
  const input = createReadStream(inputPath, { encoding: 'utf8' });
  let buffer = '';
  for await (const chunk of input) {
    buffer += chunk;
    let newline = buffer.indexOf('\n');
    while (newline >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (line.trim().length > 0) yield JSON.parse(line);
      newline = buffer.indexOf('\n');
    }
  }
  if (buffer.trim().length > 0) yield JSON.parse(buffer);
}

function describeFailure(error) {
  if (error instanceof ZodError) return 'Execution archive arguments are invalid.';
  if (error instanceof SyntaxError) return 'Execution archive dump is malformed.';
  if (error instanceof CollabServiceError) return `Execution archive operation failed: ${error.message}`;
  if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return 'Execution archive file was not found.';
  return 'Execution archive operation failed.';
}

function writeResult(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

async function writeAll(handle, line) {
  const buffer = Buffer.from(line, 'utf8');
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesWritten } = await handle.write(buffer, offset, buffer.length - offset);
    if (bytesWritten <= 0) throw new Error('Execution archive export could not write output.');
    offset += bytesWritten;
  }
  return buffer.length;
}

async function exportArchive(archiveId, output) {
  const directory = await lstat(path.dirname(output));
  if ((directory.mode & 0o077) !== 0) throw new Error('Execution archive output directory is not private.');
  let handle;
  try {
    handle = await open(output, 'wx', 0o600);
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST') {
      throw new Error('Execution archive output already exists.');
    }
    throw error;
  }
  const created = await handle.stat();
  let bytes = 0;
  try {
    await archives.writeExecutionArchiveDump({ workspaceId, archiveId }, async entry => {
      bytes += await writeAll(handle, `${JSON.stringify(entry)}\n`);
    });
  } catch (error) {
    await handle.close();
    const current = await lstat(output);
    if (current.dev === created.dev && current.ino === created.ino && current.isFile() && !current.isSymbolicLink()) {
      await rm(output);
    }
    throw error;
  }
  await handle.close();
  writeResult({ archiveId, bytes });
}

async function importArchive(inputPath) {
  const manifest = await archives.restoreExecutionArchiveDump({ workspaceId }, readDumpEntries(inputPath));
  const counts = manifest.recordCounts;
  writeResult({
    archiveId: manifest.id,
    sealedAt: manifest.sealedAt,
    recordCount: counts.command + counts.observation + counts.run + counts.session,
  });
}

try {
  if (command === 'capture') {
    const runId = argValue('--run-id');
    if (!runId) usage();
    const manifest = await archives.captureLegacyRunArchive({ workspaceId, runId });
    writeResult({ archiveId: manifest.id, sourceRunId: manifest.sourceRunId, manifestSha256: manifest.manifestSha256 });
  } else if (command === 'verify') {
    const archiveId = argValue('--archive-id');
    if (!archiveId) usage();
    const verification = await archives.verifyExecutionArchive({ workspaceId, archiveId, compareSource: hasFlag('--compare-source') });
    writeResult(verification);
  } else if (command === 'artifacts') {
    const archiveId = argValue('--archive-id');
    if (!archiveId) usage();
    const inventory = await archives.getExecutionArchiveArtifactInventory({ workspaceId, archiveId });
    writeResult({ archiveId, ...inventory });
    if (inventory.blockers.length > 0) process.exitCode = 2;
  } else if (command === 'export') {
    const archiveId = argValue('--archive-id');
    const output = argValue('--output');
    if (!archiveId || !output) usage();
    await exportArchive(archiveId, output);
  } else {
    const inputPath = argValue('--input');
    if (!inputPath) usage();
    await importArchive(inputPath);
  }
} catch (error) {
  console.error(describeFailure(error));
  process.exitCode = 1;
} finally {
  await closePool();
}
