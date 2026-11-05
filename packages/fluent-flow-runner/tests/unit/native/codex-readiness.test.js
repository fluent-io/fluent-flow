import { describe, it, expect } from 'vitest';
import { admitCodexThread, createCodexBackend } from '../../../src/native/codex-backend.js';
import { chatgptSubscriptionAuth } from '../../../src/native/codex-auth.js';

const CHATGPT = { account: { type: 'chatgpt', email: null, planType: 'plus' }, requiresOpenaiAuth: true };
const API_KEY = { account: { type: 'apiKey' }, requiresOpenaiAuth: true };

const profile = (approvalPolicy = 'on-request', overrides = {}) => ({
  id: 'codex-a',
  name: 'Codex A',
  backend: 'codex',
  executable: '/opt/codex/bin/codex',
  contextDir: '/home/owner/.ff/codex-a',
  model: 'gpt-5.5-codex',
  policy: { approvalPolicy, sandbox: 'workspace-write', networkAccess: false },
  complete: true,
  ...overrides,
});

function recordingLog() {
  const lines = [];
  const write = (level) => (obj) => lines.push({ level, ...obj });
  return { lines, info: write('info'), warn: write('warn'), error: write('error'), debug: write('debug') };
}

function backend({ platform = 'linux', version = '0.162.1', account = CHATGPT, log = recordingLog() } = {}) {
  const calls = { version: 0, account: 0 };
  const b = createCodexBackend({
    log,
    auth: chatgptSubscriptionAuth(),
    platform,
    readVersion: async () => {
      calls.version += 1;
      return version;
    },
    readAccount: async () => {
      calls.account += 1;
      return account;
    },
  });
  return { b, calls, log };
}

describe('codex readiness (production policy)', () => {
  it('an unpinned version is incompatible', async () => {
    const { b, calls } = backend({ version: '0.162.2' });
    expect(await b.readiness(profile())).toEqual({ state: 'incompatible', version: '0.162.2' });
    expect(calls.account).toBe(0);
    const missing = createCodexBackend({ log: recordingLog(), auth: chatgptSubscriptionAuth(), platform: 'linux', readVersion: async () => Promise.reject(Object.assign(new Error('x'), { code: 'ENOENT' })), readAccount: async () => CHATGPT });
    expect(await missing.readiness(profile())).toEqual({ state: 'not_installed' });
    expect(await backend({ platform: 'darwin' }).b.readiness(profile())).toEqual({ state: 'platform_unsupported' });
  });

  it('an apiKey account is sign_in_required', async () => {
    expect((await backend({ account: API_KEY }).b.readiness(profile())).state).toBe('sign_in_required');
    expect((await backend({ account: { account: null, requiresOpenaiAuth: false } }).b.readiness(profile())).state).toBe('sign_in_required');
    expect((await backend({ account: { account: { type: 'amazonBedrock', usesCodexManagedCredentials: true }, requiresOpenaiAuth: false } }).b.readiness(profile())).state).toBe('sign_in_required');
    const unreadable = createCodexBackend({ log: recordingLog(), auth: chatgptSubscriptionAuth(), platform: 'linux', readVersion: async () => '0.162.1', readAccount: async () => Promise.reject(new Error('closed')) });
    expect((await unreadable.readiness(profile())).state).toBe('sign_in_required');
    const { b, calls } = backend();
    expect(await b.readiness(profile())).toEqual({ state: 'ready', version: '0.162.1' });
    expect(calls.account).toBe(1);
  });

  it('the production policy adds no env or config overlay and admits only the chatgpt auth mode', () => {
    const auth = chatgptSubscriptionAuth();
    expect(auth.env()).toEqual({});
    expect(auth.args()).toEqual({});
    expect(auth.admitsAuthMode('chatgpt')).toBe(true);
    for (const mode of ['apikey', 'chatgptAuthTokens', 'headers', 'agentIdentity', 'personalAccessToken', 'bedrockApiKey', null, undefined]) {
      expect(auth.admitsAuthMode(mode), String(mode)).toBe(false);
    }
  });

  it('a thread/start response with another model, approval policy or sandbox is profile_unavailable', () => {
    const worktree = '/srv/ff/worktrees/run-1';
    const started = {
      thread: { id: 't1', cwd: worktree },
      model: 'gpt-5.5-codex',
      approvalPolicy: 'on-request',
      sandbox: { type: 'workspaceWrite', writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false },
    };
    expect(admitCodexThread({ profile: profile(), started, worktree })).toEqual({ ok: true });
    const refused = (s) => admitCodexThread({ profile: profile(), started: s, worktree });
    expect(refused({ ...started, model: 'gpt-5.4' })).toMatchObject({ ok: false, code: 'profile_unavailable', reason: 'model_mismatch' });
    expect(refused({ ...started, approvalPolicy: 'never' })).toMatchObject({ ok: false, code: 'profile_unavailable', reason: 'approval_policy_mismatch' });
    expect(refused({ ...started, sandbox: { type: 'readOnly', networkAccess: false } })).toMatchObject({ ok: false, code: 'profile_unavailable', reason: 'sandbox_mismatch' });
    expect(refused({ ...started, sandbox: { ...started.sandbox, networkAccess: true } })).toMatchObject({ ok: false, code: 'profile_unavailable', reason: 'sandbox_mismatch' });
    expect(refused({ ...started, thread: { id: 't1', cwd: '/srv/ff/worktrees/other' } })).toMatchObject({ ok: false, code: 'startup_failed', reason: 'thread_cwd_mismatch' });
  });

  it('an approval policy recorded as refused for reporting or questions is invalid_config, and so is an unrecorded one', async () => {
    const blocked = backend();
    expect(await blocked.b.readiness(profile('never'))).toEqual({ state: 'invalid_config', version: '0.162.1' });
    expect(blocked.log.lines.map((l) => l.reason)).toContain('required_capability_blocked');
    const unproven = backend();
    expect(await unproven.b.readiness(profile('on-failure'))).toEqual({ state: 'invalid_config', version: '0.162.1' });
    expect(unproven.log.lines.map((l) => l.reason)).toContain('required_capability_unproven');
    expect(blocked.calls.account + unproven.calls.account).toBe(0);
    expect(JSON.stringify(await backend().b.readiness(profile('never')))).not.toMatch(/required_capability/);
  });
});
