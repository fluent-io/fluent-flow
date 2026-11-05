
export function chatgptSubscriptionAuth() {
  return Object.freeze({
    kind: 'subscription',
    /** @param {{ account: any }} input the `account/read` result */
    readiness({ account }) {
      const type = account?.account?.type;
      if (type === undefined || type === null) return { state: 'sign_in_required', reason: 'no_account' };
      if (type !== 'chatgpt') return { state: 'sign_in_required', reason: 'account_not_subscription' };
      return { state: 'ready' };
    },
    /** @param {string|null|undefined} authMode from `account/updated` */
    admitsAuthMode: (authMode) => authMode === 'chatgpt',
    env: () => ({}),
    args: () => ({}),
  });
}
