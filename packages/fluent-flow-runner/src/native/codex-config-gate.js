
import { codexLaunchControls } from './pins.js';

export const CODEX_LAYER_TYPES = Object.freeze([
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

export const FF_CODEX_MCP_SERVERS = Object.freeze(['ff_reporting', 'ff_questions']);

const OUTRANKS_SESSION_FLAGS = new Set(['legacyManagedConfigTomlFromFile', 'legacyManagedConfigTomlFromMdm']);

const MISSING = Symbol('missing');

function lookup(config, dottedKey) {
  let node = config;
  for (const part of dottedKey.split('.')) {
    if (node === null || typeof node !== 'object' || !Object.hasOwn(node, part)) return MISSING;
    node = node[part];
  }
  return node;
}

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const enabled = (layer) => layer.disabledReason === null || layer.disabledReason === undefined;

/**
 * @param {{ layers?: Array<{ name: { type: string }, config: any, disabledReason: string|null }>|null }} configRead
 * @param {{ overrides: Record<string, string|number|boolean>, disabledProjectLayersInert?: boolean, allowlist?: readonly string[] }} opts
 * @returns {{ ok: true } | { ok: false, reason: 'layers_unavailable'|'unknown_layer'|'project_layer_enabled'|'project_layer_present'|'project_trust_present'|'missing_isolation_controls'|'inconsistent_layers'|'unexpected_mcp_server' }}
 */
export function assessCodexLayers(configRead, { overrides, disabledProjectLayersInert = false, allowlist = FF_CODEX_MCP_SERVERS }) {
  const fail = (reason) => ({ ok: /** @type {const} */ (false), reason });
  const layers = configRead?.layers;
  if (!Array.isArray(layers) || layers.length === 0) return fail('layers_unavailable');
  if (layers.some((l) => !CODEX_LAYER_TYPES.includes(l?.name?.type))) return fail('unknown_layer');

  const projects = layers.filter((l) => l.name.type === 'project');
  if (projects.some(enabled)) return fail('project_layer_enabled');
  if (projects.length > 0 && !disabledProjectLayersInert) return fail('project_layer_present');

  const active = layers.filter(enabled);
  const trusted = active.some((l) => {
    const table = l.config?.projects;
    return isObject(table) && Object.values(table).some((p) => isObject(p) && p.trust_level === 'trusted');
  });
  if (trusted) return fail('project_trust_present');

  for (const key of Object.keys(codexLaunchControls())) {
    if (!Object.hasOwn(overrides, key) || overrides[key] !== false) return fail('missing_isolation_controls');
  }

  const session = active.find((l) => l.name.type === 'sessionFlags');
  if (!session) return fail('inconsistent_layers');
  for (const [key, value] of Object.entries(overrides)) {
    if (lookup(session.config, key) !== value) return fail('inconsistent_layers');
  }
  for (const layer of active) {
    if (!OUTRANKS_SESSION_FLAGS.has(layer.name.type)) continue;
    if (Object.keys(overrides).some((key) => lookup(layer.config, key) !== MISSING)) return fail('inconsistent_layers');
  }

  for (const layer of active) {
    const servers = layer.config?.mcp_servers;
    if (isObject(servers) && Object.keys(servers).some((name) => !allowlist.includes(name))) return fail('unexpected_mcp_server');
  }
  return { ok: true };
}
