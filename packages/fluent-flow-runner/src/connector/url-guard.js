
function isLoopbackHost(hostname) {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host === '::1' || host === '::') return true;
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  const mapped = host.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (mapped) return /^127\./.test(mapped[1]);
  return false;
}

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
