import { readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute } from 'node:path';
import { assertSafeServerUrl } from './url-guard.js';
import { NATIVE_PINS } from '../native/pins.js';


const REPO_KEY_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

function expandHome(p) {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return joinPath(homedir(), p.slice(2));
  return p;
}

function joinPath(a, b) {
  return a.endsWith('/') ? a + b : `${a}/${b}`;
}

const CONFIG_ERROR_MESSAGES = Object.freeze({
  paseo_opt_in_required: 'Enable the saved integration explicitly or configure an available execution profile.',
  no_complete_profile: 'Configure a complete execution profile before starting the runner.',
  paseo_not_installed: 'The Paseo integration is not installed on this host.',
  duplicate_profile_id: 'Execution profile ids must be unique across local profiles and saved integrations. Fix the local configuration.',
});

export class ConnectorConfigError extends Error {
  /**
   * @param {keyof typeof CONFIG_ERROR_MESSAGES} code
   * @param {{ cause?: unknown }} [options]
   */
  constructor(code, options) {
    super(CONFIG_ERROR_MESSAGES[code], options);
    this.name = 'ConnectorConfigError';
    this.code = code;
  }
}

const PROFILE_ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

function validateLocalProfile(entry) {
  const problems = [];
  const id = typeof entry.id === 'string' ? entry.id : '';
  if (!PROFILE_ID_RE.test(id)) problems.push('invalid_id');
  const name = typeof entry.name === 'string' && entry.name !== '' ? entry.name : '';
  if (!name) problems.push('missing_name');
  const backend = entry.backend === 'claude-code' || entry.backend === 'codex' ? entry.backend : null;
  if (!backend) problems.push('invalid_backend');

  let executable = typeof entry.executable === 'string' ? expandHome(entry.executable) : '';
  if (!isAbsolute(executable)) {
    problems.push('executable_not_absolute');
  } else {
    try {
      executable = realpathSync(executable);
    } catch {
      problems.push('executable_not_found');
      executable = null;
    }
  }

  let contextDir = typeof entry.contextDir === 'string' ? expandHome(entry.contextDir) : '';
  if (!isAbsolute(contextDir)) {
    problems.push('context_dir_not_absolute');
    contextDir = null;
  } else {
    try {
      const stat = statSync(contextDir);
      if (!stat.isDirectory()) {
        problems.push('context_dir_not_found');
        contextDir = null;
      } else {
        const uid = process.getuid ? process.getuid() : null;
        if (uid !== null && stat.uid !== uid) problems.push('context_dir_not_owned');
        if (stat.mode & 0o077) problems.push('context_dir_not_private');
        contextDir = realpathSync(contextDir);
      }
    } catch {
      problems.push('context_dir_not_found');
      contextDir = null;
    }
  }

  const model = typeof entry.model === 'string' && entry.model !== '' ? entry.model : null;
  if (!model) problems.push('missing_model');

  let policy = null;
  const rawPolicy = entry.policy ?? {};
  if (backend === 'claude-code') {
    const permissionMode = rawPolicy.permissionMode;
    if (
      typeof permissionMode === 'string' &&
      NATIVE_PINS['claude-code'].permissionModes.includes(permissionMode)
    ) {
      policy = { permissionMode };
    } else {
      problems.push('missing_policy_field');
    }
  } else if (backend === 'codex') {
    const approvalPolicy = rawPolicy.approvalPolicy;
    const sandbox = rawPolicy.sandbox;
    const networkAccess = rawPolicy.networkAccess;
    const approvalOk =
      typeof approvalPolicy === 'string' && NATIVE_PINS.codex.approvalPolicies.includes(approvalPolicy);
    const sandboxOk =
      typeof sandbox === 'string' && NATIVE_PINS.codex.sandboxModes.includes(sandbox);
    const networkOk = typeof networkAccess === 'boolean';
    if (approvalOk && sandboxOk && networkOk) {
      policy = { approvalPolicy, sandbox, networkAccess };
    } else {
      problems.push('missing_policy_field');
    }
  } else if (Object.keys(rawPolicy).length > 0) {
    problems.push('missing_policy_field');
  }

  const summaryProfileId =
    entry.summaryProfileId !== undefined && entry.summaryProfileId !== null ? entry.summaryProfileId : undefined;

  const complete = problems.length === 0 && executable !== null && contextDir !== null;
  return {
    id,
    name,
    backend: backend ?? 'unknown',
    executable,
    contextDir,
    model,
    policy,
    summaryProfileId,
    complete,
    problems,
  };
}

function parseCapacity(raw) {
  function capacityFor(backend) {
    const value = raw?.[backend];
    if (value === undefined) return 1;
    if (!Number.isInteger(value) || value < 1) {
      throw new Error(`Local profiles capacity for ${backend} must be an integer of at least 1`);
    }
    return value;
  }
  return { 'claude-code': capacityFor('claude-code'), codex: capacityFor('codex') };
}

