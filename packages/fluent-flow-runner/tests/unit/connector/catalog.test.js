import { describe, it, expect } from 'vitest';
import { REQUIRED_CAPABILITIES } from '@fluent-flow/db/dist/collaboration/execution.js';
import { buildCatalog, profileRevision, PUBLISHED_CAPABILITIES } from '../../../src/connector/catalog.js';
import { canonicalDigest } from '../../../src/connector/executor.js';

const claude = Object.freeze({ id: 'cc-main', name: 'Claude main', backend: 'claude-code', executable: '/opt/claude', contextDir: '/ctx/cc', model: 'claude-model-a', policy: { permissionMode: 'manual' }, summaryProfileId: undefined, complete: true, problems: [] });
const codex = Object.freeze({ id: 'cx-main', name: 'Codex main', backend: 'codex', executable: '/opt/codex', contextDir: '/ctx/cx', model: 'codex-model-a', policy: { approvalPolicy: 'on-request', sandbox: 'workspace-write', networkAccess: false }, summaryProfileId: 'cx-sum', complete: true, problems: [] });
const incomplete = Object.freeze({ id: 'cc-half', name: 'Half', backend: 'claude-code', executable: null, contextDir: null, model: null, policy: null, summaryProfileId: undefined, complete: false, problems: ['executable_not_found', 'missing_model'] });

const paseoProfile = { id: 'agent_profile_coder', name: 'Coder', provider: 'omp', model: 'ai3/model', modeId: 'full', thinkingOptionId: 'high', featureValues: { plan: true, nested: { depth: 2 } }, notes: 'stays local' };

function fakePaseo(calls = []) {
  return { config: { get: async () => { calls.push('config.get'); return { config: { agentProfiles: [paseoProfile], providers: { omp: { env: { API_KEY: 'provider-secret' } } } } }; } } };
}

function fakeSupervisor(states) {
  return { request: async (method) => {
    if (method !== 'status') throw new Error(`unexpected ${method}`);
    return { containment: { state: 'verified' }, admissionStopped: false, workers: [], profiles: Object.entries(states).map(([id, state]) => ({ id, backend: id.startsWith('cc') ? 'claude-code' : 'codex', readiness: { state } })) };
  } };
}

function loadedConfig({ profiles, paseoEnabled = false, savedProfileIds = [], capacity = { 'claude-code': 1, codex: 1 } }) {
  return { repositories: { repo: '/src/repo' }, profiles, capacity, integrations: { paseo: { enabled: paseoEnabled, savedProfileIds, home: null, cliPath: null } }, paseo: { home: null, cliPath: null } };
}

