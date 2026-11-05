import { createHash } from 'node:crypto';

const FF_NAMESPACE_HEX = '5f1e2b6a3c9d4e0fa7b8c6d5e4f30122';

function uuidFromHex(hex) {
  const h = hex.padEnd(32, '0').slice(0, 32);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

const FF_NAMESPACE = Buffer.from(FF_NAMESPACE_HEX, 'hex');

/** @param {string} sessionId @returns {string} UUIDv5 */
export function sessionUuid(sessionId) {
  const bytes = createHash('sha1').update(FF_NAMESPACE).update(`ff:session:${sessionId}`).digest();
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const h = bytes.toString('hex').slice(0, 32);
  return uuidFromHex(h);
}

export function nativeWorkspaceId(runId) {
  return `wks_${createHash('sha256').update(`ff:workspace:${runId}`).digest('hex').slice(0, 16)}`;
}
