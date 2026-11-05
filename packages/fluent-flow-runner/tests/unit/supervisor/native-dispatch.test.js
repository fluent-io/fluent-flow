import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createLedger } from '../../../src/supervisor/ledger.js';
import { createSupervisorHandlers } from '../../../src/supervisor/supervisor.js';
import { createSpoolPrivacy } from '../../../src/supervisor/spool-privacy.js';
import { profileRevision } from '../../../src/connector/catalog.js';
import { cleanupRoots, RUN, S1, S2, claude, REV, SESSION_CAPS, flush, memoryContainment, fakeBackend, setup, launch, ledgerLines } from './helpers/dispatch-fakes.js';

afterEach(cleanupRoots);

describe('supervisor native dispatch (Task 7)', () => {
  it('a native launch records worktree, worker and session effects in order and binds before acceptance', async () => {
    const t = setup();
    const result = await t.handlers.submit(launch());
    expect(result).toEqual({ state: 'accepted', binding: { workspaceRef: expect.stringMatching(/^ffw_[0-9a-f]{16}$/), nativeSessionId: `native-${S1}`, generation: 1 } });
    const types = ledgerLines(t.dir).map((r) => (r.type === 'barrier' ? `barrier:${r.effect}` : r.type));
    expect(types).toEqual(['accept', 'slot_reserve', 'barrier:create_worktree', 'receipt', 'barrier:create_native_session', 'worker_intent', 'worker', 'bind', 'outcome']);
    expect(ledgerLines(t.dir).at(-1)).toMatchObject({ type: 'outcome', commandId: 'launch-1', state: 'accepted' });
    const opened = t.backend.opened[0];
    expect(opened).toMatchObject({ sessionId: S1, runId: RUN, generation: 1, resume: null, reporting: { url: 'http://127.0.0.1:9/mcp/collab', credential: 'reporting-credential' } });
    expect(opened.profile).toBe(claude);
    expect(opened.workspaceDir).toBe(join(t.stateDir, 'worktrees', result.binding.workspaceRef));
    expect(execFileSync('git', ['-C', opened.workspaceDir, 'symbolic-ref', 'HEAD'], { encoding: 'utf8' }).trim()).toBe(`refs/heads/ff/run-${RUN}`);
    expect(readFileSync(join(t.dir, 'ledger.jsonl'), 'utf8')).not.toContain('reporting-credential');
    expect(await t.handlers.submit(launch())).toEqual(result);
    expect(t.backend.opened).toHaveLength(1);
    expect((await t.handlers.workspace({ runId: RUN })).workspaceDir).toBe(opened.workspaceDir);
  });

  it('defers an undispatched launch while the control plane is offline and admits its replay after reconnect', async () => {
    const t = setup({ controlPlaneOnline: false });
    expect(t.handlers.connectorAttached({}, { connectorEpoch: 0 })).toEqual({ attached: true });
    expect(t.handlers.controlPlaneStatus({ online: false }, { connectorEpoch: 0 })).toEqual({ recorded: true });
    expect(await t.handlers.submit(launch())).toEqual({ state: 'deferred' });
    expect(t.ledger.classify('launch-1')).toBe('undispatched');
    expect(t.backend.opened).toEqual([]);
    expect(t.handlers.connectorDetached({}, { connectorEpoch: 0 })).toEqual({ detached: true });
    expect(t.handlers.connectorAttached({}, { connectorEpoch: 1 })).toEqual({ attached: true });
    expect(t.handlers.controlPlaneStatus({ online: true }, { connectorEpoch: 1 })).toEqual({ recorded: true });
    expect((await t.handlers.submit(launch())).state).toBe('accepted');
    expect(t.backend.opened).toHaveLength(1);
  });

  it('defers an undispatched prompt while the control plane is offline and applies its replay after reconnect', async () => {
    const t = setup();
    expect((await t.handlers.submit(launch())).state).toBe('accepted');
    expect(t.handlers.controlPlaneStatus({ online: false }, { connectorEpoch: 0 })).toEqual({ recorded: true });
    const prompt = { commandId: 'prompt-2', digest: 'd2', runId: RUN, sessionId: S1, backend: 'claude-code', kind: 'prompt', profileId: 'cc-main', profileRevision: REV, text: 'more', behavior: 'steer' };
    expect(await t.handlers.submit(prompt)).toEqual({ state: 'deferred' });
    expect(t.ledger.classify('prompt-2')).toBe('undispatched');
    expect(t.backend.workers[0].sends).toEqual([]);
    expect(t.handlers.connectorDetached({}, { connectorEpoch: 0 })).toEqual({ detached: true });
    expect(t.handlers.connectorAttached({}, { connectorEpoch: 1 })).toEqual({ attached: true });
    expect(t.handlers.controlPlaneStatus({ online: true }, { connectorEpoch: 1 })).toEqual({ recorded: true });
    expect(await t.handlers.submit(prompt)).toEqual({ state: 'applied' });
    expect(t.backend.workers[0].sends).toEqual([{ commandId: 'prompt-2', text: 'more', mode: 'steer' }]);
  });

  it('revision drift, unready readiness and unavailable containment refuse before any effect', async () => {
    const drift = setup();
    expect(await drift.handlers.submit(launch({ profileRevision: 'ffffffffffffffff' }))).toEqual({ state: 'failed', errorCode: 'execution_settings_changed' });
    const unready = setup();
    unready.backend.readinessState = 'sign_in_required';
    expect(await unready.handlers.submit(launch())).toEqual({ state: 'failed', errorCode: 'sign_in_required' });
    const incompatible = setup();
    incompatible.backend.readinessState = 'incompatible';
    expect(await incompatible.handlers.submit(launch())).toEqual({ state: 'failed', errorCode: 'profile_unavailable' });
    const noContainment = setup({ mem: { containment: { state: 'unavailable', reason: 'no_delegation' } } });
    expect(await noContainment.handlers.submit(launch())).toEqual({ state: 'failed', errorCode: 'profile_unavailable' });
    for (const t of [drift, unready, incompatible, noContainment]) {
      expect(ledgerLines(t.dir).map((r) => r.type)).toEqual(['accept', 'outcome']);
      expect(t.backend.opened).toEqual([]);
      expect(existsSync(join(t.stateDir, 'worktrees'))).toBe(false);
    }
    expect(noContainment.logs.some((l) => l.reason === 'containment_unavailable')).toBe(true);
  });

  it('deliver writes one prompt barrier through the per-call barrier and replays without a second send', async () => {
    const t = setup();
    await t.handlers.submit(launch());
    expect(await t.handlers.deliver({ commandId: 'launch-1', digest: 'd-launch-1', text: 'Do the task.' })).toEqual({ state: 'applied' });
    expect(t.backend.workers[0].sends).toEqual([{ commandId: 'launch-1', text: 'Do the task.', mode: 'start' }]);
    expect(t.ledger.classify('launch-1')).toEqual({ create_worktree: 'receipted', create_native_session: 'receipted', prompt: 'receipted' });
    expect(await t.handlers.deliver({ commandId: 'launch-1', digest: 'd-launch-1', text: 'Do the task.' })).toEqual({ state: 'applied' });
    expect(t.backend.workers[0].sends).toHaveLength(1);
    expect(readFileSync(join(t.dir, 'ledger.jsonl'), 'utf8')).not.toContain('Do the task.');
    expect(await t.handlers.submit({ commandId: 'prompt-2', digest: 'd2', runId: RUN, sessionId: S1, backend: 'claude-code', kind: 'prompt', profileId: 'cc-main', profileRevision: REV, text: 'more', behavior: 'steer' })).toEqual({ state: 'applied' });
    expect(t.backend.workers[0].sends.at(-1)).toEqual({ commandId: 'prompt-2', text: 'more', mode: 'steer' });
    await expect(t.handlers.deliver({ commandId: 'launch-1', digest: 'other', text: 'x' })).rejects.toMatchObject({ code: 'digest_mismatch' });
  });

  it('a suppressed prompt is durably recorded as FF no-write evidence, never as a receipt', async () => {
    const t = setup({ backend: fakeBackend('claude-code', { send: 'suppressed' }) });
    await t.handlers.submit(launch());
    expect(await t.handlers.deliver({ commandId: 'launch-1', digest: 'd-launch-1', text: 'go' })).toEqual({ state: 'failed', errorCode: 'request_unavailable' });
    expect(t.ledger.classify('launch-1').prompt).toBe('uncertain');
    const noWrite = ledgerLines(t.dir).find((r) => r.type === 'no_write');
    expect(noWrite).toMatchObject({ commandId: 'launch-1', effect: 'prompt', sessionId: S1, backend: 'claude-code', generation: 1, evidence: 'ff_suppressed' });
    expect(createLedger({ dir: t.dir }).noWrite('launch-1', 'prompt')).toMatchObject({ evidence: 'ff_suppressed' });
    const lost = setup({ backend: fakeBackend('claude-code', { send: 'reconciling_after_write' }) });
    await lost.handlers.submit(launch());
    expect(await lost.handlers.deliver({ commandId: 'launch-1', digest: 'd-launch-1', text: 'go' })).toEqual({ state: 'reconciling', errorCode: 'reconciling' });
    expect(ledgerLines(lost.dir).some((r) => r.type === 'no_write')).toBe(false);
  });

  it('a same-code send failure after its barrier is reconciling without FF no-write evidence; only a pre-barrier refusal is definite', async () => {
    for (const [reason, beforeBarrier, expected] of [
      ['no_active_turn', false, { state: 'reconciling', errorCode: 'reconciling' }],
      ['steer_not_submitted', false, { state: 'reconciling', errorCode: 'reconciling' }],
      ['no_active_turn', true, { state: 'failed', errorCode: 'request_unavailable' }],
    ]) {
      const label = `${reason}${beforeBarrier ? ' before barrier' : ''}`;
      const t = setup({ backend: fakeBackend('claude-code', { sendError: { code: 'request_unavailable', reason, beforeBarrier } }) });
      await t.handlers.submit(launch());
      expect(await t.handlers.submit({ commandId: 'prompt-x', digest: 'dx', runId: RUN, sessionId: S1, backend: 'claude-code', kind: 'prompt', profileId: 'cc-main', profileRevision: REV, text: 'more', behavior: 'steer' }), label).toEqual(expected);
      expect(t.ledger.noWrite('prompt-x', 'prompt'), label).toBeNull();
      expect(t.ledger.classify('prompt-x'), label).toEqual(beforeBarrier ? 'undispatched' : { prompt: 'uncertain' });
      expect(await t.handlers.submit({ commandId: 'prompt-x', digest: 'dx', runId: RUN, sessionId: S1, backend: 'claude-code', kind: 'prompt', profileId: 'cc-main', profileRevision: REV, text: 'more', behavior: 'steer' }), label).toEqual(expected);
    }
  });

  it('controls reach the recorded worker: permission through a respond barrier, cancel through an interrupt barrier', async () => {
    const settled = [{ commandId: 'prompt-x', outcome: 'cancelled', dispatched: false }];
    const t = setup({ backend: fakeBackend('claude-code', { settled }) });
    await t.handlers.submit(launch());
    await t.handlers.deliver({ commandId: 'launch-1', digest: 'd-launch-1', text: 'go' });
    t.ledger.submit({ commandId: 'prompt-x', digest: 'dx', runId: RUN, sessionId: S1, backend: 'claude-code', kind: 'prompt' });
    t.ledger.barrier('prompt-x', { effect: 'prompt', generation: 1, ref: {} });
    t.profiles.splice(0);
    expect(await t.handlers.submit({ commandId: 'perm-1', digest: 'dp', runId: RUN, sessionId: S1, backend: 'claude-code', kind: 'permission', nativeRequestId: 'req-1', response: { behavior: 'allow', selectedActionId: 'allow' } })).toEqual({ state: 'applied' });
    expect(t.backend.workers[0].responds).toEqual([{ commandId: 'perm-1', nativeRequestId: 'req-1', response: { behavior: 'allow', selectedActionId: 'allow' }, source: 'web' }]);
    expect(t.ledger.classify('perm-1')).toEqual({ respond: 'receipted' });
    expect(await t.handlers.submit({ commandId: 'cancel-1', digest: 'dc', runId: RUN, sessionId: S1, backend: 'claude-code', kind: 'cancel' })).toEqual({ state: 'applied' });
    expect(t.backend.workers[0].interrupts).toEqual(['cancel-1']);
    expect(t.ledger.classify('cancel-1')).toEqual({ interrupt: 'receipted' });
    expect(t.ledger.noWrite('prompt-x', 'prompt')).toMatchObject({ evidence: 'ff_suppressed', sessionId: S1, generation: 1, backend: 'claude-code' });
    await expect(t.handlers.submit({ commandId: 'cancel-2', digest: 'dc2', runId: RUN, sessionId: S1, backend: 'codex', kind: 'cancel' })).resolves.toEqual({ state: 'failed', errorCode: 'execution_settings_changed' });
    expect(t.backend.workers[0].interrupts).toEqual(['cancel-1']);
  });

  it('cancellation is confirmed from the interrupt call\'s own evidence, independent of when the pump spools the old terminal', async () => {
    const t = setup();
    await t.handlers.submit(launch());
    await t.handlers.deliver({ commandId: 'launch-1', digest: 'd-launch-1', text: 'go' });
    const w = t.backend.workers[0];
    expect(await t.handlers.submit({ commandId: 'cancel-1', digest: 'dc', runId: RUN, sessionId: S1, backend: 'claude-code', kind: 'cancel' })).toEqual({ state: 'applied' });
    expect(await t.handlers.submit({ commandId: 'prompt-2', digest: 'dp2', runId: RUN, sessionId: S1, backend: 'claude-code', kind: 'prompt', profileId: 'cc-main', profileRevision: REV, text: 'again' })).toEqual({ state: 'applied' });
    w.emit({ kind: 'state', nativeEventId: 'r-1', terminal: 'interrupted', payload: { phase: 'result', commandIds: ['launch-1'] } });
    expect(await t.handlers.submit({ commandId: 'prompt-3', digest: 'dp3', runId: RUN, sessionId: S1, backend: 'claude-code', kind: 'prompt', profileId: 'cc-main', profileRevision: REV, text: 'redo', behavior: 'interrupt' })).toEqual({ state: 'applied' });
    w.emit({ kind: 'state', nativeEventId: 'r-2', terminal: 'interrupted', payload: { phase: 'result', commandIds: ['prompt-2'] } });
    await flush();
    const { events } = await t.handlers.events({ afterSeq: 0 });
    const cancels = events.filter((e) => e.nativeEventId.startsWith('ff:cancel:'));
    expect(cancels.map((e) => [e.nativeEventId, e.payload.event])).toEqual([[
      'ff:cancel:cancel-1',
      { state: 'cancelled', cancelCommandId: 'cancel-1', generation: 1, nativeTerminal: 'interrupted', dispatched: true, settled: [] },
    ]]);
    expect(events.filter((e) => e.payload.terminal === 'interrupted').map((e) => [e.nativeEventId, e.payload.cancelledBy ?? null])).toEqual([['r-1', null], ['r-2', null]]);
  });

  it('a cancel whose turn ended first is not confirmed as cancelled; a proven-idle cancel is', async () => {
    const completed = setup({ backend: fakeBackend('claude-code', { interruptTerminal: 'completed' }) });
    await completed.handlers.submit(launch());
    expect(await completed.handlers.submit({ commandId: 'cancel-c', digest: 'dc', runId: RUN, sessionId: S1, backend: 'claude-code', kind: 'cancel' })).toEqual({ state: 'applied' });
    expect((await completed.handlers.events({ afterSeq: 0 })).events.some((e) => e.nativeEventId.startsWith('ff:cancel:'))).toBe(false);
    const idle = setup({ backend: fakeBackend('claude-code', { interruptTerminal: null }) });
    await idle.handlers.submit(launch());
    await idle.handlers.submit({ commandId: 'cancel-9', digest: 'dc9', runId: RUN, sessionId: S1, backend: 'claude-code', kind: 'cancel' });
    expect((await idle.handlers.events({ afterSeq: 0 })).events.map((e) => [e.nativeEventId, e.payload.event.state, e.payload.event.nativeTerminal])).toEqual([['ff:cancel:cancel-9', 'cancelled', null]]);
  });

  it('a withdrawn answer after its barrier is positive no-write evidence; the barrier stays uncertain', async () => {
    const t = setup({ backend: fakeBackend('claude-code', { respond: 'withdrawn' }) });
    await t.handlers.submit(launch());
    expect(await t.handlers.submit({ commandId: 'answer-1', digest: 'da', runId: RUN, sessionId: S1, backend: 'claude-code', kind: 'permission', nativeRequestId: 'q-1', response: { selections: { q0: ['A'] } } })).toEqual({ state: 'failed', errorCode: 'request_unavailable' });
    expect(t.ledger.classify('answer-1')).toEqual({ respond: 'uncertain' });
    expect(t.ledger.noWrite('answer-1', 'respond')).toMatchObject({ evidence: 'ff_suppressed', sessionId: S1, generation: 1 });
    expect(readFileSync(join(t.dir, 'ledger.jsonl'), 'utf8')).not.toContain('"A"');
  });

  it('the bound owned stop targets only its exact worker, runs once and reports uncertainty when unproven', async () => {
    const t = setup();
    await t.handlers.submit(launch());
    const stop = t.backend.workers[0].stopOwned;
    const [a, b] = await Promise.all([stop({ reason: 'model_rerouted' }), stop({ reason: 'unexpected_mcp_server' })]);
    expect([a, b]).toEqual(['quiesced', 'quiesced']);
    expect(t.mem.kills).toEqual([`/mem/ff-0123456789abcdef/w-1-${S1}`]);
    const stuck = setup({ mem: memoryContainment({ stuck: true }) });
    await stuck.handlers.submit(launch());
    expect(await stuck.backend.workers[0].stopOwned({ reason: 'model_rerouted' })).toBe('uncertain');
  }, 20_000);

  it('a profile violation and its quiesced owned stop are spooled; the native terminal is kept', async () => {
    const t = setup();
    await t.handlers.submit(launch());
    const w = t.backend.workers[0];
    w.emit({ kind: 'state', nativeEventId: 'session:profile_violation:1', payload: { state: 'profile_violation', errorCode: 'profile_unavailable', selectedModel: 'm-a', actualModel: 'm-a', fromModel: 'm-b' } });
    await w.stopOwned({ reason: 'model_rerouted' });
    w.emit({ kind: 'state', nativeEventId: 'turn:t1:completed', terminal: 'failed', payload: { state: 'failed', nativeState: 'completed', errorCode: 'profile_unavailable' } });
    await flush();
    const { events } = await t.handlers.events({ afterSeq: 0 });
    expect(events.map((e) => [e.nativeEventId, e.payload.event.state])).toEqual([
      ['session:profile_violation:1', 'profile_violation'],
      ['ff:owned_stop:1', 'failed'],
      ['turn:t1:completed', 'failed'],
    ]);
    expect(events[1].payload).toMatchObject({ backend: 'claude-code', event: { errorCode: 'profile_unavailable', reason: 'model_rerouted', stop: 'quiesced' } });
    expect(events[2].payload).toMatchObject({ terminal: 'failed', event: { nativeState: 'completed' } });
  });

  it('a native terminal before or after an unproven owned stop carries that stop state; only proven quiescence clears it', async () => {
    const violation = { kind: 'state', nativeEventId: 'session:profile_violation:1', payload: { state: 'profile_violation', errorCode: 'profile_unavailable', selectedModel: 'm-a', actualModel: 'm-a', fromModel: 'm-b' } };
    const terminal = (id) => ({ kind: 'state', nativeEventId: id, terminal: 'failed', payload: { state: 'failed', nativeState: 'completed', errorCode: 'profile_unavailable' } });
    const spooledTerminals = async (t) => (await t.handlers.events({ afterSeq: 0 })).events.filter((e) => e.payload.terminal).map((e) => [e.nativeEventId, e.payload.ownedStop ?? null]);
    const stops = async (t) => (await t.handlers.events({ afterSeq: 0 })).events.filter((e) => e.nativeEventId.startsWith('ff:owned_stop')).length;

    const after = setup({ mem: memoryContainment({ stuck: true }) });
    await after.handlers.submit(launch());
    const w1 = after.backend.workers[0];
    w1.emit(violation);
    expect(await w1.stopOwned({ reason: 'model_rerouted' })).toBe('uncertain');
    w1.emit(terminal('t-after'));
    await flush();
    expect(await spooledTerminals(after)).toEqual([['t-after', 'uncertain']]);

    const during = setup({ mem: memoryContainment({ stuck: true }) });
    await during.handlers.submit(launch());
    const w2 = during.backend.workers[0];
    w2.emit(violation);
    const stopping = w2.stopOwned({ reason: 'model_rerouted' });
    w2.emit(terminal('t-during'));
    await flush();
    expect(await stopping).toBe('uncertain');
    expect(await spooledTerminals(during)).toEqual([['t-during', 'pending']]);
    expect(await stops(during)).toBe(0);

    const thrown = memoryContainment();
    thrown.containment.ops.kill = async () => { throw new Error('scope gone'); };
    const threw = setup({ mem: thrown });
    await threw.handlers.submit(launch());
    const w3 = threw.backend.workers[0];
    w3.emit(violation);
    expect(await w3.stopOwned({ reason: 'model_rerouted' })).toBe('uncertain');
    w3.emit(terminal('t-thrown'));
    await flush();
    expect(await spooledTerminals(threw)).toEqual([['t-thrown', 'uncertain']]);

    const proven = setup();
    await proven.handlers.submit(launch());
    const w4 = proven.backend.workers[0];
    w4.emit(violation);
    const quiescing = w4.stopOwned({ reason: 'model_rerouted' });
    w4.emit(terminal('t-before-proof'));
    await flush();
    expect(await quiescing).toBe('quiesced');
    w4.emit(terminal('t-after-proof'));
    await flush();
    expect(await spooledTerminals(proven)).toEqual([['t-before-proof', 'pending'], ['t-after-proof', null]]);
    expect(await stops(proven)).toBe(1);
  }, 20_000);

  it('explicit question answers and registered local values are removed before the first spool write', async () => {
    const privacy = createSpoolPrivacy();
    const t = setup({ privacy });
    await t.handlers.submit(launch());
    privacy.registerLocalValue(S1, 'local-secret-answer-value');
    const w = t.backend.workers[0];
    w.emit({ kind: 'timeline', nativeEventId: 'item:call_1:completed', payload: { phase: 'completed', item: { type: 'mcpToolCall', id: 'call_1', server: 'ff_questions', tool: 'ask', arguments: { questions: [{ id: 'q0', question: 'Pick?' }] }, result: { content: [{ type: 'text', text: '{"answers":{"q0":"web-answer-value"}}' }] }, error: null } } });
    w.emit({ kind: 'timeline', nativeEventId: 'msg:1', payload: { type: 'assistant_text', text: 'You told me local-secret-answer-value earlier.' } });
    await flush();
    const raw = readFileSync(join(t.dir, 'ledger.jsonl'), 'utf8');
    expect(raw).not.toContain('web-answer-value');
    expect(raw).not.toContain('local-secret-answer-value');
    const { events } = await t.handlers.events({ afterSeq: 0 });
    expect(events[0].payload.event.item).toMatchObject({ server: 'ff_questions', result: null, resultWithheld: 'ff_question_answer', arguments: { questions: [{ id: 'q0', question: 'Pick?' }] } });
    expect(events[1].payload.event.text).toBe('You told me [local answer] earlier.');
  });

  it('unresolved earlier-lifetime work blocks new admission; a fresh instance admits', async () => {
    const first = setup();
    await first.handlers.submit(launch());
    const ledger = createLedger({ dir: first.dir });
    const backend = fakeBackend('claude-code');
    const handlers = createSupervisorHandlers({ ledger, profiles: [claude], backends: { 'claude-code': backend }, containment: first.mem.containment, log: () => {}, stateDir: first.stateDir, repositories: { repo: first.repo }, privacy: createSpoolPrivacy(), limits: SESSION_CAPS });
    const other = launch({ commandId: 'launch-2', digest: 'd-launch-2', runId: '44444444-4444-4444-8444-444444444444', sessionId: S2 });
    expect(await handlers.submit(other)).toEqual({ state: 'failed', errorCode: 'startup_failed' });
    expect(backend.opened).toEqual([]);
    expect(ledger.classify('launch-2')).toBe('undispatched');
    expect(await handlers.deliver({ commandId: 'launch-1', digest: 'd-launch-1', text: 'go' })).toEqual({ state: 'reconciling', errorCode: 'reconciling' });
    expect(backend.opened).toEqual([]);
  });

  it('a worktree conflict fails startup_failed with nothing modified', async () => {
    const t = setup();
    const target = join(t.stateDir, 'worktrees');
    mkdirSync(target, { mode: 0o700 });
    const { runWorkspaceRef } = await import('../../../src/connector/worktrees.js');
    mkdirSync(join(target, runWorkspaceRef(RUN)));
    writeFileSync(join(target, runWorkspaceRef(RUN), 'mine.txt'), 'user data');
    expect(await t.handlers.submit(launch())).toEqual({ state: 'failed', errorCode: 'startup_failed' });
    expect(readdirSync(join(target, runWorkspaceRef(RUN)))).toEqual(['mine.txt']);
    expect(t.backend.opened).toEqual([]);
    expect(t.logs.some((l) => l.reason === 'worktree_conflict')).toBe(true);
  });

  it('a recorded worktree barrier with the worktree gone is reconciling, never a second add or a definite failure', async () => {
    const t = setup();
    const { runWorkspaceRef } = await import('../../../src/connector/worktrees.js');
    t.ledger.submit({ commandId: 'launch-0', digest: 'd0', runId: RUN, sessionId: S1, backend: 'claude-code', kind: 'launch' });
    t.ledger.barrier('launch-0', { effect: 'create_worktree', generation: 0, ref: { workspaceRef: runWorkspaceRef(RUN), branchName: `ff/run-${RUN}` } });
    t.ledger.outcome('launch-0', { state: 'reconciling', errorCode: 'reconciling' });
    expect(await t.handlers.submit(launch({ commandId: 'launch-1' }))).toEqual({ state: 'reconciling', errorCode: 'reconciling' });
    expect(t.ledger.classify('launch-0')).toEqual({ create_worktree: 'uncertain' });
    expect(t.ledger.classify('launch-1')).toBe('undispatched');
    expect(t.backend.opened).toEqual([]);
    expect(existsSync(join(t.stateDir, 'worktrees', runWorkspaceRef(RUN)))).toBe(false);
    expect(execFileSync('git', ['-C', t.repo, 'branch', '--list', `ff/run-${RUN}`], { encoding: 'utf8' }).trim()).toBe('');
    expect(t.logs.some((l) => l.detail === 'recorded_worktree_missing')).toBe(true);
  });

  it('an uncertain native create stays reconciling and its replay never reopens', async () => {
    const t = setup({ backend: fakeBackend('claude-code', { open: 'lost_create' }) });
    expect(await t.handlers.submit(launch())).toEqual({ state: 'reconciling', errorCode: 'reconciling' });
    expect(t.ledger.classify('launch-1')).toEqual({ create_worktree: 'receipted', create_native_session: 'uncertain' });
    expect(await t.handlers.submit(launch())).toEqual({ state: 'reconciling', errorCode: 'reconciling' });
    expect(t.backend.opened).toHaveLength(1);
  });

  it('an additional session opens in the run worktree on the same backend', async () => {
    const t = setup();
    const first = await t.handlers.submit(launch());
    const create = await t.handlers.submit({ commandId: 'create-2', digest: 'dc2', runId: RUN, sessionId: S2, backend: 'claude-code', kind: 'create_session', profileId: 'cc-main', profileRevision: REV, repositoryKey: 'repo', role: 'work', reporting: { url: 'http://127.0.0.1:9/mcp/collab', credential: 'second' } });
    expect(create).toEqual({ state: 'accepted', binding: { workspaceRef: first.binding.workspaceRef, nativeSessionId: `native-${S2}`, generation: 1 } });
    expect(t.backend.opened[1].workspaceDir).toBe(t.backend.opened[0].workspaceDir);
    writeFileSync(join(t.backend.opened[0].workspaceDir, 'wip.txt'), 'in progress');
    const third = await t.handlers.submit({ commandId: 'create-3', digest: 'dc3', runId: RUN, sessionId: '55555555-5555-4555-8555-555555555555', backend: 'claude-code', kind: 'create_session', profileId: 'cc-main', profileRevision: REV, repositoryKey: 'repo', role: 'work', reporting: { url: 'http://127.0.0.1:9/mcp/collab', credential: 'third' } });
    expect(third.state).toBe('accepted');
  });
});

