import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { configurePreviewAppWebhook } from './preview-github-app.mjs';

const privateKeyPem = await readFile(new URL('../packages/fluent-flow/tests/fixtures/test-app.pem', import.meta.url), 'utf8');
const privateKey = Buffer.from(privateKeyPem, 'utf8').toString('base64');

function response(status, body = '') {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => body,
  };
}

function decodeJwt(token) {
  return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
}

test('configures the Preview App webhook with a JWT and TLS verification', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return response(200);
  };

  await configurePreviewAppWebhook({
    appId: '12345',
    privateKey,
    webhookSecret: 'webhook-secret',
    fetchImpl,
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.github.com/app/hook/config');
  assert.equal(calls[0].options.method, 'PATCH');
  assert.equal(calls[0].options.headers.Accept, 'application/vnd.github+json');
  assert.equal(calls[0].options.headers['X-GitHub-Api-Version'], '2022-11-28');
  assert.equal(calls[0].options.headers['content-type'], 'application/json');
  assert.equal(calls[0].options.headers.Authorization.startsWith('Bearer '), true);
  assert.equal(decodeJwt(calls[0].options.headers.Authorization.slice(7)).iss, '12345');
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    url: 'https://preview-webhooks.fluentflow.tech/webhooks/github-app',
    content_type: 'json',
    secret: 'webhook-secret',
    insecure_ssl: '0',
  });
});

test('fails without exposing a GitHub response body', async () => {
  const fetchImpl = async () => response(500, 'private github response body');

  await assert.rejects(
    () => configurePreviewAppWebhook({
      appId: '12345',
      privateKey,
      webhookSecret: 'webhook-secret',
      fetchImpl,
    }),
    (error) => !error.message.includes('private github response body'),
  );
});
