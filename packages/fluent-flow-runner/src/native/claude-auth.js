
export const CLAUDE_SUBSCRIPTION_AUTH_METHODS = Object.freeze(['claude.ai']);

const absent = (value) => value === undefined || value === null;

export function claudeSubscriptionAuth() {
  return Object.freeze({
    kind: 'subscription',
    /** @param {{ authStatus: any }} input C10 shape */
    readiness({ authStatus }) {
      if (authStatus?.loggedIn !== true) return { state: 'sign_in_required', reason: 'not_logged_in' };
      if (!CLAUDE_SUBSCRIPTION_AUTH_METHODS.includes(authStatus.authMethod)) return { state: 'sign_in_required', reason: 'auth_method_not_subscription' };
      if (authStatus.apiProvider !== 'firstParty') return { state: 'sign_in_required', reason: 'api_provider_not_first_party' };
      if (!absent(authStatus.apiKeySource)) return { state: 'sign_in_required', reason: 'api_key_source_present' };
      return { state: 'ready' };
    },
    /** @param {{ account?: { tokenSource?: string, apiKeySource?: string, apiProvider?: string, subscriptionType?: string } }} init */
    admitInit(init) {
      const account = init?.account;
      if (!account || typeof account !== 'object') return { ok: false, reason: 'auth_source_unreported' };
      if (account.apiProvider !== 'firstParty') return { ok: false, reason: 'api_provider_not_first_party' };
      if (!absent(account.apiKeySource)) return { ok: false, reason: 'api_key_source_present' };
      if (!absent(account.tokenSource)) return { ok: false, reason: 'token_source_not_subscription' };
      if (typeof account.subscriptionType !== 'string' || account.subscriptionType === '') return { ok: false, reason: 'subscription_unreported' };
      return { ok: true };
    },
    env: () => ({}),
    args: () => [],
  });
}
