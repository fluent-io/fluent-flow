/**
 * Agent questions and permission requests answered from a Fluent Flow session.
 *
 * Adapted from Flowly `shared/permission-question.ts` (MIT License,
 * Copyright (c) 2026 Flowly contributors; pinned revision 13213f4 of
 * JasprW/flowly). The answer encoding mirrors Paseo's shared question form so
 * an answer given here reaches the provider exactly as one given in Paseo:
 * answers are keyed by question header, several choices are joined with ", ",
 * and the provider maps headers back to the full question text. Adaptations:
 * the dashboard consumes A's pending-request DTO (`requestId`, optional
 * `inputSchema`) via `pendingFromSession`, and approvals carry the action id
 * supplied by the host (`selectedActionId`).
 *
 * The full MIT notice is recorded in the repository THIRD_PARTY_NOTICES file.
 */

export interface PendingRequest {
  id: string;
  name?: string;
  kind?: string;
  title?: string;
  description?: string;
  input?: Record<string, unknown>;
  actions?: readonly { id: string; label: string; behavior: 'allow' | 'deny'; variant?: string }[];
}

export type PermissionReply =
  | { behavior: 'allow'; selectedActionId?: string; updatedInput?: Record<string, unknown> }
  | { behavior: 'deny'; selectedActionId?: string; message?: string };

export interface FormQuestion {
  question: string;
  header: string;
  options: { label: string; description?: string }[];
  multiSelect: boolean;
  allowOther: boolean;
  allowEmpty: boolean;
  placeholder?: string;
  dismissLabel?: string;
}

/** Per question: the chosen option indexes and the typed "Other" text. */
export interface QuestionDraft {
  selected: number[][];
  other: string[];
}

const record = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const text = (v: unknown) => (typeof v === 'string' ? v : undefined);

/** The questions of a `question` request, or null when it is not a well-formed question form. */
export function parseQuestions(request: PendingRequest): FormQuestion[] | null {
  if (request.kind !== 'question' || !record(request.input) || !Array.isArray(request.input.questions)) return null;
  const out: FormQuestion[] = [];
  for (const item of request.input.questions) {
    if (!record(item) || typeof item.question !== 'string' || typeof item.header !== 'string' || !Array.isArray(item.options))
      return null;
    const options: FormQuestion['options'] = [];
    for (const option of item.options) {
      if (!record(option) || typeof option.label !== 'string') return null;
      options.push({ label: option.label, description: text(option.description) });
    }
    out.push({
      question: item.question,
      header: item.header,
      options,
      multiSelect: item.multiSelect === true,
      allowOther: item.allowOther === true || item.isOther === true,
      allowEmpty: item.allowEmpty === true,
      placeholder: text(item.placeholder),
      dismissLabel: text(item.dismissLabel),
    });
  }
  return out.length ? out : null;
}

/** Whether the question takes typed text ("Other", or no options at all). */
export const showsTextInput = (q: FormQuestion) => q.options.length === 0 || q.allowOther;

export const emptyDraft = (questions: readonly FormQuestion[]): QuestionDraft => ({
  selected: questions.map(() => []),
  other: questions.map(() => ''),
});

/** Picking an option: multi-select toggles; single select replaces (or clears) and drops typed text. */
export function choose(draft: QuestionDraft, questions: readonly FormQuestion[], index: number, option: number): QuestionDraft {
  const q = questions[index];
  const current = draft.selected[index] || [];
  const next = q.multiSelect
    ? current.includes(option)
      ? current.filter((o) => o !== option)
      : [...current, option].sort((a, b) => a - b)
    : current.includes(option)
      ? []
      : [option];
  const selected = draft.selected.map((s, i) => (i === index ? next : s));
  const other = !q.multiSelect && draft.other[index] ? draft.other.map((o, i) => (i === index ? '' : o)) : draft.other;
  return { selected, other };
}

