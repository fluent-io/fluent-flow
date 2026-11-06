import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { READINESS_STATES } from '@fluent-flow/db/dist/collaboration/execution.js';
import {
  EXECUTION_MESSAGES,
  READINESS_COPY,
  executionErrorMessage,
  safeDialogError,
} from '../../src/lib/collab/execution-copy';
import { ApiError } from '../../src/lib/collab/api';
import type { Mapping } from '../../src/lib/collab/types';

vi.mock('next-auth/react', () => ({ useSession: () => ({ data: null, status: 'unauthenticated' }), signOut: vi.fn() }));
vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams(), useRouter: () => ({ replace: vi.fn() }), usePathname: () => '/settings' }));
const { ExecutionProfileSummary, RunStatusNotices, SessionControls, isNativeRecovery, createIntentKeys } = await import('../../src/components/collab/task-execution-tab');
const { ProfileReadinessList, UsageSummary } = await import('../../src/components/collab/settings-view');

const INCOMPLETE = 'Choose a complete execution profile before starting.';
const UNAVAILABLE = 'This execution profile is unavailable. Contact the execution host owner.';
const SIGN_IN = 'Sign in to the selected tool on the execution host, then try again.';

describe('execution copy', () => {
  it('READINESS_COPY covers exactly READINESS_STATES from @fluent-flow/db and each non-ready state shows its approved message', () => {
    expect(Object.keys(READINESS_COPY).sort()).toEqual([...READINESS_STATES].sort());
    expect(READINESS_COPY).toEqual({
      ready: { label: 'Ready', message: null },
      incomplete: { label: 'Incomplete profile', message: INCOMPLETE },
      not_installed: { label: 'Tool not installed', message: UNAVAILABLE },
      incompatible: { label: 'Unsupported tool version', message: UNAVAILABLE },
      invalid_config: { label: 'Invalid configuration', message: UNAVAILABLE },
      platform_unsupported: { label: 'Unsupported on this host', message: UNAVAILABLE },
      sign_in_required: { label: 'Sign-in needed', message: SIGN_IN },
    });
  });

  it('EXECUTION_MESSAGES holds the approved public copy table exactly', () => {
    expect(EXECUTION_MESSAGES).toEqual({
      profile_incomplete: INCOMPLETE,
      profile_unavailable: UNAVAILABLE,
      execution_settings_changed: 'Execution settings changed. Ask a project administrator to select an available profile.',
      sign_in_required: SIGN_IN,
      account_limited: 'Your selected tool cannot continue right now. Check its account limits and try again.',
      startup_failed: 'Execution could not start. Contact the execution host owner.',
      reconciling: 'Execution status is uncertain. Review recovery before continuing.',
      request_unavailable: 'This request is no longer available. Refresh the session.',
      integration_disabled: 'This run requires an integration that is not enabled.',
      answer_on_host: 'Answer this request on the execution host.',
      capacity_wait: 'Waiting for an execution slot.',
      wrapup_blocked: 'Worktree cleanup is blocked. Review the outstanding work.',
    });
  });

  it('executionErrorMessage maps known codes and returns null for unknown or missing codes', () => {
    expect(executionErrorMessage('account_limited')).toBe(EXECUTION_MESSAGES.account_limited);
    expect(executionErrorMessage('integration_disabled')).toBe('This run requires an integration that is not enabled.');
    expect(executionErrorMessage('ENOENT /home/user/.codex/auth.json')).toBeNull();
    expect(executionErrorMessage('toString')).toBeNull();
    expect(executionErrorMessage(null)).toBeNull();
  });

  it('safeDialogError never surfaces raw server messages, only approved copy or the fallback', () => {
    const leaky = new ApiError(
      500,
      'unexpected_response',
      'connect ECONNREFUSED 10.0.0.42:5432 while loading /opt/fluent-flow/.env secret FF_COLLAB_AUTH_SECRET=0123deadbeef',
      'req-42',
      null,
    );
    expect(safeDialogError(leaky, 'Could not queue the run.')).toBe('Could not queue the run.');
    expect(safeDialogError(leaky, 'Could not queue the run.')).not.toContain('ECONNREFUSED');
    expect(safeDialogError(leaky, 'Could not queue the run.')).not.toContain('FF_COLLAB_AUTH_SECRET');
    expect(safeDialogError(leaky, 'Could not queue the run.')).not.toContain('.env');

    const mapped = new ApiError(422, 'integration_disabled', 'something internal /tmp/.ff/private', null, null);
    expect(safeDialogError(mapped, 'fallback')).toBe(EXECUTION_MESSAGES.integration_disabled);
    expect(safeDialogError(mapped, 'fallback')).not.toContain('/tmp/.ff/private');

    const thrown = new Error('postgres: duplicate key value violates unique constraint "collab_session_execution_pkey"');
    expect(safeDialogError(thrown, 'Command failed.')).toBe('Command failed.');
    expect(safeDialogError(thrown, 'Command failed.')).not.toContain('postgres');
    expect(safeDialogError(thrown, 'Command failed.')).not.toContain('collab_session_execution_pkey');

    expect(safeDialogError(null, 'fallback')).toBe('fallback');
    expect(safeDialogError(undefined, 'fallback')).toBe('fallback');
    expect(safeDialogError('a string', 'fallback')).toBe('fallback');
  });
});

