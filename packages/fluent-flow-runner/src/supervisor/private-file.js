import nodeFs from 'node:fs';


export class SupervisorFileUnsafe extends Error {
  /** @param {string} path @param {string} reason */
  constructor(path, reason, options) {
    super(`Supervisor file ${path} is not a private regular file (${reason})`, options);
    this.name = 'SupervisorFileUnsafe';
    this.code = 'supervisor_file_unsafe';
    this.reason = reason;
  }
}

const ACCESS = {
  read: nodeFs.constants.O_RDONLY,
  readwrite: nodeFs.constants.O_RDWR,
  append: nodeFs.constants.O_WRONLY | nodeFs.constants.O_APPEND,
};

function verify(fs, fd, path, uid) {
  const st = fs.fstatSync(fd);
  let reason = null;
  if (!st.isFile()) reason = 'not_regular';
  else if (st.uid !== uid) reason = 'foreign_owner';
  else if ((st.mode & 0o777) !== 0o600) reason = 'mode';
  if (reason) {
    fs.closeSync(fd);
    throw new SupervisorFileUnsafe(path, reason);
  }
  return fd;
}

/**
 * @param {string} path
 * @param {{ access: 'read' | 'readwrite' | 'append', create?: boolean, fs?: typeof nodeFs, uid?: number }} opts
 * @returns {number | null} a verified descriptor, or null when the file is missing and create is false
 */
export function openPrivateFile(path, { access, create = false, fs = nodeFs, uid = process.getuid() }) {
  const { O_CREAT, O_EXCL, O_NOFOLLOW, O_NONBLOCK } = fs.constants;
  const flags = ACCESS[access] | O_NOFOLLOW | O_NONBLOCK;
  if (create) {
    let fd;
    try {
      fd = fs.openSync(path, flags | O_CREAT | O_EXCL, 0o600);
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }
    if (fd !== undefined) {
      fs.fchmodSync(fd, 0o600);
      return verify(fs, fd, path, uid);
    }
  }
  let fd;
  try {
    fd = fs.openSync(path, flags);
  } catch (err) {
    if (err.code === 'ENOENT' && !create) return null;
    if (err.code === 'ELOOP') throw new SupervisorFileUnsafe(path, 'symlink', { cause: err });
    if (err.code === 'EISDIR' || err.code === 'ENXIO') throw new SupervisorFileUnsafe(path, 'not_regular', { cause: err });
    throw err;
  }
  return verify(fs, fd, path, uid);
}
