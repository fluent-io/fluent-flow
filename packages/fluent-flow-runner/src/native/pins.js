
import { execFile as execFileCb } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { promisify } from 'node:util';
import { NativeProtocolError } from './jsonl.js';

const execFileAsync = promisify(execFileCb);

export const NATIVE_PINS = Object.freeze({
  'claude-code': Object.freeze({
    versions: Object.freeze(['2.1.317']),
    permissionModes: Object.freeze(['acceptEdits', 'auto', 'bypassPermissions', 'manual', 'dontAsk', 'plan']),
  }),
  codex: Object.freeze({
    versions: Object.freeze(['0.162.1']),
    approvalPolicies: Object.freeze(['untrusted', 'on-request', 'never']),
    sandboxModes: Object.freeze(['read-only', 'workspace-write', 'danger-full-access']),
  }),
});

export const POLICY_OUTCOMES = Object.freeze(['runs', 'asks', 'refused', 'unproven']);

export const NATIVE_OBSERVED = Object.freeze({
  'claude-code': Object.freeze({
    authStatusArgv: Object.freeze(['auth', 'status', '--json']),
    unknownResume: 'error',
    existingSessionId: 'refused',
    mcpToolsDeferred: true,
    permissionPromptsFlagNeeded: false,
    interruptReceiptKeys: Object.freeze(['still_queued', 'cancelled']),
    initPermissionModes: Object.freeze({ acceptEdits: 'acceptEdits', auto: 'auto', bypassPermissions: 'bypassPermissions', manual: 'default', dontAsk: 'dontAsk', plan: 'plan' }),
    policyOutcomes: Object.freeze({
      acceptEdits: Object.freeze({ reporting: 'asks', questions: 'asks' }),
      auto: Object.freeze({ reporting: 'unproven', questions: 'asks' }),
      bypassPermissions: Object.freeze({ reporting: 'runs', questions: 'asks' }),
      manual: Object.freeze({ reporting: 'asks', questions: 'asks' }),
      dontAsk: Object.freeze({ reporting: 'refused', questions: 'refused' }),
      plan: Object.freeze({ reporting: 'asks', questions: 'asks' }),
    }),
  }),
  codex: Object.freeze({
    threadListMethod: 'thread/list',
    threadListOmitsTurnless: true,
    lostCreateLookup: Object.freeze(['thread/loaded/list', 'thread/read']),
    disabledProjectLayersInert: true,
    threadStartCwdWritesTrust: true,
    commandApprovalDecline: 'accepted_but_unlisted',
    commandCancelInterrupts: true,
    mcpApprovalCancelInterrupts: false,
    mcpApprovalPersistScopes: Object.freeze(['session', 'always']),
    mcpApprovalAlwaysNeedsConfiguredServer: true,
    modelUnavailableSignal: 'http400_other_body_code_model_not_found',
    requestUserInputSecretProducible: false,
    policyOutcomes: Object.freeze({
      'on-request': Object.freeze({ reporting: 'asks', questions: 'asks' }),
      untrusted: Object.freeze({ reporting: 'asks', questions: 'asks' }),
      never: Object.freeze({ reporting: 'refused', questions: 'refused' }),
    }),
    requestUserInputMode: 'plan',
    requestUserInputOfferedInDefault: true,
  }),
});

const VERSION_PATTERNS = {
  'claude-code': /^(\d+\.\d+\.\d+) \(Claude Code\)$/,
  codex: /^codex-cli (\d+\.\d+\.\d+)$/,
};

/**
 * @param {{ backend: 'claude-code'|'codex', executable: string, env: Record<string, string>, execFile?: (file: string, args: string[], opts: object) => Promise<{ stdout: string }> }} opts
 */
export async function readNativeVersion({ backend, executable, env, execFile = execFileAsync }) {
  const pattern = VERSION_PATTERNS[backend];
  if (!pattern) throw new Error(`unknown native backend: ${backend}`);
  const { stdout } = await execFile(executable, ['--version'], { env, timeout: 15_000 });
  const match = String(stdout).trim().match(pattern);
  if (!match) throw new NativeProtocolError('version_unreadable', 'native version output was not recognized');
  return match[1];
}

/**
 * @param {{ sessionId: string, resume?: boolean, model: string, permissionMode: string, mcpConfigPath: string, settingsPath: string, workspaceDir: string }} opts
 * @returns {string[]}
 */
export function claudeArgs({ sessionId, resume = false, model, permissionMode, mcpConfigPath, settingsPath, workspaceDir }) {
  if (!NATIVE_PINS['claude-code'].permissionModes.includes(permissionMode)) throw new Error(`unsupported permissionMode: ${permissionMode}`);
  if (typeof workspaceDir !== 'string' || !isAbsolute(workspaceDir)) throw new Error('workspaceDir must be an absolute path');
  for (const [name, value] of Object.entries({ sessionId, model, mcpConfigPath, settingsPath })) {
    if (typeof value !== 'string' || value === '') throw new Error(`${name} is required`);
  }
  return [
    '-p',
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--verbose',
    '--replay-user-messages',
    '--include-partial-messages',
    '--model',
    model,
    '--permission-mode',
    permissionMode,
    '--permission-prompt-tool',
    'stdio',
    '--strict-mcp-config',
    '--mcp-config',
    mcpConfigPath,
    '--setting-sources',
    'user',
    '--settings',
    settingsPath,
    '--add-dir',
    workspaceDir,
    resume ? '--resume' : '--session-id',
    sessionId,
  ];
}

function tomlValue(value) {
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'boolean') return String(value);
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  throw new Error(`unsupported codex override value: ${typeof value}`);
}

/**
 * @param {{ overrides?: Record<string, string|number|boolean> }} opts
 * @returns {string[]}
 */
export function codexArgs({ overrides = {} } = {}) {
  const args = ['app-server', '--listen', 'stdio://', '--strict-config'];
  for (const [key, value] of Object.entries(overrides)) {
    if (!/^[A-Za-z0-9_.-]+$/.test(key)) throw new Error(`invalid codex override key: ${key}`);
    args.push('-c', `${key}=${tomlValue(value)}`);
  }
  return args;
}

/**
 * @returns {Record<string, boolean>}
 */
export function codexLaunchControls() {
  return { 'features.plugins': false, 'features.apps': false };
}

/**
 * @param {{ url: string }} opts
 */
export function codexQuestionServerOverrides({ url }) {
  return {
    'mcp_servers.ff_questions.url': url,
    'mcp_servers.ff_questions.bearer_token_env_var': 'FF_QUESTIONS_TOKEN',
    'mcp_servers.ff_questions.required': true,
    'mcp_servers.ff_questions.tool_timeout_sec': 604800,
  };
}
