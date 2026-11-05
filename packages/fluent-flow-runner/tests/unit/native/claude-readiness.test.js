import { describe, it, expect } from 'vitest';
import { admitClaudeInit, createClaudeBackend } from '../../../src/native/claude-backend.js';
import { claudeSubscriptionAuth } from '../../../src/native/claude-auth.js';

const API_KEY_STATUS = { loggedIn: true, authMethod: 'api_key', apiProvider: 'firstParty', apiKeySource: 'ANTHROPIC_API_KEY' };
const SUBSCRIPTION_STATUS = { loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty' };

const profile = (permissionMode = 'manual', model = 'claude-opus-5-5') => ({
  id: 'claude-a',
  name: 'Claude A',
  backend: 'claude-code',
  executable: '/opt/claude/bin/claude',
  contextDir: '/home/owner/.ff/claude-a',
  model,
  policy: { permissionMode },
  complete: true,
});

function recordingLog() {
  const lines = [];
  const write = (level) => (obj) => lines.push({ level, ...obj });
  return { lines, info: write('info'), warn: write('warn'), error: write('error'), debug: write('debug') };
}

function backend({ platform = 'linux', version = '2.1.317', authStatus = SUBSCRIPTION_STATUS, log = recordingLog() } = {}) {
  const calls = { version: 0, authStatus: 0 };
  const b = createClaudeBackend({
    privateDir: '/run/ff-test/sessions',
    log,
    auth: claudeSubscriptionAuth(),
    platform,
    readVersion: async () => {
      calls.version += 1;
      return version;
    },
    readAuthStatus: async () => {
      calls.authStatus += 1;
      return authStatus;
    },
  });
  return { b, calls, log };
}

describe('claude readiness (production policy)', () => {
  it('an unpinned version is incompatible', async () => {
    const { b } = backend({ version: '2.1.318' });
    expect(await b.readiness(profile())).toEqual({ state: 'incompatible', version: '2.1.318' });
  });

  it('API-key auth is sign_in_required', async () => {
    const apiKey = backend({ authStatus: API_KEY_STATUS });
    expect((await apiKey.b.readiness(profile())).state).toBe('sign_in_required');
    const loggedOut = backend({ authStatus: { loggedIn: false, authMethod: 'none', apiProvider: 'firstParty' } });
    expect((await loggedOut.b.readiness(profile())).state).toBe('sign_in_required');
    const subscriptionWithKey = backend({ authStatus: { ...SUBSCRIPTION_STATUS, apiKeySource: 'ANTHROPIC_API_KEY' } });
    expect((await subscriptionWithKey.b.readiness(profile())).state).toBe('sign_in_required');
    const subscription = backend();
    expect(await subscription.b.readiness(profile())).toEqual({ state: 'ready', version: '2.1.317' });
  });

  it('non-Linux is platform_unsupported', async () => {
    const { b, calls } = backend({ platform: 'darwin' });
    expect((await b.readiness(profile())).state).toBe('platform_unsupported');
    expect(calls).toEqual({ version: 0, authStatus: 0 });
  });

  it('manual reported as default in init is accepted, and another init mode or model is profile_unavailable', () => {
    const auth = { readiness: () => ({ state: 'ready' }), admitInit: () => ({ ok: true }) };
    const init = {
      model: 'claude-opus-5-5',
      authStatus: SUBSCRIPTION_STATUS,
      permissionMode: 'default',
      account: { tokenSource: 'claude.ai', apiKeySource: 'none', apiProvider: 'firstParty' },
      mcpServers: [{ name: 'ff_reporting', status: 'connected' }],
    };
    expect(admitClaudeInit({ profile: profile('manual'), init, auth })).toEqual({ ok: true });
    expect(admitClaudeInit({ profile: profile('acceptEdits'), init: { ...init, permissionMode: 'acceptEdits' }, auth })).toEqual({ ok: true });

    const otherMode = admitClaudeInit({ profile: profile('manual'), init: { ...init, permissionMode: 'acceptEdits' }, auth });
    expect(otherMode).toMatchObject({ ok: false, code: 'profile_unavailable' });
    const manualLiteral = admitClaudeInit({ profile: profile('manual'), init: { ...init, permissionMode: 'manual' }, auth });
    expect(manualLiteral).toMatchObject({ ok: false, code: 'profile_unavailable' });
    const otherModel = admitClaudeInit({ profile: profile('manual'), init: { ...init, model: 'claude-sonnet-5-5' }, auth });
    expect(otherModel).toMatchObject({ ok: false, code: 'profile_unavailable' });

    const reporterDown = admitClaudeInit({ profile: profile(), init: { ...init, mcpServers: [{ name: 'ff_reporting', status: 'failed' }] }, auth });
    expect(reporterDown).toMatchObject({ ok: false, code: 'startup_failed' });
    const refusedAuth = admitClaudeInit({ profile: profile(), init, auth: { readiness: () => ({ state: 'ready' }), admitInit: () => ({ ok: false, reason: 'api_key_source' }) } });
    expect(refusedAuth).toMatchObject({ ok: false, code: 'sign_in_required' });
  });

  it('a permission mode recorded as refused for reporting or questions is invalid_config with required_capability_blocked', async () => {
    const { b, log } = backend();
    const result = await b.readiness(profile('dontAsk'));
    expect(result).toEqual({ state: 'invalid_config', version: '2.1.317' });
    expect(log.lines.some((l) => l.reason === 'required_capability_blocked')).toBe(true);
  });

  it('an unrecorded mode, or an unproven entry such as auto reporting, is invalid_config with required_capability_unproven', async () => {
    for (const mode of ['auto', 'ffUnrecordedMode']) {
      const { b, log } = backend();
      const result = await b.readiness(profile(mode));
      expect(result).toEqual({ state: 'invalid_config', version: '2.1.317' });
      expect(log.lines.filter((l) => l.reason).map((l) => l.reason)).toEqual(['required_capability_unproven']);
    }
  });

  it('claudeSubscriptionAuth admits only the pinned subscription shapes', () => {
    const auth = claudeSubscriptionAuth();
    expect(auth.admitInit({ account: { subscriptionType: 'Claude Max', apiProvider: 'firstParty' } })).toEqual({ ok: true });
    const refused = [
      undefined,
      {},
      { tokenSource: 'none', apiKeySource: 'ANTHROPIC_API_KEY', apiProvider: 'firstParty' },
      { tokenSource: 'claude.ai', apiProvider: 'firstParty' },
      { tokenSource: 'CLAUDE_CODE_OAUTH_TOKEN', apiProvider: 'firstParty' },
      { tokenSource: 'apiKeyHelper', apiProvider: 'firstParty' },
      { tokenSource: 'ANTHROPIC_AUTH_TOKEN', apiProvider: 'firstParty' },
      { tokenSource: 'claude.ai', subscriptionType: 'Claude Pro', apiProvider: 'firstParty' },
      { tokenSource: 'CLAUDE_CODE_OAUTH_TOKEN', subscriptionType: 'Claude Pro', apiProvider: 'firstParty' },
      { tokenSource: 'none', subscriptionType: 'Claude Pro', apiProvider: 'firstParty' },
      { subscriptionType: 'Claude Pro', apiKeySource: 'apiKeyHelper', apiProvider: 'firstParty' },
      { subscriptionType: 'Claude Pro', apiKeySource: '/login managed key', apiProvider: 'firstParty' },
      { subscriptionType: 'Claude Pro', apiProvider: 'bedrock' },
      { subscriptionType: '', apiProvider: 'firstParty' },
      { apiProvider: 'firstParty' },
    ];
    for (const account of refused) expect(auth.admitInit({ account }).ok, JSON.stringify(account)).toBe(false);

    for (const authMethod of ['oauth_token', 'api_key_helper', 'api_key', 'third_party', 'none', 'Claude.ai']) {
      expect(auth.readiness({ authStatus: { ...SUBSCRIPTION_STATUS, authMethod } }).state, authMethod).toBe('sign_in_required');
    }
    expect(auth.readiness({ authStatus: SUBSCRIPTION_STATUS }).state).toBe('ready');
  });

  it('a subscription-like init account with a fresh auth status other than claude.ai is sign_in_required', () => {
    const auth = claudeSubscriptionAuth();
    const init = {
      model: 'claude-opus-5-5',
      permissionMode: 'default',
      account: { subscriptionType: 'Claude Max', apiProvider: 'firstParty' },
      mcpServers: [{ name: 'ff_reporting', status: 'connected' }],
    };
    const p = profile('manual');
    expect(admitClaudeInit({ profile: p, init: { ...init, authStatus: SUBSCRIPTION_STATUS }, auth })).toEqual({ ok: true });
    for (const authStatus of [
      { loggedIn: true, authMethod: 'oauth_token', apiProvider: 'firstParty' },
      { loggedIn: true, authMethod: 'api_key', apiProvider: 'firstParty', apiKeySource: 'ANTHROPIC_API_KEY' },
      { loggedIn: false, authMethod: 'none', apiProvider: 'firstParty' },
      null,
      undefined,
    ]) {
      expect(admitClaudeInit({ profile: p, init: { ...init, authStatus }, auth }), JSON.stringify(authStatus)).toMatchObject({ ok: false, code: 'sign_in_required' });
    }
  });
});
