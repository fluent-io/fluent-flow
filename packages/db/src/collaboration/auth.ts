import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Bridge actor assertion (dashboard -> Express collaboration API).
 *
 * Wire format: `v1.<payloadBase64url>.<signatureBase64url>` where the payload
 * is UTF-8 JSON `{iss,aud,sub,sessionVersion,iat,exp}` and the signature is
 * HMAC-SHA256 over the ASCII signing input `v1.<payloadBase64url>` keyed with
 * the server-only FF_COLLAB_AUTH_SECRET. See
 * docs/plans/2026-10-19-collaborative-contracts.md ("Identity and permissions").
 *
 * These helpers are pure cryptography: principal/sessionVersion/membership are
 * re-checked against the DB by callers on every operation.
 */

export type CollabActor = { principalId: string; sessionVersion: number };

const ACTOR_VERSION = 'v1';
const ACTOR_ISSUER = 'fluent-flow-dashboard';
const ACTOR_AUDIENCE = 'fluent-flow-collab';
const ACTOR_TTL_SECONDS = 60;
const ACTOR_CLOCK_SKEW_SECONDS = 5;
const SIGNATURE_LENGTH_BYTES = 32; // HMAC-SHA256
const MAX_PAYLOAD_BYTES = 4096;
const MAX_SUB_LENGTH = 128;

/** Typed rejection with a stable internal reason for server-side logs only. */
export class CollabAssertionError extends Error {
  readonly reason: string;

  constructor(reason: string) {
    // The message never contains assertion content — it may end up in logs
    // alongside request IDs and must not carry secrets or tokens.
    super(`collab actor assertion rejected: ${reason}`);
    this.name = 'CollabAssertionError';
    this.reason = reason;
  }
}

function hmac(secret: string, payloadB64: string): Buffer {
  // The signing input `v1.<payloadBase64url>` is the wire contract — sign and
  // verify must construct it identically.
  return createHmac('sha256', secret)
    .update(`${ACTOR_VERSION}.${payloadB64}`, 'ascii')
    .digest();
}

export function signCollaborationActor(
  actor: CollabActor,
  secret: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): string {
  if (typeof secret !== 'string' || secret.length === 0) {
    // Callers translate this into 503 unavailable configuration; the detail
    // stays server-side.
    throw new CollabAssertionError('missing_secret');
  }
  if (
    typeof actor?.principalId !== 'string' ||
    actor.principalId.length === 0 ||
    actor.principalId.length > MAX_SUB_LENGTH ||
    !Number.isInteger(actor?.sessionVersion) ||
    actor.sessionVersion < 1 ||
    !Number.isInteger(nowSeconds)
  ) {
    throw new CollabAssertionError('invalid_actor');
  }
  const payload = JSON.stringify({
    iss: ACTOR_ISSUER,
    aud: ACTOR_AUDIENCE,
    sub: actor.principalId,
    sessionVersion: actor.sessionVersion,
    iat: nowSeconds,
    exp: nowSeconds + ACTOR_TTL_SECONDS,
  });
  const payloadB64 = Buffer.from(payload, 'utf8').toString('base64url');
  const signature = hmac(secret, payloadB64);
  return `${ACTOR_VERSION}.${payloadB64}.${signature.toString('base64url')}`;
}

function decodeSegment(segment: string, reason: string): Buffer {
  if (typeof segment !== 'string' || segment.length === 0 || !/^[A-Za-z0-9_-]+$/.test(segment)) {
    throw new CollabAssertionError(reason);
  }
  const decoded = Buffer.from(segment, 'base64url');
  // base64url decoding is permissive; re-encode to prove the segment was canonical.
  if (decoded.toString('base64url') !== segment) {
    throw new CollabAssertionError(reason);
  }
  return decoded;
}

export function verifyCollaborationActor(
  assertion: string,
  secret: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): CollabActor {
  if (typeof secret !== 'string' || secret.length === 0) {
    throw new CollabAssertionError('missing_secret');
  }
  if (typeof assertion !== 'string' || assertion.length === 0) {
    throw new CollabAssertionError('malformed');
  }

  const parts = assertion.split('.');
  if (parts.length !== 3) {
    throw new CollabAssertionError('malformed');
  }
  const [version, payloadB64, signatureB64] = parts;
  if (version !== ACTOR_VERSION) {
    throw new CollabAssertionError('unsupported_version');
  }

  const signature = decodeSegment(signatureB64, 'malformed');
  if (
    signature.length !== SIGNATURE_LENGTH_BYTES ||
    !timingSafeEqual(signature, hmac(secret, payloadB64))
  ) {
    throw new CollabAssertionError('bad_signature');
  }

  const payloadBytes = decodeSegment(payloadB64, 'malformed');
  if (payloadBytes.length > MAX_PAYLOAD_BYTES) {
    throw new CollabAssertionError('payload_too_large');
  }
  let payload: unknown;
  try {
    payload = JSON.parse(payloadBytes.toString('utf8'));
  } catch {
    throw new CollabAssertionError('malformed_payload');
  }
  if (typeof payload !== 'object' || payload === null) {
    throw new CollabAssertionError('malformed_payload');
  }
  const { iss, aud, sub, sessionVersion, iat, exp } = payload as Record<string, unknown>;

  if (iss !== ACTOR_ISSUER) throw new CollabAssertionError('bad_issuer');
  if (aud !== ACTOR_AUDIENCE) throw new CollabAssertionError('bad_audience');
  if (typeof sub !== 'string' || sub.length === 0 || sub.length > MAX_SUB_LENGTH) {
    throw new CollabAssertionError('bad_subject');
  }
  if (typeof sessionVersion !== 'number' || !Number.isInteger(sessionVersion) || sessionVersion < 1) {
    throw new CollabAssertionError('bad_session_version');
  }
  if (
    typeof iat !== 'number' ||
    typeof exp !== 'number' ||
    !Number.isInteger(iat) ||
    !Number.isInteger(exp) ||
    exp - iat !== ACTOR_TTL_SECONDS
  ) {
    throw new CollabAssertionError('bad_lifetime');
  }
  if (
    nowSeconds < iat - ACTOR_CLOCK_SKEW_SECONDS ||
    nowSeconds > exp + ACTOR_CLOCK_SKEW_SECONDS
  ) {
    throw new CollabAssertionError('expired_or_future');
  }

  return { principalId: sub, sessionVersion };
}
