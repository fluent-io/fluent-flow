/**
 * HTTP client for the Fluent Flow connector control plane (/api/connector/v1).
 *
 * The connector is outbound-only: it registers, heartbeats, long-polls for
 * commands, acknowledges them and posts execution observations. The host token
 * is bound to one enrolled host; there is no hostId body override anywhere in
 * this protocol — the server derives the host from the credential.
 *
 * Errors are typed: ConnectorApiError carries the HTTP status and the server's
 * machine-readable error code so the loop can distinguish stale-fence 409s and
 * revoked-token 401s from transient network failures.
 *
 * @param {object} opts
 * @param {string} opts.serverUrl - Fluent Flow server base URL
 * @param {string} opts.token - host connector token (never logged)
 * @param {Function} [opts.fetch] fetch implementation (default: globalThis.fetch)
 */
import { assertSafeServerUrl } from './url-guard.js';

export class ConnectorApiError extends Error {
  constructor(label, status, code, message) {
    super(`${label} failed: ${status}${code ? ` (${code})` : ''}`);
    this.name = 'ConnectorApiError';
    this.status = status;
    this.code = code ?? null;
  }
}

export function createConnectorClient({ serverUrl, token, fetch: fetchFn = globalThis.fetch }) {
  const base = assertSafeServerUrl(serverUrl);
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
  };

  async function post(path, body, label, timeoutMs, signal) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const onExternalAbort = () => controller.abort(signal.reason);
    if (signal) {
      if (signal.aborted) onExternalAbort();
      else signal.addEventListener('abort', onExternalAbort, { once: true });
    }
    let res;
    try {
      res = await fetchFn(`${base}${path}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      if (signal?.aborted) {
        throw Object.assign(new Error(`${label} aborted`), { name: 'AbortError', causedByExternal: true });
      }
      const reason = err?.message ? `: ${err.message}${err.cause?.code ? ` [${err.cause.code}]` : ''}` : '';
      const message = controller.signal.aborted
        ? `${label} request failed after ${timeoutMs}ms${reason}`
        : `${label} request failed${reason}`;
      throw new Error(message, { cause: err });
    } finally {
      clearTimeout(timeout);
      if (signal) signal.removeEventListener('abort', onExternalAbort);
    }
    if (!res.ok) {
      let code = null;
      try {
        const parsed = await res.json();
        code = parsed?.error?.code ?? null;
      } catch {
        // Non-JSON error body: status alone is still meaningful.
      }
      throw new ConnectorApiError(label, res.status, code);
    }
    const envelope = await res.json();
    // Canonical REST envelope from the control plane: successes are
    // {data: T}; the connector works on T.
    return envelope && typeof envelope === 'object' && 'data' in envelope ? envelope.data : envelope;
  }

  return {
    /** Register this connector instance for its host. */
    register: (body, opts) => post('/api/connector/v1/register', body, 'Register', 15_000, opts?.signal),

    /** Heartbeat with the current lease fence and active run ids. */
    heartbeat: (body, opts) => post('/api/connector/v1/heartbeat', body, 'Heartbeat', 10_000, opts?.signal),

    /** Long-poll for commands (server holds the request up to waitMs). */
    poll: (body, opts) => post('/api/connector/v1/poll', body, 'Poll', (body.waitMs ?? 25_000) + 10_000, opts?.signal),

    /** Acknowledge a command with a terminal or ambiguous state + fence. */
    ack: (commandId, body, opts) => post(`/api/connector/v1/commands/${encodeURIComponent(commandId)}/ack`, body, 'Ack', 10_000, opts?.signal),

    /** Post a batch of execution observations; server dedupes by eventId. */
    observe: (body, opts) => post('/api/connector/v1/observations', body, 'Observations', 15_000, opts?.signal),
  };
}
