import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createCodexNormalizeContext, normalizeCodexMessage, codexServerRequest, markOpenTurnsUnproven } from '../../../src/native/codex-normalize.js';

const transcripts = JSON.parse(readFileSync(new URL('./fixtures/codex-0.162.1-transcripts.json', import.meta.url), 'utf8'));
const notifications = (messages) => messages.filter((m) => m.id === undefined);

function run(messages, ctx = createCodexNormalizeContext({ model: 'ff-probe-model' })) {
  return notifications(messages).flatMap((m) => normalizeCodexMessage(m, ctx));
}

describe('normalizeCodexMessage (0.162.1)', () => {
  it('the 0.162.1 transcript yields ordered timeline items', () => {
    const events = run(transcripts.plain.messages);
    const timeline = events.filter((e) => e.kind === 'timeline').map((e) => `${e.payload.phase}:${e.payload.item?.type ?? e.payload.stream}`);
    expect(timeline).toEqual([
      'started:userMessage',
      'completed:userMessage',
      'started:mcpToolCall',
      'completed:mcpToolCall',
      'started:agentMessage',
      'delta:agentMessage',
      'completed:agentMessage',
    ]);
    const ids = events.map((e) => e.nativeEventId);
    expect(new Set(ids).size, 'nativeEventIds are unique').toBe(ids.length);
    const delta = events.find((e) => e.payload.phase === 'delta');
    expect(delta.payload.delta).toBe('hello there');
    const tail = events.slice(-2);
    expect(tail[0]).toMatchObject({ kind: 'usage', payload: { model: 'ff-probe-model', tokens: { input: 2, cachedInput: 0, output: 2, reasoningOutput: 0, total: 4 } } });
    expect(tail[1]).toMatchObject({ kind: 'state', terminal: 'completed', payload: { state: 'completed' } });
    expect(events.filter((e) => e.terminal)).toHaveLength(1);
  });

  it('a 404 transcript is a generic failure and keeps provider text out', () => {
    const events = run(transcripts.missingModel.messages);
    const terminal = events.filter((e) => e.terminal);
    expect(terminal).toHaveLength(1);
    expect(terminal[0]).toMatchObject({ terminal: 'failed', payload: { state: 'failed', errorKind: 'httpConnectionFailed' } });
    expect(terminal[0].payload.errorCode).toBeUndefined();
    const text = JSON.stringify(events);
    expect(text).not.toContain('fixture-url');
    expect(text).not.toContain('404 Not Found');
  });

  it('only the pinned 400 model_not_found body is profile_unavailable; no 404 variant is a model diagnosis', () => {
    const x15 = JSON.parse(readFileSync(new URL('../../native/evidence/codex-0.162.1/X15.json', import.meta.url), 'utf8'));
    const terminalFor = (error) => normalizeCodexMessage({ method: 'turn/completed', params: { threadId: 't', turn: { id: 'u', status: 'failed', error } } }, createCodexNormalizeContext({ model: 'm' })).find((e) => e.terminal);
    const classified = Object.fromEntries(Object.entries(x15).map(([name, r]) => [name, terminalFor({ message: r.terminalMessage, codexErrorInfo: r.terminalErrorInfo }).payload.errorCode ?? null]));
    expect(classified).toEqual({ modelNotFound404: null, routing404: null, plain404: null, modelNotFound400: 'profile_unavailable', invalidValue400: null });
    for (const variant of ['httpConnectionFailed', 'responseStreamConnectionFailed', 'responseStreamDisconnected', 'responseTooManyFailedAttempts']) {
      const routing = terminalFor({ message: 'Reverse proxy route /invalid-endpoint was not found; model identifier accepted', codexErrorInfo: { [variant]: { httpStatusCode: 404 } } });
      expect(routing.payload.errorCode, variant).toBeUndefined();
      expect(routing.payload.errorKind, variant).toBe(variant);
    }
    const body = JSON.stringify({ error: { code: 'model_not_found', message: 'x' } });
    expect(terminalFor({ message: body, codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 400 } } }).payload.errorCode).toBeUndefined();
    expect(terminalFor({ message: `prefix ${body}`, codexErrorInfo: 'other' }).payload.errorCode).toBeUndefined();
    expect(JSON.stringify(terminalFor({ message: body, codexErrorInfo: 'other' }))).not.toContain('model_not_found');
  });

  it('a usageLimitExceeded turn is account_limited; a rate limit or other failure is not', () => {
    const terminalFor = (error) => normalizeCodexMessage({ method: 'turn/completed', params: { threadId: 't', turn: { id: 'u', status: 'failed', error } } }, createCodexNormalizeContext({ model: 'm' })).find((e) => e.terminal);
    const limited = terminalFor({ message: 'You have hit your usage limit.', codexErrorInfo: 'usageLimitExceeded' });
    expect(limited).toMatchObject({ terminal: 'account_limited', payload: { state: 'account_limited', errorKind: 'usageLimitExceeded', errorCode: 'account_limited' } });
    expect(JSON.stringify(limited)).not.toContain('usage limit');
    for (const info of ['rateLimitExceeded', 'serverOverloaded', 'other', { httpConnectionFailed: { httpStatusCode: 429 } }]) {
      const other = terminalFor({ message: 'You have hit your usage limit.', codexErrorInfo: info });
      expect(other.terminal, JSON.stringify(info)).toBe('failed');
      expect(other.payload.errorCode, JSON.stringify(info)).toBeUndefined();
    }
  });

  it('serverRequest/resolved alone never marks an approval accepted', () => {
    const ctx = createCodexNormalizeContext({ model: 'm' });
    const [native] = normalizeCodexMessage({ method: 'serverRequest/resolved', params: { threadId: 't', requestId: 0 } }, ctx);
    expect(native).toMatchObject({ kind: 'attention', payload: { nativeRequestId: 'rpc:0', state: 'resolved', resolvedBy: 'native' } });
    ctx.ffResolved.add('rpc:1');
    const [ff] = normalizeCodexMessage({ method: 'serverRequest/resolved', params: { threadId: 't', requestId: 1 } }, ctx);
    expect(ff.payload).toMatchObject({ nativeRequestId: 'rpc:1', state: 'resolved', resolvedBy: 'ff' });
    for (const e of [native, ff]) {
      expect(Object.keys(e.payload).sort()).toEqual(['nativeRequestId', 'resolvedBy', 'state']);
      expect(e.terminal).toBeUndefined();
    }
  });

  it('unknown usage is null', () => {
    const ctx = createCodexNormalizeContext({ model: null });
    const done = (turnId) => ({ method: 'turn/completed', params: { threadId: 't', turn: { id: turnId, status: 'completed', error: null } } });
    const usageOf = (events) => {
      const usage = events.filter((e) => e.kind === 'usage');
      expect(usage, 'one usage event per terminal').toHaveLength(1);
      return usage;
    };
    const [noUsage] = usageOf(normalizeCodexMessage(done('a'), ctx));
    expect(noUsage.payload).toEqual({ turnId: 'a', model: null, modelAttribution: 'unknown', tokens: null, threadTotals: null, cost: null });
    const fresh = createCodexNormalizeContext({ model: null });
    normalizeCodexMessage({ method: 'thread/tokenUsage/updated', params: { threadId: 't', turnId: 'b', tokenUsage: { total: { inputTokens: 5, outputTokens: 'x' } } } }, fresh);
    const [partial] = usageOf(normalizeCodexMessage(done('b'), fresh));
    expect(partial.payload.tokens).toEqual({ input: 5, cachedInput: null, cacheWriteInput: null, output: null, reasoningOutput: null, total: null });
    const resumed = createCodexNormalizeContext({ model: 'm', resumed: true });
    normalizeCodexMessage({ method: 'thread/tokenUsage/updated', params: { threadId: 't', turnId: 'c', tokenUsage: { total: { totalTokens: 9, inputTokens: 5, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 4, reasoningOutputTokens: 0 } } } }, resumed);
    const [first] = usageOf(normalizeCodexMessage(done('c'), resumed));
    expect(first.payload.tokens).toBeNull();
  });
});

