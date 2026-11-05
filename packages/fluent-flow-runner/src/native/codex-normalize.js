
import { createHash } from 'node:crypto';
import { NATIVE_OBSERVED } from './pins.js';

const OBSERVED = NATIVE_OBSERVED.codex;

export const CODEX_LABELS = Object.freeze({
  allowOnce: 'Allow once',
  allowSession: 'Allow for this session',
  allowAmendment: "Allow and don't ask again for similar commands",
  allowHost: 'Allow this network host',
  blockHost: 'Block this network host',
  denyContinue: 'Deny and continue',
  denyStop: 'Deny and stop this turn',
  deny: 'Deny',
  allowAlwaysTool: "Allow and don't ask again for this tool",
  allowAlwaysSession: "Allow and don't ask again in this session",
});

const DELTA_STREAMS = Object.freeze({
  'item/agentMessage/delta': 'agentMessage',
  'item/reasoning/textDelta': 'reasoning',
  'item/reasoning/summaryTextDelta': 'reasoningSummary',
  'item/plan/delta': 'plan',
  'item/commandExecution/outputDelta': 'commandOutput',
  'item/fileChange/outputDelta': 'fileChangeOutput',
});

const ERROR_KINDS = new Set([
  'contextWindowExceeded', 'sessionBudgetExceeded', 'usageLimitExceeded', 'rateLimitExceeded', 'flexUnavailable', 'serverOverloaded',
  'cyberPolicy', 'misalignmentPolicyViolation', 'tooManyDenials', 'httpConnectionFailed', 'responseStreamConnectionFailed',
  'internalServerError', 'unauthorized', 'badRequest', 'threadRollbackFailed', 'sandboxError', 'responseStreamDisconnected',
  'responseTooManyFailedAttempts', 'activeTurnNotSteerable', 'other',
]);
function errorKind(info) {
  if (typeof info === 'string') return ERROR_KINDS.has(info) ? info : 'other';
  if (info && typeof info === 'object') {
    const [key] = Object.keys(info);
    return ERROR_KINDS.has(key) ? key : 'other';
  }
  return null;
}

function modelUnavailable(error) {
  if (error?.codexErrorInfo !== 'other' || typeof error.message !== 'string') return false;
  let body;
  try {
    body = JSON.parse(error.message);
  } catch {
    return false;
  }
  return body?.error?.code === 'model_not_found';
}

