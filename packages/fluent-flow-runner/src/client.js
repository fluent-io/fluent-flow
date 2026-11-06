export function createClient({ serverUrl, token, fetch: fetchFn = globalThis.fetch }) {
  const base = serverUrl.replace(/\/+$/, '');
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
  };
  async function post(path, body, label, { signal } = {}) {
    const timeoutMs = 35_000;
    const controller = new AbortController();
    const forwardAbort = () => controller.abort();
    if (signal?.aborted) forwardAbort();
    else signal?.addEventListener('abort', forwardAbort, { once: true });
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      response = await fetchFn(`${base}${path}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (error) {
      const reason = error?.message ? `: ${error.message}` : '';
      const message = controller.signal.aborted && !signal?.aborted
        ? `${label} request failed after ${timeoutMs}ms${reason}`
        : `${label} request failed${reason}`;
      throw new Error(message, { cause: error });
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', forwardAbort);
    }
    if (!response.ok) throw new Error(`${label} failed: ${response.status}`);
    return response.json();
  }

  return {
    register: (meta) => post('/api/runner/register', { meta }, 'Register'),
    poll: async (sessionId) => {
      const data = await post('/api/runner/poll', { session_id: sessionId }, 'Poll');
      return data.work ?? null;
    },
    heartbeat: (sessionId, claimId) => post(
      '/api/runner/heartbeat',
      { session_id: sessionId, claim_id: claimId },
      'Heartbeat',
    ),
    reportClaim: (claim) => post('/api/runner/claim', claim, 'Claim report'),
    postClaimEvents: (sessionId, claimId, events) => post(
      `/api/runner/claims/${encodeURIComponent(claimId)}/events`,
      { session_id: sessionId, events },
      'Claim events',
    ),
    postClaimRequest: (sessionId, claimId, request) => post(
      `/api/runner/claims/${encodeURIComponent(claimId)}/requests`,
      { session_id: sessionId, request },
      'Claim request',
    ),
    pollClaimCommands: (sessionId, claimId, options) => post(
      `/api/runner/claims/${encodeURIComponent(claimId)}/commands/poll`,
      { session_id: sessionId },
      'Claim commands',
      options,
    ),
    ackClaimCommand: (sessionId, claimId, commandId, status, result, options) => post(
      `/api/runner/claims/${encodeURIComponent(claimId)}/commands/${encodeURIComponent(commandId)}/ack`,
      { session_id: sessionId, status, result },
      'Claim command acknowledgement',
      options,
    ),
  };
}
