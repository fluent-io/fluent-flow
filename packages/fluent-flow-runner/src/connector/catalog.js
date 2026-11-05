import { ConnectorConfigError, servedPaseoProfileIds } from './config.js';
import { canonicalDigest } from './executor.js';
import { NATIVE_PINS } from '../native/pins.js';


const NATIVE_CAPABILITIES = Object.freeze(['timeline', 'permissions', 'questions', 'local_answers', 'steer', 'cancel', 'usage', 'summary', 'artifacts', 'wrapup', 'reporting']);
export const PUBLISHED_CAPABILITIES = Object.freeze({
  'claude-code': NATIVE_CAPABILITIES,
  codex: Object.freeze([...NATIVE_CAPABILITIES, 'secret_questions']),
  paseo: Object.freeze(['timeline', 'permissions', 'cancel', 'artifacts', 'wrapup']),
});

const AUTH_EXPECTATION = Object.freeze({ 'claude-code': 'claude-subscription', codex: 'chatgpt-subscription', paseo: 'paseo' });
export const PASEO_HARNESS_VERSION = '0.12.0';
const STANDALONE = new Set(['claude-code', 'codex']);
const ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export function harnessVersionFor(backend) {
  if (backend === 'paseo') return PASEO_HARNESS_VERSION;
  return NATIVE_PINS[backend]?.versions[0] ?? null;
}

export function profileRevision(profile, harnessVersion) {
  return canonicalDigest({
    backend: profile.backend,
    harnessVersion,
    model: profile.model ?? null,
    policy: profile.policy ?? null,
    summaryProfileId: profile.summaryProfileId ?? null,
  }).slice(0, 16);
}

export function paseoSnapshot(profile) {
  return {
    id: profile.id,
    name: profile.name,
    provider: profile.provider,
    model: profile.model ?? null,
    modeId: profile.modeId ?? null,
    thinkingOptionId: profile.thinkingOptionId ?? null,
    features: profile.featureValues ?? {},
  };
}

export function paseoExecutionProfile(profile) {
  return {
    id: profile.id,
    name: profile.name ?? null,
    backend: 'paseo',
    model: profile.model ?? null,
    policy: {
      provider: profile.provider ?? null,
      modeId: profile.modeId ?? null,
      thinkingOptionId: profile.thinkingOptionId ?? null,
      featureValues: profile.featureValues ?? {},
    },
    summaryProfileId: null,
  };
}

function publicPolicy(backend, policy) {
  if (!policy) return null;
  if (backend === 'claude-code') return { permissionMode: policy.permissionMode };
  if (backend === 'codex') return { approvalPolicy: policy.approvalPolicy, sandbox: policy.sandbox, networkAccess: policy.networkAccess };
  const out = {};
  if (typeof policy.modeId === 'string' && policy.modeId) out.modeId = policy.modeId;
  if (typeof policy.thinkingOptionId === 'string' && policy.thinkingOptionId) out.thinkingOptionId = policy.thinkingOptionId;
  return Object.keys(out).length ? out : null;
}

function entryFor(profile, readinessState, limits) {
  const version = harnessVersionFor(profile.backend);
  return {
    id: profile.id,
    name: profile.name || null,
    backend: profile.backend,
    model: profile.model ?? null,
    revision: profileRevision(profile, version),
    capabilities: [...PUBLISHED_CAPABILITIES[profile.backend]],
    readiness: { state: readinessState },
    harness: { name: profile.backend, version },
    policy: publicPolicy(profile.backend, profile.policy),
    authExpectation: AUTH_EXPECTATION[profile.backend],
    limits,
  };
}

export async function readPaseoProfiles({ config, paseo }) {
  const ids = servedPaseoProfileIds(config);
  if (ids.length === 0) return [];
  const { config: daemonConfig } = await paseo.config.get();
  const all = daemonConfig.agentProfiles ?? [];
  return ids.map((id) => {
    const matches = all.filter((p) => p?.id === id);
    if (matches.length > 1) throw new ConnectorConfigError('duplicate_profile_id');
    if (!matches.length) {
      throw new Error(`Allowlisted Paseo profile ${id} does not exist in the local daemon config; fix the connector config profiles allowlist`);
    }
    return matches[0];
  });
}

/**
 * @param {object} opts
 * @param {{repositories: Record<string,string>, profiles: any[], integrations?: object, capacity?: Record<string, number>}} opts.config
 * @param {object | null} opts.paseo - connected PaseoApi, or null when the integration is disabled
 * @param {{ request: (method: string, params?: object) => Promise<any> } | null} [opts.supervisor]
 */
export async function buildCatalog({ config, paseo, supervisor = null }) {
  const repositories = Object.keys(config.repositories).map((key) => ({ key }));
  if (!config.integrations) {
    const profiles = (await readPaseoProfiles({ config, paseo })).map(paseoSnapshot);
    return { repositories, profiles };
  }

  const standalone = (config.profiles ?? []).filter((p) => STANDALONE.has(p.backend) && ID_RE.test(p.id));
  let reported = new Map();
  if (supervisor && standalone.length) {
    const status = await supervisor.request('status');
    reported = new Map((status.profiles ?? []).map((p) => [p.id, p]));
  }
  const capacity = config.capacity ?? { 'claude-code': 1, codex: 1 };
  const profiles = standalone.map((profile) => {
    const fromSupervisor = reported.get(profile.id);
    const state = !profile.complete ? 'incomplete'
      : fromSupervisor && fromSupervisor.backend === profile.backend ? fromSupervisor.readiness.state
        : 'platform_unsupported';
    return entryFor(profile, state, { maxActiveSessions: capacity[profile.backend] });
  });
  for (const profile of await readPaseoProfiles({ config, paseo })) {
    profiles.push(entryFor(paseoExecutionProfile(profile), 'ready', null));
  }
  return {
    formatVersion: 2,
    repositories,
    profiles,
    capacity: Object.fromEntries(['claude-code', 'codex'].map((backend) => [backend, { limit: capacity[backend], available: null, observedAt: null }])),
  };
}

export function resolveLaunchTargets({ config, repositoryKey, profileId }) {
  const repoPath = config.repositories[repositoryKey];
  if (!repoPath) {
    throw new Error(`Repository key is not allowlisted on this host: ${repositoryKey}`);
  }
  if (!servedPaseoProfileIds(config).includes(profileId)) {
    throw new Error(`Profile is not allowlisted on this host: ${profileId}`);
  }
  return { repoPath, profileId };
}
