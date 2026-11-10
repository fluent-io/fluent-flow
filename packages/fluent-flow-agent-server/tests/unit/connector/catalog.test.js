import { describe, it, expect } from 'vitest';
import { buildCatalog } from '../../../src/connector/catalog.js';

const profiles = [
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

function fakePaseo() {
  return {
    config: {
      get: async () => ({
        requestId: 'r',
        config: {
          agentProfiles: profiles,
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
      paseo: fakePaseo(),
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
      paseo: fakePaseo(),
    });
    expect(JSON.stringify(catalog)).not.toContain('supersecret');
    expect(JSON.stringify(catalog)).not.toContain('internal notes');
  });

  it('fails fast when an allowlisted profile does not exist in the daemon config', async () => {
    await expect(
      buildCatalog({
        config: { repositories: {}, profiles: ['agent_profile_missing'] },
        paseo: fakePaseo(),
      }),
    ).rejects.toThrow(/agent_profile_missing/);
  });
});
