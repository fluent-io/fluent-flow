/** Display-only redaction of local context already known to this connector.
 * Native SDK inputs are never passed through this transform.
 * @param {{sourceRoots?: string[], paseoHome?: string, secrets?: string[]}} [options]
 */
export function createObservationPrivacy({ sourceRoots = [], paseoHome, secrets = [] } = {}) {
  const roots = new Map();
  const knownSecrets = new Set();
  function addRoot(path, display) {
    if (typeof path === 'string' && path.startsWith('/') && path !== '/') roots.set(path.replace(/\/+$/, ''), display);
  }
  function addSecret(value) {
    if (typeof value === 'string' && value.length > 0) knownSecrets.add(value);
  }
  for (const root of sourceRoots) addRoot(root, '[source]');
  addRoot(paseoHome, '[paseo-home]');
  for (const secret of secrets) addSecret(secret);

  function text(value) {
    let out = value;
    for (const secret of [...knownSecrets].sort((a, b) => b.length - a.length)) out = out.split(secret).join('[redacted]');
    for (const [root, display] of [...roots].sort(([a], [b]) => b.length - a.length)) out = out.split(root).join(display);
    return out;
  }
  function redact(value) {
    if (typeof value === 'string') return text(value);
    if (Array.isArray(value)) return value.map(redact);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redact(item)]));
    return value;
  }
  return {
    addSecret,
    addWorkspace: (path) => addRoot(path, '[workspace]'),
    redact,
    observation: (event) => ({ ...event, payload: redact(event.payload) }),
  };
}