/** Typing "Other" text: a single-select question drops its chosen option. */
export function typeOther(draft: QuestionDraft, questions: readonly FormQuestion[], index: number, value: string): QuestionDraft {
  const other = draft.other.map((o, i) => (i === index ? value : o));
  const clear = !questions[index].multiSelect && value.length > 0 && (draft.selected[index] || []).length > 0;
  return { selected: clear ? draft.selected.map((s, i) => (i === index ? [] : s)) : draft.selected, other };
}

export function isAnswered(q: FormQuestion, index: number, draft: QuestionDraft) {
  if ((draft.selected[index] || []).length > 0) return true;
  if (!showsTextInput(q)) return false;
  return !!draft.other[index]?.trim() || q.allowEmpty;
}

export const allAnswered = (questions: readonly FormQuestion[], draft: QuestionDraft) =>
  questions.every((q, i) => isAnswered(q, i, draft));

export function buildAnswers(questions: readonly FormQuestion[], draft: QuestionDraft): Record<string, string> {
  const answers: Record<string, string> = {};
  questions.forEach((q, i) => {
    const labels = (draft.selected[i] || []).map((o) => q.options[o]?.label).filter((l): l is string => !!l);
    const typed = draft.other[i]?.trim();
    if (showsTextInput(q)) {
      if (typed) {
        answers[q.header] = q.multiSelect ? [...labels, typed].join(', ') : typed;
        return;
      }
      if (q.allowEmpty && q.options.length === 0) {
        answers[q.header] = '';
        return;
      }
    }
    if (labels.length) answers[q.header] = labels.join(', ');
  });
  return answers;
}

export function answerReply(request: PendingRequest, questions: readonly FormQuestion[], draft: QuestionDraft): PermissionReply {
  return { behavior: 'allow', updatedInput: { ...(request.input || {}), answers: buildAnswers(questions, draft) } };
}

/** Dismissing: free-text-only questions that accept empty answers submit empty; otherwise the request is denied. */
export function dismissReply(request: PendingRequest, questions: readonly FormQuestion[], draft: QuestionDraft): PermissionReply {
  return questions.length > 0 && questions.every((q) => q.allowEmpty && q.options.length === 0)
    ? answerReply(request, questions, draft)
    : { behavior: 'deny', message: 'Dismissed by user' };
}

export const dismissLabel = (questions: readonly FormQuestion[]) => questions.find((q) => q.dismissLabel)?.dismissLabel;

/** The pending requests of a session snapshot (defensive: hosts may omit or malform the list). */
export function pendingRequests(agent: { pendingPermissions?: readonly unknown[] | null } | null | undefined): PendingRequest[] {
  return (agent?.pendingPermissions || []).filter(
    (r): r is PendingRequest => record(r) && typeof r.id === 'string' && r.id.length > 0,
  );
}

/** Whether a session is waiting on an agent question (as opposed to a tool/plan approval). */
export const asksQuestion = (agent: { pendingPermissions?: readonly unknown[] | null } | null | undefined) =>
  pendingRequests(agent).some((r) => r.kind === 'question');

interface SessionPendingDto {
  requestId: string;
  kind: 'permission' | 'question';
  promptText: string;
  choices?: { id: string; label: string }[] | null;
  inputSchema?: Record<string, unknown> | null;
  expiresAt?: string | null;
}

const denyActionIds = /deny|reject|no\b/i;

/**
 * Map A's authoritative pending-request DTO onto the shared request shape.
 * Approval choices keep their host-supplied action ids; a choice whose id
 * reads as a denial is marked so the deny branch preserves selectedActionId.
 */
export function pendingFromSession(dto: SessionPendingDto): PendingRequest {
  return {
    id: dto.requestId,
    kind: dto.kind,
    name: dto.promptText,
    title: dto.promptText,
    input: dto.inputSchema ?? undefined,
    actions: dto.choices?.map((choice) => ({
      id: choice.id,
      label: choice.label,
      behavior: (denyActionIds.test(choice.id) ? 'deny' : 'allow') as 'allow' | 'deny',
    })),
  };
}
