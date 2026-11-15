import { it, expect } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAcpRuntime } from '../../src/acp/runtime.js';
const fixture = join(dirname(fileURLToPath(import.meta.url)), 'fake-acp-agent.js');
it('resolves only local profiles/models and rejects remote process injection', async () => {
  const { validateChatProfiles, resolveChatProfile } = await import('../../src/chat-profiles.js');
  const profiles = validateChatProfiles([{ id: 'safe', permission: { configId: 'approval', value: 'ask' }, modelConfigId: 'model', models: ['small', 'large'], defaultModel: 'small' }]);
  expect(resolveChatProfile(profiles, { profile: 'safe', model: 'large' })).toMatchObject({ model: 'large', permission: { value: 'ask' } });
  expect(() => resolveChatProfile(profiles, { profile: 'safe', model: 'unknown' })).toThrow();
  expect(() => resolveChatProfile(profiles, { profile: 'safe', env: { BAD: '1' } })).toThrow();
  expect(() => validateChatProfiles([{ id: 'unsafe', permission: { configId: 'mode', value: 'bypass' }, models: [] }])).toThrow();
});
it('bounds programmatic catalogs to the file/remote contract and projects no private settings', async () => {
  const { validateChatProfiles, advertisedChatProfiles } = await import('../../src/chat-profiles.js');
  const profile = { id: 'safe', permission: { configId: 'approval', value: 'ask' }, models: [] };
  expect(advertisedChatProfiles(validateChatProfiles([profile]))).toEqual([{ id: 'safe', models: [] }]);
  expect(() => validateChatProfiles([{ ...profile, defaultModel: 'absent' }])).toThrow();
  const large = Array.from({ length: 32 }, (_, i) => ({ ...profile, id: `p${i}`, modelConfigId: 'model',
    models: Array.from({ length: 100 }, (_, m) => `m${m}-${'x'.repeat(100)}`), defaultModel: `m0-${'x'.repeat(100)}` }));
  expect(() => validateChatProfiles(large)).toThrow();
});
it('validates advertised provider config and applies ask/model before allowing any prompt', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ff-chat-policy-'));
  const runtime = createAcpRuntime({ command: { bin: process.execPath, args: [fixture, '--scenario', 'chat-policy'] }, cwd: root,
    env: { PATH: process.env.PATH }, sessionPolicy: { permission: { configId: 'approval', value: 'ask' }, modelConfigId: 'model', model: 'large' } });
  try {
    await runtime.openSession();
    expect(runtime.sessionConfiguration).toEqual(expect.arrayContaining([
      expect.objectContaining({ configId: 'approval', currentValue: 'ask' }), expect.objectContaining({ configId: 'model', currentValue: 'large' }),
    ]));
  } finally { await runtime.close(); await rm(root, { recursive: true, force: true }); }
});
it('terminates when provider config drifts out of the pinned ask mode', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ff-chat-policy-'));
  const runtime = createAcpRuntime({ command: { bin: process.execPath, args: [fixture, '--scenario', 'chat-policy', '--drift', 'yes'] }, cwd: root,
    env: { PATH: process.env.PATH }, sessionPolicy: { permission: { configId: 'approval', value: 'ask' } } });
  try { await runtime.openSession(); await expect(runtime.prompt('Keep permissions')).rejects.toThrow(); }
  finally { await runtime.close(); await rm(root, { recursive: true, force: true }); }
});
it('fails closed when a provider cannot confirm the required permission mode', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ff-chat-policy-'));
  const runtime = createAcpRuntime({ command: { bin: process.execPath, args: [fixture] }, cwd: root,
    env: { PATH: process.env.PATH }, sessionPolicy: { permission: { configId: 'approval', value: 'ask' } } });
  try { await expect(runtime.openSession()).rejects.toThrow(/policy|config|permission/i); }
  finally { await runtime.close(); await rm(root, { recursive: true, force: true }); }
});