export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().filter((k) => value[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const USAGE_FIELDS = Object.freeze({ input: 'inputTokens', cachedInput: 'cachedInputTokens', cacheWriteInput: 'cacheWriteInputTokens', output: 'outputTokens', reasoningOutput: 'reasoningOutputTokens', total: 'totalTokens' });

function readTotals(total) {
  return Object.fromEntries(Object.entries(USAGE_FIELDS).map(([name, key]) => [name, num(total?.[key])]));
}

function diffTotals(latest, baseline) {
  return Object.fromEntries(Object.keys(USAGE_FIELDS).map((name) => [name, latest[name] === null || baseline[name] === null ? null : latest[name] - baseline[name]]));
}

/**
 * @param {{ model?: string|null, resumed?: boolean }} [opts] `model` is the thread's actual model (thread/start or thread/resume response); a resumed thread has no known usage baseline, so its first turn's usage is unknown.
 */
export function createCodexNormalizeContext({ model = null, resumed = false } = {}) {
  const zero = Object.fromEntries(Object.keys(USAGE_FIELDS).map((k) => [k, 0]));
  return {
    model,
    seq: 0,
    baseline: resumed ? null : zero,
    turnTotals: new Map(),
    turns: new Map(),
    ffResolved: new Set(),
    persistableMcpServers: new Set(),
  };
}

export const rpcRequestId = (id) => `rpc:${id}`;

/**
 * @param {{ method: string, params: any }} message a server notification
 * @param {ReturnType<typeof createCodexNormalizeContext>} ctx
 * @returns {Array<{ kind: string, nativeEventId: string, payload: any, receiptFor?: string, terminal?: string }>}
 */
export function normalizeCodexMessage(message, ctx) {
  const params = message?.params ?? {};
  switch (message?.method) {
    case 'item/started':
    case 'item/completed': {
      const phase = message.method === 'item/started' ? 'started' : 'completed';
      const item = params.item;
      if (!item || typeof item.id !== 'string') return [];
      const event = { kind: 'timeline', nativeEventId: `item:${item.id}:${phase}`, payload: { phase, threadId: params.threadId, turnId: params.turnId, item } };
      if (phase === 'completed' && item.type === 'userMessage' && typeof item.clientId === 'string') event.receiptFor = item.clientId;
      return [event];
    }
    case 'turn/started':
      if (typeof params.turn?.id === 'string') turnAttribution(ctx, params.turn.id);
      return [{ kind: 'state', nativeEventId: `turn:${params.turn?.id}:started`, payload: { state: 'running', threadId: params.threadId, turnId: params.turn?.id } }];
    case 'turn/completed':
      return turnCompleted(params, ctx);
    case 'thread/tokenUsage/updated':
      if (typeof params.turnId === 'string') {
        turnAttribution(ctx, params.turnId);
        ctx.turnTotals.set(params.turnId, readTotals(params.tokenUsage?.total));
      }
      return [];
    case 'model/rerouted': {
      const str = (v) => (typeof v === 'string' ? v : null);
      const turnId = typeof params.turnId === 'string' && params.turnId !== '' ? params.turnId : null;
      if (typeof params.toModel !== 'string' || params.toModel === '') {
        if (turnId) turnAttribution(ctx, turnId).attribution = 'unknown';
        else markOpenTurnsUnproven(ctx);
        return [];
      }
      const fromModel = typeof params.fromModel === 'string' && params.fromModel !== '' ? params.fromModel : null;
      const unchanged = (entry) => fromModel === params.toModel && entry.attribution === 'single' && entry.model === params.toModel;
      if (turnId) {
        const entry = turnAttribution(ctx, turnId, fromModel ?? ctx.model);
        if (!unchanged(entry)) {
          const known = fromModel !== null && fromModel !== params.toModel;
          if (entry.attribution === 'single') entry.attribution = known ? 'mixed' : 'unknown';
          if (entry.attribution === 'mixed') for (const m of [fromModel, params.toModel]) if (m && !entry.reported.includes(m)) entry.reported.push(m);
        }
      } else if (![...ctx.turns.values()].every(unchanged)) {
        markOpenTurnsUnproven(ctx);
      }
      ctx.model = params.toModel;
      return [{ kind: 'state', nativeEventId: `model:${turnId}:rerouted:${++ctx.seq}`, payload: { state: 'model_rerouted', threadId: str(params.threadId), turnId, fromModel: str(params.fromModel), toModel: params.toModel, reason: str(params.reason) } }];
    }
    case 'turn/plan/updated':
      return [{ kind: 'plan', nativeEventId: `plan:${params.turnId}:${++ctx.seq}`, payload: { turnId: params.turnId, explanation: params.explanation ?? null, plan: params.plan ?? [] } }];
    case 'serverRequest/resolved': {
      const nativeRequestId = rpcRequestId(params.requestId);
      return [{ kind: 'attention', nativeEventId: `request:${nativeRequestId}:resolved`, payload: { nativeRequestId, state: 'resolved', resolvedBy: ctx.ffResolved.has(nativeRequestId) ? 'ff' : 'native' } }];
    }
    default: {
      const stream = DELTA_STREAMS[message?.method];
      if (!stream) return [];
      return [{ kind: 'timeline', nativeEventId: `delta:${params.itemId}:${++ctx.seq}`, payload: { phase: 'delta', stream, threadId: params.threadId, turnId: params.turnId, itemId: params.itemId, delta: params.delta } }];
    }
  }
}

function turnCompleted(params, ctx) {
  const turn = params.turn ?? {};
  const latest = ctx.turnTotals.get(turn.id);
  ctx.turnTotals.delete(turn.id);
  let tokens = null;
  if (latest) {
    if (ctx.baseline) tokens = diffTotals(latest, ctx.baseline);
    ctx.baseline = Object.values(latest).every((v) => v !== null) ? latest : null;
  } else {
    ctx.baseline = null;
  }
  const entry = ctx.turns.get(turn.id) ?? { model: ctx.model ?? null, attribution: ctx.model ? 'single' : 'unknown', reported: [] };
  ctx.turns.delete(turn.id);
  const attribution = { model: entry.attribution === 'single' ? entry.model : null, modelAttribution: entry.attribution, ...(entry.attribution === 'mixed' ? { modelsReported: [...entry.reported] } : {}) };
  const usage = { kind: 'usage', nativeEventId: `usage:${turn.id}`, payload: { turnId: turn.id, ...attribution, tokens, threadTotals: latest ?? null, cost: null } };
  let terminal;
  const payload = { state: '', threadId: params.threadId, turnId: turn.id };
  if (turn.status === 'completed') terminal = 'completed';
  else if (turn.status === 'interrupted') terminal = 'interrupted';
  else if (turn.status === 'failed') {
    terminal = 'failed';
    const info = turn.error?.codexErrorInfo;
    payload.errorKind = errorKind(info);
    if (modelUnavailable(turn.error)) payload.errorCode = 'profile_unavailable';
    else if (payload.errorKind === 'usageLimitExceeded') {
      terminal = 'account_limited';
      payload.errorCode = 'account_limited';
    }
  } else return [usage];
  payload.state = terminal;
  return [usage, { kind: 'state', nativeEventId: `turn:${turn.id}:completed`, payload, terminal }];
}

const allow = (id, label, scope) => ({ id, label, scope, behavior: /** @type {const} */ ('allow') });
const deny = (id, label, scope = 'once') => ({ id, label, scope, behavior: /** @type {const} */ ('deny') });

function commandChoice(decision, index) {
  if (decision === 'accept') return allow('accept', CODEX_LABELS.allowOnce, 'once');
  if (decision === 'acceptForSession') return allow('acceptForSession', CODEX_LABELS.allowSession, 'session');
  if (decision === 'decline') return deny('decline', CODEX_LABELS.denyContinue);
  if (decision === 'cancel') return deny('cancel', OBSERVED.commandCancelInterrupts ? CODEX_LABELS.denyStop : CODEX_LABELS.deny);
  if (decision && typeof decision === 'object' && !Array.isArray(decision)) {
    const keys = Object.keys(decision);
    if (keys.length !== 1) return null;
    if (keys[0] === 'acceptWithExecpolicyAmendment') return allow(`acceptWithExecpolicyAmendment:${index}`, CODEX_LABELS.allowAmendment, null);
    if (keys[0] === 'applyNetworkPolicyAmendment') {
      const action = decision.applyNetworkPolicyAmendment?.network_policy_amendment?.action;
      if (action === 'allow') return allow(`applyNetworkPolicyAmendment:${index}`, CODEX_LABELS.allowHost, null);
      if (action === 'deny') return deny(`applyNetworkPolicyAmendment:${index}`, CODEX_LABELS.blockHost, null);
    }
  }
  return null;
}

/**
 * @param {{ id: number|string, method: string, params: any }} request
 * @param {ReturnType<typeof createCodexNormalizeContext>} ctx
 */
export function codexServerRequest(request, ctx) {
  const { id, method } = request;
  const params = request.params ?? {};
  /** @type {Array<ReturnType<typeof allow> | ReturnType<typeof deny>>} */
  const choices = [];
  /** @type {Map<string, object>} */
  const responses = new Map();
  let reconcile = false;
  const add = (choice, body) => {
    choices.push(choice);
    responses.set(choice.id, body);
  };

  if (method === 'item/commandExecution/requestApproval') {
    const offered = params.availableDecisions;
    const mapped = Array.isArray(offered) ? offered.map(commandChoice) : null;
    if (!mapped || mapped.some((c) => c === null)) reconcile = true;
    else mapped.forEach((choice, i) => add(choice, { decision: structuredClone(offered[i]) }));
  } else if (method === 'item/fileChange/requestApproval') {
    add(allow('accept', CODEX_LABELS.allowOnce, 'once'), { decision: 'accept' });
    add(allow('acceptForSession', CODEX_LABELS.allowSession, 'session'), { decision: 'acceptForSession' });
    add(deny('decline', CODEX_LABELS.denyContinue), { decision: 'decline' });
    add(deny('cancel', CODEX_LABELS.denyStop), { decision: 'cancel' });
  } else if (method === 'item/permissions/requestApproval') {
    const granted = {};
    if (params.permissions?.network) granted.network = structuredClone(params.permissions.network);
    if (params.permissions?.fileSystem) granted.fileSystem = structuredClone(params.permissions.fileSystem);
    add(allow('accept', CODEX_LABELS.allowOnce, 'once'), { permissions: granted, scope: 'turn' });
    add(allow('acceptForSession', CODEX_LABELS.allowSession, 'session'), { permissions: structuredClone(granted), scope: 'session' });
    add(deny('decline', CODEX_LABELS.denyContinue), { permissions: {}, scope: 'turn' });
  } else if (method === 'mcpServer/elicitation/request' && params._meta?.codex_approval_kind === 'mcp_tool_call') {
    add(allow('accept', CODEX_LABELS.allowOnce, 'once'), { action: 'accept', content: {}, _meta: null });
    const persist = params._meta.persist;
    const scopes = typeof persist === 'string' ? [persist] : Array.isArray(persist) ? persist : [];
    if (scopes.includes('session')) add(allow('acceptForSession', CODEX_LABELS.allowSession, 'session'), { action: 'accept', content: {}, _meta: { persist: 'session' } });
    if (scopes.includes('always')) {
      const saved = ctx.persistableMcpServers.has(params.serverName);
      add(allow('acceptAlways', saved ? CODEX_LABELS.allowAlwaysTool : CODEX_LABELS.allowAlwaysSession, saved ? null : 'session'), { action: 'accept', content: {}, _meta: { persist: 'always' } });
    }
    add(deny('decline', CODEX_LABELS.denyContinue), { action: 'decline', content: null, _meta: null });
    add(deny('cancel', OBSERVED.mcpApprovalCancelInterrupts ? CODEX_LABELS.denyStop : CODEX_LABELS.deny), { action: 'cancel', content: null, _meta: null });
  } else {
    return { unsupported: true };
  }

  const nativeRequestId = rpcRequestId(id);
  const publicRequest = {
    nativeRequestId,
    kind: /** @type {'permission'} */ ('permission'),
    method,
    fingerprint: createHash('sha256').update(canonical({ id, method, params })).digest('hex'),
    secret: false,
    hostOnly: false,
    choices,
    questions: null,
    detail: structuredClone(params),
  };
  return { publicRequest, responses, reconcile };
}

function turnAttribution(ctx, turnId, model = ctx.model) {
  if (!ctx.turns.has(turnId)) ctx.turns.set(turnId, { model: model ?? null, attribution: model ? 'single' : 'unknown', reported: [] });
  return ctx.turns.get(turnId);
}

export function markOpenTurnsUnproven(ctx) {
  for (const entry of ctx.turns.values()) entry.attribution = 'unknown';
}
