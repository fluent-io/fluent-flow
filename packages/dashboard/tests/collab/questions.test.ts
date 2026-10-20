import { describe, expect, it } from 'vitest';

// Adapted from Flowly shared/permission-question.test.ts (MIT, pinned 13213f4).
// The cases encode Paseo's provider answer contract and must not drift.
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
