import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { redeliverFailedPreviewWebhooks } from './preview-webhook-redelivery.mjs';

const privateKeyPem = await readFile(new URL('../packages/fluent-flow/tests/fixtures/test-app.pem', import.meta.url), 'utf8');
const privateKey = Buffer.from(privateKeyPem, 'utf8').toString('base64');
const now = new Date('2026-11-07T12:00:00.000Z');

function response(status, payload, body = '') {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => body,
    json: async () => payload,
  };
}

function delivery(id, guid, status, deliveredAt, extra = {}) {
  return { id, guid, status, delivered_at: deliveredAt, ...extra };
}

test('redelivers one recent unresolved failure per GUID and skips successful histories', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    if (url.includes('/app/hook/deliveries?')) {
      const page = new URL(url).searchParams.get('page');
      return page === '1'
        ? response(200, [
          delivery(11, 'guid-success', 'ERROR', '2026-11-07T11:58:00.000Z'),
          delivery(12, 'guid-success', 'OK', '2026-11-07T11:59:00.000Z', { status_code: 200 }),
          delivery(21, 'guid-failed', 'ERROR', '2026-11-07T11:57:00.000Z'),
          delivery(22, 'guid-failed', 'ERROR', '2026-11-07T11:58:30.000Z'),
          delivery(31, 'guid-old', 'ERROR', '2026-11-07T11:00:00.000Z'),
        ])
        : response(200, []);
    }
    return response(202);
  };

  const result = await redeliverFailedPreviewWebhooks({
    appId: '12345',
    privateKey,
    fetchImpl,
    now,
  });

  assert.deepEqual(result, { redelivered: 1 });
  const redeliveries = calls.filter(({ url }) => url.includes('/attempts'));
  assert.equal(redeliveries.length, 1);
  assert.equal(redeliveries[0].url, 'https://api.github.com/app/hook/deliveries/22/attempts');
  assert.equal(redeliveries[0].options.method, 'POST');
  assert.equal(redeliveries[0].options.headers.Authorization.startsWith('Bearer '), true);
});

test('fails loudly on delivery listing errors without exposing response bodies', async () => {
  const fetchImpl = async () => response(503, null, 'private list response body');

  await assert.rejects(
    () => redeliverFailedPreviewWebhooks({ appId: '12345', privateKey, fetchImpl, now }),
    (error) => !error.message.includes('private list response body'),
  );
});

test('fails loudly when a redelivery request fails without exposing response bodies', async () => {
  const fetchImpl = async (url) => {
    if (url.includes('/app/hook/deliveries?')) {
      return response(200, [delivery(41, 'guid-failed', 'ERROR', '2026-11-07T11:59:00.000Z')]);
    }
    return response(500, null, 'private redelivery response body');
  };

  await assert.rejects(
    () => redeliverFailedPreviewWebhooks({ appId: '12345', privateKey, fetchImpl, now }),
    (error) => !error.message.includes('private redelivery response body'),
  );
});
