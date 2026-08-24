import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockExecFile = vi.fn();
vi.mock('node:child_process', () => ({
  execFile: (...args) => mockExecFile(...args),
}));

import { checkRunnerHealth, sendAlert } from '../../src/health.js';
import { parseHarnessResult } from '../../src/runner.js';

function execResult({ ok = true, stdout = '', stderr = '' } = {}) {
  return (cmd, args, opts, cb) => cb(ok ? null : new Error(stderr || 'failed'), stdout, stderr);
}

beforeEach(() => {
  vi.resetAllMocks();
  delete process.env.FLUENT_FLOW_ALERT_WEBHOOK_URL;
});

describe('checkRunnerHealth', () => {
  it('unhealthy when claude is present but reports an error result (the "Not logged in" case)', async () => {
    mockExecFile.mockImplementation((cmd, args, opts, cb) => {
      if (cmd === 'which') return cb(null, '/usr/bin/claude\n', '');
      if (cmd === 'claude') {
        return cb(null, JSON.stringify({ type: 'result', subtype: 'success', is_error: true, result: 'Not logged in · Please run /login' }), '');
      }
      return cb(new Error('unexpected'), '', '');
    });

    const health = await checkRunnerHealth();
    expect(health.healthy).toBe(false);
    expect(health.harness.detail).toContain('Not logged in');
  });

  it('healthy when claude responds with a clean result envelope', async () => {
    mockExecFile.mockImplementation((cmd, _args, _opts, cb) => {
      if (cmd === 'which') return cb(null, '/usr/bin/claude\n', '');
      if (cmd === 'claude') {
        return cb(null, JSON.stringify({ type: 'result', is_error: false, result: 'OK' }), '');
      }
      if (cmd === 'gh') return cb(null, 'github.com\n ✓ Logged in', '');
      return cb(new Error('unexpected'), '', '');
    });

    const health = await checkRunnerHealth();
    expect(health.healthy).toBe(true);
    expect(health.gh.ok).toBe(true);
  });

  it('unhealthy when no harness binary exists on PATH', async () => {
    mockExecFile.mockImplementation((_cmd, _args, _opts, cb) => cb(new Error('not found'), '', ''));
    const health = await checkRunnerHealth();
    expect(health.healthy).toBe(false);
    expect(health.harness.detail).toContain('no harness binary found');
  });
});

describe('sendAlert', () => {
  it('posts the alert to FLUENT_FLOW_ALERT_WEBHOOK_URL and never throws', async () => {
    process.env.FLUENT_FLOW_ALERT_WEBHOOK_URL = 'https://hooks.example/x';
    const origFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true });
    try {
      const res = await sendAlert('startup-health-check-failed', { harness: { ok: false } });
      expect(res).toEqual({ sent: true, configured: true });
      const [url, init] = globalThis.fetch.mock.calls[0];
      expect(url).toBe('https://hooks.example/x');
      expect(JSON.parse(init.body).text).toContain('startup-health-check-failed');
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it('is a no-op (but logs) when no webhook is configured', async () => {
    const res = await sendAlert('harness-error-result', {});
    expect(res).toEqual({ sent: false, configured: false });
  });

  it('survives webhook failures', async () => {
    process.env.FLUENT_FLOW_ALERT_WEBHOOK_URL = 'https://hooks.example/x';
    const origFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('network down'));
    try {
      const res = await sendAlert('health-check-failed', {});
      expect(res).toEqual({ sent: false, configured: true });
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});

describe('parseHarnessResult', () => {
  it('extracts a claude result envelope', () => {
    const env = parseHarnessResult(JSON.stringify({ type: 'result', subtype: 'success', is_error: true, result: 'Not logged in' }));
    expect(env.is_error).toBe(true);
    expect(env.result).toBe('Not logged in');
  });

  it('returns null for plain stdout', () => {
    expect(parseHarnessResult('just review text')).toBeNull();
    expect(parseHarnessResult('{"type":"other"}')).toBeNull();
  });
});
