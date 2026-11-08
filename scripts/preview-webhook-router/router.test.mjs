import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { createServer, request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import * as router from './router.mjs';

const {
  classifyWebhook,
  createPreviewWebhookRouter,
  createRouteStore,
} = router;

const webhookSecret = 'webhook-secret';
const routeSecret = 'route-secret';
const repository = 'fluent-io/fluent-flow';
const sha = 'a'.repeat(40);
const baselineBody = Buffer.from('{"action":"created","installation":{"id":42}}');
const responseBody = 'downstream response body';

function signature(body, secret = webhookSecret) {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

async function tempDirectory() {
  return mkdtemp(join(tmpdir(), 'preview-webhook-router-'));
}

async function listen(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  return `http://127.0.0.1:${address.port}`;
}

async function close(server) {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

function httpRequest(baseUrl, path, { method = 'GET', body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, baseUrl);
    const req = request(url, {
      method,
      hostname: url.hostname,
      port: url.port,
      path: `${url.pathname}${url.search}`,
      headers: {
        ...(body === undefined ? {} : { 'content-length': Buffer.byteLength(body) }),
        ...headers,
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

function routePayload(overrides = {}) {
  return JSON.stringify({ repository, pullRequest: 123, headSha: sha, ...overrides });
}
function deferred() {
  let resolve;
  const promise = new Promise((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function webhookPayload(overrides = {}) {
  return Buffer.from(JSON.stringify({
    action: 'opened',
    repository: { full_name: repository },
    pull_request: { number: 123 },
    ...overrides,
  }));
}

async function createTestRouter({ transport, logger, directory, downstreamTimeoutMs } = {}) {
  const store = createRouteStore({ directory: directory ?? await tempDirectory() });
  await store.load();
  const server = createPreviewWebhookRouter({
    webhookSecret,
    routeSecret,
    store,
    transport: transport ?? (async () => ({ status: 202 })),
    downstreamTimeoutMs,
    logger: logger ?? { info() {}, warn() {}, error() {} },
  });
  const baseUrl = await listen(server);
  return { store, server, baseUrl };
}


test('classifyWebhook selects the pull request route', () => {
  assert.deepEqual(classifyWebhook('pull_request', {
    repository: { full_name: repository },
    pull_request: { number: 123 },
  }), { scope: 'pull_request', repository, pullRequests: [123] });
  assert.deepEqual(classifyWebhook('pull_request_review', {
    repository: { full_name: repository },
    pull_request: { number: 123 },
  }), { scope: 'pull_request', repository, pullRequests: [123] });
  assert.deepEqual(classifyWebhook('pull_request_review_comment', {
    repository: { full_name: repository },
    pull_request: { number: 123 },
  }), { scope: 'pull_request', repository, pullRequests: [123] });
});

test('classifyWebhook selects an issue comment route only when the issue is a pull request', () => {
  assert.deepEqual(classifyWebhook('issue_comment', {
    repository: { full_name: repository },
    issue: { number: 123, pull_request: { url: 'https://api.github.com/pulls/123' } },
  }), { scope: 'pull_request', repository, pullRequests: [123] });
  assert.deepEqual(classifyWebhook('issue_comment', {
    repository: { full_name: repository },
    issue: { number: 456 },
  }), { scope: 'repository', repository, pullRequests: [] });
});

test('classifyWebhook selects every pull request in nested check and workflow arrays', () => {
  for (const eventName of ['check_run', 'check_suite', 'workflow_run']) {
    assert.deepEqual(classifyWebhook(eventName, {
      repository: { full_name: repository },
      [eventName]: { pull_requests: [{ number: 123 }, { number: 456 }] },
    }), { scope: 'pull_request', repository, pullRequests: [123, 456] });
    assert.deepEqual(classifyWebhook(eventName, {
      repository: { full_name: repository },
      [eventName]: { pull_requests: [] },
    }), { scope: 'repository', repository, pullRequests: [] });
  }
});

test('classifyWebhook selects repository fan-out and installation fan-out', () => {
  assert.deepEqual(classifyWebhook('push', { repository: { full_name: repository } }), {
    scope: 'repository', repository, pullRequests: [],
  });
  assert.deepEqual(classifyWebhook('installation', { installation: { id: 42 } }), {
    scope: 'installation', repository: null, pullRequests: [],
  });
  assert.deepEqual(classifyWebhook('installation_repositories', { installation: { id: 42 } }), {
    scope: 'installation', repository: null, pullRequests: [],
  });
  assert.deepEqual(classifyWebhook('ping', {}), {
    scope: 'unresolvable', repository: null, pullRequests: [],
  });
});

test('route store persists registration, removes routes, derives the destination, and reloads', async () => {
  const directory = await tempDirectory();
  const store = createRouteStore({ directory });
  await store.load();
  const route = await store.register({ repository, pullRequest: 123, headSha: sha });
  assert.deepEqual(route, {
    key: `${repository}#123`,
    repository,
    pullRequest: 123,
    headSha: sha,
    host: 'api-pr-123-preview.fluentflow.tech',
  });
  assert.deepEqual(store.routesFor({ scope: 'pull_request', repository, pullRequests: [123] }), [route]);
  assert.deepEqual(store.routesFor({ scope: 'repository', repository, pullRequests: [] }), [route]);
  assert.deepEqual(store.routesFor({ scope: 'installation', repository: null, pullRequests: [] }), [route]);
  assert.deepEqual(store.routesFor('push', { repository: { full_name: repository } }), []);
  await store.remove({ repository, pullRequest: 123, headSha: sha });
  assert.deepEqual(store.routesFor({ scope: 'repository', repository, pullRequests: [] }), []);
  await store.register({ repository, pullRequest: 123, headSha: sha });
  const restarted = createRouteStore({ directory });
  await restarted.load();
  assert.equal(restarted.routesFor({ scope: 'repository', repository, pullRequests: [] }).length, 1);
  await assert.rejects(() => restarted.register(repository, 123, sha));
  await assert.rejects(() => restarted.register({ repository, pull_request: 123, headSha: sha }));
  await assert.rejects(() => restarted.register({ repository, pullRequest: 0, headSha: sha }));
  await assert.rejects(() => restarted.register({ repository, pullRequest: 123, headSha: 'z'.repeat(40) }));
  await assert.rejects(() => restarted.remove({ repository, pullRequest: 123 }));
});

test('route store writes one versioned state file atomically and replaces the baseline exactly', async () => {
  const directory = await tempDirectory();
  const store = createRouteStore({ directory });
  await store.load();
  await store.saveInstallationBaseline({ body: baselineBody, signature: signature(baselineBody), event: 'installation', delivery: 'delivery-1' });
  const replacement = Buffer.from('{"action":"created","installation":{"id":99}}');
  await store.saveInstallationBaseline({ body: replacement, signature: signature(replacement), event: 'installation', delivery: 'delivery-2' });
  assert.deepEqual(store.installationBaseline(), {
    body: replacement,
    signature: signature(replacement),
    event: 'installation',
    delivery: 'delivery-2',
  });
  const files = await readdir(directory);
  assert.deepEqual(files, ['state.json']);
  const persisted = JSON.parse(await readFile(join(directory, 'state.json'), 'utf8'));
  assert.equal(persisted.version, 1);
  assert.equal(persisted.baseline.body, replacement.toString('base64'));
  await assert.rejects(() => store.saveInstallationBaseline('installation', replacement, signature(replacement), 'delivery-3'));
  await writeFile(join(directory, 'state.json'), '{bad', 'utf8');
  const corrupted = createRouteStore({ directory });
  await assert.rejects(() => corrupted.load());
});

test('HTTP forwards valid signed raw bytes and selected headers through Traefik', async () => {
  const calls = [];
  const { server, baseUrl } = await createTestRouter({ transport: async (url, options) => {
    calls.push({ url, options });
    return { status: 202 };
  }});
  try {
    const registration = await httpRequest(baseUrl, '/routes', {
      method: 'PUT',
      body: routePayload(),
      headers: { authorization: `Bearer ${routeSecret}`, 'content-type': 'application/json' },
    });
    assert.equal(registration.status, 204);
    const body = webhookPayload();
    const response = await httpRequest(baseUrl, '/webhooks/github-app', {
      method: 'POST',
      body,
      headers: {
        'x-hub-signature-256': signature(body),
        'x-github-event': 'pull_request',
        'x-github-delivery': 'delivery-123',
        'content-type': 'application/json',
      },
    });
    assert.equal(response.status, 202);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'http://traefik/webhooks/github-app');
    assert.equal(calls[0].options.headers.host, 'api-pr-123-preview.fluentflow.tech');
    assert.equal(calls[0].options.headers['x-hub-signature-256'], signature(body));
    assert.equal(calls[0].options.headers['x-github-event'], 'pull_request');
    assert.equal(calls[0].options.headers['x-github-delivery'], 'delivery-123');
    assert.deepEqual(Buffer.from(calls[0].options.body), body);
  } finally {
    await close(server);
  }
});

test('HTTP rejects an invalid signature before parsing the payload', async () => {
  const { server, baseUrl } = await createTestRouter();
  try {
    const response = await httpRequest(baseUrl, '/webhooks/github-app', {
      method: 'POST',
      body: Buffer.from('{not-json'),
      headers: {
        'x-hub-signature-256': 'sha256=invalid',
        'x-github-event': 'push',
        'x-github-delivery': 'delivery-invalid',
      },
    });
    assert.equal(response.status, 401);
  } finally {
    await close(server);
  }
});

test('HTTP enforces the 5 MiB body limit', async () => {
  const calls = [];
  const { server, baseUrl } = await createTestRouter({ transport: async () => {
    calls.push(true);
    return { status: 202 };
  }});
  try {
    const body = Buffer.alloc(5 * 1024 * 1024 + 1, 97);
    const response = await httpRequest(baseUrl, '/webhooks/github-app', {
      method: 'POST',
      body,
      headers: { 'x-hub-signature-256': signature(body), 'x-github-event': 'push', 'x-github-delivery': 'large' },
    });
    assert.equal(response.status, 413);
    assert.deepEqual(calls, []);
  } finally {
    await close(server);
  }
});

test('HTTP keeps pull request events isolated and fans out repository and installation events', async () => {
  const calls = [];
  const { server, baseUrl } = await createTestRouter({ transport: async (url, options) => {
    calls.push({ url, options });
    return { status: 202 };
  }});
  try {
    for (const pullRequest of [123, 456]) {
      const response = await httpRequest(baseUrl, '/routes', {
        method: 'PUT',
        body: routePayload({ pullRequest }),
        headers: { authorization: `Bearer ${routeSecret}`, 'content-type': 'application/json' },
      });
      assert.equal(response.status, 204);
    }
    const prBody = webhookPayload({ pull_request: { number: 123 } });
    assert.equal((await httpRequest(baseUrl, '/webhooks/github-app', {
      method: 'POST', body: prBody, headers: {
        'x-hub-signature-256': signature(prBody), 'x-github-event': 'pull_request', 'x-github-delivery': 'pr-1',
      },
    })).status, 202);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].options.headers.host, 'api-pr-123-preview.fluentflow.tech');
    const repositoryBody = Buffer.from(JSON.stringify({ repository: { full_name: repository }, ref: 'refs/heads/main' }));
    assert.equal((await httpRequest(baseUrl, '/webhooks/github-app', {
      method: 'POST', body: repositoryBody, headers: {
        'x-hub-signature-256': signature(repositoryBody), 'x-github-event': 'push', 'x-github-delivery': 'repo-1',
      },
    })).status, 202);
    assert.deepEqual(calls.slice(1).map(({ options }) => options.headers.host).sort(), [
      'api-pr-123-preview.fluentflow.tech', 'api-pr-456-preview.fluentflow.tech',
    ]);
  } finally {
    await close(server);
  }
});

test('HTTP returns 502 when any selected target fails and 202 when there are no targets', async () => {
  let call = 0;
  const { server, baseUrl } = await createTestRouter({ transport: async () => {
    call += 1;
    return { status: call === 1 ? 500 : 202 };
  }});
  try {
    assert.equal((await httpRequest(baseUrl, '/routes', {
      method: 'PUT', body: routePayload(), headers: { authorization: `Bearer ${routeSecret}` },
    })).status, 204);
    const body = webhookPayload();
    assert.equal((await httpRequest(baseUrl, '/webhooks/github-app', {
      method: 'POST', body, headers: { 'x-hub-signature-256': signature(body), 'x-github-event': 'pull_request', 'x-github-delivery': 'fail' },
    })).status, 502);
    const otherBody = Buffer.from(JSON.stringify({ repository: { full_name: 'other/repository' } }));
    assert.equal((await httpRequest(baseUrl, '/webhooks/github-app', {
      method: 'POST', body: otherBody, headers: { 'x-hub-signature-256': signature(otherBody), 'x-github-event': 'push', 'x-github-delivery': 'none' },
    })).status, 202);
  } finally {
    await close(server);
  }
});

test('concurrent PUTs serialize baseline replay and return successful responses after one delivery', async () => {
  const replayStarted = deferred();
  const releaseReplay = deferred();
  const deliveredBaselineEvents = [];
  const { server, baseUrl } = await createTestRouter({
    transport: async (url, options) => {
      if (options.headers['x-github-event'] === 'installation') {
        deliveredBaselineEvents.push({
          body: Buffer.from(options.body),
          host: options.headers.host,
          signature: options.headers['x-hub-signature-256'],
        });
        if (deliveredBaselineEvents.length === 1) {
          replayStarted.resolve();
          await releaseReplay.promise;
        }
      }
      return { status: 202 };
    },
  });
  try {
    assert.equal((await httpRequest(baseUrl, '/webhooks/github-app', {
      method: 'POST', body: baselineBody, headers: {
        'x-hub-signature-256': signature(baselineBody), 'x-github-event': 'installation', 'x-github-delivery': 'installation-concurrent',
      },
    })).status, 202);
    const routeRequest = {
      method: 'PUT',
      body: routePayload(),
      headers: { authorization: `Bearer ${routeSecret}` },
    };
    const firstPut = httpRequest(baseUrl, '/routes', routeRequest);
    const secondPut = httpRequest(baseUrl, '/routes', routeRequest);
    await replayStarted.promise;
    releaseReplay.resolve();
    assert.equal((await firstPut).status, 204);
    assert.equal((await secondPut).status, 204);
    assert.deepEqual(deliveredBaselineEvents, [{
      body: baselineBody,
      host: 'api-pr-123-preview.fluentflow.tech',
      signature: signature(baselineBody),
    }]);
  } finally {
    await close(server);
  }
});
test('each newly registered route replays the installation baseline once', async () => {
  const deliveredBaselineEvents = [];
  const { server, baseUrl } = await createTestRouter({
    transport: async (url, options) => {
      if (options.headers['x-github-event'] === 'installation') {
        deliveredBaselineEvents.push({
          body: Buffer.from(options.body),
          host: options.headers.host,
          signature: options.headers['x-hub-signature-256'],
        });
      }
      return { status: 202 };
    },
  });
  try {
    assert.equal((await httpRequest(baseUrl, '/webhooks/github-app', {
      method: 'POST',
      body: baselineBody,
      headers: {
        'x-hub-signature-256': signature(baselineBody),
        'x-github-event': 'installation',
        'x-github-delivery': 'baseline-per-route',
      },
    })).status, 202);
    const firstRoute = {
      method: 'PUT',
      body: routePayload({ pullRequest: 123 }),
      headers: { authorization: `Bearer ${routeSecret}` },
    };
    const secondRoute = {
      method: 'PUT',
      body: routePayload({ pullRequest: 456 }),
      headers: { authorization: `Bearer ${routeSecret}` },
    };
    assert.equal((await httpRequest(baseUrl, '/routes', firstRoute)).status, 204);
    assert.equal((await httpRequest(baseUrl, '/routes', secondRoute)).status, 204);
    assert.deepEqual(deliveredBaselineEvents, [
      {
        body: baselineBody,
        host: 'api-pr-123-preview.fluentflow.tech',
        signature: signature(baselineBody),
      },
      {
        body: baselineBody,
        host: 'api-pr-456-preview.fluentflow.tech',
        signature: signature(baselineBody),
      },
    ]);
    assert.equal((await httpRequest(baseUrl, '/routes', firstRoute)).status, 204);
    assert.equal((await httpRequest(baseUrl, '/routes', secondRoute)).status, 204);
    assert.equal(deliveredBaselineEvents.length, 2);
  } finally {
    await close(server);
  }
});
test('baseline replay and rollback failures preserve a retry marker until one successful replay clears it', async () => {
  const deliveredBaselineEvents = [];
  let rollbackAttempts = 0;
  let replayAttempts = 0;
  const { store, server, baseUrl } = await createTestRouter({
    transport: async (url, options) => {
      if (options.headers['x-github-event'] === 'installation') {
        replayAttempts += 1;
        deliveredBaselineEvents.push(Buffer.from(options.body));
        return { status: replayAttempts === 1 ? 500 : 202 };
      }
      return { status: 202 };
    },
  });
  const remove = store.remove;
  store.remove = async (input) => {
    rollbackAttempts += 1;
    if (rollbackAttempts === 1) throw new Error('rollback failed');
    return remove.call(store, input);
  };
  try {
    assert.equal((await httpRequest(baseUrl, '/webhooks/github-app', {
      method: 'POST',
      body: baselineBody,
      headers: {
        'x-hub-signature-256': signature(baselineBody),
        'x-github-event': 'installation',
        'x-github-delivery': 'baseline-rollback-failure',
      },
    })).status, 202);
    const routeRequest = {
      method: 'PUT',
      body: routePayload(),
      headers: { authorization: `Bearer ${routeSecret}` },
    };
    assert.equal((await httpRequest(baseUrl, '/routes', routeRequest)).status, 500);
    assert.equal(store.routesFor({ scope: 'repository', repository, pullRequests: [] }).length, 1);
    assert.equal((await httpRequest(baseUrl, '/routes', routeRequest)).status, 204);
    assert.deepEqual(deliveredBaselineEvents, [baselineBody, baselineBody]);
    assert.equal(store.routesFor({ scope: 'repository', repository, pullRequests: [] }).length, 1);
    assert.equal((await httpRequest(baseUrl, '/routes', routeRequest)).status, 204);
    assert.deepEqual(deliveredBaselineEvents, [baselineBody, baselineBody]);
  } finally {
    await close(server);
  }
});
test('Node transport sends the derived Host header on the wire', async () => {
  assert.equal(typeof router.createNodeTransport, 'function');
  const hosts = [];
  const upstream = createServer((req, res) => {
    hosts.push(req.headers.host);
    req.resume();
    req.on('end', () => {
      res.writeHead(202);
      res.end(responseBody);
    });
  });
  const upstreamUrl = await listen(upstream);
  const { server, baseUrl } = await createTestRouter({
    transport: router.createNodeTransport({ target: upstreamUrl }),
  });
  try {
    assert.equal((await httpRequest(baseUrl, '/routes', {
      method: 'PUT',
      body: routePayload(),
      headers: { authorization: `Bearer ${routeSecret}` },
    })).status, 204);
    const body = webhookPayload();
    assert.equal((await httpRequest(baseUrl, '/webhooks/github-app', {
      method: 'POST',
      body,
      headers: {
        'x-hub-signature-256': signature(body),
        'x-github-event': 'pull_request',
        'x-github-delivery': 'wire-host',
      },
    })).status, 202);
    assert.deepEqual(hosts, ['api-pr-123-preview.fluentflow.tech']);
  } finally {
    await close(server);
    await close(upstream);
  }
});

test('downstream timeout returns 502 before the GitHub delivery deadline', async () => {
  const sockets = new Set();
  const upstream = createServer(() => {});
  upstream.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  const upstreamUrl = await listen(upstream);
  const { server, baseUrl } = await createTestRouter({
    transport: router.createNodeTransport({ target: upstreamUrl }),
    downstreamTimeoutMs: 25,
  });
  try {
    assert.equal((await httpRequest(baseUrl, '/routes', {
      method: 'PUT',
      body: routePayload(),
      headers: { authorization: `Bearer ${routeSecret}` },
    })).status, 204);
    const body = webhookPayload();
    assert.equal((await httpRequest(baseUrl, '/webhooks/github-app', {
      method: 'POST',
      body,
      headers: {
        'x-hub-signature-256': signature(body),
        'x-github-event': 'pull_request',
        'x-github-delivery': 'timeout',
      },
    })).status, 502);
  } finally {
    for (const socket of sockets) socket.destroy();
    await close(server);
    await close(upstream);
  }
});

test('downstream failures are logged without payloads or secrets', async () => {
  const errors = [];
  const body = webhookPayload();
  const { server, baseUrl } = await createTestRouter({
    transport: async () => {
      throw Object.assign(new Error(responseBody), { code: 'E_DOWNSTREAM' });
    },
    logger: {
      info() {},
      warn() {},
      error(fields) {
        errors.push(fields);
      },
    },
  });
  try {
    assert.equal((await httpRequest(baseUrl, '/routes', {
      method: 'PUT',
      body: routePayload(),
      headers: { authorization: `Bearer ${routeSecret}` },
    })).status, 204);
    assert.equal((await httpRequest(baseUrl, '/webhooks/github-app', {
      method: 'POST',
      body,
      headers: {
        'x-hub-signature-256': signature(body),
        'x-github-event': 'pull_request',
        'x-github-delivery': 'logged-failure',
      },
    })).status, 502);
    assert.ok(errors.length > 0);
    const serialized = JSON.stringify(errors);
    assert.ok(serialized.includes('E_DOWNSTREAM'));
    assert.ok(!serialized.includes(body.toString('utf8')));
    assert.ok(!serialized.includes(signature(body)));
    assert.ok(!serialized.includes(webhookSecret));
    assert.ok(!serialized.includes(routeSecret));
    assert.ok(!serialized.includes(responseBody));
  } finally {
    await close(server);
  }
});

test('baseline replay failure returns 502, removes the route, and retries safely', async () => {
  let attempts = 0;
  const { store, server, baseUrl } = await createTestRouter({
    transport: async () => ({ status: ++attempts === 1 ? 500 : 202 }),
  });
  try {
    assert.equal((await httpRequest(baseUrl, '/webhooks/github-app', {
      method: 'POST',
      body: baselineBody,
      headers: {
        'x-hub-signature-256': signature(baselineBody),
        'x-github-event': 'installation',
        'x-github-delivery': 'baseline-failure',
      },
    })).status, 202);
    const routeRequest = {
      method: 'PUT',
      body: routePayload(),
      headers: { authorization: `Bearer ${routeSecret}` },
    };
    assert.equal((await httpRequest(baseUrl, '/routes', routeRequest)).status, 502);
    assert.deepEqual(store.routesFor({ scope: 'repository', repository, pullRequests: [] }), []);
    assert.equal((await httpRequest(baseUrl, '/routes', routeRequest)).status, 204);
    assert.equal(attempts, 2);
    assert.equal(store.routesFor({ scope: 'repository', repository, pullRequests: [] }).length, 1);
  } finally {
    await close(server);
  }
});

test('DELETE requires admin auth, validates the exact route shape, and removes a route', async () => {
  const { store, server, baseUrl } = await createTestRouter();
  try {
    const routeRequest = {
      method: 'PUT',
      body: routePayload(),
      headers: { authorization: `Bearer ${routeSecret}` },
    };
    assert.equal((await httpRequest(baseUrl, '/routes', routeRequest)).status, 204);
    assert.equal((await httpRequest(baseUrl, '/routes', {
      method: 'DELETE',
      body: routePayload(),
      headers: { authorization: 'Bearer wrong' },
    })).status, 401);
    assert.equal((await httpRequest(baseUrl, '/routes', {
      method: 'DELETE',
      body: JSON.stringify({ repository, pullRequest: 123 }),
      headers: { authorization: `Bearer ${routeSecret}` },
    })).status, 400);
    assert.equal((await httpRequest(baseUrl, '/routes', {
      method: 'DELETE',
      body: JSON.stringify({ repository, pull_request: 123, head_sha: sha }),
      headers: { authorization: `Bearer ${routeSecret}` },
    })).status, 400);
    assert.equal((await httpRequest(baseUrl, '/routes', {
      method: 'DELETE',
      body: routePayload(),
      headers: { authorization: `Bearer ${routeSecret}` },
    })).status, 204);
    assert.deepEqual(store.routesFor({ scope: 'repository', repository, pullRequests: [] }), []);
  } finally {
    await close(server);
  }
});

test('DELETE persistence failures return 500', async () => {
  const { store, server, baseUrl } = await createTestRouter();
  await store.register({ repository, pullRequest: 123, headSha: sha });
  store.remove = async () => {
    throw new Error('persistence failure');
  };
  try {
    assert.equal((await httpRequest(baseUrl, '/routes', {
      method: 'DELETE',
      body: routePayload(),
      headers: { authorization: `Bearer ${routeSecret}` },
    })).status, 500);
  } finally {
    await close(server);
  }
});



test('HTTP uses distinct admin authentication and generic auth failures', async () => {
  const { server, baseUrl } = await createTestRouter();
  try {
    for (const authorization of ['', `Bearer ${webhookSecret}`, 'Bearer wrong']) {
      const response = await httpRequest(baseUrl, '/routes', {
        method: 'PUT', body: routePayload(), headers: { authorization },
      });
      assert.equal(response.status, 401);
      assert.equal(response.body.toString(), 'Unauthorized');
    }
    assert.equal((await httpRequest(baseUrl, '/health')).status, 200);
  } finally {
    await close(server);
  }
});
