import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { redeliverFailedPreviewWebhooks } from './preview-webhook-redelivery.mjs';

const privateKeyPem = await readFile(new URL('../packages/fluent-flow/tests/fixtures/test-app.pem', import.meta.url), 'utf8');
const privateKey = Buffer.from(privateKeyPem, 'utf8').toString('base64');
const now = new Date('2026-11-07T12:00:00.000Z');

function response(status, payload, body = '', link = null) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => body,
    json: async () => payload,
    headers: {
      get: (name) => name.toLowerCase() === 'link' ? link : null,
    },
  };
}

function delivery(id, guid, statusCode, deliveredAt, extra = {}) {
  return { id, guid, status_code: statusCode, delivered_at: deliveredAt, ...extra };
}

test('follows GitHub cursor pagination and groups realistic delivery status codes', async () => {
  const calls = [];
  const firstPageUrl = 'https://api.github.com/app/hook/deliveries?per_page=100';
  const secondPageUrl = 'https://api.github.com/app/hook/deliveries?per_page=100&cursor=cursor-1';
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    if (url === firstPageUrl) {
      return response(200, [
        delivery(11, 'guid-success', 500, '2026-11-07T11:58:00.000Z'),
        delivery(21, 'guid-failed', 500, '2026-11-07T11:57:00.000Z'),
      ], '', `<${secondPageUrl}>; rel="next"`);
    }
    if (url === secondPageUrl) {
      return response(200, [
        delivery(12, 'guid-success', 302, '2026-11-07T11:59:00.000Z'),
        delivery(22, 'guid-failed', 500, '2026-11-07T11:58:30.000Z'),
        delivery(31, 'guid-old', 500, '2026-11-07T05:59:00.000Z'),
      ]);
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
  assert.deepEqual(calls.slice(0, 2).map(({ url }) => url), [firstPageUrl, secondPageUrl]);
  assert.equal(calls.some(({ url }) => new URL(url).searchParams.has('page')), false);
  const redeliveries = calls.filter(({ url }) => url.includes('/attempts'));
  assert.equal(redeliveries.length, 1);
  assert.equal(redeliveries[0].url, 'https://api.github.com/app/hook/deliveries/22/attempts');
  assert.equal(redeliveries[0].options.method, 'POST');
  assert.equal(redeliveries[0].options.headers.Authorization.startsWith('Bearer '), true);
});

test('uses a six-hour outage lookback and excludes older deliveries', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    if (url.includes('/app/hook/deliveries?')) {
      return response(200, [
        delivery(51, 'guid-within-window', 500, '2026-11-07T07:00:00.000Z'),
        delivery(52, 'guid-outside-window', 500, '2026-11-07T05:00:00.000Z'),
      ]);
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
  assert.equal(calls.filter(({ url }) => url.includes('/attempts'))[0].url, 'https://api.github.com/app/hook/deliveries/51/attempts');
});

test('throws when a delivery is missing its GUID', async () => {
  const fetchImpl = async (url) => url.includes('/app/hook/deliveries?')
    ? response(200, [delivery(61, undefined, 500, '2026-11-07T11:59:00.000Z')])
    : response(202);

  await assert.rejects(
    () => redeliverFailedPreviewWebhooks({ appId: '12345', privateKey, fetchImpl, now }),
    /missing GUID/,
  );
});

test('attempts every selected redelivery before throwing an AggregateError', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    if (url.includes('/app/hook/deliveries?')) {
      return response(200, [
        delivery(71, 'guid-one', 500, '2026-11-07T11:59:00.000Z'),
        delivery(72, 'guid-two', 500, '2026-11-07T11:58:00.000Z'),
      ]);
    }
    return response(500, null, 'private redelivery response body');
  };

  await assert.rejects(
    () => redeliverFailedPreviewWebhooks({ appId: '12345', privateKey, fetchImpl, now }),
    (error) => error instanceof AggregateError
      && error.errors.length === 2
      && !error.message.includes('private redelivery response body'),
  );
  assert.equal(calls.filter(({ url }) => url.includes('/attempts')).length, 2);
});

test('fails loudly before redelivering when unresolved candidates exceed one hundred per run', async () => {
  const calls = [];
  const firstPage = Array.from({ length: 100 }, (_, index) => delivery(
    1000 + index,
    `guid-${index}`,
    500,
    '2026-11-07T11:59:00.000Z',
  ));
  const secondPage = [delivery(1100, 'guid-100', 500, '2026-11-07T11:58:00.000Z')];
  const secondPageUrl = 'https://api.github.com/app/hook/deliveries?per_page=100&cursor=cursor-cap';
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    if (url === 'https://api.github.com/app/hook/deliveries?per_page=100') return response(200, firstPage, '', `<${secondPageUrl}>; rel="next"`);
    if (url === secondPageUrl) return response(200, secondPage);
    return response(202);
  };

  await assert.rejects(
    () => redeliverFailedPreviewWebhooks({
      appId: '12345',
      privateKey,
      fetchImpl,
      now,
    }),
    /maximum redelivery cap of 100/,
  );
  assert.equal(
    calls.filter(({ url, options }) => url.includes('/attempts') && options?.method === 'POST').length,
    0,
  );
});

test('fails when cursor pagination is exhausted before the lookback cutoff', async () => {
  const urls = [
    'https://api.github.com/app/hook/deliveries?per_page=100',
    'https://api.github.com/app/hook/deliveries?per_page=100&cursor=cursor-1',
    'https://api.github.com/app/hook/deliveries?per_page=100&cursor=cursor-2',
    'https://api.github.com/app/hook/deliveries?per_page=100&cursor=cursor-3',
  ];
  const fetchImpl = async (url) => {
    const index = urls.indexOf(url);
    if (index < 0) return response(202);
    const next = urls[index + 1];
    const batch = Array.from({ length: 100 }, (_, item) => delivery(
      index * 100 + item,
      `guid-page-${index}-${item}`,
      500,
      '2026-11-07T11:59:00.000Z',
    ));
    return response(200, batch, '', next ? `<${next}>; rel="next"` : null);
  };

  await assert.rejects(
    () => redeliverFailedPreviewWebhooks({ appId: '12345', privateKey, fetchImpl, now }),
    /maximum delivery pages before the lookback cutoff/,
  );
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
      return response(200, [delivery(41, 'guid-failed', 500, '2026-11-07T11:59:00.000Z')]);
    }
    return response(500, null, 'private redelivery response body');
  };

  await assert.rejects(
    () => redeliverFailedPreviewWebhooks({ appId: '12345', privateKey, fetchImpl, now }),
    (error) => error instanceof AggregateError
      && !error.message.includes('private redelivery response body'),
  );
});
