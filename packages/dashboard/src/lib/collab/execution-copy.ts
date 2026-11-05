import type { CapacityEntry, ExecutionBackend, ReadinessState } from './types';

export const EXECUTION_MESSAGES: Record<string, string> = Object.freeze({
  profile_incomplete: 'Choose a complete execution profile before starting.',
  profile_unavailable: 'This execution profile is unavailable. Contact the execution host owner.',
  execution_settings_changed: 'Execution settings changed. Ask a project administrator to select an available profile.',
  sign_in_required: 'Sign in to the selected tool on the execution host, then try again.',
  account_limited: 'Your selected tool cannot continue right now. Check its account limits and try again.',
  startup_failed: 'Execution could not start. Contact the execution host owner.',
  reconciling: 'Execution status is uncertain. Review recovery before continuing.',
  request_unavailable: 'This request is no longer available. Refresh the session.',
  integration_disabled: 'This run requires an integration that is not enabled.',
  answer_on_host: 'Answer this request on the execution host.',
  capacity_wait: 'Waiting for an execution slot.',
  wrapup_blocked: 'Worktree cleanup is blocked. Review the outstanding work.',
});

const unavailable = EXECUTION_MESSAGES.profile_unavailable;

export const READINESS_COPY: Record<ReadinessState, { label: string; message: string | null }> = Object.freeze({
  ready: { label: 'Ready', message: null },
  incomplete: { label: 'Incomplete profile', message: EXECUTION_MESSAGES.profile_incomplete },
  not_installed: { label: 'Tool not installed', message: unavailable },
  incompatible: { label: 'Unsupported tool version', message: unavailable },
  invalid_config: { label: 'Invalid configuration', message: unavailable },
  platform_unsupported: { label: 'Unsupported on this host', message: unavailable },
  sign_in_required: { label: 'Sign-in needed', message: EXECUTION_MESSAGES.sign_in_required },
});

export function executionErrorMessage(code: string | null): string | null {
  if (code === null || !Object.hasOwn(EXECUTION_MESSAGES, code)) return null;
  return EXECUTION_MESSAGES[code];
}

export const BACKEND_LABELS: Record<ExecutionBackend, string> = Object.freeze({
  'claude-code': 'Claude Code',
  codex: 'Codex',
  paseo: 'Paseo',
});

const POLICY_LABELS: Record<ExecutionBackend, Record<string, string>> = {
  'claude-code': { permissionMode: 'permission mode' },
  codex: { approvalPolicy: 'approval', sandbox: 'sandbox', networkAccess: 'network access' },
  paseo: { modeId: 'mode', thinkingOptionId: 'thinking' },
};

export function policyText(backend: ExecutionBackend, policy: Record<string, unknown> | null | undefined): string | null {
  if (!policy) return null;
  const parts = Object.entries(POLICY_LABELS[backend]).flatMap(([key, label]) => {
    const value = policy[key];
    if (typeof value === 'boolean') return [`${label} ${value ? 'on' : 'off'}`];
    if (typeof value === 'string' && value.length > 0) return [`${label} ${value}`];
    return [];
  });
  return parts.length > 0 ? parts.join(', ') : null;
}

export function capacityText(entry: CapacityEntry): string {
  const slots = `${entry.limit} ${entry.limit === 1 ? 'slot' : 'slots'}`;
  return entry.available === null ? `Capacity: ${slots}, availability unknown` : `Capacity: ${slots}, ${entry.available} available`;
}
