import type { PendingRequestV2 } from './types';

export interface PendingRequest {
  id: string;
  backend?: PendingRequestV2['backend'];
  generation?: number | null;
  fingerprint?: string | null;
  hostOnly?: boolean;
  questions?: readonly FormQuestion[] | null;
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
  id?: string;
  question: string;
  header: string;
  options: { id?: string; label: string; description?: string }[];
  multiSelect: boolean;
  allowOther: boolean;
  allowEmpty: boolean;
  placeholder?: string;
  dismissLabel?: string;
}

export interface QuestionDraft {
  selected: number[][];
  other: string[];
}

const record = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const text = (v: unknown) => (typeof v === 'string' ? v : undefined);

export function parseQuestions(request: PendingRequest): FormQuestion[] | null {
  if (request.kind === 'question' && request.questions) return request.questions.length ? [...request.questions] : null;
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

export const showsTextInput = (q: FormQuestion) => q.options.length === 0 || q.allowOther;

export const emptyDraft = (questions: readonly FormQuestion[]): QuestionDraft => ({
  selected: questions.map(() => []),
  other: questions.map(() => ''),
});

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

export function dismissReply(request: PendingRequest, questions: readonly FormQuestion[], draft: QuestionDraft): PermissionReply {
  return questions.length > 0 && questions.every((q) => q.allowEmpty && q.options.length === 0)
    ? answerReply(request, questions, draft)
    : { behavior: 'deny', message: 'Dismissed by user' };
}

export const dismissLabel = (questions: readonly FormQuestion[]) => questions.find((q) => q.dismissLabel)?.dismissLabel;

export function pendingRequests(agent: { pendingPermissions?: readonly unknown[] | null } | null | undefined): PendingRequest[] {
  return (agent?.pendingPermissions || []).filter(
    (r): r is PendingRequest => record(r) && typeof r.id === 'string' && r.id.length > 0,
  );
}

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

export type Selections = Record<string, { optionIds: string[]; other?: string }>;

export function pendingFromV2(dto: PendingRequestV2): PendingRequest {
  return {
    id: dto.requestId,
    kind: dto.kind,
    backend: dto.backend,
    generation: dto.generation,
    fingerprint: dto.fingerprint,
    hostOnly: dto.hostOnly,
    name: dto.promptText,
    title: dto.promptText,
    input: dto.inputSchema ?? undefined,
    questions: dto.questions?.map((q) => ({
      id: q.id,
      question: q.question,
      header: q.header,
      options: (q.options ?? []).map((o) => ({ id: o.id, label: o.label, description: o.description ?? undefined })),
      multiSelect: q.multiSelect,
      allowOther: q.allowOther,
      allowEmpty: false,
    })) ?? null,
    actions: dto.choices?.map((choice) => ({
      id: choice.id,
      label: choice.label,
      behavior: choice.behavior ?? ((denyActionIds.test(choice.id) ? 'deny' : 'allow') as 'allow' | 'deny'),
    })),
  };
}

export function buildSelections(questions: readonly FormQuestion[], draft: QuestionDraft): Selections {
  const out: Selections = {};
  questions.forEach((q, i) => {
    const optionIds = (draft.selected[i] || []).map((o) => q.options[o]?.id).filter((id): id is string => !!id);
    const typed = draft.other[i] ?? '';
    out[q.id ?? String(i)] = showsTextInput(q) && typed.trim() ? { optionIds, other: typed } : { optionIds };
  });
  return out;
}

export function requestCommand(request: PendingRequest, response: Record<string, unknown>): Record<string, unknown> {
  const native = typeof request.generation === 'number' && typeof request.fingerprint === 'string';
  return { kind: 'permission', requestId: request.id, ...(native ? { generation: request.generation, fingerprint: request.fingerprint } : {}), response };
}

export type PendingPage = { data: PendingRequestV2[]; nextCursor: string | null };

export async function loadPendingRequests(fetchPage: (cursor: string | null) => Promise<PendingPage>): Promise<{ requests: PendingRequestV2[]; complete: boolean }> {
  const requests: PendingRequestV2[] = [];
  const seen = new Set<string>();
  let cursor: string | null = null;
  for (;;) {
    const page: PendingPage = await fetchPage(cursor);
    requests.push(...page.data);
    if (page.nextCursor === null) return { requests, complete: true };
    if (seen.has(page.nextCursor)) return { requests, complete: false };
    seen.add(page.nextCursor);
    cursor = page.nextCursor;
  }
}