const FIXTURE_PATH = '/home/owner/.codex/config.toml';
const FIXTURE_TOKEN = 'sk-fixture-9f8e7d6c';
const OBSERVED = '2026-11-05T09:00:00.000Z';
const QUEUED = '2026-11-05T08:59:30.000Z';

const mapping: Mapping = {
  id: 'm1', projectId: 'p1', hostId: 'h1', repositoryKey: 'org/repo', profileIds: ['cc-main', 'cc-login', 'cx-main', 'legacy'],
  defaultProfileId: 'cc-main', baseRef: null, hostName: 'build box', hostReachability: 'online', hostLastSeenAt: OBSERVED,
  profiles: [
    { id: 'cc-main', name: 'Claude main', provider: null, model: 'claude-opus-5-5', backend: 'claude-code', readiness: { state: 'ready' }, policy: { permissionMode: 'default' } },
    { id: 'cx-main', name: 'Codex main', provider: null, model: 'gpt-codex', backend: 'codex', readiness: { state: 'not_installed' }, policy: { approvalPolicy: 'on-request', configPath: FIXTURE_PATH, apiKey: FIXTURE_TOKEN } },
    { id: 'cc-login', name: 'Claude review', provider: null, model: 'claude-sonnet-5-5', backend: 'claude-code', readiness: { state: 'sign_in_required' }, policy: null },
    { id: 'legacy', name: 'Paseo agent', provider: 'claude', model: null },
  ],
  capacity: {
    'claude-code': { limit: 1, available: 0, observedAt: OBSERVED },
    codex: { limit: 2, available: null, observedAt: null },
  },
};

function section(markup: string, attribute: string, value: string) {
  const start = markup.indexOf(`${attribute}="${value}"`);
  expect(start, `${attribute}=${value}`).toBeGreaterThanOrEqual(0);
  const next = markup.indexOf(`${attribute}="`, start + attribute.length + 2);
  return markup.slice(start, next === -1 ? undefined : next);
}

