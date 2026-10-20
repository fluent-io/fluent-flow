/**
 * Transport-security guard shared by the connector config loader and API
 * client: the host bearer token must only travel over https, except plain
 * http to loopback hosts (local smoke/isolated control plane). Server URLs
 * embedding userinfo credentials are always rejected — credentials go in the
 * Authorization header or nowhere.
 */

function isLoopbackHost(hostname) {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host === '::1' || host === '::') return true;
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  // IPv4-mapped IPv6 loopback (::ffff:127.x.x.x).
  const mapped = host.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (mapped) return /^127\./.test(mapped[1]);
  return false;
}

/**
 * Validate a control-plane base URL. Returns the normalized URL string
 * (trailing slashes stripped). Throws before any token is read or sent.
 */
export function assertSafeServerUrl(serverUrl) {
  let url;
  try {
    url = new URL(serverUrl);
  } catch {
    throw new Error('Connector serverUrl must be a valid absolute http(s) URL');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('Connector serverUrl must use http or https');
  }
  if (url.username || url.password) {
    throw new Error('Connector serverUrl must not contain embedded URL credentials');
  }
  if (url.protocol === 'http:' && !isLoopbackHost(url.hostname)) {
    throw new Error('Connector serverUrl must use https except on loopback hosts');
  }
  return serverUrl.replace(/\/+$/, '');
}
