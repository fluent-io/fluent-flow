import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHmac } from 'crypto';

vi.mock('../../../src/logger.js', async () => {
  const { createMockLogger } = await import('../../helpers/mock-logger.js');
  return { default: createMockLogger() };
});

import { appWebhookSignatureMiddleware } from '../../../src/providers/github/webhook-verify.js';

const APP_SECRET = 'app-webhook-secret-xyz';

function sign(body, secret) {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

function makeReq(body, signature, secret = APP_SECRET) {
  process.env.FF_GITHUB_APP_WEBHOOK_SECRET = secret;
  return {
    rawBody: Buffer.from(body),
    headers: { 'x-hub-signature-256': signature },
    ip: '127.0.0.1',
  };
}

function makeRes() {
  const res = {
    statusCode: null,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
  return res;
}

beforeEach(() => {
  process.env.FF_GITHUB_APP_WEBHOOK_SECRET = APP_SECRET;
});

afterEach(() => {
  delete process.env.FF_GITHUB_APP_WEBHOOK_SECRET;
});

describe('appWebhookSignatureMiddleware', () => {
  it('calls next() for a valid HMAC-SHA256 signature', () => {
    const body = '{"action":"created"}';
    const req = makeReq(body, sign(body, APP_SECRET));
    const res = makeRes();
    const next = vi.fn();

    appWebhookSignatureMiddleware(req, res, next);

    expect(next).toHaveBeenCalledOnce();
    expect(res.statusCode).toBeNull();
  });

  it('returns 401 for a tampered body', () => {
    const body = '{"action":"created"}';
    const tampered = '{"action":"deleted"}';
    const req = makeReq(tampered, sign(body, APP_SECRET));
    const res = makeRes();
    const next = vi.fn();

    appWebhookSignatureMiddleware(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
  });

  it('returns 401 when signature header is missing', () => {
    const body = '{"action":"created"}';
    const req = {
      rawBody: Buffer.from(body),
      headers: {},
      ip: '127.0.0.1',
    };
    const res = makeRes();
    const next = vi.fn();

    appWebhookSignatureMiddleware(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
  });

  it('fails closed with 500 when FF_GITHUB_APP_WEBHOOK_SECRET is not set', () => {
    delete process.env.FF_GITHUB_APP_WEBHOOK_SECRET;
    const body = '{"action":"created"}';
    const req = {
      rawBody: Buffer.from(body),
      headers: { 'x-hub-signature-256': 'sha256=deadbeef' },
      ip: '127.0.0.1',
    };
    const res = makeRes();
    const next = vi.fn();

    appWebhookSignatureMiddleware(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(500);
  });
});
