import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('next-auth/react', () => ({ useSession: () => ({ data: null, status: 'unauthenticated' }), signOut: vi.fn() }));
const { PendingRequestList, SessionTimeline } = await import('../../src/components/collab/task-execution-tab');
const { pendingFromV2 } = await import('../../src/lib/collab/questions');

type V2 = Parameters<typeof pendingFromV2>[0];
const base = { generation: 1, fingerprint: 'e'.repeat(64), inputSchema: null, expiresAt: null, observedAt: '2026-11-05T09:00:00.000Z' };
const approval: V2 = {
  ...base, requestId: 'a'.repeat(32), kind: 'permission', backend: 'claude-code', promptText: 'Run npm test', questions: null, hostOnly: false,
  choices: [
    { id: 'allow_once', label: 'Allow once', scope: 'once', behavior: 'allow' },
    { id: 'allow_session', label: 'Allow for this session', scope: 'session', behavior: 'allow' },
    { id: 'deny', label: 'Deny and continue', scope: 'once', behavior: 'deny' },
  ],
};
const ordinary: V2 = {
  ...base, requestId: 'b'.repeat(32), kind: 'question', backend: 'claude-code', promptText: 'Which color?', hostOnly: false,
  choices: [{ id: 'deny', label: 'Deny and continue', scope: 'once', behavior: 'deny' }],
  questions: [{ id: 'q0', header: 'Color', question: 'Which color?', options: [{ id: 'o0', label: 'Red', description: null }, { id: 'o1', label: 'Blue', description: 'cool' }], multiSelect: false, allowOther: true, secret: false }],
};
const secret: V2 = {
  ...base, requestId: 'c'.repeat(32), kind: 'question', backend: 'codex', promptText: 'Paste the token', hostOnly: true,
  choices: [{ id: 'decline', label: 'Deny and continue', scope: 'once', behavior: 'deny' }],
  questions: [{ id: 'token', header: 'Token', question: 'Paste the token', options: null, multiSelect: false, allowOther: true, secret: true }],
};

const render = (requests: V2[], canRespond = true) =>
  renderToStaticMarkup(<PendingRequestList requests={requests.map(pendingFromV2)} drafts={{}} setDraft={() => {}} canRespond={canRespond} onSend={() => {}} />);
function card(markup: string, requestId: string) {
  const start = markup.indexOf(`data-request-id="${requestId}"`);
  expect(start).toBeGreaterThanOrEqual(0);
  const next = markup.indexOf('data-request-id="', start + 20);
  return markup.slice(start, next === -1 ? undefined : next);
}

describe('pending requests (Task 9)', () => {
  it('every request renders', () => {
    const many = Array.from({ length: 60 }, (_, i) => ({ ...approval, requestId: i.toString(16).padStart(32, '0'), promptText: `Run step ${i}` }));
    const markup = render([...many, ordinary, secret]);
    for (const r of [...many, ordinary, secret]) expect(markup).toContain(`data-request-id="${r.requestId}"`);
    expect(markup).toContain('Run step 59');
    const one = card(markup, many[0].requestId);
    expect([...one.matchAll(/<button[^>]*>([^<]*)<\/button>/g)].map((m) => m[1])).toEqual(['Allow once', 'Allow for this session', 'Deny and continue']);
  });

  it('hostOnly shows the host instruction and Cancel with no input', () => {
    const markup = card(render([secret]), secret.requestId);
    expect(markup).toContain('Answer this request on the execution host.');
    expect(markup).toContain('Paste the token');
    expect(markup).toContain(`answer --local --request ${secret.requestId}`);
    expect([...markup.matchAll(/<button[^>]*>([^<]*)<\/button>/g)].map((m) => m[1])).toEqual(['Cancel']);
    expect(markup).not.toMatch(/<input|<textarea|<select|contenteditable/);
  });

  it('ordinary questions show the form and host-answer instructions without a value field', () => {
    const markup = card(render([ordinary]), ordinary.requestId);
    expect(markup).toContain('Which color?');
    expect(markup).toMatch(/<input[^>]*type="radio"/);
    expect(markup).toMatch(/<input[^>]*aria-label="Other answer for Which color\?"/);
    expect(markup).toContain('Submit answers');
    expect(markup).toContain('Deny and continue');
    const host = markup.slice(markup.indexOf('data-host-answer'));
    expect(host).toContain(`answer --local --request ${ordinary.requestId}`);
    expect(host).not.toMatch(/<input|<textarea|<select|contenteditable/);
    const readOnly = card(render([ordinary], false), ordinary.requestId);
    expect(readOnly).toContain('Which color?');
    expect(readOnly).not.toMatch(/<input|<button/);
  });

  it('fix 1 I2: two options showing the same scrubbed label render as separate choices', () => {
    const scrubbed: V2 = { ...ordinary, requestId: 'e'.repeat(32), questions: [{ id: 'q0', header: 'Pick', question: 'Pick one', options: [{ id: 'o0', label: '[local answer]', description: null }, { id: 'o1', label: '[local answer]', description: null }, { id: 'o2', label: 'Red', description: null }], multiSelect: false, allowOther: false, secret: false }] };
    const markup = card(render([scrubbed]), scrubbed.requestId);
    expect([...markup.matchAll(/<input[^>]*type="radio"[^>]*value="([^"]*)"/g)].map((m) => m[1])).toEqual(['o0', 'o1', 'o2']);
  });

  it('a request present only in the timeline renders as history without actions', () => {
    const entries = [
      { eventId: 'claude-code:s:1:request:ctl-1', kind: 'attention', observedAt: '2026-11-05T09:00:00.000Z', payload: { attention: 'permission', requestId: 'ctl-1', kind: 'permission', choices: [{ id: 'allow_once', label: 'Allow once', behavior: 'allow' }], tool: { name: 'Bash' } } },
      { eventId: 'paseo-q', kind: 'attention', observedAt: '2026-11-05T09:00:01.000Z', payload: { attention: 'permission', permissionKind: 'question', requestId: 'paseo-q', actions: [{ id: 'approve', label: 'Approve' }] } },
    ];
    const timeline = renderToStaticMarkup(<SessionTimeline entries={entries} error={null} />);
    expect(timeline).toContain('ctl-1');
    expect(timeline).toContain('paseo-q');
    expect(timeline).not.toMatch(/<button|<input|<form/);
    expect(render([])).toBe('');
  });
});
