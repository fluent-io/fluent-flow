import { readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute } from 'node:path';
import { assertSafeServerUrl } from './url-guard.js';

/**
 * Local connector configuration (file + host token).
 *
 * The config file maps allowlisted `repositoryKey -> canonical checkout path`.
 * Only the connector resolves absolute paths; server and clients never send
 * or receive local filesystem locations. The profiles allowlist is an explicit
 * allow/deny decision by the host owner: an empty allowlist offers nothing.
 *
 * Shape:
 * {
 *   "serverUrl": "http://127.0.0.1:4000",
 *   "tokenFile": "~/.fluent-flow/connector-token",
 *   "instanceId": "pc-studio",
 *   "repositories": { "fluent-flow": "/home/me/work/fluent-flow" },
 *   "profiles": ["agent_profile_..."],
 *   "paseo": { "home": "~/.paseo", "cliPath": null }   // optional overrides
 * }
 */

const REPO_KEY_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

function expandHome(p) {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return joinPath(homedir(), p.slice(2));
  return p;
}

function joinPath(a, b) {
  return a.endsWith('/') ? a + b : `${a}/${b}`;
}

export function loadConnectorConfig({ file }) {
  let raw;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (err) {
    throw new Error(`Connector config is unreadable: ${err.message}`, { cause: err });
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Connector config is not valid JSON: ${err.message}`, { cause: err });
  }
  const serverUrl = assertSafeServerUrl(
    typeof parsed.serverUrl === 'string' ? parsed.serverUrl.replace(/\/+$/, '') : '',
  );
  if (typeof parsed.instanceId !== 'string' || !/^[a-zA-Z0-9._-]{1,64}$/.test(parsed.instanceId)) {
    throw new Error('Connector config instanceId must be 1-64 chars of [a-zA-Z0-9._-]');
  }
  const tokenFile = expandHome(typeof parsed.tokenFile === 'string' ? parsed.tokenFile : '');
  if (!tokenFile) throw new Error('Connector config tokenFile is required');
  let token;
  try {
    token = readFileSync(tokenFile, 'utf8').trim();
  } catch {
    throw new Error(`Connector host token file does not exist or is unreadable: ${tokenFile}`);
  }
  if (!token) throw new Error('Connector host token file is empty');

  const repositories = {};
  for (const [key, value] of Object.entries(parsed.repositories ?? {})) {
    if (!REPO_KEY_RE.test(key)) {
      throw new Error(`Connector config repository key is invalid: ${JSON.stringify(key)}`);
    }
    const expanded = expandHome(value);
    if (!isAbsolute(expanded)) {
      throw new Error(`Connector config repository ${key} must be an absolute path`);
    }
    let canonical;
    try {
      canonical = realpathSync(expanded);
    } catch {
      throw new Error(`Connector config repository ${key} path does not exist: ${expanded}`);
    }
    repositories[key] = canonical;
  }

  const profiles = parsed.profiles;
  if (!Array.isArray(profiles) || profiles.length === 0 || !profiles.every((p) => typeof p === 'string' && p)) {
    throw new Error('Connector config profiles must be a non-empty allowlist of profile ids');
  }

  const paseo = parsed.paseo ?? {};
  const redactionSecretsFile = parsed.redactionSecretsFile === undefined ? undefined : typeof parsed.redactionSecretsFile === 'string' ? expandHome(parsed.redactionSecretsFile) : '';
  if (redactionSecretsFile !== undefined && !isAbsolute(redactionSecretsFile)) throw new Error('Connector config redactionSecretsFile must be an absolute local path');
  return {
    serverUrl,
    instanceId: parsed.instanceId,
    token,
    tokenFile,
    repositories,
    profiles,
    redactionSecretsFile,
    paseo: {
      home: paseo.home ? expandHome(paseo.home) : null,
      cliPath: paseo.cliPath ? expandHome(paseo.cliPath) : null,
    },
    file,
  };
}
