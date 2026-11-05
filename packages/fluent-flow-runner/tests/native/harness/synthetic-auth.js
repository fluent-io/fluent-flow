
const DUMMY_API_KEY = 'sk-ant-ff-synthetic-dummy-key';

/**
 * @param {{ fixture: { url: string } }} opts a running anthropic-fixture
 */
export function syntheticClaudeAuth({ fixture }) {
  if (typeof fixture?.url !== 'string' || !fixture.url.startsWith('http://127.0.0.1:')) {
    throw new Error('syntheticClaudeAuth needs a loopback fixture');
  }
  return Object.freeze({
    kind: 'synthetic',
    readiness({ authStatus }) {
      return authStatus?.loggedIn === true && authStatus.apiKeySource === 'ANTHROPIC_API_KEY' ? { state: 'ready' } : { state: 'sign_in_required', reason: 'not_dummy_key' };
    },
    admitInit(init) {
      return init?.account?.apiKeySource === 'ANTHROPIC_API_KEY' ? { ok: true } : { ok: false, reason: 'not_dummy_key' };
    },
    env: () => ({ ANTHROPIC_BASE_URL: fixture.url, ANTHROPIC_API_KEY: DUMMY_API_KEY }),
    args: () => [],
  });
}

const DUMMY_OPENAI_KEY = 'sk-ff-synthetic-dummy-openai-key';

/**
 * @param {{ fixture: { url: string } }} opts a running openai-fixture
 */
export function syntheticCodexAuth({ fixture }) {
  if (typeof fixture?.url !== 'string' || !fixture.url.startsWith('http://127.0.0.1:')) {
    throw new Error('syntheticCodexAuth needs a loopback fixture');
  }
  return Object.freeze({
    kind: 'synthetic',
    readiness({ account }) {
      return account && account.account === null && account.requiresOpenaiAuth === false ? { state: 'ready' } : { state: 'sign_in_required', reason: 'not_synthetic_context' };
    },
    admitsAuthMode: (authMode) => authMode === null || authMode === undefined,
    env: () => ({ FF_PROBE_OPENAI_KEY: DUMMY_OPENAI_KEY }),
    args: () => ({
      model_provider: 'ffprobe',
      'model_providers.ffprobe.name': 'ffprobe',
      'model_providers.ffprobe.base_url': fixture.url,
      'model_providers.ffprobe.env_key': 'FF_PROBE_OPENAI_KEY',
      'model_providers.ffprobe.wire_api': 'responses',
      'model_providers.ffprobe.requires_openai_auth': false,
    }),
  });
}
