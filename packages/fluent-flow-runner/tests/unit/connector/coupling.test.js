import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createJournal } from '../../../src/connector/journal.js';
import { createExecutor, canonicalDigest } from '../../../src/connector/executor.js';
import { createPaseoAdapter } from '../../../src/connector/paseo-adapter.js';
import { fakePaseoSdk } from './helpers/fake-paseo.js';
import { createObservationPrivacy } from '../../../src/connector/observation-privacy.js';

/**
 * Coupling regressions over the REAL journal + executor + adapter stack.
 * Only the external SDK (and, in loop.test.js, HTTP) is faked.
 */

let dir;
let journal;
let paseo;
let adapter;
let executor;

const catalogProfile = { id: 'p1', name: 'Coder', provider: 'omp', model: 'ai3/x', modeId: 'full', thinkingOptionId: null, features: {} };
const config = { repositories: { 'test-repo': '/repos/test' }, profiles: ['p1'] };

const command = {
  id: 'cmd-1',
  runId: 'run-1',
  sessionId: 'sess-1',
  kind: 'launch',
  payload: {
    repositoryKey: 'test-repo',
    profileId: 'p1',
    profileSnapshot: catalogProfile,
    model: null,
    prompt: 'Do the bounded task.',
    workspace: { mode: 'worktree', branchName: 'ff/run-1/sess-1', baseRef: 'main' },
  },
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ff-coupling-'));
  journal = createJournal({ dir });
  paseo = fakePaseoSdk();
  adapter = createPaseoAdapter({ paseo, journal });
  executor = createExecutor({ config, adapter, journal, catalogProfiles: [catalogProfile] });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('coupling: digest ownership', () => {
  it('rejects a redelivered command whose NESTED payload changed, executing nothing', async () => {
    const o1 = await executor.execute(structuredClone(command));
    expect(o1.stage).toBe('bound');
    const creates = paseo.state.createCalls.length;

    // Same id, deep payload change (prompt text).
    const changed = structuredClone(command);
    changed.payload.prompt = 'CHANGED instructions';
    const o2 = await executor.execute(changed);
    expect(o2.state).toBe('failed');
    expect(o2.errorCode).toBe('digest_mismatch');
    expect(paseo.state.createCalls).toHaveLength(creates);
    expect(paseo.state.sends).toHaveLength(0);

    // Nested-in-workspace change is caught the same way.
    const nested = structuredClone(command);
    nested.payload.workspace.baseRef = 'main-evil';
    const o3 = await executor.execute(nested);
    expect(o3.errorCode).toBe('digest_mismatch');
    expect(paseo.state.sends).toHaveLength(0);
  });

  it('digest is order-insensitive and covers nested keys', () => {
    const a = canonicalDigest({ x: { b: 1, a: 2 }, y: [1, { z: 3 }] });
    const b = canonicalDigest({ y: [1, { z: 3 }], x: { a: 2, b: 1 } });
    expect(a).toBe(b);
    const c = canonicalDigest({ x: { b: 1, a: 3 }, y: [1, { z: 3 }] });
    expect(c).not.toBe(a);
  });
});

describe('coupling: lost prompt acknowledgment', () => {
  it('send records prompt then throws: ambiguous hold, redelivery verifies ONE prompt', async () => {
    const o1 = await executor.execute(structuredClone(command));
    expect(o1.state).toBe('accepted');

    // Daemon applied the send but the connector saw the transport die.
    paseo.state.fail.onSend = { recordFirst: true, error: Object.assign(new Error('send failed'), { cause: { code: 'ECONNRESET' } }) };
    const o2 = await executor.complete(structuredClone(command));
    expect(o2.state).toBe('ambiguous');
    expect(o2.errorCode).toBe('send_unconfirmed');
    expect(paseo.state.sends).toHaveLength(1); // recorded, then "connection died"

    // Restart: fresh journal view over the same dir, redelivered same command.
    const journal2 = createJournal({ dir });
    const adapter2 = createPaseoAdapter({ paseo, journal: journal2 });
    const executor2 = createExecutor({ config, adapter: adapter2, journal: journal2, catalogProfiles: [catalogProfile] });
    const o3 = await executor2.execute(structuredClone(command));
    expect(o3.stage).toBe('bound');
    const o4 = await executor2.complete(structuredClone(command));
    expect(o4.state).toBe('applied');
    expect(paseo.state.sends).toHaveLength(1); // timeline proved delivery: NO resend
  });

  it('send fails with NO trace in timeline: provably absent, resent ONCE with the same message id', async () => {
    const o1 = await executor.execute(structuredClone(command));
    expect(o1.state).toBe('accepted');

    paseo.state.fail.onSend = { recordFirst: false, error: new Error('rejected before delivery') };
    const o2 = await executor.complete(structuredClone(command));
    expect(o2.state).toBe('ambiguous');
    expect(paseo.state.sends).toHaveLength(0);

    const journal2 = createJournal({ dir });
    const adapter2 = createPaseoAdapter({ paseo, journal: journal2 });
    const executor2 = createExecutor({ config, adapter: adapter2, journal: journal2, catalogProfiles: [catalogProfile] });
    await executor2.execute(structuredClone(command));
    const o3 = await executor2.complete(structuredClone(command));
    expect(o3.state).toBe('applied');
    expect(paseo.state.sends).toHaveLength(1);
    expect(paseo.state.sends[0].messageId).toBe('cmd-1');
  });
});

describe('coupling: selected-session identity', () => {
  async function bindSecondSession() {
    await executor.execute(structuredClone(command));
    await executor.complete(structuredClone(command));
    const second = {
      id: 'cmd-s2',
      runId: 'run-1',
      sessionId: 'sess-2',
      kind: 'create_session',
      payload: {
        profileId: 'p1',
        profileSnapshot: catalogProfile,
        model: null,
        title: 'Second session',
        instructions: 'Second session bounded prompt.',
      },
    };
    const o = await executor.execute(second);
    expect(o.state).toBe('accepted');
    const o2 = await executor.complete(second);
    expect(o2.state).toBe('applied');
  }

  it('steers each session exactly: behavior forwarded to the addressed agent', async () => {
    await bindSecondSession();
    expect(paseo.state.sends.map((s) => s.agentId)).toHaveLength(2);
    const [agent1, agent2] = paseo.state.sends.map((s) => s.agentId);
    expect(agent1).not.toBe(agent2);

    const steer1 = { id: 'cmd-p1', runId: 'run-1', sessionId: 'sess-1', kind: 'prompt', payload: { text: 'focus tests', behavior: 'steer' } };
    const steer2 = { id: 'cmd-p2', runId: 'run-1', sessionId: 'sess-2', kind: 'prompt', payload: { text: 'replan docs', behavior: 'interrupt' } };
    expect((await executor.execute(steer1)).state).toBe('applied');
    expect((await executor.execute(steer2)).state).toBe('applied');
    const byAgent = new Map(paseo.state.sends.map((s) => [s.agentId, s]));
    expect(byAgent.get(agent1)).toMatchObject({ messageId: 'cmd-p1', activeTurnBehavior: 'steer' });
    expect(byAgent.get(agent2)).toMatchObject({ messageId: 'cmd-p2', activeTurnBehavior: 'interrupt' });
  });

  it('rejects a payload naming a foreign agent id for the addressed session', async () => {
    await bindSecondSession();
    const agent1 = paseo.state.sends[0].agentId;
    const foreign = { id: 'cmd-px', runId: 'run-1', sessionId: 'sess-2', kind: 'prompt', payload: { text: 'hijack', paseoAgentId: agent1 } };
    const o = await executor.execute(foreign);
    expect(o.state).toBe('failed');
    expect(o.errorCode).toBe('session_mismatch');
    expect(paseo.state.sends).toHaveLength(2);
  });

  it('cancel targets the addressed session only', async () => {
    await bindSecondSession();
    const stopped = [];
    const execWithStop = createExecutor({
      config,
      adapter,
      journal,
      catalogProfiles: [catalogProfile],
      capabilities: { stopAgent: async (agentId) => stopped.push(agentId) },
    });
    const o = await execWithStop.execute({ id: 'cmd-c2', runId: 'run-1', sessionId: 'sess-2', kind: 'cancel', payload: {} });
    expect(o.state).toBe('applied');
    expect(stopped).toHaveLength(1);
    expect(stopped[0]).toBe(paseo.state.sends[1].agentId);
  });
});

describe('coupling: host allowlist pinning', () => {
  it('rejects a command whose snapshot differs from the local catalog (no SDK calls)', async () => {
    const tampered = structuredClone(command);
    tampered.payload.profileSnapshot = { ...catalogProfile, model: 'claude/opus-evil', modeId: 'bypass' };
    const o = await executor.execute(tampered);
    expect(o.state).toBe('failed');
    expect(o.errorCode).toBe('profile_snapshot_mismatch');
    expect(paseo.state.createCalls).toHaveLength(0);
    expect(paseo.state.sends).toHaveLength(0);
  });

  it('rejects a run model override that is not the allowlisted profile model', async () => {
    const override = structuredClone(command);
    override.payload.model = 'openai/gpt-evil';
    const o = await executor.execute(override);
    expect(o.state).toBe('failed');
    expect(o.errorCode).toBe('model_not_allowed');
    expect(paseo.state.createCalls).toHaveLength(0);
  });

  it('rejects an out-of-allowlist repository key with a failed outcome and no SDK calls', async () => {
    const bad = structuredClone(command);
    bad.payload.repositoryKey = 'NOT-ALLOWED';
    const o = await executor.execute(bad);
    expect(o.state).toBe('failed');
    expect(o.errorCode).toBe('repository_not_allowed');
    expect(paseo.state.createCalls).toHaveLength(0);
  });
});

describe('coupling: launch prompt guard', () => {
  it.each([
    { prompt: 'Frozen canonical task prompt', instructions: '', expected: 'Frozen canonical task prompt' },
    { prompt: 'Frozen canonical task prompt', instructions: 'Operator note', expected: 'Frozen canonical task prompt' },
    { instructions: 'Legacy nonempty instructions', expected: 'Legacy nonempty instructions' },
  ])('delivers the selected nonempty additional-session prompt: $expected', async ({ expected, ...payload }) => {
    await executor.execute(structuredClone(command));
    const extra = { id: 'cmd-extra', kind: 'create_session', runId: 'run-1', sessionId: 'sess-extra', payload: { profileId: 'p1', profileSnapshot: catalogProfile, ...payload } };
    expect((await executor.execute(extra)).state).toBe('accepted');
    expect((await executor.complete(extra)).state).toBe('applied');
    expect(paseo.state.sends).toHaveLength(1);
    expect(paseo.state.sends[0]).toMatchObject({ text: expected, messageId: extra.id, agentId: journal.byCommand(extra.id).binding.paseoAgentId });
  });

  it.each([
    { prompt: '', instructions: '', errorCode: 'prompt_required' },
    { prompt: '   ', instructions: '  ', errorCode: 'prompt_required' },
    { prompt: 'x'.repeat(200_001), instructions: '', errorCode: 'prompt_too_large' },
  ])('refuses an invalid additional-session prompt with $errorCode', async ({ errorCode, ...payload }) => {
    await executor.execute(structuredClone(command));
    const extra = { id: 'cmd-extra', kind: 'create_session', runId: 'run-1', sessionId: 'sess-extra', payload: { profileId: 'p1', profileSnapshot: catalogProfile, ...payload } };
    expect((await executor.execute(extra)).state).toBe('accepted');
    expect(await executor.complete(extra)).toMatchObject({ state: 'failed', errorCode });
    expect(paseo.state.sends).toHaveLength(0);
  });

  it('never reports applied for an initial launch without an actual prompt', async () => {
    const o1 = await executor.execute(structuredClone(command));
    expect(o1.stage).toBe('bound');
    expect(o1.state).toBe('accepted');
    const noPrompt = structuredClone(command);
    delete noPrompt.payload.prompt;
    const o2 = await executor.complete(noPrompt);
    expect(o2.state).toBe('failed');
    expect(o2.errorCode).toBe('prompt_required');
    expect(paseo.state.sends).toHaveLength(0);
    const blank = structuredClone(command);
    blank.payload.prompt = '   ';
    const o3 = await executor.complete(blank);
    expect(o3.errorCode).toBe('prompt_required');
    expect(paseo.state.sends).toHaveLength(0);
  });

  it('rejects an oversized prompt before any send', async () => {
    const o1 = await executor.execute(structuredClone(command));
    expect(o1.state).toBe('accepted');
    const huge = structuredClone(command);
    huge.payload.prompt = 'x'.repeat(200_001);
    const o2 = await executor.complete(huge);
    expect(o2.state).toBe('failed');
    expect(o2.errorCode).toBe('prompt_too_large');
    expect(paseo.state.sends).toHaveLength(0);
  });

  it('summary without a real source prompt is refused', async () => {
    await executor.execute(structuredClone(command));
    await executor.complete(structuredClone(command));
    const s = {
      id: 'cmd-sum',
      runId: 'run-1',
      sessionId: 'sess-sum',
      kind: 'summarize',
      payload: { profileId: 'p1', profileSnapshot: catalogProfile, model: null },
    };
    const o = await executor.execute(s);
    expect(o.state).toBe('accepted'); // session may bind
    const o2 = await executor.complete(s);
    expect(o2.state).toBe('failed');
    expect(o2.errorCode).toBe('prompt_required');
  });
});

describe('coupling: summary staging', () => {
  it('without a server snapshot the summary is disabled', async () => {
    await executor.execute(structuredClone(command));
    const s = { id: 'cmd-sum', runId: 'run-1', sessionId: 'sess-sum', kind: 'summarize', payload: {} };
    const o = await executor.execute(s);
    expect(o.state).toBe('failed');
    expect(o.errorCode).toBe('summary_disabled');
  });

  it('with a snapshot it binds a summary session first, prompt only after complete()', async () => {
    await executor.execute(structuredClone(command));
    await executor.complete(structuredClone(command));
    expect(paseo.state.sends).toHaveLength(1);
    const s = {
      id: 'cmd-sum',
      runId: 'run-1',
      sessionId: 'sess-sum',
      kind: 'summarize',
      payload: { profileId: 'p1', profileSnapshot: catalogProfile, model: null, title: 'Summary run-1', prompt: 'Summarize the completed turn.' },
    };
    const o1 = await executor.execute(s);
    expect(o1.stage).toBe('bound');
    expect(o1.state).toBe('accepted');
    expect(paseo.state.sends).toHaveLength(1); // no summary prompt yet
    expect(journal.byCommand('cmd-sum').binding).toBeTruthy();
    const o2 = await executor.complete(s);
    expect(o2.state).toBe('applied');
    expect(paseo.state.sends).toHaveLength(2);
  });
});

describe('coupling: bidirectional timeline verification', () => {
  it('finds the prompt in OLDER history behind a full tail window instead of resending', async () => {
    const o1 = await executor.execute(structuredClone(command));
    expect(o1.state).toBe('accepted');
    const agentId = journal.byCommand('cmd-1').binding.paseoAgentId;

    // Journey: the send landed but the ack was lost...
    paseo.state.fail.onSend = { recordFirst: true, error: Object.assign(new Error('send failed'), { cause: { code: 'ECONNRESET' } }) };
    const o2 = await executor.complete(structuredClone(command));
    expect(o2.state).toBe('ambiguous');

    // ...and afterwards the timeline grew beyond one tail window, so the
    // default tail page no longer contains the original user_message.
    const timeline = paseo.state.timelineByAgent.get(agentId);
    for (let i = 0; i < 30; i++) {
      timeline.items.push({ type: 'assistant_message', text: `filler ${i}`, messageId: `filler-${i}` });
    }

    // Windowed refetch: tail returns only the last 20 items (the prompt sits
    // at index 0 of 31); 'before' pages walk toward older entries.
    paseo.state.customRefetch = (id, opts, defaultPayload) => {
      const direction = opts?.direction ?? 'tail';
      const items = timeline.items;
      const page = (startSeq, endSeq, hasOlder, hasNewer) => ({
        ...defaultPayload,
        direction,
        window: { minSeq: startSeq, maxSeq: endSeq, nextSeq: endSeq + 1 },
        startCursor: { epoch: 'e1', seq: startSeq },
        endCursor: { epoch: 'e1', seq: endSeq },
        hasOlder,
        hasNewer,
        entries: items.slice(startSeq - 1, endSeq).map((item, i) => ({
          provider: 'omp', item, timestamp: 't', seqStart: startSeq + i, seqEnd: startSeq + i, sourceSeqRanges: [], collapsed: [],
        })),
      });
      if (direction === 'tail') {
        return page(items.length - 19, items.length, true, false);
      }
      if (direction === 'before') {
        const startSeq = Math.max(1, (opts?.cursor?.seq ?? items.length + 1) - 20);
        const endSeq = startSeq + 19;
        return page(startSeq, endSeq, startSeq > 1, endSeq < items.length);
      }
      return defaultPayload;
    };

    const journal2 = createJournal({ dir });
    const adapter2 = createPaseoAdapter({ paseo, journal: journal2 });
    const executor2 = createExecutor({ config, adapter: adapter2, journal: journal2, catalogProfiles: [catalogProfile] });
    await executor2.execute(structuredClone(command));
    const o3 = await executor2.complete(structuredClone(command));
    expect(o3.state).toBe('applied');
    expect(paseo.state.sends).toHaveLength(1); // verified via older pages: no resend
  });
});

describe('coupling: permission contract (translated to the real SDK union)', () => {
  it('maps only unambiguous current display choices and preserves free text without expanding local placeholders', async () => {
    await executor.execute(structuredClone(command));
    const privacy = createObservationPrivacy({ secrets: ['secret-one', 'secret-two'] });
    privacy.addWorkspace('/host/owned');
    const displayExecutor = createExecutor({ config, adapter, journal, catalogProfiles: [catalogProfile], privacy });
    paseo.state.pendingPermissions.set('display-question', { id: 'display-question', kind: 'question', input: { questions: [{ header: '/host/owned/Choice', question: 'Choose', options: [{ label: '/host/owned/src/a.ts' }], allowOther: true }] } });
    expect((await displayExecutor.execute({ id: 'display-answer', runId: 'run-1', sessionId: 'sess-1', kind: 'permission', payload: { requestId: 'display-question', response: { behavior: 'allow', answers: { '[workspace]/Choice': '[workspace]/unlisted.ts' } } } })).state).toBe('applied');
    expect(paseo.state.permissionResponses[0].response.updatedInput.answers).toEqual({ '/host/owned/Choice': '[workspace]/unlisted.ts' });
    paseo.state.pendingPermissions.set('ambiguous', { id: 'ambiguous', kind: 'question', input: { questions: [{ header: 'Choice', question: 'Choose', options: [{ label: 'secret-one' }, { label: 'secret-two' }] }] } });
    const response = await displayExecutor.execute({ id: 'ambiguous-answer', runId: 'run-1', sessionId: 'sess-1', kind: 'permission', payload: { requestId: 'ambiguous', response: { behavior: 'allow', answers: { Choice: '[redacted]' } } } });
    expect(response).toMatchObject({ state: 'failed', errorCode: 'invalid_response' });
    expect(paseo.state.permissionResponses).toHaveLength(1);
  });
  it('passes the full per-session report credential to a fixed MCP endpoint and carries identity labels', async () => {
    const launch = structuredClone(command);
    launch.payload.reportingCredential = 'ffreport_complete_session_secret';
    launch.payload.labels = { 'fluent-flow.task': 'task-1' };
    const secureExecutor = createExecutor({ config: { ...config, serverUrl: 'http://127.0.0.1:4000' }, adapter, journal, catalogProfiles: [catalogProfile] });
    expect((await secureExecutor.execute(launch)).state).toBe('accepted');
    const created = paseo.state.agentCreateCalls[0];
    expect(created.config.mcpServers).toEqual({ 'fluent-flow': { type: 'http', url: 'http://127.0.0.1:4000/mcp/collab', headers: { Authorization: 'Bearer ffreport_complete_session_secret' } } });
    expect(created.labels).toMatchObject({ 'fluent-flow.task': 'task-1', 'fluent-flow.run': 'run-1', 'fluent-flow.session': 'sess-1' });
    expect(JSON.stringify(journal.byCommand('cmd-1'))).not.toContain('ffreport_complete_session_secret');
  });
  const questionRequest = {
    id: 'q-1',
    provider: 'omp',
    name: 'Ask user',
    kind: 'question',
    input: { metadata: { source: 'native' }, questions: [{ header: 'choice', question: 'Pick one', options: [{ label: 'a' }, { label: 'b' }], multiSelect: false, allowOther: false, allowEmpty: false }] },
    actions: [{ id: 'allow-once', label: 'Answer', behavior: 'allow' }],
  };

  async function bindLive() {
    await executor.execute(structuredClone(command));
    await executor.complete(structuredClone(command));
  }

  it('translates allow+answers on a question request into SDK allow with merged updatedInput', async () => {
    await bindLive();
    const agentId = journal.byCommand('cmd-1').binding.paseoAgentId;
    paseo.state.pendingPermissions.set('q-1', questionRequest);

    // WIRE shape: behavior allow|deny with optional answers (headers->string).
    const wire = { id: 'cmd-a1', runId: 'run-1', sessionId: 'sess-1', kind: 'permission', payload: { requestId: 'q-1', response: { behavior: 'allow', answers: { choice: 'b' } } } };
    const o = await executor.execute(wire);
    expect(o.state).toBe('applied');

    // SDK-visible shape: allow only, updatedInput = current input + answers.
    expect(paseo.state.permissionResponses).toHaveLength(1);
    const sent = paseo.state.permissionResponses[0];
    expect(sent.requestId).toBe('q-1');
    expect(sent.response.behavior).toBe('allow');
    expect(sent.response.updatedInput).toEqual({ ...questionRequest.input, answers: { choice: 'b' } });
    expect(sent.response.updatedInput).not.toHaveProperty('behavior');
    void agentId;
  });

  it('passes deny through verbatim and rejects answers on plain non-question allows without translation data', async () => {
    await bindLive();
    paseo.state.pendingPermissions.set('t-1', { id: 't-1', provider: 'omp', name: 'bash', kind: 'tool', input: { command: 'npm test' } });
    const deny = { id: 'cmd-a2', runId: 'run-1', sessionId: 'sess-1', kind: 'permission', payload: { requestId: 't-1', response: { behavior: 'deny', selectedActionId: 'deny' } } };
    expect((await executor.execute(deny)).state).toBe('applied');
    expect(paseo.state.permissionResponses[0].response).toEqual({ behavior: 'deny', selectedActionId: 'deny' });
  });

  it('rejects answers on non-question requests and unknown or invalid question headers', async () => {
    await bindLive();
    paseo.state.pendingPermissions.set('tool', { id: 'tool', kind: 'tool', input: { command: 'npm test' } });
    paseo.state.pendingPermissions.set('q-1', questionRequest);
    for (const [index, requestId, answers] of [[1, 'tool', { choice: 'b' }], [2, 'q-1', { unknown: 'b' }], [3, 'q-1', { choice: 'c' }]]) {
      const result = await executor.execute({ id: `invalid-${index}`, runId: 'run-1', sessionId: 'sess-1', kind: 'permission', payload: { requestId, response: { behavior: 'allow', answers } } });
      expect(result.errorCode).toBe('invalid_response');
    }
    expect(paseo.state.permissionResponses).toHaveLength(0);
  });

  it('surfaces stale/unknown requests as failed request_inactive without touching the SDK', async () => {
    await bindLive();
    const stale = { id: 'cmd-a4', runId: 'run-1', sessionId: 'sess-1', kind: 'permission', payload: { requestId: 'expired-1', response: { behavior: 'allow' } } };
    const o = await executor.execute(stale);
    expect(o.state).toBe('failed');
    expect(o.errorCode).toBe('request_inactive');
    expect(paseo.state.permissionResponses).toHaveLength(0);
  });

  it('rejects malformed wire responses', async () => {
    await bindLive();
    paseo.state.pendingPermissions.set('q-1', questionRequest);
    const badAnswerShape = { id: 'cmd-a5', runId: 'run-1', sessionId: 'sess-1', kind: 'permission', payload: { requestId: 'q-1', response: { behavior: 'allow', answers: 'not-an-object' } } };
    expect((await executor.execute(badAnswerShape)).errorCode).toBe('invalid_response');
    const badDeny = { id: 'cmd-a6', runId: 'run-1', sessionId: 'sess-1', kind: 'permission', payload: { requestId: 'q-1', response: { behavior: 'deny', updatedInput: { cmd: 'rm' } } } };
    expect((await executor.execute(badDeny)).errorCode).toBe('invalid_response');
    const wrongSession = { id: 'cmd-a7', runId: 'run-1', sessionId: 'sess-999', kind: 'permission', payload: { requestId: 'q-1', response: { behavior: 'allow' } } };
    expect((await executor.execute(wrongSession)).errorCode).toBe('session_not_bound');
  });
});
