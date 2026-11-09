import { access, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { delimiter, join } from 'node:path';

function pathValue(environment, platform) {
  if (platform === 'win32') {
    const key = Object.keys(environment).find((name) => name.toLowerCase() === 'path');
    return key === undefined ? '' : environment[key] ?? '';
  }
  return environment.PATH ?? '';
}

function candidateNames(name, environment, platform) {
  if (platform !== 'win32') return [name];
  const key = Object.keys(environment).find((entry) => entry.toUpperCase() === 'PATHEXT');
  const extensions = (key === undefined ? '.COM;.EXE;.BAT;.CMD' : environment[key] ?? '')
    .split(';')
    .filter(Boolean);
  return [name, ...extensions.map((extension) => `${name}${extension}`)];
}

const STAT_NOT_FOUND_CODES = new Set(['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM', 'ELOOP', 'ENAMETOOLONG']);

async function isExecutableFile(path) {
  let details;
  try {
    details = await stat(path);
  } catch (error) {
    if (STAT_NOT_FOUND_CODES.has(error?.code)) return false;
    throw error;
  }
  if (!details.isFile()) return false;
  try {
    await access(path, constants.X_OK);
  } catch (error) {
    if (error?.code === 'EACCES' || error?.code === 'EPERM') return false;
    throw error;
  }
  return true;
}

async function isAvailable(name, environment, platform) {
  if (/[\\/]/u.test(name)) return isExecutableFile(name);
  for (const directory of String(pathValue(environment, platform)).split(delimiter).filter(Boolean)) {
    for (const candidate of candidateNames(name, environment, platform)) {
      if (await isExecutableFile(join(directory, candidate))) return true;
    }
  }
  return false;
}

export async function probeExecutables({ names, environment, platform = process.platform }) {
  const missing = [];
  for (const name of names) {
    if (!(await isAvailable(name, environment, platform))) missing.push(name);
  }
  if (missing.length > 0) throw new Error(`Required tools are missing: ${missing.join(', ')}`);
}
