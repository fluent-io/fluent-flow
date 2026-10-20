import { nativeWorkspaceId } from '../../../src/connector/uuid-v5.js';
import { it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
import { fakePaseoSdk } from './helpers/fake-paseo.js';

const temp = mkdtempSync(join(tmpdir(), 'ff-runtime-'));
afterEach(() => vi.unstubAllGlobals());

it('constructs the real SDK through the connector runtime and clearly rejects unavailable WebSocket', async () => {
  const { connectLocalPaseo } = await import('../../../src/connector/runtime.js');
  vi.stubGlobal('WebSocket', undefined);
  await expect(connectLocalPaseo({ url: 'ws://127.0.0.1:1/ws', password: 'private' })).rejects.toThrow('Node 22');
});

it('redacts prior and newly delivered reporting credentials during native backfill after restart without putting them in the intent journal', async () => {
  const { createConnectorRuntime } = await import('../../../src/connector/runtime.js');
  const dir = mkdtempSync(join(tmpdir(), 'ff-runtime-private-'));
  const stateDir = join(dir, 'state');
  const seedFile = join(dir, 'redaction-seed.json');
  const priorCredential = 'prior-session-private-reporting-credential';
  const reportingCredential = 'new-session-private-reporting-credential';
  writeFileSync(seedFile, JSON.stringify([priorCredential]), { mode: 0o600 });
  const paseo = fakePaseoSdk();
  const profile = { id: 'p1', name: 'Coder', provider: 'omp', model: 'synthetic', features: {} };
  paseo.config = { get: async () => ({ config: { agentProfiles: [profile] } }) };
  paseo.close = async () => {};
  const config = { instanceId: 'private', serverUrl: 'http://127.0.0.1:1', token: 'host-private-value', repositories: { repo: dir }, profiles: ['p1'], paseo: {}, redactionSecretsFile: seedFile };
  let runtime;
  try {
    runtime = await createConnectorRuntime({ config, journalDir: stateDir, paseo, stopAgent: async () => {} });
    const command = { id: 'launch-private', kind: 'launch', runId: 'private-run', sessionId: 'private-session', payload: { repositoryKey: 'repo', profileId: 'p1', profileSnapshot: profile, reportingCredential, prompt: 'bounded', workspace: { branchName: 'ff/private', baseRef: 'main' } } };
    expect((await runtime.executor.execute(command)).state).toBe('accepted');
    const binding = runtime.journal.bindingForRun(command.runId);
    await runtime.close();
    runtime = await createConnectorRuntime({ config, journalDir: stateDir, paseo, stopAgent: async () => {} });
    paseo.state.timelineByAgent.get(binding.paseoAgentId).items.push({ type: 'assistant_message', text: `Observed ${priorCredential} and ${reportingCredential}` });
    await runtime.observer.sync();
    const rawJournal = readFileSync(join(stateDir, 'journal.jsonl'), 'utf8');
    expect(rawJournal.includes(priorCredential)).toBe(false);
    expect(rawJournal.includes(reportingCredential)).toBe(false);
    expect(rawJournal).toContain('Observed [redacted] and [redacted]');
    const persisted = JSON.parse(readFileSync(join(stateDir, 'redaction-context.json'), 'utf8'));
    expect(persisted).toEqual([reportingCredential]);
    expect(statSync(stateDir).mode & 0o777).toBe(0o700);
    expect(statSync(join(stateDir, 'redaction-context.json')).mode & 0o777).toBe(0o600);
    expect(paseo.state.agentCreateCalls[0].config.mcpServers['fluent-flow'].headers.Authorization).toBe(`Bearer ${reportingCredential}`);
  } finally {
    await runtime?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

it('composes real journal, executor, observer and exact workspace artifact/Git readers', async () => {
  const { createConnectorRuntime } = await import('../../../src/connector/runtime.js');
  const workspace = join(temp, 'workspace');
  const source = join(temp, 'source');
  mkdirSync(workspace, { recursive: true });
  mkdirSync(source, { recursive: true });
  await exec('git', ['init', '-b', 'main', workspace]);
  await exec('git', ['-C', workspace, '-c', 'user.name=T', '-c', 'user.email=t@example.test', 'commit', '--allow-empty', '-m', 'base']);
  writeFileSync(join(workspace, 'output.md'), 'generated in worktree');
  writeFileSync(join(source, 'output.md'), 'wrong source checkout');
  const paseo = fakePaseoSdk();
  const profile = { id: 'p1', name: 'Coder', provider: 'omp', model: 'synthetic', modeId: null, thinkingOptionId: null, features: {} };
  paseo.config = { get: async () => ({ config: { agentProfiles: [profile] } }) };
  paseo.close = async () => {};
  const runtime = await createConnectorRuntime({ config: { instanceId: 'test', serverUrl: 'http://127.0.0.1:1', token: 'private', repositories: { repo: source }, profiles: ['p1'], paseo: {} }, journalDir: join(temp, 'journal'), paseo, stopAgent: async () => {} });
  const command = { id: 'launch', kind: 'launch', runId: 'r1', sessionId: 's1', payload: { repositoryKey: 'repo', profileId: 'p1', profileSnapshot: profile, prompt: 'bounded', workspace: { branchName: 'ff/r1/s1', baseRef: 'main' } } };
  expect((await runtime.executor.execute(command)).state).toBe('accepted');
  paseo.state.workspacesById.get(nativeWorkspaceId('r1')).refresh = async () => ({ id: nativeWorkspaceId('r1'), workspaceKind: 'worktree', workspaceDirectory: workspace, archivingAt: null });
  await runtime.observer.sync();
  const result = await runtime.executor.execute({ id: 'artifact', runId: 'r1', sessionId: 's1', kind: 'artifact_read', payload: { reference: 'output.md', repositoryKey: 'spoof' } });
  expect(result.state).toBe('applied');
  expect(Buffer.from(result.result.contentBase64, 'base64').toString()).toBe('generated in worktree');
  const head = await runtime.sampleGit(runtime.journal.bindingForRun('r1'));
  expect(head.payload.headCommit).toMatch(/^[a-f0-9]{40}$/);
  expect(head.payload.dirty).toBe(true);
  const preflight = await runtime.executor.execute({ id: 'preflight', kind: 'wrapup_preflight', runId: 'r1', sessionId: 's1', payload: {} });
  expect(preflight.result.workspaceId).toBe(nativeWorkspaceId('r1'));
  expect(preflight.result.blockers.map((blocker) => blocker.code)).toContain('untracked_files');
  const summaryCommand = { id: 'summary', kind: 'summarize', runId: 'r1', sessionId: 's-summary', payload: { profileId: 'p1', profileSnapshot: profile, prompt: 'Summarize this run.', sourceSessionId: 's1', sourceCursor: 'work-source:1' } };
  expect((await runtime.executor.execute(summaryCommand)).state).toBe('accepted');
  const summaryBinding = runtime.journal.bindingForSession('r1', 's-summary');
  expect(summaryBinding.role).toBe('summary');
  paseo.state.timelineByAgent.get(summaryBinding.paseoAgentId).items.push({ type: 'assistant_message', text: 'Tests passed. Work remains for human review.' });
  await runtime.observer.sync();
  paseo.state.deliverLive(summaryBinding.paseoAgentId, { event: { type: 'turn_completed', turnId: 'summary-turn' }, epoch: 'e1', seq: 2, timestamp: new Date().toISOString() });
  for (let tries = 0; tries < 100 && !runtime.journal.pendingObservationIds().some((id) => id.startsWith('summary:')); tries++) await new Promise((resolve) => setTimeout(resolve, 10));
  const summary = runtime.journal.pendingObservationIds().map((id) => runtime.journal.observationById(id)).find((event) => event.kind === 'summary');
  expect(summary).toMatchObject({ runId: 'r1', sessionId: 's-summary', payload: { body: 'Tests passed. Work remains for human review.', model: 'synthetic', sourceCursor: 'work-source:1' } });
  await runtime.close();
  rmSync(temp, { recursive: true, force: true });
});
