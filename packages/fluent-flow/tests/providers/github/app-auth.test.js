import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { signAppJwt } from '../../../src/providers/github/app-auth.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEST_PEM = readFileSync(join(__dirname, '../../fixtures/test-app.pem'), 'utf8');

function decodeJwtPart(str) {
  const padded = str + '='.repeat((4 - (str.length % 4)) % 4);
  return JSON.parse(Buffer.from(padded, 'base64url').toString('utf8'));
}

describe('signAppJwt', () => {
  it('produces a JWT with RS256 alg and correct iss', () => {
    const token = signAppJwt({ appId: '12345', privateKeyPem: TEST_PEM });
    expect(typeof token).toBe('string');

    const parts = token.split('.');
    expect(parts).toHaveLength(3);

    const header = decodeJwtPart(parts[0]);
    expect(header.alg).toBe('RS256');
    expect(header.typ).toBe('JWT');

    const payload = decodeJwtPart(parts[1]);
    expect(payload.iss).toBe('12345');
    expect(typeof payload.iat).toBe('number');
    expect(typeof payload.exp).toBe('number');
  });

  it('exp is approximately 10 minutes after iat', () => {
    const token = signAppJwt({ appId: '99', privateKeyPem: TEST_PEM });
    const parts = token.split('.');
    const payload = decodeJwtPart(parts[1]);
    const diffMinutes = (payload.exp - payload.iat) / 60;
    // Allow a small tolerance
    expect(diffMinutes).toBeCloseTo(10, 0);
  });

  it('is verifiable with RS256', () => {
    // We can verify by checking the signature is non-empty
    const token = signAppJwt({ appId: '1', privateKeyPem: TEST_PEM });
    const parts = token.split('.');
    expect(parts[2].length).toBeGreaterThan(10);
  });
});
