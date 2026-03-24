import { describe, it, expect, vi } from 'vitest';
import { createHmac } from 'crypto';

vi.mock('../../src/logger.js', async () => {
  const { createMockLogger } = await import('../helpers/mock-logger.js');
  return { default: createMockLogger() };
});

import { verifyWebhookSignature } from '../../src/github/webhook-verify.js';

function sign(body, secret) {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

const SECRET = 'test-webhook-secret';
const BODY = Buffer.from('{"action":"opened"}');

describe('verifyWebhookSignature', () => {
  it('returns true for valid signature', () => {
    const sig = sign(BODY, SECRET);
    expect(verifyWebhookSignature(BODY, sig, SECRET)).toBe(true);
  });

  it('returns false for wrong secret', () => {
    const sig = sign(BODY, 'wrong-secret');
    expect(verifyWebhookSignature(BODY, sig, SECRET)).toBe(false);
  });

  it('returns false for tampered body', () => {
    const sig = sign(BODY, SECRET);
    const tampered = Buffer.from('{"action":"closed"}');
    expect(verifyWebhookSignature(tampered, sig, SECRET)).toBe(false);
  });

  it('returns false when signature is null/undefined', () => {
    expect(verifyWebhookSignature(BODY, null, SECRET)).toBe(false);
    expect(verifyWebhookSignature(BODY, undefined, SECRET)).toBe(false);
  });

  it('returns false when secret is null/undefined', () => {
    const sig = sign(BODY, SECRET);
    expect(verifyWebhookSignature(BODY, sig, null)).toBe(false);
    expect(verifyWebhookSignature(BODY, sig, undefined)).toBe(false);
  });

  it('returns false for malformed signature (no sha256= prefix)', () => {
    const raw = createHmac('sha256', SECRET).update(BODY).digest('hex');
    expect(verifyWebhookSignature(BODY, raw, SECRET)).toBe(false);
  });

  it('returns false for empty signature string', () => {
    expect(verifyWebhookSignature(BODY, '', SECRET)).toBe(false);
  });

  it('handles large body', () => {
    const largeBody = Buffer.alloc(1024 * 64, 'x');
    const sig = sign(largeBody, SECRET);
    expect(verifyWebhookSignature(largeBody, sig, SECRET)).toBe(true);
  });
});
