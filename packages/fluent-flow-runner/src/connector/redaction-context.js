import fs from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const MAX_BYTES = 4 * 1024 * 1024;
const PRIVATE_FILE_ERROR = 'Connector redaction context must be a private regular file containing a JSON array of non-empty strings.';

function readSecrets(file, optional = false) {
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.size > MAX_BYTES || (process.getuid && stat.uid !== process.getuid())) throw new Error(PRIVATE_FILE_ERROR);
    const values = JSON.parse(fs.readFileSync(fd, 'utf8'));
    if (!Array.isArray(values) || !values.every((value) => typeof value === 'string' && value.length > 0)) throw new Error(PRIVATE_FILE_ERROR);
    return values;
  } catch (error) {
    if (optional && error.code === 'ENOENT') return [];
    // Parsing and filesystem exceptions may contain the private contents/path.
    throw new Error(PRIVATE_FILE_ERROR);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/** Reporting credentials live separately from the token-free intent journal.
 * Persist before native creation so an immediate crash can still redact backfill.
 * Host and daemon credentials are supplied afresh by runtime, never stored here.
 * @param {{dir: string, secretsFile?: string}} options
 */
export function createRedactionContext({ dir, secretsFile }) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  const file = join(dir, 'redaction-context.json');
  const reportingCredentials = new Set(readSecrets(file, true));
  const seeds = secretsFile ? readSecrets(secretsFile) : [];

  function rememberReportingCredential(value) {
    if (reportingCredentials.has(value)) return;
    const next = [...reportingCredentials, value];
    const bytes = Buffer.from(`${JSON.stringify(next)}\n`);
    if (typeof value !== 'string' || !value || bytes.length > MAX_BYTES) throw new Error('Connector redaction context cannot retain this credential.');
    const temporary = join(dir, `.redaction-context-${randomUUID()}.tmp`);
    let fd;
    let renamed = false;
    try {
      fd = fs.openSync(temporary, 'wx', 0o600);
      fs.fchmodSync(fd, 0o600);
      for (let written = 0; written < bytes.length;) written += fs.writeSync(fd, bytes, written, bytes.length - written);
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = undefined;
      fs.renameSync(temporary, file);
      renamed = true;
      const directory = fs.openSync(dir, 'r');
      try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
      reportingCredentials.add(value);
    } catch {
      throw new Error('Connector redaction context could not be saved privately.');
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
      if (!renamed) fs.rmSync(temporary, { force: true });
    }
  }

  return { secrets: [...reportingCredentials, ...seeds], rememberReportingCredential };
}