describe('catalog v2 (Task 7)', () => {
  it('standalone entries carry backend, revision, capabilities, readiness, limits and capacity', async () => {
    const catalog = await buildCatalog({ config: loadedConfig({ profiles: [claude, codex], capacity: { 'claude-code': 2, codex: 1 } }), paseo: null, supervisor: fakeSupervisor({ 'cc-main': 'ready', 'cx-main': 'ready' }) });
    expect(catalog.formatVersion).toBe(2);
    expect(catalog.repositories).toEqual([{ key: 'repo' }]);
    expect(catalog.capacity).toEqual({ 'claude-code': { limit: 2, available: null, observedAt: null }, codex: { limit: 1, available: null, observedAt: null } });
    expect(catalog.profiles).toEqual([
      { id: 'cc-main', name: 'Claude main', backend: 'claude-code', model: 'claude-model-a', revision: profileRevision(claude, '2.1.317'), capabilities: [...REQUIRED_CAPABILITIES['claude-code']], readiness: { state: 'ready' }, harness: { name: 'claude-code', version: '2.1.317' }, policy: { permissionMode: 'manual' }, authExpectation: 'claude-subscription', limits: { maxActiveSessions: 2 } },
      { id: 'cx-main', name: 'Codex main', backend: 'codex', model: 'codex-model-a', revision: profileRevision(codex, '0.162.1'), capabilities: [...REQUIRED_CAPABILITIES.codex], readiness: { state: 'ready' }, harness: { name: 'codex', version: '0.162.1' }, policy: { approvalPolicy: 'on-request', sandbox: 'workspace-write', networkAccess: false }, authExpectation: 'chatgpt-subscription', limits: { maxActiveSessions: 1 } },
    ]);
    expect(JSON.stringify(catalog)).not.toMatch(/\/opt\/|\/ctx\/|\/src\/repo/);
  });

  it('profile revision is the documented digest and changes with model, policy, harness or summary profile', () => {
    const expected = canonicalDigest({ backend: 'codex', harnessVersion: '0.162.1', model: 'codex-model-a', policy: codex.policy, summaryProfileId: 'cx-sum' }).slice(0, 16);
    expect(profileRevision(codex, '0.162.1')).toBe(expected);
    expect(profileRevision(codex, '0.162.1')).toMatch(/^[0-9a-f]{16}$/);
    const variants = [{ ...codex, model: 'codex-model-b' }, { ...codex, policy: { ...codex.policy, networkAccess: true } }, { ...codex, summaryProfileId: null }];
    for (const v of variants) expect(profileRevision(v, '0.162.1')).not.toBe(expected);
    expect(profileRevision(codex, '0.162.2')).not.toBe(expected);
    expect(profileRevision({ ...codex, name: 'Renamed', contextDir: '/elsewhere' }, '0.162.1')).toBe(expected);
  });

  it('incomplete or unpinned profiles are published as unavailable', async () => {
    const catalog = await buildCatalog({ config: loadedConfig({ profiles: [claude, codex, incomplete] }), paseo: null, supervisor: fakeSupervisor({ 'cc-main': 'incompatible', 'cx-main': 'sign_in_required', 'cc-half': 'incomplete' }) });
    expect(catalog.profiles.map((p) => [p.id, p.readiness.state])).toEqual([['cc-main', 'incompatible'], ['cx-main', 'sign_in_required'], ['cc-half', 'incomplete']]);
    expect(catalog.profiles.find((p) => p.id === 'cc-half')).toMatchObject({ backend: 'claude-code', model: null, policy: null });
    const unsupervised = await buildCatalog({ config: loadedConfig({ profiles: [claude, incomplete] }), paseo: null, supervisor: null });
    expect(unsupervised.profiles.map((p) => [p.id, p.readiness.state])).toEqual([['cc-main', 'platform_unsupported'], ['cc-half', 'incomplete']]);
    const unreported = await buildCatalog({ config: loadedConfig({ profiles: [claude] }), paseo: null, supervisor: fakeSupervisor({}) });
    expect(unreported.profiles[0].readiness.state).toBe('platform_unsupported');
  });

  it('paseo entries appear only when enabled', async () => {
    const calls = [];
    const disabled = await buildCatalog({ config: loadedConfig({ profiles: [claude], savedProfileIds: ['agent_profile_coder'] }), paseo: fakePaseo(calls), supervisor: fakeSupervisor({ 'cc-main': 'ready' }) });
    expect(disabled.profiles.map((p) => p.backend)).toEqual(['claude-code']);
    expect(calls).toEqual([]);
    const enabled = await buildCatalog({ config: loadedConfig({ profiles: [claude], paseoEnabled: true, savedProfileIds: ['agent_profile_coder'] }), paseo: fakePaseo(calls), supervisor: fakeSupervisor({ 'cc-main': 'ready' }) });
    const entry = enabled.profiles.find((p) => p.backend === 'paseo');
    expect(entry).toEqual({ id: 'agent_profile_coder', name: 'Coder', backend: 'paseo', model: 'ai3/model', revision: expect.stringMatching(/^[0-9a-f]{16}$/), capabilities: [...REQUIRED_CAPABILITIES.paseo], readiness: { state: 'ready' }, harness: { name: 'paseo', version: '0.12.0' }, policy: { modeId: 'full', thinkingOptionId: 'high' }, authExpectation: 'paseo', limits: null });
    const changed = { ...paseoProfile, featureValues: { plan: true, nested: { depth: 3 } } };
    const other = await buildCatalog({ config: loadedConfig({ profiles: [], paseoEnabled: true, savedProfileIds: ['agent_profile_coder'] }), paseo: { config: { get: async () => ({ config: { agentProfiles: [changed] } }) } }, supervisor: null });
    expect(other.profiles[0].revision).not.toBe(entry.revision);
    expect(JSON.stringify(enabled)).not.toMatch(/provider-secret|stays local|omp|nested/);
  });

  it('a served Paseo id that names two live daemon profiles is rejected, never first-matched', async () => {
    const twin = { ...paseoProfile, provider: 'other-provider', model: 'other/model' };
    const daemon = { config: { get: async () => ({ config: { agentProfiles: [paseoProfile, twin] } }) } };
    const enabled = loadedConfig({ profiles: [claude], paseoEnabled: true, savedProfileIds: ['agent_profile_coder'] });
    await expect(buildCatalog({ config: enabled, paseo: daemon, supervisor: fakeSupervisor({ 'cc-main': 'ready' }) })).rejects.toMatchObject({ code: 'duplicate_profile_id' });
    await expect(buildCatalog({ config: { repositories: {}, profiles: ['agent_profile_coder'] }, paseo: daemon })).rejects.toMatchObject({ code: 'duplicate_profile_id' });
    const unrelated = { config: { get: async () => ({ config: { agentProfiles: [paseoProfile, { id: 'x' }, { id: 'x' }] } }) } };
    expect((await buildCatalog({ config: enabled, paseo: unrelated, supervisor: fakeSupervisor({ 'cc-main': 'ready' }) })).profiles.map((p) => p.id)).toEqual(['cc-main', 'agent_profile_coder']);
  });

  it('a legacy injected config without integrations keeps the v1 catalog unchanged', async () => {
    const catalog = await buildCatalog({ config: { repositories: { r: '/r' }, profiles: ['agent_profile_coder'] }, paseo: fakePaseo() });
    expect(catalog).toEqual({ repositories: [{ key: 'r' }], profiles: [{ id: 'agent_profile_coder', name: 'Coder', provider: 'omp', model: 'ai3/model', modeId: 'full', thinkingOptionId: 'high', features: { plan: true, nested: { depth: 2 } } }] });
  });

  it('PUBLISHED_CAPABILITIES equals REQUIRED_CAPABILITIES from @fluent-flow/db', () => {
    expect(JSON.parse(JSON.stringify(PUBLISHED_CAPABILITIES))).toEqual(JSON.parse(JSON.stringify(REQUIRED_CAPABILITIES)));
  });
});

