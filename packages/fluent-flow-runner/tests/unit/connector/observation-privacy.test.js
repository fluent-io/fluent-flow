import { it, expect } from 'vitest';
import { createObservationPrivacy } from '../../../src/connector/observation-privacy.js';

it('copies display payloads with longest local-root matches and exact known values while preserving relative paths', () => {
  const privacy = createObservationPrivacy({ sourceRoots: ['/host/source'], paseoHome: '/host/paseo', secrets: ['exact-host-token', 'exact-native-password'] });
  privacy.addWorkspace('/host/paseo/worktrees/task/repo');
  privacy.addSecret('exact-session-report-token');
  const original = { detail: { filePath: '/host/paseo/worktrees/task/repo/src/a.ts', source: '/host/source/lib.ts', home: '/host/paseo/config.json', relative: 'src/a.ts', text: 'exact-host-token exact-native-password exact-session-report-token' }, items: ['exact-session-report-token'] };
  const result = privacy.observation({ eventId: 'stable-id', payload: original });
  expect(result.eventId).toBe('stable-id');
  expect(result.payload).toEqual({ detail: { filePath: '[workspace]/src/a.ts', source: '[source]/lib.ts', home: '[paseo-home]/config.json', relative: 'src/a.ts', text: '[redacted] [redacted] [redacted]' }, items: ['[redacted]'] });
  expect(original.detail.filePath).toBe('/host/paseo/worktrees/task/repo/src/a.ts');
  expect(original.items[0]).toBe('exact-session-report-token');
});

it('does not claim to detect unrelated unknown paths, values or encoded content', () => {
  const privacy = createObservationPrivacy({ sourceRoots: ['/host/source'], secrets: ['known-secret'] });
  expect(privacy.redact({ text: '/other/machine/file unknown-value', encoded: Buffer.from('known-secret').toString('base64') })).toEqual({ text: '/other/machine/file unknown-value', encoded: Buffer.from('known-secret').toString('base64') });
});
