import { createHash } from 'node:crypto';
import { openSync, readSync, closeSync, fstatSync, realpathSync, statSync } from 'node:fs';
import { relative, resolve, sep, isAbsolute, dirname } from 'node:path';

/**
 * Safe artifact reads for `artifact_read` commands.
 *
 * Contract: references are workspace-relative opaque paths chosen by the
 * control plane — never absolute paths, never client text. The workspace root
 * comes from the JOURNALED run binding (executor), never from payload
 * selection.
 *
 * Defense layers (regression-tested against a real temp filesystem):
 * 1. lexical containment: relative-only, resolved inside the root;
 * 2. symlink safety: the REAL resolved path's basename AND every component
 *    below the root are credential-checked — `innocent.md` aliasing `.env`
 *    (in-root or escaped) is refused;
 * 3. credential/config-named files refused outright;
 * 4. active content (html/svg) served as attachment-only media types;
 * 5. bounded reads with a digest over exactly the returned bytes; open fd is
 *    fstat-verified as a regular file.
 */

const MAX_BYTES = 2 * 1024 * 1024;
const CREDENTIAL_NAME_RE = /(^|[/\\)])(\.env(\..*)?|.*\.pem|.*\.key|id_(rsa|dsa|ecdsa|ed25519)(\..*)?|credentials?(\..*)?|secrets?(\..*)?|\.npmrc|\.netrc|kubeconfig|\.git-credentials)$/i;
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
      // Credential check runs BEFORE media typing so secrets never even get
      // a media-type decision (`.env` has no extension and would otherwise
      // fall through as unsupported rather than explicitly refused).
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
        fd = openSync(real, 'r');
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
        if (err?.code === 'EACCES') return { status: 'unavailable', reason: 'permission_denied' };
        return { status: 'unavailable', reason: 'read_failed' };
      } finally {
        if (fd !== undefined) closeSync(fd);
      }
    },
  };
}
