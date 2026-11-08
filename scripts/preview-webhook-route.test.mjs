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

test('reconciles only the fixed router origin with the route identity fields', async () => {
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

test('removal treats an absent route as an idempotent success', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return response(404);
  };

  await reconcilePreviewWebhookRoute({
    operation: 'remove',
    repository,
    prNumber: 123,
    headSha,
    secret: 'route-secret',
    fetchImpl,
  });
  await reconcilePreviewWebhookRoute({
    operation: 'remove',
    repository,
    prNumber: 123,
    headSha,
    secret: 'route-secret',
    fetchImpl,
  });

  assert.equal(calls.length, 2);
  assert.equal(calls[0].options.method, 'DELETE');
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    repository,
    pullRequest: 123,
    headSha,
  });
});

test('rejects invalid identities and arbitrary origins before fetch', async () => {
  const fetchImpl = async () => {
    throw new Error('fetch must not run');
  };

  await assert.rejects(() => reconcilePreviewWebhookRoute({
    operation: 'deploy',
    repository,
    prNumber: 123,
    headSha,
    secret: 'route-secret',
    origin: 'https://attacker.example',
    fetchImpl,
  }), /fixed router origin/);
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