describe('per-turn usage attribution and cumulative baseline', () => {
  const totals = (n) => ({ totalTokens: n, inputTokens: n, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 });
  const update = (ctx, turnId, n) => normalizeCodexMessage({ method: 'thread/tokenUsage/updated', params: { threadId: 'thread', turnId, tokenUsage: { total: totals(n) } } }, ctx);
  const started = (ctx, turnId) => normalizeCodexMessage({ method: 'turn/started', params: { threadId: 'thread', turn: { id: turnId, status: 'inProgress' } } }, ctx);
  const reroute = (ctx, turnId, fromModel, toModel) => normalizeCodexMessage({ method: 'model/rerouted', params: { threadId: 'thread', turnId, fromModel, toModel, reason: 'highRiskCyberActivity' } }, ctx);
  const done = (ctx, turnId) => normalizeCodexMessage({ method: 'turn/completed', params: { threadId: 'thread', turn: { id: turnId, status: 'completed' } } }, ctx).find((e) => e.kind === 'usage').payload;

  it('a rerouted turn keeps its aggregate tokens but no single-model attribution', () => {
    const ctx = createCodexNormalizeContext({ model: 'A' });
    started(ctx, 'mixed');
    update(ctx, 'mixed', 5);
    reroute(ctx, 'mixed', 'A', 'B');
    update(ctx, 'mixed', 9);
    const usage = done(ctx, 'mixed');
    expect(usage).toMatchObject({ turnId: 'mixed', model: null, modelAttribution: 'mixed', modelsReported: ['A', 'B'], tokens: { total: 9 }, threadTotals: { total: 9 } });
  });

  it('a reroute naming another turn never relabels an earlier turn, and a same-model report keeps the model', () => {
    const ctx = createCodexNormalizeContext({ model: 'A' });
    update(ctx, 'prior', 4);
    reroute(ctx, 'later', 'A', 'B');
    expect(done(ctx, 'prior')).toMatchObject({ model: 'A', modelAttribution: 'single', tokens: { total: 4 } });
    const same = createCodexNormalizeContext({ model: 'A' });
    started(same, 'same');
    reroute(same, 'same', 'A', 'A');
    update(same, 'same', 3);
    expect(done(same, 'same')).toMatchObject({ model: 'A', modelAttribution: 'single', tokens: { total: 3 } });
  });

  it('malformed or unproven reroute evidence leaves the turn attribution unknown', () => {
    const ctx = createCodexNormalizeContext({ model: 'A' });
    started(ctx, 't1');
    update(ctx, 't1', 2);
    normalizeCodexMessage({ method: 'model/rerouted', params: { threadId: 'thread', turnId: 't1', fromModel: 'A', toModel: 42 } }, ctx);
    expect(done(ctx, 't1')).toMatchObject({ model: null, modelAttribution: 'unknown', tokens: { total: 2 } });
    const foreign = createCodexNormalizeContext({ model: 'A' });
    started(foreign, 't2');
    update(foreign, 't2', 2);
    markOpenTurnsUnproven(foreign);
    expect(done(foreign, 't2')).toMatchObject({ model: null, modelAttribution: 'unknown' });
  });

  it('a valid reroute with an absent, null, empty or non-string turn id leaves open turns unknown', () => {
    for (const turnId of [undefined, null, '', 42]) {
      const ctx = createCodexNormalizeContext({ model: 'A' });
      started(ctx, 'active');
      update(ctx, 'active', 5);
      const params = { threadId: 'thread', fromModel: 'A', toModel: 'B', reason: 'highRiskCyberActivity' };
      if (turnId !== undefined) params.turnId = turnId;
      const provenance = normalizeCodexMessage({ method: 'model/rerouted', params }, ctx);
      expect(provenance.map((e) => e.payload), String(turnId)).toEqual([{ state: 'model_rerouted', threadId: 'thread', turnId: null, fromModel: 'A', toModel: 'B', reason: 'highRiskCyberActivity' }]);
      expect(done(ctx, 'active'), String(turnId)).toMatchObject({ model: null, modelAttribution: 'unknown', tokens: { total: 5 }, threadTotals: { total: 5 } });
    }
    const same = createCodexNormalizeContext({ model: 'A' });
    started(same, 'active');
    normalizeCodexMessage({ method: 'model/rerouted', params: { threadId: 'thread', fromModel: 'A', toModel: 'A' } }, same);
    expect(done(same, 'active')).toMatchObject({ model: 'A', modelAttribution: 'single' });
  });

  it('an unscoped reroute keeps single attribution only for a proven A-to-A report (truth table)', () => {
    const froms = { same: 'A', different: 'B', missing: undefined, invalid: 42, empty: '' };
    const turnIds = { absent: undefined, null: null, empty: '', invalid: 42 };
    for (const [fromName, fromModel] of Object.entries(froms)) {
      for (const [turnName, turnId] of Object.entries(turnIds)) {
        const ctx = createCodexNormalizeContext({ model: 'A' });
        started(ctx, 'active');
        update(ctx, 'active', 5);
        const params = { threadId: 'thread', toModel: 'A' };
        if (fromModel !== undefined) params.fromModel = fromModel;
        if (turnId !== undefined) params.turnId = turnId;
        normalizeCodexMessage({ method: 'model/rerouted', params }, ctx);
        const usage = done(ctx, 'active');
        const label = `from ${fromName}, turn ${turnName}`;
        expect(usage, label).toMatchObject(fromName === 'same' ? { model: 'A', modelAttribution: 'single' } : { model: null, modelAttribution: 'unknown' });
        expect(usage, label).toMatchObject({ tokens: { total: 5 }, threadTotals: { total: 5 } });
      }
    }
  });

  it('a scoped reroute keeps single attribution only for a proven A-to-A report (truth table)', () => {
    const cases = [
      [{ fromModel: 'A', toModel: 'A' }, { model: 'A', modelAttribution: 'single' }],
      [{ fromModel: 'B', toModel: 'A' }, { model: null, modelAttribution: 'mixed', modelsReported: ['B', 'A'] }],
      [{ fromModel: 'A', toModel: 'B' }, { model: null, modelAttribution: 'mixed', modelsReported: ['A', 'B'] }],
      [{ toModel: 'A' }, { model: null, modelAttribution: 'unknown' }],
      [{ fromModel: 42, toModel: 'A' }, { model: null, modelAttribution: 'unknown' }],
      [{ fromModel: '', toModel: 'A' }, { model: null, modelAttribution: 'unknown' }],
      [{ fromModel: 'B', toModel: 'B' }, { model: null, modelAttribution: 'unknown' }],
    ];
    for (const [report, expected] of cases) {
      const ctx = createCodexNormalizeContext({ model: 'A' });
      started(ctx, 'active');
      update(ctx, 'active', 5);
      normalizeCodexMessage({ method: 'model/rerouted', params: { threadId: 'thread', turnId: 'active', ...report } }, ctx);
      const usage = done(ctx, 'active');
      expect(usage, JSON.stringify(report)).toMatchObject({ ...expected, tokens: { total: 5 } });
      if (expected.modelAttribution !== 'mixed') expect(usage.modelsReported, JSON.stringify(report)).toBeUndefined();
    }
    const prior = createCodexNormalizeContext({ model: 'A' });
    started(prior, 'prior');
    update(prior, 'prior', 4);
    reroute(prior, 'later', 'B', 'A');
    expect(done(prior, 'prior')).toMatchObject({ model: 'A', modelAttribution: 'single' });
  });

  it('a turn without a usable update invalidates the baseline until a complete observation re-establishes it', () => {
    const ctx = createCodexNormalizeContext({ model: 'A' });
    update(ctx, 'one', 5);
    expect(done(ctx, 'one')).toMatchObject({ tokens: { total: 5 }, threadTotals: { total: 5 } });
    expect(done(ctx, 'missing')).toMatchObject({ tokens: null, threadTotals: null });
    update(ctx, 'after', 12);
    expect(done(ctx, 'after')).toMatchObject({ tokens: null, threadTotals: { total: 12 } });
    update(ctx, 'recovered', 15);
    expect(done(ctx, 'recovered')).toMatchObject({ tokens: { total: 3 }, threadTotals: { total: 15 } });
    const resumed = createCodexNormalizeContext({ model: 'A', resumed: true });
    update(resumed, 'r1', 7);
    expect(done(resumed, 'r1')).toMatchObject({ tokens: null, threadTotals: { total: 7 } });
    update(resumed, 'r2', 10);
    expect(done(resumed, 'r2')).toMatchObject({ tokens: { total: 3 } });
  });
});

