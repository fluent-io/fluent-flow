import assert from 'node:assert/strict';
import test from 'node:test';
import { reconcilePreviewWebhookRoute } from './preview-webhook-route.mjs';

const repository = 'fluent-io/fluent-flow';
const headSha = 'a'.repeat(40);

function response(status, body = '') {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => body,
  };
}

test('reconciles the route with the fixed router origin and identity fields', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return response(204);
  };

  await reconcilePreviewWebhookRoute({
    operation: 'deploy',
    repository,
    prNumber: 123,
    headSha,
    secret: 'route-secret',
    fetchImpl,
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://preview-webhooks.fluentflow.tech/routes');
  assert.equal(calls[0].options.method, 'PUT');
  assert.deepEqual(calls[0].options.headers, {
    authorization: 'Bearer route-secret',
    'content-type': 'application/json',
  });
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    repository,
    pullRequest: 123,
    headSha,
  });
});

test('fails when removal receives a 404', async () => {
  const fetchImpl = async () => response(404);

  await assert.rejects(
    () => reconcilePreviewWebhookRoute({
      operation: 'remove',
      repository,
      prNumber: 123,
      headSha,
      secret: 'route-secret',
      fetchImpl,
    }),
    /status 404/,
  );
});

test('accepts a successful removal and rejects status boundaries outside 2xx', async () => {
  let method;
  await reconcilePreviewWebhookRoute({
    operation: 'remove',
    repository,
    prNumber: 123,
    headSha,
    secret: 'route-secret',
    fetchImpl: async (_url, options) => {
      method = options.method;
      return response(204);
    },
  });
  assert.equal(method, 'DELETE');

  for (const status of [199, 400]) {
    await assert.rejects(
      () => reconcilePreviewWebhookRoute({
        operation: 'remove',
        repository,
        prNumber: 123,
        headSha,
        secret: 'route-secret',
        fetchImpl: async () => response(status),
      }),
      new RegExp(`status ${status}`),
    );
  }
});

test('fails when deployment receives a 404', async () => {
  const fetchImpl = async () => response(404);

  await assert.rejects(
    () => reconcilePreviewWebhookRoute({
      operation: 'deploy',
      repository,
      prNumber: 123,
      headSha,
      secret: 'route-secret',
      fetchImpl,
    }),
    /status 404/,
  );
});

test('rejects a missing route secret and invalid identities before fetch', async () => {
  const fetchImpl = async () => {
    throw new Error('fetch must not run');
  };

  await assert.rejects(() => reconcilePreviewWebhookRoute({
    operation: 'deploy',
    repository,
    prNumber: 123,
    headSha,
    secret: '',
    fetchImpl,
  }), /route secret is required/);
  await assert.rejects(() => reconcilePreviewWebhookRoute({
    operation: 'deploy',
    repository: 'fluent-io',
    prNumber: 123,
    headSha,
    secret: 'route-secret',
    fetchImpl,
  }), /invalid route identity/);
  await assert.rejects(() => reconcilePreviewWebhookRoute({
    operation: 'deploy',
    repository,
    prNumber: 0,
    headSha,
    secret: 'route-secret',
    fetchImpl,
  }), /invalid route identity/);
  await assert.rejects(() => reconcilePreviewWebhookRoute({
    operation: 'deploy',
    repository,
    prNumber: 123,
    headSha: 'not-a-sha',
    secret: 'route-secret',
    fetchImpl,
  }), /invalid route identity/);
});
