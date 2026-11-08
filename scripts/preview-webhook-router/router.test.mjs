import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { test } from 'node:test';
import {
  classifyWebhook,
  createPreviewWebhookRouter,
  createRouteStore,
} from './router.mjs';

const webhookSecret = 'webhook-secret';
const routeSecret = 'route-secret';
const repository = 'fluent-io/fluent-flow';
const sha = 'a'.repeat(40);
const baselineBody = Buffer.from('{"action":"created","installation":{"id":42}}');

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

function webhookPayload(overrides = {}) {
  return Buffer.from(JSON.stringify({
    action: 'opened',
    repository: { full_name: repository },
    pull_request: { number: 123 },
    ...overrides,
  }));
}

async function createTestRouter({ fetchImpl, logger, directory } = {}) {
  const store = createRouteStore({ directory: directory ?? await tempDirectory() });
  await store.load();
  const server = createPreviewWebhookRouter({
    webhookSecret,
    routeSecret,
    store,
    fetchImpl: fetchImpl ?? (async () => new Response('ok', { status: 202 })),
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

test('classifyWebhook selects every pull request in check and workflow arrays', () => {
  for (const eventName of ['check_run', 'check_suite', 'workflow_run']) {
    assert.deepEqual(classifyWebhook(eventName, {
      repository: { full_name: repository },
      pull_requests: [{ number: 123 }, { number: 456 }],
    }), { scope: 'pull_request', repository, pullRequests: [123, 456] });
    assert.deepEqual(classifyWebhook(eventName, {
      repository: { full_name: repository },
      pull_requests: [],
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
  await store.remove({ repository, pullRequest: 123 });
  assert.deepEqual(store.routesFor({ scope: 'repository', repository, pullRequests: [] }), []);
  await store.register({ repository, pullRequest: 123, headSha: sha });
  const restarted = createRouteStore({ directory });
  await restarted.load();
  assert.equal(restarted.routesFor({ scope: 'repository', repository, pullRequests: [] }).length, 1);
  await assert.rejects(() => restarted.register({ repository: 'bad', pullRequest: 123, headSha: sha }));
  await assert.rejects(() => restarted.register({ repository, pullRequest: 0, headSha: sha }));
  await assert.rejects(() => restarted.register({ repository, pullRequest: 123, headSha: 'z'.repeat(40) }));
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
  await writeFile(join(directory, 'state.json'), '{bad', 'utf8');
  const corrupted = createRouteStore({ directory });
  await assert.rejects(() => corrupted.load());
});

test('HTTP forwards valid signed raw bytes and selected headers through Traefik', async () => {
  const calls = [];
  const { server, baseUrl } = await createTestRouter({ fetchImpl: async (url, options) => {
    calls.push({ url, options });
    return new Response('accepted', { status: 202 });
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
  const { server, baseUrl } = await createTestRouter({ fetchImpl: async () => {
    calls.push(true);
    return new Response('accepted', { status: 202 });
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
  const { server, baseUrl } = await createTestRouter({ fetchImpl: async (url, options) => {
    calls.push({ url, options });
    return new Response('accepted', { status: 202 });
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
  const { server, baseUrl } = await createTestRouter({ fetchImpl: async () => {
    call += 1;
    return new Response('rejected', { status: call === 1 ? 500 : 202 });
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

test('HTTP replays the latest installation baseline once to a newly registered route', async () => {
  const calls = [];
  const { server, baseUrl } = await createTestRouter({ fetchImpl: async (url, options) => {
    calls.push({ url, options });
    return new Response('accepted', { status: 202 });
  }});
  try {
    const baseline = Buffer.from('{"action":"created","installation":{"id":42}}');
    assert.equal((await httpRequest(baseUrl, '/webhooks/github-app', {
      method: 'POST', body: baseline, headers: {
        'x-hub-signature-256': signature(baseline), 'x-github-event': 'installation', 'x-github-delivery': 'installation-1',
      },
    })).status, 202);
    assert.equal((await httpRequest(baseUrl, '/routes', {
      method: 'PUT', body: routePayload(), headers: { authorization: `Bearer ${routeSecret}` },
    })).status, 204);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].options.headers.host, 'api-pr-123-preview.fluentflow.tech');
    assert.deepEqual(Buffer.from(calls[0].options.body), baseline);
    assert.equal(calls[0].options.headers['x-hub-signature-256'], signature(baseline));
    assert.equal((await httpRequest(baseUrl, '/routes', {
      method: 'PUT', body: routePayload({ pullRequest: 456 }), headers: { authorization: `Bearer ${routeSecret}` },
    })).status, 204);
    assert.equal(calls.length, 2);
  } finally {
    await close(server);
  }
});

test('HTTP serializes concurrent registration and replays the baseline once', async () => {
  const calls = [];
  let releaseReplay;
  let releaseRegister;
  let registerCalls = 0;
  const replayGate = new Promise((resolve) => { releaseReplay = resolve; });
  const registerGate = new Promise((resolve) => { releaseRegister = resolve; });
  const { store, server, baseUrl } = await createTestRouter({ fetchImpl: async (url, options) => {
    calls.push({ url, options });
    await replayGate;
    return new Response('accepted', { status: 202 });
  }});
  const originalRegister = store.register.bind(store);
  store.register = async (...args) => {
    registerCalls += 1;
    await registerGate;
    return originalRegister(...args);
  };
  try {
    const baseline = Buffer.from('{"action":"created","installation":{"id":42}}');
    assert.equal((await httpRequest(baseUrl, '/webhooks/github-app', {
      method: 'POST', body: baseline, headers: {
        'x-hub-signature-256': signature(baseline), 'x-github-event': 'installation', 'x-github-delivery': 'installation-2',
      },
    })).status, 202);
    const first = httpRequest(baseUrl, '/routes', {
      method: 'PUT', body: routePayload(), headers: { authorization: `Bearer ${routeSecret}` },
    });
    const second = httpRequest(baseUrl, '/routes', {
      method: 'PUT', body: routePayload(), headers: { authorization: `Bearer ${routeSecret}` },
    });
    for (let attempt = 0; attempt < 100 && registerCalls === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
    const concurrentRegisterCalls = registerCalls;
    releaseRegister();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(calls.length, 1);
    releaseReplay();
    assert.deepEqual((await Promise.all([first, second])).map((response) => response.status), [204, 204]);
    assert.equal(concurrentRegisterCalls, 1);
    assert.equal(calls.length, 1);
  } finally {
    releaseRegister?.();
    releaseReplay?.();
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
