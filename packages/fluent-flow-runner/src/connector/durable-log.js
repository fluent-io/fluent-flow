import nodeFs from 'node:fs';
import { join } from 'node:path';


export class DurableLogCorruptionError extends Error {
  /** @param {{ path: string, line: number, reason: 'malformed' | 'unknown_record' }} detail */
  constructor({ path, line, reason }) {
    super(`Durable log ${path} is corrupt at line ${line} (${reason})`);
    this.name = 'DurableLogCorruptionError';
    this.path = path;
    this.line = line;
    this.reason = reason;
  }
}

/**
 * @param {{ dir: string, file: string, recordTypes: Set<string>, fs?: typeof nodeFs, openFile?: (path: string, opts: { access: 'readwrite' | 'append', create: boolean }) => number | null, validate?: (entries: object[]) => void }} opts
 */
export function createDurableLog({ dir, file, recordTypes, fs = nodeFs, openFile = null, validate = () => {} }) {
  const path = join(dir, file);

  function writeFull(fd, string) {
    const bytes = Buffer.from(string, 'utf8');
    let written = 0;
    while (written < bytes.length) {
      written += fs.writeSync(fd, bytes, written, bytes.length - written);
    }
  }

  function load() {
    if (!openFile) return parse(readByPath(), (goodBytes) => fs.truncateSync(path, goodBytes));
    const fd = openFile(path, { access: 'readwrite', create: false });
    if (fd === null) return [];
    try {
      return parse(fs.readFileSync(fd, 'utf8'), (goodBytes) => fs.ftruncateSync(fd, goodBytes));
    } finally {
      fs.closeSync(fd);
    }
  }

  function readByPath() {
    try {
      return fs.readFileSync(path, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') return '';
      throw err;
    }
  }

  function parse(raw, truncate) {
    if (raw === '') return [];
    const lines = raw.split('\n');
    const completeLines = lines.slice(0, -1);
    const trailing = lines[lines.length - 1];
    const parsedEntries = [];
    let goodBytes = 0;
    for (let i = 0; i < completeLines.length; i++) {
      let parsed;
      try {
        parsed = JSON.parse(completeLines[i]);
      } catch {
        throw new DurableLogCorruptionError({ path, line: i + 1, reason: 'malformed' });
      }
      if (!parsed || typeof parsed !== 'object' || !recordTypes.has(parsed.type)) {
        throw new DurableLogCorruptionError({ path, line: i + 1, reason: 'unknown_record' });
      }
      parsedEntries.push(parsed);
      goodBytes += Buffer.byteLength(completeLines[i], 'utf8') + 1;
    }
    validate(parsedEntries);
    if (trailing !== '') {
      truncate(goodBytes);
    }
    return parsedEntries;
  }

  function fsyncDir() {
    const dirFd = fs.openSync(dir, 'r');
    try {
      fs.fsyncSync(dirFd);
    } finally {
      fs.closeSync(dirFd);
    }
  }

  const loaded = load();

  return {
    entries() {
      return loaded;
    },

    append(entry) {
      if (!entry || !recordTypes.has(entry.type)) {
        throw new Error(`Unknown durable log record type: ${entry?.type}`);
      }
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      const line = JSON.stringify(entry);
      let fd;
      try {
        if (openFile) {
          fd = openFile(path, { access: 'append', create: true });
        } else {
          fd = fs.openSync(path, 'a', 0o600);
          fs.chmodSync(path, 0o600);
        }
        writeFull(fd, line + '\n');
        fs.fsyncSync(fd);
      } finally {
        if (fd !== undefined) fs.closeSync(fd);
      }
      fsyncDir();
      loaded.push(entry);
    },
  };
}