describe('claimed cancel of a launch that has not started (Task 10)', () => {
  const second = () => launch({ commandId: 'launch-2', digest: 'd-launch-2', sessionId: S2, kind: 'create_session', branchName: undefined, baseRef: undefined });

  it('a cancel before a deferred launch was dispatched cancels it without any native start', async () => {
    const t = setup({ limits: { 'claude-code': 1, codex: 1 } });
    expect((await t.handlers.submit(launch())).state).toBe('accepted');
    expect(await t.handlers.submit(second())).toEqual({ state: 'deferred' });
    const cancel = { commandId: 'cancel-2', digest: 'd-cancel-2', runId: RUN, sessionId: S2, backend: 'claude-code', kind: 'cancel' };
    expect(await t.handlers.submit(cancel)).toEqual({ state: 'applied', dispatched: false });
    expect(await t.handlers.submit(second())).toEqual({ state: 'failed', errorCode: 'request_unavailable' });
    expect(t.backend.opened).toHaveLength(1);
    expect(t.ledger.classify('launch-2')).toBe('undispatched');
  });

  it('a cancel of a bound launch whose first prompt was never written interrupts it, and that prompt is never written', async () => {
    const t = setup();
    expect((await t.handlers.submit(launch())).state).toBe('accepted');
    const cancel = { commandId: 'cancel-1', digest: 'd-cancel-1', runId: RUN, sessionId: S1, backend: 'claude-code', kind: 'cancel' };
    expect(await t.handlers.submit(cancel)).toEqual({ state: 'applied' });
    expect(await t.handlers.deliver({ commandId: 'launch-1', digest: 'd-launch-1', text: 'Do the task.' })).toEqual({ state: 'failed', errorCode: 'request_unavailable' });
    expect(t.backend.workers[0].sends).toEqual([]);
    expect(t.ledger.classify('launch-1').prompt).toBeUndefined();
  });

  it('a cancel accepted before its launch reached the supervisor fences that launch before any effect', async () => {
    const t = setup();
    const cancel = { commandId: 'cancel-early', digest: 'd-cancel-early', runId: RUN, sessionId: S1, backend: 'claude-code', kind: 'cancel' };
    expect(await t.handlers.submit(cancel)).toEqual({ state: 'applied', dispatched: false });
    expect(await t.handlers.submit(launch())).toEqual({ state: 'failed', errorCode: 'request_unavailable' });
    expect(t.backend.opened).toEqual([]);
    expect(existsSync(join(t.stateDir, 'worktrees'))).toBe(false);
    expect(t.ledger.classify('launch-1')).toBe('undispatched');
    const again = createSupervisorHandlers({ ledger: createLedger({ dir: t.dir }), profiles: [claude], backends: { 'claude-code': t.backend }, containment: t.mem.containment, log: () => {}, stateDir: t.stateDir, repositories: { repo: t.repo }, limits: SESSION_CAPS });
    expect(await again.submit(launch())).toEqual({ state: 'failed', errorCode: 'request_unavailable' });
    expect(t.backend.opened).toEqual([]);
  });

  it('a launch whose only effect was its worktree is settled by cancel with the worktree evidence kept; after a native-create barrier it stays uncertain', async () => {
    const t = setup();
    t.ledger.submit({ commandId: 'launch-1', digest: 'd-launch-1', runId: RUN, sessionId: S1, backend: 'claude-code', kind: 'launch' });
    t.ledger.barrier('launch-1', { effect: 'create_worktree', generation: 0, ref: { workspaceRef: 'ffw_0123456789abcdef', branchName: `ff/run-${RUN}` } });
    t.ledger.receipt('launch-1', { effect: 'create_worktree', evidence: { workspaceRef: 'ffw_0123456789abcdef' } });
    const later = createSupervisorHandlers({ ledger: createLedger({ dir: t.dir }), profiles: [claude], backends: { 'claude-code': t.backend }, containment: t.mem.containment, log: () => {}, stateDir: t.stateDir, repositories: { repo: t.repo }, limits: SESSION_CAPS });
    expect(await later.submit({ commandId: 'cancel-1', digest: 'd-cancel-1', runId: RUN, sessionId: S1, backend: 'claude-code', kind: 'cancel' })).toEqual({ state: 'applied', dispatched: false });
    expect(await later.submit(launch())).toEqual({ state: 'failed', errorCode: 'request_unavailable' });
    expect(createLedger({ dir: t.dir }).classify('launch-1')).toEqual({ create_worktree: 'receipted' });
    expect(t.backend.opened).toEqual([]);
    const u = setup();
    u.ledger.submit({ commandId: 'launch-1', digest: 'd-launch-1', runId: RUN, sessionId: S1, backend: 'claude-code', kind: 'launch' });
    u.ledger.barrier('launch-1', { effect: 'create_native_session', generation: 1, ref: {} });
    const uncertain = createSupervisorHandlers({ ledger: createLedger({ dir: u.dir }), profiles: [claude], backends: { 'claude-code': u.backend }, containment: u.mem.containment, log: () => {}, stateDir: u.stateDir, repositories: { repo: u.repo }, limits: SESSION_CAPS });
    expect(await uncertain.submit({ commandId: 'cancel-1', digest: 'd-cancel-1', runId: RUN, sessionId: S1, backend: 'claude-code', kind: 'cancel' })).toEqual({ state: 'reconciling', errorCode: 'reconciling' });
    expect(await uncertain.submit(launch())).toEqual({ state: 'reconciling', errorCode: 'reconciling' });
  });
});
