/**
 * HTTP client for the Fluent Flow runner API.
 * Wraps the three runner endpoints: register, poll, reportClaim.
 *
 * @param {object} opts
 * @param {string} opts.serverUrl — Fluent Flow server base URL
 * @param {string} opts.token — Agent token (ff_...)
 * @param {Function} [opts.fetch] — fetch implementation (default: globalThis.fetch)
 * @returns {{ register, poll, reportClaim }}
 */
export function createClient({ serverUrl, token, fetch: fetchFn = globalThis.fetch }) {
  const base = serverUrl.replace(/\/+$/, '');
  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${token}`,
  };

  async function post(path, body, label) {
    const timeoutMs = 35_000;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    let res;
    try {
      res = await fetchFn(`${base}${path}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      const reason = err?.message ? `: ${err.message}` : '';
      const message = controller.signal.aborted
        ? `${label} request failed after ${timeoutMs}ms${reason}`
        : `${label} request failed${reason}`;
      throw new Error(message, { cause: err });
    } finally {
      clearTimeout(timeout);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`${label} failed: ${res.status}${text ? ` — ${text}` : ''}`);
    }
    return res.json();
  }

  return {
    /**
     * Register a session with the server.
     * @param {object} meta — { hostname, os, cwd }
     * @returns {Promise<{ ok, session_id, status }>}
     */
    register: (meta) => post('/api/runner/register', { meta }, 'Register'),

    /**
     * Long-poll for work.
     * @param {number} sessionId
     * @returns {Promise<object|null>} — claim payload or null
     */
    poll: async (sessionId) => {
      const data = await post('/api/runner/poll', { session_id: sessionId }, 'Poll');
      return data.work ?? null;
    },

    /**
     * Heartbeat while a claim executes — extends the session TTL and the
     * claim's expiry on the server so long agent runs aren't re-dispatched
     * mid-flight.
     * @param {number} sessionId
     * @param {number} claimId
     * @returns {Promise<{ ok: boolean }>}
     */
    heartbeat: (sessionId, claimId) => post('/api/runner/heartbeat', { session_id: sessionId, claim_id: claimId }, 'Heartbeat'),

    /**
     * Report a claim result back to the server.
     * @param {object} claim — { status, repo, pr_number, attempt }
     * @returns {Promise<{ ok, claim_id, status }>}
     */
    reportClaim: (claim) => post('/api/runner/claim', claim, 'Claim report'),

  };
}
