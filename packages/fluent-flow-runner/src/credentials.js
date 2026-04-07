import { homedir, hostname } from 'node:os';
import { join } from 'node:path';
import { readFileSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs';
import { randomBytes, scryptSync, createCipheriv, createDecipheriv } from 'node:crypto';

/**
 * Encrypted credentials storage for Fluent Flow runner.
 *
 * Tokens are encrypted at rest using AES-256-GCM with a key derived from
 * the machine hostname via scrypt. A random salt is generated on first use
 * and stored alongside the credentials.
 *
 * SECURITY MODEL:
 * This encryption protects against offline attacks where only the credentials
 * file is compromised (e.g., through backup systems, accidental exposure in
 * terminals, or version control). It does NOT protect against attackers with
 * the ability to execute code on the same machine, as they can derive the
 * encryption key from the hostname and the stored salt.
 *
 * For stronger protection in multi-user or high-security environments,
 * consider using OS-level key storage (macOS Keychain, Windows DPAPI,
 * Linux keyring) instead.
 */

const ALGO = 'aes-256-gcm';
const KEY_LEN = 32;
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

const EMPTY = { agents: {}, default_agent: null };

function credDir() {
  return join(homedir(), '.fluent-flow');
}

function credPath() {
  return join(credDir(), 'credentials.json');
}

/**
 * Derive an encryption key from machine identity and salt.
 * @param {Buffer} salt
 * @returns {Buffer}
 */
function deriveKey(salt) {
  return scryptSync(hostname(), salt, KEY_LEN);
}

/**
 * Encrypt a plaintext string using AES-256-GCM.
 * @param {string} plaintext
 * @param {Buffer} salt
 * @returns {{ iv: string, data: string, tag: string }}
 */
function encryptToken(plaintext, salt) {
  const key = deriveKey(salt);
  const iv = randomBytes(16);
  const cipher = createCipheriv(ALGO, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return {
    iv: iv.toString('base64'),
    data: encrypted.toString('base64'),
    tag: authTag.toString('base64'),
  };
}

/**
 * Decrypt an encrypted token object using AES-256-GCM.
 * @param {{ iv: string, data: string, tag: string }} encObj
 * @param {Buffer} salt
 * @returns {string}
 */
function decryptToken(encObj, salt) {
  const key = deriveKey(salt);
  const iv = Buffer.from(encObj.iv, 'base64');
  const tag = Buffer.from(encObj.tag, 'base64');
  const data = Buffer.from(encObj.data, 'base64');
  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  return decipher.update(data, undefined, 'utf8') + decipher.final('utf8');
}

/**
 * Load raw credentials from ~/.fluent-flow/credentials.json.
 * Returns parsed object (tokens remain encrypted) or empty default if file missing/invalid.
 * @returns {{ agents: Record<string, { token: object, server: string }>, default_agent: string|null, _encryption?: { salt: string } }}
 */
export function loadCredentials() {
  try {
    const raw = readFileSync(credPath(), 'utf-8');
    const data = JSON.parse(raw);
    // Normalize shape — ensure agents is a plain object
    if (!data.agents || typeof data.agents !== 'object' || Array.isArray(data.agents)) {
      data.agents = {};
    }
    return data;
  } catch (err) {
    if (err.code === 'ENOENT' || err instanceof SyntaxError) {
      return { ...EMPTY, agents: {} };
    }
    throw err;
  }
}

/**
 * Save raw credentials to ~/.fluent-flow/credentials.json.
 * Creates directory with restricted permissions (0700) if needed.
 * Writes file with owner-only permissions (0600).
 * @param {object} data
 */
export function saveCredentials(data) {
  mkdirSync(credDir(), { recursive: true, mode: DIR_MODE });
  writeFileSync(credPath(), JSON.stringify(data, null, 2), { encoding: 'utf-8', mode: FILE_MODE });
  // Enforce owner-only permissions even if file already existed with looser mode
  try { chmodSync(credPath(), FILE_MODE); } catch { /* best effort */ }
}

/**
 * Get decrypted credentials for a specific agent.
 * @param {string} agentId
 * @returns {{ token: string, server: string }|null}
 */
export function getAgentCredentials(agentId) {
  const data = loadCredentials();
  const entry = data.agents[agentId];
  if (!entry) return null;

  const saltBase64 = data._encryption?.salt;
  if (!saltBase64 || !entry.token?.data) {
    return null;
  }

  try {
    const salt = Buffer.from(saltBase64, 'base64');
    return {
      token: decryptToken(entry.token, salt),
      server: entry.server,
    };
  } catch {
    return null;
  }
}

/**
 * Save encrypted credentials for a specific agent.
 * Sets as default_agent if no default exists.
 * @param {string} agentId
 * @param {{ token: string, server: string }} creds
 */
export function setAgentCredentials(agentId, creds) {
  const data = loadCredentials();
  if (!data._encryption) {
    data._encryption = { salt: randomBytes(16).toString('base64') };
  }
  const salt = Buffer.from(data._encryption.salt, 'base64');
  data.agents[agentId] = {
    token: encryptToken(creds.token, salt),
    server: creds.server,
  };
  if (!data.default_agent) {
    data.default_agent = agentId;
  }
  saveCredentials(data);
}
