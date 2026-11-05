import { describe, expect, it } from 'vitest';

const {
  allAnswered,
  answerReply,
  asksQuestion,
  buildAnswers,
  choose,
  dismissReply,
  emptyDraft,
  parseQuestions,
  pendingRequests,
  typeOther,
  pendingFromSession,
  pendingFromV2,
  buildSelections,
  requestCommand,
  loadPendingRequests,
} = await import('../../src/lib/collab/questions');

type PendingRequest = Parameters<typeof parseQuestions>[0];

const request: PendingRequest = {
  id: 'permission-1',
  name: 'AskUserQuestion',
  kind: 'question',
  input: {
    questions: [
      {
        question: 'Which database should we use?',
        header: 'Database',
        options: [{ label: 'Postgres', description: 'Relational' }, { label: 'SQLite' }],
        multiSelect: false,
        allowOther: true,
      },
      {
        question: 'Which features?',
        header: 'Features',
        options: [{ label: 'Auth' }, { label: 'Search' }, { label: 'Export' }],
        multiSelect: true,
        allowOther: true,
      },
    ],
  },
};
const questions = parseQuestions(request)!;

describe('adapted Flowly question encoding', () => {
  it('parses a question form and rejects other kinds or malformed input', () => {
    expect(questions.map((q) => [q.header, q.multiSelect, q.allowOther, q.options.length])).toEqual([
      ['Database', false, true, 2],
      ['Features', true, true, 3],
    ]);
    expect(parseQuestions({ ...request, kind: 'tool' })).toBeNull();
    expect(parseQuestions({ ...request, input: { questions: [{ question: 'q', options: [] }] } })).toBeNull();
    expect(parseQuestions({ ...request, input: { questions: [] } })).toBeNull();
  });

  it('single select replaces and clears typed text; multi select toggles', () => {
    let draft = emptyDraft(questions);
    draft = typeOther(draft, questions, 0, 'MySQL');
    draft = choose(draft, questions, 0, 1);
    expect(draft.selected[0]).toEqual([1]);
    expect(draft.other[0]).toBe('');
    draft = choose(draft, questions, 0, 0);
    expect(draft.selected[0]).toEqual([0]);
    draft = choose(draft, questions, 1, 2);
    draft = choose(draft, questions, 1, 0);
    draft = choose(draft, questions, 1, 2);
    expect(draft.selected[1]).toEqual([0]);
    expect(typeOther(draft, questions, 0, 'x').selected[0]).toEqual([]);
    expect(typeOther(draft, questions, 1, 'x').selected[1]).toEqual([0]);
  });

  it('answers are keyed by header and match the provider encoding', () => {
    let draft = emptyDraft(questions);
    expect(allAnswered(questions, draft)).toBe(false);
    draft = choose(draft, questions, 0, 0);
    expect(allAnswered(questions, draft)).toBe(false);
    draft = choose(draft, questions, 1, 1);
    draft = choose(draft, questions, 1, 0);
    draft = typeOther(draft, questions, 1, '  Billing ');
    expect(allAnswered(questions, draft)).toBe(true);
    expect(buildAnswers(questions, draft)).toEqual({ Database: 'Postgres', Features: 'Auth, Search, Billing' });
    expect(answerReply(request, questions, draft)).toEqual({
      behavior: 'allow',
      updatedInput: { ...request.input, answers: { Database: 'Postgres', Features: 'Auth, Search, Billing' } },
    });
    expect(buildAnswers(questions, typeOther(emptyDraft(questions), questions, 0, ' Mongo '))).toEqual({ Database: 'Mongo' });
  });

  it('dismiss denies, except empty-allowed free-text questions submit empty', () => {
    expect(dismissReply(request, questions, emptyDraft(questions))).toEqual({
      behavior: 'deny',
      message: 'Dismissed by user',
    });
    const free: PendingRequest = {
      id: 'p2',
      kind: 'question',
      input: { questions: [{ question: 'Anything else?', header: 'Notes', options: [], allowEmpty: true }] },
    };
    const qs = parseQuestions(free)!;
    expect(allAnswered(qs, emptyDraft(qs))).toBe(true);
    expect(dismissReply(free, qs, emptyDraft(qs))).toEqual({
      behavior: 'allow',
      updatedInput: { ...free.input, answers: { Notes: '' } },
    });
  });

  it('pending requests tolerate missing or malformed host data', () => {
    expect(pendingRequests(null)).toEqual([]);
    expect(pendingRequests({ pendingPermissions: [null, {}, { id: '' }, request] })).toEqual([request]);
    expect(asksQuestion({ pendingPermissions: [request] })).toBe(true);
    expect(asksQuestion({ pendingPermissions: [{ id: 't', kind: 'tool' }] })).toBe(false);
  });

  it('adapts the dashboard pending-request DTO to the shared shape', () => {
    const dto = {
      requestId: 'req-7',
      kind: 'question' as const,
      promptText: 'Need input',
      choices: null,
      inputSchema: request.input,
      expiresAt: null,
    };
    const adapted = pendingFromSession(dto);
    expect(adapted).toMatchObject({ id: 'req-7', kind: 'question' });
    expect(parseQuestions(adapted)).not.toBeNull();
  });

  it('adapts an approval DTO preserving its supplied actions', () => {
    const dto = {
      requestId: 'req-9',
      kind: 'permission' as const,
      promptText: 'Run rm -rf dist?',
      choices: [
        { id: 'action-allow-once', label: 'Allow once' },
        { id: 'action-deny', label: 'Deny' },
      ],
      inputSchema: null,
      expiresAt: null,
    };
    const adapted = pendingFromSession(dto);
    expect(adapted.actions).toEqual([
      { id: 'action-allow-once', label: 'Allow once', behavior: 'allow' },
      { id: 'action-deny', label: 'Deny', behavior: 'deny' },
    ]);
  });
});

