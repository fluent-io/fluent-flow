import { describe, it, expect } from 'vitest';
import { assessCodexLayers, CODEX_LAYER_TYPES, FF_CODEX_MCP_SERVERS } from '../../../src/native/codex-config-gate.js';

const overrides = {
  model_provider: 'ffprobe',
  'model_providers.ffprobe.base_url': 'http://127.0.0.1:1/v1',
  'features.plugins': false,
  'features.apps': false,
  'mcp_servers.ff_reporting.url': 'http://127.0.0.1:2/mcp',
  'mcp_servers.ff_questions.url': 'http://127.0.0.1:3/mcp/s',
};

const sessionFlagsConfig = () => ({
  model_provider: 'ffprobe',
  model_providers: { ffprobe: { base_url: 'http://127.0.0.1:1/v1' } },
  features: { plugins: false, apps: false },
  mcp_servers: { ff_reporting: { url: 'http://127.0.0.1:2/mcp' }, ff_questions: { url: 'http://127.0.0.1:3/mcp/s' } },
});

const layer = (name, config = {}, disabledReason = null) => ({ name, version: 'v', config, disabledReason });
const user = (config = {}) => layer({ type: 'user', file: '/h/ctx/config.toml', profile: null }, config);
const session = (config = sessionFlagsConfig()) => layer({ type: 'sessionFlags' }, config);
const project = (config = {}, disabledReason = 'project is not trusted') =>
  layer({ type: 'project', dotCodexFolder: '/w/repo/.codex' }, config, disabledReason);
const plantedProject = (disabledReason) => project({ model: 'planted-model', mcp_servers: { planted: { url: 'http://127.0.0.1:9/p' } } }, disabledReason);

const read = (...layers) => ({ config: {}, origins: {}, layers });
const passing = () => read(layer({ type: 'system', file: '/etc/codex/config.toml' }), user(), session());