describe('codexServerRequest', () => {
  const approval = transcripts.commandApproval.messages.find((m) => m.method === 'item/commandExecution/requestApproval');

  it('command choices are exactly availableDecisions in order, with their behaviors', () => {
    const offered = codexServerRequest(approval, createCodexNormalizeContext({ model: 'm' }));
    expect(offered.reconcile).toBe(false);
    expect(offered.publicRequest.choices.map((c) => [c.label, c.behavior])).toEqual([
      ['Allow once', 'allow'],
      ["Allow and don't ask again for similar commands", 'allow'],
      ['Deny and stop this turn', 'deny'],
    ]);
    expect(offered.publicRequest.choices.map((c) => offered.responses.get(c.id))).toEqual(approval.params.availableDecisions.map((decision) => ({ decision })));
    expect(offered.publicRequest).toMatchObject({ nativeRequestId: `rpc:${approval.id}`, kind: 'permission', secret: false, hostOnly: false, questions: null });
    expect(offered.publicRequest.fingerprint).toMatch(/^[0-9a-f]{64}$/);

    const full = codexServerRequest({ ...approval, params: { ...approval.params, availableDecisions: ['decline', 'acceptForSession', { applyNetworkPolicyAmendment: { network_policy_amendment: { host: 'example.com', action: 'deny' } } }, { applyNetworkPolicyAmendment: { network_policy_amendment: { host: 'example.org', action: 'allow' } } }] } }, createCodexNormalizeContext({ model: 'm' }));
    expect(full.publicRequest.choices.map((c) => [c.label, c.behavior, c.scope])).toEqual([
      ['Deny and continue', 'deny', 'once'],
      ['Allow for this session', 'allow', 'session'],
      ['Block this network host', 'deny', null],
      ['Allow this network host', 'allow', null],
    ]);

    const { availableDecisions, ...withoutList } = approval.params;
    const missing = codexServerRequest({ ...approval, params: withoutList }, createCodexNormalizeContext({ model: 'm' }));
    expect(missing.publicRequest.choices).toEqual([]);
    expect(missing.reconcile).toBe(true);
    const unknown = codexServerRequest({ ...approval, params: { ...approval.params, availableDecisions: ['accept', { somethingNew: {} }] } }, createCodexNormalizeContext({ model: 'm' }));
    expect(unknown.publicRequest.choices).toEqual([]);
    expect(unknown.reconcile).toBe(true);
  });

  it('MCP remember choices follow exactly what the native advertises, with their native encoding and actual scope', () => {
    const elicitation = transcripts.plain.messages.find((m) => m.method === 'mcpServer/elicitation/request');
    const withPersist = (persist, ctx = createCodexNormalizeContext({ model: 'm' })) => codexServerRequest({ ...elicitation, params: { ...elicitation.params, _meta: { ...elicitation.params._meta, persist } } }, ctx);
    const ids = (offered) => offered.publicRequest.choices.map((c) => c.id);
    expect(ids(withPersist('session'))).toEqual(['accept', 'acceptForSession', 'decline', 'cancel']);
    expect(ids(withPersist('always'))).toEqual(['accept', 'acceptAlways', 'decline', 'cancel']);
    expect(ids(withPersist(['session', 'always']))).toEqual(['accept', 'acceptForSession', 'acceptAlways', 'decline', 'cancel']);
    expect(ids(withPersist(['other']))).toEqual(['accept', 'decline', 'cancel']);
    const both = withPersist(['session', 'always']);
    expect(both.responses.get('acceptForSession')).toEqual({ action: 'accept', content: {}, _meta: { persist: 'session' } });
    expect(both.responses.get('acceptAlways')).toEqual({ action: 'accept', content: {}, _meta: { persist: 'always' } });
    expect(both.publicRequest.choices.find((c) => c.id === 'acceptAlways')).toEqual({ id: 'acceptAlways', label: "Allow and don't ask again in this session", scope: 'session', behavior: 'allow' });
    const persistable = createCodexNormalizeContext({ model: 'm' });
    persistable.persistableMcpServers.add('ff_reporting');
    expect(withPersist(['session', 'always'], persistable).publicRequest.choices.find((c) => c.id === 'acceptAlways')).toEqual({ id: 'acceptAlways', label: "Allow and don't ask again for this tool", scope: null, behavior: 'allow' });
  });

  it('file-change, permission and MCP approvals offer only their pinned choices', () => {
    const ctx = createCodexNormalizeContext({ model: 'm' });
    const file = codexServerRequest({ id: 3, method: 'item/fileChange/requestApproval', params: { threadId: 't', turnId: 'u', itemId: 'i', startedAtMs: 1 } }, ctx);
    expect(file.publicRequest.choices.map((c) => [c.id, c.label, c.behavior])).toEqual([
      ['accept', 'Allow once', 'allow'],
      ['acceptForSession', 'Allow for this session', 'allow'],
      ['decline', 'Deny and continue', 'deny'],
      ['cancel', 'Deny and stop this turn', 'deny'],
    ]);
    expect(file.responses.get('decline')).toEqual({ decision: 'decline' });
    expect(file.responses.get('cancel')).toEqual({ decision: 'cancel' });

    const permissions = { network: null, fileSystem: { read: null, write: ['/w/out'] } };
    const perm = codexServerRequest({ id: 4, method: 'item/permissions/requestApproval', params: { threadId: 't', turnId: 'u', itemId: 'i', environmentId: null, startedAtMs: 1, cwd: '/w', reason: null, permissions } }, ctx);
    expect(perm.publicRequest.choices.map((c) => c.label)).toEqual(['Allow once', 'Allow for this session', 'Deny and continue']);
    expect(perm.responses.get('accept')).toEqual({ permissions: { fileSystem: permissions.fileSystem }, scope: 'turn' });
    expect(perm.responses.get('acceptForSession')).toEqual({ permissions: { fileSystem: permissions.fileSystem }, scope: 'session' });
    expect(perm.responses.get('decline')).toEqual({ permissions: {}, scope: 'turn' });

    const elicitation = transcripts.plain.messages.find((m) => m.method === 'mcpServer/elicitation/request');
    const mcp = codexServerRequest(elicitation, ctx);
    expect(mcp.publicRequest.choices.map((c) => [c.id, c.label, c.behavior])).toEqual([
      ['accept', 'Allow once', 'allow'],
      ['acceptForSession', 'Allow for this session', 'allow'],
      ['acceptAlways', "Allow and don't ask again in this session", 'allow'],
      ['decline', 'Deny and continue', 'deny'],
      ['cancel', 'Deny', 'deny'],
    ]);
    const { persist, ...noPersist } = elicitation.params._meta;
    const plainMcp = codexServerRequest({ ...elicitation, params: { ...elicitation.params, _meta: noPersist } }, ctx);
    expect(plainMcp.publicRequest.choices.map((c) => c.id)).toEqual(['accept', 'decline', 'cancel']);

    for (const method of ['item/tool/requestUserInput', 'item/tool/call', 'execCommandApproval', 'account/chatgptAuthTokens/refresh']) {
      expect(codexServerRequest({ id: 9, method, params: {} }, ctx), method).toEqual({ unsupported: true });
    }
    expect(codexServerRequest({ id: 9, method: 'mcpServer/elicitation/request', params: { ...elicitation.params, _meta: {} } }, ctx)).toEqual({ unsupported: true });
  });
});
