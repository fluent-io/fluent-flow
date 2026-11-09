import { constants } from 'node:fs';
import { lstat, link, mkdir, open as openFile, rename as renameFile, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const STATE_FILE = 'state.json';
const MAX_STATE_BYTES = 1024 * 1024;
const RENAME_ATTEMPTS = 5;
const RENAME_BACKOFF_MS = 10;
const RETRYABLE_RENAME_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function filesystemContext({
  platform = process.platform,
  open = openFile,
  rename = renameFile,
  delay = sleep,
} = {}) {
  return { windows: platform === 'win32', open, rename, delay };
}

function validateState(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Agent server state is invalid.');
  }
  const keys = Object.keys(value).sort();
  if (keys.length !== 2 || keys[0] !== 'instanceId' || keys[1] !== 'token') {
    throw new Error('Agent server state is invalid.');
  }
  if (typeof value.instanceId !== 'string' || !UUID_PATTERN.test(value.instanceId)) {
    throw new Error('Agent server state is invalid.');
  }
  if (value.token !== null && typeof value.token !== 'string') {
    throw new Error('Agent server state is invalid.');
  }
  return { instanceId: value.instanceId, token: value.token };
}

async function withClosedHandle(handle, operation) {
  let result;
  let operationError;
  try {
    result = await operation(handle);
  } catch (error) {
    operationError = error;
  }
  try {
    await handle.close();
  } catch (closeError) {
    if (operationError) {
      throw new AggregateError(
        [operationError, closeError],
        'Agent server state operation and file cleanup both failed.',
      );
    }
    throw closeError;
  }
  if (operationError) throw operationError;
  return result;
}

async function ensurePrivateDirectory(stateDir, context) {
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  if (context.windows) {
    const info = await lstat(stateDir);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Agent server state directory is unsafe.');
    return;
  }
  const handle = await context.open(
    stateDir,
    constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0),
  );
  await withClosedHandle(handle, async (directory) => {
    const info = await directory.stat();
    if (!info.isDirectory()) throw new Error('Agent server state directory is unsafe.');
    await directory.chmod(0o700);
  });
}

async function syncDirectory(stateDir, context) {
  if (context.windows) return;
  const handle = await context.open(
    stateDir,
    constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0),
  );
  await withClosedHandle(handle, async (directory) => {
    const info = await directory.stat();
    if (!info.isDirectory()) throw new Error('Agent server state directory is unsafe.');
    await directory.sync();
  });
}

async function inspectStatePath(statePath, optional) {
  try {
    const info = await lstat(statePath);
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new Error('Agent server state file is unsafe.');
    }
    return true;
  } catch (error) {
    if (optional && error.code === 'ENOENT') return false;
    throw error;
  }
}

async function readState(statePath, context) {
  await inspectStatePath(statePath, false);
  const handle = await context.open(statePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  return withClosedHandle(handle, async (stateFile) => {
    const info = await stateFile.stat();
    const privateMode = context.windows || (info.mode & 0o777) === 0o600;
    if (!info.isFile() || info.size > MAX_STATE_BYTES || !privateMode) {
      throw new Error('Agent server state file is unsafe.');
    }
    const contents = await stateFile.readFile('utf8');
    return validateState(JSON.parse(contents));
  });
}

async function renameWithRetry(from, to, context) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await context.rename(from, to);
      return;
    } catch (error) {
      if (!context.windows || !RETRYABLE_RENAME_CODES.has(error?.code) || attempt >= RENAME_ATTEMPTS) throw error;
      await context.delay(RENAME_BACKOFF_MS * 2 ** (attempt - 1));
    }
  }
}

async function writeState(stateDir, state, context, { exclusive = false } = {}) {
  const validated = validateState(state);
  const statePath = join(stateDir, STATE_FILE);
  await inspectStatePath(statePath, true);
  const temporaryPath = join(stateDir, `.state-${process.pid}-${randomUUID()}.tmp`);
  let operationError;
  let temporaryCreated = false;
  let published = false;
  try {
    const handle = await context.open(
      temporaryPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    temporaryCreated = true;
    await withClosedHandle(handle, async (temporaryFile) => {
      await temporaryFile.chmod(0o600);
      await temporaryFile.writeFile(`${JSON.stringify(validated)}\n`, 'utf8');
      await temporaryFile.sync();
    });
    if (exclusive) {
      try {
        await link(temporaryPath, statePath);
        published = true;
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
      }
    } else {
      await renameWithRetry(temporaryPath, statePath, context);
      published = true;
    }
  } catch (error) {
    operationError = error;
  }
  if (temporaryCreated) {
    try {
      await rm(temporaryPath, { force: true });
    } catch (cleanupError) {
      operationError = operationError
        ? new AggregateError(
          [operationError, cleanupError],
          'Agent server state operation and temporary-file cleanup both failed.',
        )
        : cleanupError;
    }
  }
  if (operationError) throw operationError;
  await syncDirectory(stateDir, context);
  return published;
}

export async function loadOrCreateState(stateDir, options) {
  const context = filesystemContext(options);
  await ensurePrivateDirectory(stateDir, context);
  const statePath = join(stateDir, STATE_FILE);
  if (await inspectStatePath(statePath, true)) return readState(statePath, context);
  const state = { instanceId: randomUUID(), token: null };
  if (await writeState(stateDir, state, context, { exclusive: true })) return state;
  return readState(statePath, context);
}

export async function storeRuntimeToken(stateDir, instanceId, token, options) {
  const context = filesystemContext(options);
  await ensurePrivateDirectory(stateDir, context);
  await writeState(stateDir, { instanceId, token }, context);
}