/**
 * @param {...string[]} sources - id lists
 */
export function assertUniqueProfileIds(...sources) {
  const seen = new Set();
  for (const ids of sources) {
    for (const id of ids) {
      if (seen.has(id)) throw new ConnectorConfigError('duplicate_profile_id');
      seen.add(id);
    }
  }
}

function parseLocalProfiles(parsed) {
  const rawProfiles = Array.isArray(parsed.profiles) ? parsed.profiles : [];
  const rawIds = rawProfiles.map((entry) => entry?.id).filter((id) => typeof id === 'string' && id !== '');
  if (new Set(rawIds).size !== rawIds.length) throw new ConnectorConfigError('duplicate_profile_id');
  return {
    profiles: rawProfiles.map((entry) => validateLocalProfile(entry && typeof entry === 'object' ? entry : {})),
    capacity: parseCapacity(parsed.capacity),
  };
}

function readJson(file, label) {
  let raw;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (err) {
    throw new Error(`${label} is unreadable: ${err.message}`, { cause: err });
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`${label} is not valid JSON: ${err.message}`, { cause: err });
  }
}

export function loadLocalProfiles({ file }) {
  return parseLocalProfiles(readJson(file, 'Local profiles file'));
}

function parseProfileSections(parsed, enableIntegrations) {
  const legacy = Array.isArray(parsed.profiles) && parsed.profiles.some((p) => typeof p === 'string');
  let savedProfileIds;
  let paseoSection;
  let local;
  if (legacy) {
    if (!parsed.profiles.every((p) => typeof p === 'string' && p)) {
      throw new Error('Connector config profiles must be a non-empty allowlist of profile ids');
    }
    savedProfileIds = [...parsed.profiles];
    paseoSection = parsed.paseo ?? {};
    local = { profiles: [], capacity: parseCapacity(parsed.capacity) };
  } else {
    if (parsed.profiles !== undefined && !Array.isArray(parsed.profiles)) {
      throw new Error('Connector config profiles must be an array of execution profiles');
    }
    paseoSection = parsed.integrations?.paseo ?? {};
    const ids = paseoSection.profiles ?? [];
    if (!Array.isArray(ids) || !ids.every((p) => typeof p === 'string' && p)) {
      throw new Error('Connector config integrations.paseo.profiles must be a list of profile ids');
    }
    savedProfileIds = [...ids];
    local = parseLocalProfiles(parsed);
  }
  assertUniqueProfileIds(local.profiles.map((p) => p.id).filter(Boolean), savedProfileIds);
  const enabled = enableIntegrations.includes('paseo');
  const hasComplete = local.profiles.some((p) => p.complete);
  if (!hasComplete && !(enabled && savedProfileIds.length > 0)) {
    throw new ConnectorConfigError(savedProfileIds.length > 0 && !enabled ? 'paseo_opt_in_required' : 'no_complete_profile');
  }
  const paseo = {
    enabled,
    savedProfileIds,
    home: paseoSection.home ? expandHome(paseoSection.home) : null,
    cliPath: paseoSection.cliPath ? expandHome(paseoSection.cliPath) : null,
  };
  return { ...local, paseo };
}

/**
 * @returns {string[]}
 */
export function servedPaseoProfileIds(config) {
  if (config.integrations) return config.integrations.paseo.enabled ? config.integrations.paseo.savedProfileIds : [];
  return config.profiles;
}

function parseRepositories(parsed) {
  /** @type {Record<string, string>} */
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
  return repositories;
}

export function loadRepositories({ file }) {
  return parseRepositories(readJson(file, 'Local profiles file'));
}

export function loadConnectorConfig({ file, enableIntegrations = [] }) {
  const parsed = readJson(file, 'Connector config');
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

  const repositories = parseRepositories(parsed);
  const sections = parseProfileSections(parsed, enableIntegrations);
  const redactionSecretsFile = parsed.redactionSecretsFile === undefined ? undefined : typeof parsed.redactionSecretsFile === 'string' ? expandHome(parsed.redactionSecretsFile) : '';
  if (redactionSecretsFile !== undefined && !isAbsolute(redactionSecretsFile)) throw new Error('Connector config redactionSecretsFile must be an absolute local path');
  return {
    serverUrl,
    instanceId: parsed.instanceId,
    token,
    tokenFile,
    repositories,
    profiles: sections.profiles,
    capacity: sections.capacity,
    integrations: { paseo: sections.paseo },
    redactionSecretsFile,
    paseo: { home: sections.paseo.home, cliPath: sections.paseo.cliPath },
    file,
  };
}
