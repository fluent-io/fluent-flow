import { createHash } from 'node:crypto';
import { constants, openSync, readSync, closeSync, fstatSync, realpathSync } from 'node:fs';
import { relative, resolve, sep, isAbsolute, dirname } from 'node:path';


const MAX_BYTES = 2 * 1024 * 1024;
const CREDENTIAL_NAME_RE = /(^|[/\\])(\.env(\..*)?|.*\.pem|.*\.key|id_(rsa|dsa|ecdsa|ed25519)(\..*)?|credentials?(\..*)?|secrets?(\..*)?|\.npmrc|\.netrc|kubeconfig|\.git-credentials)$/i;
const ACTIVE_CONTENT_TYPES = new Map([
  ['html', 'application/octet-stream'],
  ['htm', 'application/octet-stream'],
  ['svg', 'application/octet-stream'],
]);
const EXTENSION_TYPES = new Map([
  ['txt', 'text/plain'], ['md', 'text/plain'], ['log', 'text/plain'], ['json', 'application/json'],
  ['csv', 'text/csv'], ['yml', 'text/plain'], ['yaml', 'text/plain'],
  ['png', 'image/png'], ['jpg', 'image/jpeg'], ['jpeg', 'image/jpeg'], ['gif', 'image/gif'], ['webp', 'image/webp'],
  ['pdf', 'application/pdf'],
]);

export function mediaTypeFor(name) {
  const base = name.split(/[\\/]/).pop() ?? name;
  const ext = base.includes('.') ? base.split('.').pop().toLowerCase() : '';
  return ACTIVE_CONTENT_TYPES.get(ext) ?? EXTENSION_TYPES.get(ext) ?? null;
}

function anyComponentSensitive(realPath, rootReal) {
  let current = realPath;
  while (current.length > rootReal.length) {
    const base = current.split(sep).pop() ?? current;
    if (CREDENTIAL_NAME_RE.test(base)) return true;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return false;
}


/**
 * @param {object} opts
 * @param {Record<string, string>} opts.roots - mapping key -> canonical workspace root
 * @param {{maxBytes?: number}} [opts.limits]
 */
export function createArtifactReader({ roots, limits = {} }) {
  const maxBytes = limits.maxBytes ?? MAX_BYTES;
  return {
    /**
     * @param {object} p
     * @param {string} p.repositoryKey - which mapped workspace root
     * @param {string} p.reference - workspace-relative opaque path
     * @returns {{status:'available'|'unavailable', reason?:string, mediaType?:string, sizeBytes?:number, sha256?:string, contentBase64?:string, truncated?:boolean}}
     */
    read({ repositoryKey, reference }) {
      const root = roots[repositoryKey];
      if (!root) return { status: 'unavailable', reason: 'unknown_workspace' };
      if (typeof reference !== 'string' || reference === '' || isAbsolute(reference)) {
        return { status: 'unavailable', reason: 'invalid_reference' };
      }
      const candidate = resolve(root, reference);
      const rel = relative(root, candidate);
      if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
        return { status: 'unavailable', reason: 'outside_workspace' };
      }
      const candidateBase = candidate.split(sep).pop() ?? candidate;
      if (CREDENTIAL_NAME_RE.test(candidateBase)) {
        return { status: 'unavailable', reason: 'credential_file' };
      }
      const mediaType = mediaTypeFor(candidateBase);
      if (!mediaType) {
        return { status: 'unavailable', reason: 'unsupported_media_type' };
      }
      let real;
      let rootReal;
      try {
        real = realpathSync(candidate);
        rootReal = realpathSync(root);
      } catch {
        return { status: 'unavailable', reason: 'not_found' };
      }
      const realRel = relative(rootReal, real);
      if (realRel === '' || realRel.startsWith('..') || isAbsolute(realRel)) {
        return { status: 'unavailable', reason: 'symlink_escape' };
      }
      if (anyComponentSensitive(real, rootReal)) {
        return { status: 'unavailable', reason: 'credential_file' };
      }
      let fd;
      try {
        fd = openSync(real, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        const descriptorRoot = process.platform === 'linux' ? '/proc/self/fd' : process.platform === 'darwin' ? '/dev/fd' : null;
        const actual = descriptorRoot ? realpathSync(`${descriptorRoot}/${fd}`) : null;
        if (!actual) return { status: 'unavailable', reason: 'read_failed' };
        const actualRel = relative(rootReal, actual);
        if (actualRel === '' || actualRel.startsWith('..') || isAbsolute(actualRel)) {
          return { status: 'unavailable', reason: 'symlink_escape' };
        }
        if (anyComponentSensitive(actual, rootReal)) {
          return { status: 'unavailable', reason: 'credential_file' };
        }
        const st = fstatSync(fd);
        if (!st.isFile()) return { status: 'unavailable', reason: 'not_a_file' };
        if (st.size > maxBytes) return { status: 'unavailable', reason: 'too_large', sizeBytes: st.size };
        const hash = createHash('sha256');
        const chunks = [];
        let total = 0;
        const buf = Buffer.alloc(256 * 1024);
        for (;;) {
          const n = readSync(fd, buf, 0, buf.length, total);
          if (n === 0) break;
          chunks.push(Buffer.from(buf.subarray(0, n)));
          hash.update(buf.subarray(0, n));
          total += n;
          if (total > maxBytes) return { status: 'unavailable', reason: 'too_large' };
        }
        return {
          status: 'available',
          mediaType,
          sizeBytes: total,
          sha256: hash.digest('hex'),
          contentBase64: Buffer.concat(chunks).toString('base64'),
          truncated: false,
        };
      } catch (err) {
        if (err?.code === 'ELOOP') return { status: 'unavailable', reason: 'symlink_escape' };
        if (err?.code === 'EACCES') return { status: 'unavailable', reason: 'permission_denied' };
        return { status: 'unavailable', reason: 'read_failed' };
      } finally {
        if (fd !== undefined) closeSync(fd);
      }
    },
  };
}