describe('settings: advertised profiles and capacity', () => {
  it('profiles are grouped by backend with readiness labels', () => {
    const html = renderToStaticMarkup(<ProfileReadinessList mapping={mapping} />);
    const claude = section(html, 'data-backend', 'claude-code');
    expect(claude).toContain('Claude Code');
    expect(claude).toContain('Claude main');
    expect(claude).toContain('Claude review');
    expect(section(claude, 'data-profile-id', 'cc-main')).toContain('Ready');
    expect(section(claude, 'data-profile-id', 'cc-login')).toContain('Sign-in needed');
    expect(section(claude, 'data-profile-id', 'cc-login')).toContain(SIGN_IN);
    expect(claude).toContain('Capacity: 1 slot, 0 available');
    const codex = section(html, 'data-backend', 'codex');
    expect(codex).toContain('Codex main');
    expect(codex).toContain('Tool not installed');
    expect(codex).toContain(UNAVAILABLE);
    expect(codex).toContain('Capacity: 2 slots, availability unknown');
    expect(codex).not.toContain('Claude');
    const paseo = section(html, 'data-backend', 'paseo');
    expect(paseo).toContain('Paseo agent');
    expect(paseo).not.toContain('Capacity');
    expect(html.indexOf('data-backend="claude-code"')).toBeLessThan(html.indexOf('data-backend="codex"'));
  });

  it('unknown usage renders Unavailable, not 0', () => {
    const unknown = renderToStaticMarkup(
      <UsageSummary usage={{ available: true, reason: null, tokensIn: null, tokensOut: 1200, costUsd: null, coverage: { samples: 2, tokensIn: 0, tokensOut: 2, costUsd: 0 } }} />,
    );
    expect(unknown).toContain('in Unavailable');
    expect(unknown).toContain('out 1200');
    expect(unknown).toContain('Estimated cost: Unavailable');
    expect(unknown).not.toMatch(/in 0\b/);
    const known = renderToStaticMarkup(
      <UsageSummary usage={{ available: true, reason: null, tokensIn: 10, tokensOut: 20, costUsd: 0.42, coverage: { samples: 1, tokensIn: 1, tokensOut: 1, costUsd: 1 } }} />,
    );
    expect(known).toContain('Estimated cost: $0.42');
    const none = renderToStaticMarkup(
      <UsageSummary usage={{ available: false, reason: null, tokensIn: null, tokensOut: null, costUsd: null, coverage: { samples: 0, tokensIn: 0, tokensOut: 0, costUsd: 0 } }} />,
    );
    expect(none).toContain('Unavailable');
    expect(none).not.toContain('0 /');
  });
});