const legacyProfiles = [
  {
    id: 'agent_profile_coder',
    name: 'Coder',
    provider: 'omp',
    model: 'ai3/qwen/qwen3.8-27b',
    modeId: 'full',
    thinkingOptionId: null,
    featureValues: { plan: true },
    notes: 'internal notes stay local',
  },
  {
    id: 'agent_profile_other',
    name: 'Not allowed',
    provider: 'claude',
    model: 'x',
  },
];

function legacyPaseo() {
  return {
    config: {
      get: async () => ({
        requestId: 'r',
        config: {
          agentProfiles: legacyProfiles,
          providers: { omp: { env: { API_KEY: 'supersecret' } } },
        },
      }),
    },
  };
}

describe('catalog builder', () => {
  it('publishes only allowlisted profiles with sanitized fields', async () => {
    const catalog = await buildCatalog({
      config: { repositories: { 'my-repo': '/r' }, profiles: ['agent_profile_coder'] },
      paseo: legacyPaseo(),
    });
    expect(catalog.repositories).toEqual([{ key: 'my-repo' }]);
    expect(catalog.profiles).toHaveLength(1);
    expect(catalog.profiles[0]).toEqual({
      id: 'agent_profile_coder',
      name: 'Coder',
      provider: 'omp',
      model: 'ai3/qwen/qwen3.8-27b',
      modeId: 'full',
      thinkingOptionId: null,
      features: { plan: true },
    });
  });

  it('never includes provider credentials, env, notes or raw config in the catalog', async () => {
    const catalog = await buildCatalog({
      config: { repositories: {}, profiles: ['agent_profile_coder'] },
      paseo: legacyPaseo(),
    });
    expect(JSON.stringify(catalog)).not.toContain('supersecret');
    expect(JSON.stringify(catalog)).not.toContain('internal notes');
  });

  it('fails fast when an allowlisted profile does not exist in the daemon config', async () => {
    await expect(
      buildCatalog({
        config: { repositories: {}, profiles: ['agent_profile_missing'] },
        paseo: legacyPaseo(),
      }),
    ).rejects.toThrow(/agent_profile_missing/);
  });
});