type V2 = Parameters<typeof pendingFromV2>[0];
const v2 = (over: Partial<V2>): V2 => ({
  requestId: 'f'.repeat(32), kind: 'question', backend: 'claude-code', generation: 3, fingerprint: 'e'.repeat(64), promptText: 'Pick',
  choices: [{ id: 'deny', label: 'Deny and continue', scope: 'once', behavior: 'deny' }], questions: null, hostOnly: false, inputSchema: null, expiresAt: null,
  observedAt: '2026-11-05T09:00:00.000Z', ...over,
});

describe('structured native answers (Task 9)', () => {
  const native = pendingFromV2(v2({
    questions: [
      { id: 'q0', header: 'Pick', question: 'Which colors?', options: [{ id: 'o0', label: 'Red, bright', description: 'warm' }, { id: 'o1', label: 'Blue', description: null }], multiSelect: true, allowOther: true, secret: false },
      { id: 'q1', header: 'Pick', question: 'Which size?', options: [{ id: 'o0', label: 'Small', description: null }, { id: 'o1', label: 'Large', description: null }], multiSelect: false, allowOther: true, secret: false },
      { id: 'q2', header: 'Notes', question: 'Anything else?', options: null, multiSelect: false, allowOther: true, secret: false },
    ],
  }));
  const qs = parseQuestions(native)!;

  it('builds structured selections with duplicate headers, commas, valid empty text and separate other text', () => {
    expect(qs).not.toBeNull();
    expect(qs.map((q) => [q.header, q.question, q.options.map((o) => o.label)])).toEqual([
      ['Pick', 'Which colors?', ['Red, bright', 'Blue']],
      ['Pick', 'Which size?', ['Small', 'Large']],
      ['Notes', 'Anything else?', []],
    ]);
    let draft = emptyDraft(qs);
    draft = choose(draft, qs, 0, 0);
    draft = choose(draft, qs, 0, 1);
    draft = typeOther(draft, qs, 0, 'and teal');
    draft = choose(draft, qs, 1, 1);
    expect(allAnswered(qs, draft)).toBe(false);
    draft = typeOther(draft, qs, 2, 'Ship it, today');
    expect(allAnswered(qs, draft)).toBe(true);
    expect(buildSelections(qs, draft)).toEqual({
      q0: { optionIds: ['o0', 'o1'], other: 'and teal' },
      q1: { optionIds: ['o1'] },
      q2: { optionIds: [], other: 'Ship it, today' },
    });
    const blank = typeOther(choose(choose(emptyDraft(qs), qs, 0, 1), qs, 1, 0), qs, 2, '   ');
    expect(allAnswered(qs, blank)).toBe(false);
    expect(buildSelections(qs, typeOther(blank, qs, 0, ' '))).toEqual({ q0: { optionIds: ['o1'] }, q1: { optionIds: ['o0'] }, q2: { optionIds: [] } });
    expect(requestCommand(native, { behavior: 'allow', selections: buildSelections(qs, draft) })).toEqual({
      kind: 'permission', requestId: 'f'.repeat(32), generation: 3, fingerprint: 'e'.repeat(64),
      response: { behavior: 'allow', selections: buildSelections(qs, draft) },
    });
  });

  it('fix 1 I2: options that display the same scrubbed label stay distinct and are sent by option id', () => {
    const scrubbed = pendingFromV2(v2({ questions: [{ id: 'q0', header: 'Pick', question: 'Pick one', options: [{ id: 'o0', label: '[local answer]', description: null }, { id: 'o1', label: '[local answer]', description: null }, { id: 'o2', label: 'Red', description: null }], multiSelect: false, allowOther: false, secret: false }] }));
    const qs2 = parseQuestions(scrubbed)!;
    expect(qs2[0].options.map((o) => [o.id, o.label])).toEqual([['o0', '[local answer]'], ['o1', '[local answer]'], ['o2', 'Red']]);
    expect(buildSelections(qs2, choose(emptyDraft(qs2), qs2, 0, 1))).toEqual({ q0: { optionIds: ['o1'] } });
    expect(buildSelections(qs2, choose(emptyDraft(qs2), qs2, 0, 0))).toEqual({ q0: { optionIds: ['o0'] } });
  });

  it('a cancel or decline choice with behavior deny is submitted as deny', () => {
    const approval = pendingFromV2(v2({
      kind: 'permission', backend: 'codex', questions: null,
      choices: [
        { id: 'acceptForSession', label: 'Allow for this session', scope: 'session', behavior: 'allow' },
        { id: 'decline', label: 'Deny and continue', scope: 'once', behavior: 'deny' },
        { id: 'cancel', label: 'Deny and stop this turn', scope: 'once', behavior: 'deny' },
        { id: 'applyNetworkPolicyAmendment:1', label: 'Block this network host', scope: null, behavior: 'deny' },
      ],
    }));
    expect(approval.actions?.map((a) => [a.id, a.behavior])).toEqual([
      ['acceptForSession', 'allow'], ['decline', 'deny'], ['cancel', 'deny'], ['applyNetworkPolicyAmendment:1', 'deny'],
    ]);
    const cancel = approval.actions!.find((a) => a.id === 'cancel')!;
    expect(requestCommand(approval, { behavior: cancel.behavior, selectedActionId: cancel.id })).toEqual({
      kind: 'permission', requestId: 'f'.repeat(32), generation: 3, fingerprint: 'e'.repeat(64), response: { behavior: 'deny', selectedActionId: 'cancel' },
    });
  });

  it('legacy choices without behavior keep the id classification', () => {
    const legacy = pendingFromV2(v2({
      kind: 'permission', backend: 'paseo', generation: null, fingerprint: null, questions: null,
      choices: [{ id: 'approve', label: 'Approve', scope: null, behavior: null }, { id: 'action-deny', label: 'Deny', scope: null, behavior: null }, { id: 'reject-all', label: 'Reject', scope: null, behavior: null }],
    }));
    expect(legacy.actions).toEqual([
      { id: 'approve', label: 'Approve', behavior: 'allow' },
      { id: 'action-deny', label: 'Deny', behavior: 'deny' },
      { id: 'reject-all', label: 'Reject', behavior: 'deny' },
    ]);
    expect(requestCommand(legacy, { behavior: 'deny', selectedActionId: 'action-deny' })).toEqual({ kind: 'permission', requestId: 'f'.repeat(32), response: { behavior: 'deny', selectedActionId: 'action-deny' } });
    const paseoQuestion = pendingFromV2(v2({ backend: 'paseo', generation: null, fingerprint: null, choices: null, inputSchema: request.input as Record<string, unknown> }));
    expect(parseQuestions(paseoQuestion)?.map((q) => q.header)).toEqual(['Database', 'Features']);
  });
});