describe('start and execution surfaces', () => {
  it('Start shows backend, model and policy', () => {
    const html = renderToStaticMarkup(<ExecutionProfileSummary execution={{ backend: 'codex', model: 'gpt-codex', policy: { approvalPolicy: 'on-request', sandbox: 'workspace-write', networkAccess: false } }} />);
    expect(html).toContain('Backend: Codex');
    expect(html).toContain('Model: gpt-codex');
    expect(html).toContain('Policy: approval on-request, sandbox workspace-write, network access off');
    const unset = renderToStaticMarkup(<ExecutionProfileSummary execution={{ backend: 'claude-code', model: null, policy: null }} />);
    expect(unset).toContain('Backend: Claude Code');
    expect(unset).toContain('Model: Selected by the profile');
    expect(unset).toContain('Policy: Selected by the profile');
  });

  it('a capacity wait shows the actor\'s queued time and copy', () => {
    const waiting = renderToStaticMarkup(<RunStatusNotices run={{ state: 'queued' }} queue={{ queuedAt: QUEUED, reason: 'capacity' }} integrationDisabled={false} />);
    expect(waiting).toContain('Waiting for an execution slot.');
    expect(waiting).toContain(`dateTime="${QUEUED}"`);
    const offline = renderToStaticMarkup(<RunStatusNotices run={{ state: 'queued' }} queue={{ queuedAt: QUEUED, reason: 'host_offline' }} integrationDisabled={false} />);
    expect(offline).toContain('The execution host is offline.');
    expect(offline).not.toContain('Waiting for an execution slot.');
    expect(offline).toContain(`dateTime="${QUEUED}"`);
    const unobserved = renderToStaticMarkup(<RunStatusNotices run={{ state: 'queued' }} queue={{ queuedAt: QUEUED, reason: null }} integrationDisabled={false} />);
    expect(unobserved).not.toContain('Waiting for an execution slot.');
    expect(unobserved).toContain(`dateTime="${QUEUED}"`);
  });

  it('reconciling shows the uncertain copy', () => {
    const html = renderToStaticMarkup(<RunStatusNotices run={{ state: 'reconciling' }} queue={null} integrationDisabled={false} />);
    expect(html).toContain('Execution status is uncertain. Review recovery before continuing.');
    expect(html).not.toMatch(/running|completed|succeeded/i);
  });

  it('failed runs show the approved message for their code, never the raw code', () => {
    const limited = renderToStaticMarkup(<RunStatusNotices run={{ state: 'failed', errorCode: 'account_limited' }} queue={null} integrationDisabled={false} />);
    expect(limited).toContain('Your selected tool cannot continue right now. Check its account limits and try again.');
    expect(limited).not.toContain('account_limited');
    const unknown = renderToStaticMarkup(<RunStatusNotices run={{ state: 'failed', errorCode: `ENOENT ${FIXTURE_PATH}` }} queue={null} integrationDisabled={false} />);
    expect(unknown).toContain('Execution failed.');
    expect(unknown).not.toContain(FIXTURE_PATH);
  });

  it('integration_disabled keeps history and disables controls', () => {
    const notice = renderToStaticMarkup(<RunStatusNotices run={{ state: 'failed', errorCode: 'integration_disabled' }} queue={null} integrationDisabled />);
    expect(notice.split('This run requires an integration that is not enabled.').length).toBe(2);
    const controls = renderToStaticMarkup(<SessionControls canSteer canCancel active blockedCode="integration_disabled" onPrompt={() => {}} onCancel={() => {}} />);
    expect(controls).toContain('This run requires an integration that is not enabled.');
    expect(controls).toMatch(/<input[^>]*disabled=""/);
    expect(controls).toMatch(/<button[^>]*disabled=""[^>]*>Send<\/button>/);
    expect(controls).toMatch(/<button[^>]*disabled=""[^>]*>Cancel current turn<\/button>/);
    const live = renderToStaticMarkup(<SessionControls canSteer canCancel active blockedCode={null} onPrompt={() => {}} onCancel={() => {}} />);
    expect(live).not.toContain('disabled=""');
    expect(live).not.toContain('This run requires an integration');
    const viewer = renderToStaticMarkup(<SessionControls canSteer={false} canCancel={false} active blockedCode={null} onPrompt={() => {}} onCancel={() => {}} />);
    expect(viewer).not.toContain('Send');
    expect(viewer).not.toContain('Cancel current turn');
  });

  it('rendered HTML contains no fixture path or token substring', () => {
    const html = [
      renderToStaticMarkup(<ProfileReadinessList mapping={mapping} />),
      renderToStaticMarkup(<ExecutionProfileSummary execution={{ backend: 'codex', model: 'gpt-codex', policy: mapping.profiles![1].policy }} />),
    ].join('');
    expect(html).toContain('approval on-request');
    expect(html).not.toContain(FIXTURE_PATH);
    expect(html).not.toContain(FIXTURE_TOKEN);
    expect(html).not.toContain('configPath');
    expect(html).not.toContain('apiKey');
  });

  it('a start-only reader sees its own wait without profile, model or policy details', () => {
    const html = renderToStaticMarkup(<RunStatusNotices run={{ state: 'queued' }} queue={{ queuedAt: QUEUED, reason: 'capacity' }} integrationDisabled={false} />);
    expect(html).toContain('Waiting for an execution slot.');
    expect(html).not.toMatch(/Backend|Model|Policy|profile/i);
  });
});

