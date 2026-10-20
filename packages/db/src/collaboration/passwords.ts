import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { z } from 'zod';
import { getPool } from '../pool.js';
import { CollabServiceError } from './errors.js';
import { enforceRateLimitBucket, rateLimitBucket } from './rate-limit.js';
import type { CollabPrincipal } from './principals.js';
import { rowToPrincipal } from './principals.js';

const scrypt = promisify(scryptCallback) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number },
) => Promise<Buffer>;

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LENGTH_BYTES = 64;
// Non-secret placeholders give ineligible and corrupt credentials the same
// fixed KDF work; they are never accepted as a stored password encoding.
const DUMMY_SALT = Buffer.alloc(16);
const DUMMY_HASH = Buffer.alloc(KEY_LENGTH_BYTES);
export const MIN_PASSWORD_LENGTH = 8;
export const MAX_PASSWORD_LENGTH = 1024;

const authenticateSchema = z.object({
  email: z.string().min(3).max(320),
  password: z.string().min(1).max(MAX_PASSWORD_LENGTH),
  rateLimitKey: z.string().min(8).max(256),
});

export async function hashPassword(password: string): Promise<string> {
  if (
    typeof password !== 'string' ||
    password.length < MIN_PASSWORD_LENGTH ||
    password.length > MAX_PASSWORD_LENGTH
  ) {
    throw new CollabServiceError(
      422,
      'invalid_password',
      `Password must be ${MIN_PASSWORD_LENGTH}-${MAX_PASSWORD_LENGTH} characters.`,
    );
  }
  const salt = randomBytes(16);
  const derived = await scrypt(password.normalize('NFKC'), salt, KEY_LENGTH_BYTES, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
  });
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('base64')}$${derived.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  if (typeof password !== 'string' || password.length > MAX_PASSWORD_LENGTH) return false;
  const parts = typeof stored === 'string' && stored.length <= 256 ? stored.split('$') : [];
  const [, nStr, rStr, pStr, saltB64, hashB64] = parts;
  const salt = Buffer.from(saltB64 ?? '', 'base64');
  const expected = Buffer.from(hashB64 ?? '', 'base64');
  const validEncoding = parts.length === 6 && parts[0] === 'scrypt' &&
    nStr === String(SCRYPT_N) && rStr === String(SCRYPT_R) && pStr === String(SCRYPT_P) &&
    salt.length === 16 && expected.length === KEY_LENGTH_BYTES &&
    salt.toString('base64') === saltB64 && expected.toString('base64') === hashB64;
  const derived = await scrypt(password.normalize('NFKC'), validEncoding ? salt : DUMMY_SALT, KEY_LENGTH_BYTES, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
  });
  const matches = timingSafeEqual(derived, validEncoding ? expected : DUMMY_HASH);
  return validEncoding && matches;
}

/**
 * Password login for invited principals. Invalid credentials return null
 * (uniform for unknown email / wrong password / disabled principal);
 * throttling throws the typed 429. GitHub-mirrored principals never have
 * password credentials.
 */
export async function authenticateCollabPassword(input: {
  email: string;
  password: string;
  rateLimitKey: string;
}): Promise<CollabPrincipal | null> {
  const { email, password, rateLimitKey } = authenticateSchema.parse(input);
  await enforceRateLimitBucket(rateLimitBucket('login', rateLimitKey, email.toLowerCase()));

  const { rows } = await getPool().query(
    `SELECT p.id, p.display_name, p.email, p.legacy_user_id, p.disabled_at, p.session_version,
            c.password_hash
     FROM collab_principals p
     JOIN collab_password_credentials c ON c.principal_id = p.id
     WHERE lower(p.email) = lower($1)`,
    [email],
  );
  const row = rows[0];
  // Do not reveal account existence or disabled status by skipping scrypt.
  const verified = await verifyPassword(password, row?.disabled_at === null ? row.password_hash : '');
  if (!row || row.disabled_at !== null || !verified) return null;
  return rowToPrincipal(row);
}