describe('loading every pending request (Task 9 concern C1)', () => {
  it('follows the cursor past 100 underfilled pages, so request 101 is reachable', async () => {
    const pages = Array.from({ length: 101 }, (_, i) => ({ data: [v2({ requestId: i.toString(16).padStart(32, '0') })], nextCursor: i < 100 ? `c${i + 1}` : null }));
    const asked: (string | null)[] = [];
    const loaded = await loadPendingRequests(async (cursor) => {
      asked.push(cursor);
      return pages[cursor === null ? 0 : Number(cursor.slice(1))];
    });
    expect(loaded.requests).toHaveLength(101);
    expect(loaded.requests.at(-1)?.requestId).toBe((100).toString(16).padStart(32, '0'));
    expect(loaded.complete).toBe(true);
    expect(asked).toEqual([null, ...Array.from({ length: 100 }, (_, i) => `c${i + 1}`)]);
  });

  it('a repeated cursor stops loading and reports the list as incomplete instead of looping', async () => {
    let calls = 0;
    const loaded = await loadPendingRequests(async () => {
      calls += 1;
      return { data: [v2({ requestId: `${calls}`.padStart(32, '0') })], nextCursor: 'same' };
    });
    expect(calls).toBe(2);
    expect(loaded).toMatchObject({ complete: false });
    expect(loaded.requests).toHaveLength(2);
  });
});