describe('native recovery controls', () => {
  const RECOVERY = 'Execution status is uncertain. Cancel it, or send new instructions to continue. Earlier instructions are not sent again.';
  const controls = (props: Partial<React.ComponentProps<typeof SessionControls>> = {}) =>
    renderToStaticMarkup(<SessionControls canSteer canCancel active blockedCode={null} onPrompt={() => {}} onCancel={() => {}} {...props} />);

  it('recognizes only a native backend with a reconciling session in a recoverable run state', () => {
    for (const backend of ['claude-code', 'codex'] as const) {
      for (const runState of ['reconciling', 'cancelled', 'idle', 'queued'] as const) {
        expect(isNativeRecovery({ backend }, runState, 'reconciling'), `${backend} ${runState}`).toBe(true);
      }
      expect(isNativeRecovery({ backend }, 'failed', 'reconciling')).toBe(false);
      expect(isNativeRecovery({ backend }, 'running', 'reconciling')).toBe(false);
      expect(isNativeRecovery({ backend }, 'reconciling', 'running')).toBe(false);
      expect(isNativeRecovery({ backend }, 'reconciling', null)).toBe(false);
    }
    expect(isNativeRecovery({ backend: 'paseo' }, 'reconciling', 'reconciling')).toBe(false);
    expect(isNativeRecovery(null, 'reconciling', 'reconciling')).toBe(false);
  });

  it('recovery offers an explicit cancel and new instructions only, never a turn cancel or steer', () => {
    const html = controls({ recovery: true });
    expect(html).toContain(RECOVERY);
    expect(html).toMatch(/<button[^>]*>Cancel uncertain execution<\/button>/);
    expect(html).toMatch(/<button[^>]*type="submit"[^>]*>Send new instructions<\/button>/);
    expect(html).toContain('placeholder="New instructions to continue…"');
    expect(html).not.toContain('Cancel current turn');
    expect(html).not.toContain('aria-label="Prompt behavior"');
    expect(html).not.toContain('>steer<');
  });

  it('recovery controls follow capabilities and an integration block', () => {
    const cancelOnly = controls({ recovery: true, canSteer: false });
    expect(cancelOnly).toContain('Cancel uncertain execution');
    expect(cancelOnly).not.toContain('Send new instructions');
    const promptOnly = controls({ recovery: true, canCancel: false });
    expect(promptOnly).toContain('Send new instructions');
    expect(promptOnly).not.toContain('Cancel uncertain execution');
    const viewer = controls({ recovery: true, canSteer: false, canCancel: false });
    expect(viewer).not.toContain(RECOVERY);
    expect(viewer).not.toContain('<button');
    const blocked = controls({ recovery: true, blockedCode: 'integration_disabled' });
    expect(blocked).toMatch(/<button[^>]*disabled=""[^>]*>Cancel uncertain execution<\/button>/);
    expect(blocked).toMatch(/<button[^>]*disabled=""[^>]*>Send new instructions<\/button>/);
  });

  it('a legacy or ordinary reconciling session keeps the existing controls', () => {
    const html = controls({ recovery: false });
    expect(html).toContain('Cancel current turn');
    expect(html).toContain('aria-label="Prompt behavior"');
    expect(html).not.toContain('Cancel uncertain execution');
    expect(html).not.toContain(RECOVERY);
  });

  it('a retried intent reuses its idempotency key until it settles; new text gets a new key', () => {
    let n = 0;
    const keys = createIntentKeys(() => `k${++n}`);
    const cancel = { kind: 'cancel' };
    const first = keys.keyFor(cancel);
    expect(keys.keyFor({ kind: 'cancel' })).toBe(first);
    const prompt = { kind: 'prompt', text: 'continue with tests', behavior: 'interrupt' };
    const promptKey = keys.keyFor(prompt);
    expect(promptKey).not.toBe(first);
    expect(keys.keyFor({ kind: 'prompt', text: 'continue with tests', behavior: 'interrupt' })).toBe(promptKey);
    expect(keys.keyFor({ kind: 'prompt', text: 'something else', behavior: 'interrupt' })).not.toBe(promptKey);
    keys.settled(cancel);
    expect(keys.keyFor(cancel)).not.toBe(first);
  });

  it('an unconfirmed recovery prompt keeps its key for the same retried body after the mode changes', () => {
    let n = 0;
    const keys = createIntentKeys(() => `k${++n}`);
    const prompt = { kind: 'prompt', text: 'continue with tests', behavior: 'interrupt' };
    expect(keys.pending(prompt)).toBeUndefined();
    const key = keys.keyFor(prompt);
    expect(keys.pending({ kind: 'prompt', text: 'continue with tests', behavior: 'interrupt' })).toBe(key);
    expect(keys.pending({ kind: 'prompt', text: 'continue with tests', behavior: 'steer' })).toBeUndefined();
    keys.settled(prompt);
    expect(keys.pending(prompt)).toBeUndefined();
  });
});