describe('assessCodexLayers', () => {
  it('pins the nine layer types and the FF server allowlist', () => {
    expect([...CODEX_LAYER_TYPES]).toEqual([
      'packagedDefaults',
      'mdm',
      'system',
      'enterpriseManaged',
      'user',
      'project',
      'sessionFlags',
      'legacyManagedConfigTomlFromFile',
      'legacyManagedConfigTomlFromMdm',
    ]);
    expect([...FF_CODEX_MCP_SERVERS]).toEqual(['ff_reporting', 'ff_questions']);
  });

  it('passes the reference layers', () => {
    expect(assessCodexLayers(passing(), { overrides })).toEqual({ ok: true });
  });

  const rows = [
    ['layers_unavailable', { config: {}, origins: {}, layers: null }, {}],
    ['layers_unavailable', read(), {}],
    ['unknown_layer', read(layer({ type: 'cloudFuture' }), user(), session()), {}],
    ['project_layer_enabled', read(user(), session(), project({}, null)), { disabledProjectLayersInert: true }],
    ['project_layer_present', read(user(), session(), project()), {}],
    ['project_trust_present', read(user({ projects: { '/w/repo': { trust_level: 'trusted' } } }), session()), {}],
    ['missing_isolation_controls', passing(), { overrides: { ...overrides, 'features.apps': true } }],
    ['missing_isolation_controls', passing(), { overrides: Object.fromEntries(Object.entries(overrides).filter(([k]) => k !== 'features.plugins')) }],
    ['inconsistent_layers', read(user()), {}],
    ['unexpected_mcp_server', read(user({ mcp_servers: { stranger: { command: 'x' } } }), session()), {}],
  ];
  it.each(rows)('reports %s', (reason, configRead, extra) => {
    expect(assessCodexLayers(configRead, { overrides, ...extra })).toEqual({ ok: false, reason });
  });

  it('a project layer with no disabledReason field is project_layer_enabled', () => {
    const enabledProject = { name: { type: 'project', dotCodexFolder: '/w/repo/.codex' }, version: 'v', config: {} };
    expect(assessCodexLayers(read(user(), session(), enabledProject), { overrides, disabledProjectLayersInert: true })).toEqual({ ok: false, reason: 'project_layer_enabled' });
  });

  it('checks reasons in order, so the first failure wins', () => {
    const many = read(layer({ type: 'cloudFuture' }), user({ mcp_servers: { stranger: {} } }), project({}, null));
    expect(assessCodexLayers(many, { overrides: {} })).toEqual({ ok: false, reason: 'unknown_layer' });
  });

  it('a disabled project layer defining planted servers passes only when disabledProjectLayersInert is true', () => {
    const r = read(user(), session(), plantedProject('project is not trusted'));
    expect(assessCodexLayers(r, { overrides })).toEqual({ ok: false, reason: 'project_layer_present' });
    expect(assessCodexLayers(r, { overrides, disabledProjectLayersInert: true })).toEqual({ ok: true });
  });

  it('a legacy managed layer setting an FF override is inconsistent_layers', () => {
    for (const type of ['legacyManagedConfigTomlFromFile', 'legacyManagedConfigTomlFromMdm']) {
      const name = type === 'legacyManagedConfigTomlFromFile' ? { type, file: '/etc/codex/managed_config.toml' } : { type };
      const r = read(user(), session(), layer(name, { features: { plugins: true } }));
      expect(assessCodexLayers(r, { overrides }), type).toEqual({ ok: false, reason: 'inconsistent_layers' });
      const unrelated = read(user(), session(), layer(name, { model_reasoning_effort: 'low' }));
      expect(assessCodexLayers(unrelated, { overrides }), `${type} unrelated`).toEqual({ ok: true });
    }
  });

  it('a session flags layer missing or changing an override is inconsistent_layers', () => {
    const missing = sessionFlagsConfig();
    delete missing.mcp_servers.ff_questions;
    expect(assessCodexLayers(read(user(), session(missing)), { overrides })).toEqual({ ok: false, reason: 'inconsistent_layers' });
    const changed = sessionFlagsConfig();
    changed.model_providers.ffprobe.base_url = 'http://elsewhere/v1';
    expect(assessCodexLayers(read(user(), session(changed)), { overrides })).toEqual({ ok: false, reason: 'inconsistent_layers' });
    const disabled = layer({ type: 'sessionFlags' }, sessionFlagsConfig(), 'disabled');
    expect(assessCodexLayers(read(user(), disabled), { overrides })).toEqual({ ok: false, reason: 'inconsistent_layers' });
  });

  it('a trusted project in the user layer is project_trust_present', () => {
    const r = read(user({ projects: { '/elsewhere': { trust_level: 'untrusted' }, '/w/repo': { trust_level: 'trusted' } } }), session());
    expect(assessCodexLayers(r, { overrides })).toEqual({ ok: false, reason: 'project_trust_present' });
    const untrusted = read(user({ projects: { '/w/repo': { trust_level: 'untrusted' } } }), session());
    expect(assessCodexLayers(untrusted, { overrides })).toEqual({ ok: true });
  });

  it('a server outside the allowlist in any enabled layer is unexpected_mcp_server', () => {
    for (const name of [{ type: 'system', file: '/etc/codex/config.toml' }, { type: 'mdm', domain: 'd', key: 'k' }, { type: 'enterpriseManaged', id: 'i', name: 'n' }]) {
      const r = read(user(), session(), layer(name, { mcp_servers: { stranger: { url: 'http://x' } } }));
      expect(assessCodexLayers(r, { overrides }), name.type).toEqual({ ok: false, reason: 'unexpected_mcp_server' });
    }
    const disabledElsewhere = read(user(), session(), layer({ type: 'system', file: '/etc/codex/config.toml' }, { mcp_servers: { stranger: {} } }, 'disabled'));
    expect(assessCodexLayers(disabledElsewhere, { overrides })).toEqual({ ok: true });
    const custom = read(user({ mcp_servers: { mine: {} } }), session());
    expect(assessCodexLayers(custom, { overrides, allowlist: ['ff_reporting', 'ff_questions', 'mine'] })).toEqual({ ok: true });
  });
});
