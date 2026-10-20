import { createHmac } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import {
  signCollaborationActor,
  verifyCollaborationActor,
  CollabAssertionError,
} from '../../src/collaboration/auth.js';

const SECRET = 'collab-test-secret-0123456789abcdef0123456789abcdef';
const ACTOR = { principalId: 'p-123', sessionVersion: 3 };
const NOW = 1_700_000_000;

// Craft an assertion with a REAL signature over a custom payload so payload
// validation (not signature validation) is what the assertion exercises.
function craftSigned(payload: Record<string, unknown>, secret = SECRET): string {
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = createHmac('sha256', secret).update(`v1.${payloadB64}`, 'ascii').digest('base64url');
  return `v1.${payloadB64}.${sig}`;
}

const BASE_PAYLOAD = {
  iss: 'fluent-flow-dashboard',
  aud: 'fluent-flow-collab',
  sub: 'p-123',
  sessionVersion: 3,
  iat: NOW,
  exp: NOW + 60,
};

describe('signCollaborationActor / verifyCollaborationActor', () => {
  it('round-trips a signed assertion back to the actor', () => {
    const assertion = signCollaborationActor(ACTOR, SECRET, NOW);
    expect(assertion.startsWith('v1.')).toBe(true);
    expect(verifyCollaborationActor(assertion, SECRET, NOW)).toEqual(ACTOR);
  });

  it('serializes the exact contract payload fields', () => {
    const [, payloadB64] = signCollaborationActor(ACTOR, SECRET, NOW).split('.');
    const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
    expect(payload).toEqual({
      iss: 'fluent-flow-dashboard',
      aud: 'fluent-flow-collab',
      sub: 'p-123',
      sessionVersion: 3,
      iat: NOW,
      exp: NOW + 60,
    });
  });

  it('rejects a tampered payload with a valid-signature segment from another assertion', () => {
    const assertion = signCollaborationActor(ACTOR, SECRET, NOW);
    const [, , sig] = assertion.split('.');
    const forged = Buffer.from(
      JSON.stringify({
        iss: 'fluent-flow-dashboard',
        aud: 'fluent-flow-collab',
        sub: 'victim-principal',
        sessionVersion: 1,
        iat: NOW,
        exp: NOW + 60,
      }),
    ).toString('base64url');
    expect(() => verifyCollaborationActor(`${forged}.${sig}`, SECRET, NOW)).toThrow(
      CollabAssertionError,
    );
  });

  it('rejects a signature made with a different secret', () => {
    const assertion = signCollaborationActor(ACTOR, SECRET, NOW);
    expect(() =>
      verifyCollaborationActor(assertion, `${SECRET}-other`, NOW),
    ).toThrow(CollabAssertionError);
  });

  it('accepts at the expiry + skew boundary and rejects beyond it', () => {
    const assertion = signCollaborationActor(ACTOR, SECRET, NOW);
    expect(verifyCollaborationActor(assertion, SECRET, NOW + 65)).toEqual(ACTOR);
    expect(() => verifyCollaborationActor(assertion, SECRET, NOW + 66)).toThrow(
      CollabAssertionError,
    );
  });

  it('rejects an assertion dated in the future beyond the clock skew', () => {
    const assertion = signCollaborationActor(ACTOR, SECRET, NOW + 120);
    expect(() => verifyCollaborationActor(assertion, SECRET, NOW)).toThrow(
      CollabAssertionError,
    );
  });

  it('rejects a validly signed assertion with a wrong issuer or audience', () => {
    const wrongIss = craftSigned({ ...BASE_PAYLOAD, iss: 'evil-issuer' });
    const wrongAud = craftSigned({ ...BASE_PAYLOAD, aud: 'fluent-flow-evil' });
    expect(() => verifyCollaborationActor(wrongIss, SECRET, NOW)).toThrow(CollabAssertionError);
    try {
      verifyCollaborationActor(wrongIss, SECRET, NOW);
      expect.unreachable('expected rejection');
    } catch (err) {
      expect((err as CollabAssertionError).reason).toBe('bad_issuer');
    }
    try {
      verifyCollaborationActor(wrongAud, SECRET, NOW);
      expect.unreachable('expected rejection');
    } catch (err) {
      expect((err as CollabAssertionError).reason).toBe('bad_audience');
    }
  });

  it('rejects a payload whose lifetime differs from 60 seconds', () => {
    const longLived = craftSigned({ ...BASE_PAYLOAD, exp: NOW + 600 });
    try {
      verifyCollaborationActor(longLived, SECRET, NOW);
      expect.unreachable('expected rejection');
    } catch (err) {
      expect((err as CollabAssertionError).reason).toBe('bad_lifetime');
    }
  });

  it('rejects validly signed payloads with invalid schema', () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      // Missing fields → first failed check.
      [{ iss: 'fluent-flow-dashboard' }, 'bad_audience'],
      [{ ...BASE_PAYLOAD, sub: '' }, 'bad_subject'],
      [{ ...BASE_PAYLOAD, sessionVersion: 0 }, 'bad_session_version'],
      [{ ...BASE_PAYLOAD, sessionVersion: 1.5 }, 'bad_session_version'],
      [{ ...BASE_PAYLOAD, iat: NOW, exp: NOW }, 'bad_lifetime'],
    ];
    for (const [payload, reason] of cases) {
      try {
        verifyCollaborationActor(craftSigned(payload), SECRET, NOW);
        expect.unreachable(`expected rejection for ${reason}`);
      } catch (err) {
        expect(err).toBeInstanceOf(CollabAssertionError);
        expect((err as CollabAssertionError).reason).toBe(reason);
      }
    }
  });

  it('rejects signature/structure failures independently of payload content', () => {
    const malformed = [
      '',
      'not-an-assertion',
      'v1.a.b.c',
      'v2.a.b',
      `v1.!!!not-base64!!!.${'A'.repeat(43)}`,
      `v1.${Buffer.from('not json').toString('base64url')}.${'A'.repeat(43)}`,
    ];
    for (const assertion of malformed) {
      try {
        verifyCollaborationActor(assertion, SECRET, NOW);
        expect.unreachable('expected rejection');
      } catch (err) {
        expect(err).toBeInstanceOf(CollabAssertionError);
      }
    }
    // Valid structure + real signature over a non-JSON payload → payload parse.
    const payloadB64 = Buffer.from('not json').toString('base64url');
    const sig = createHmac('sha256', SECRET).update(`v1.${payloadB64}`, 'ascii').digest('base64url');
    try {
      verifyCollaborationActor(`v1.${payloadB64}.${sig}`, SECRET, NOW);
      expect.unreachable('expected rejection');
    } catch (err) {
      expect((err as CollabAssertionError).reason).toBe('malformed_payload');
    }
  });

  it('refuses to sign or verify without a non-empty secret', () => {
    expect(() => signCollaborationActor(ACTOR, '', NOW)).toThrow(Error);
    const assertion = signCollaborationActor(ACTOR, SECRET, NOW);
    expect(() => verifyCollaborationActor(assertion, '', NOW)).toThrow(Error);
  });

  it('exposes a stable internal reason without assertion content for logs', () => {
    try {
      verifyCollaborationActor('v1.a.b', SECRET, NOW);
      expect.unreachable('expected rejection');
    } catch (err) {
      expect(err).toBeInstanceOf(CollabAssertionError);
      expect((err as CollabAssertionError).reason).toBeTypeOf('string');
      expect((err as Error).message).not.toContain('v1.a.b');
    }
  });
});
