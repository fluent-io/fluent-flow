import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import {
  AGENT_METHODS,
  CLIENT_METHODS,
  PROTOCOL_VERSION,
  agent,
  ndJsonStream,
} from '@agentclientprotocol/sdk/experimental/v2';

function argument(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
}

const scenario = argument('--scenario', process.env.FAKE_ACP_SCENARIO ?? 'normal');
const tracePath = argument('--trace', process.env.FAKE_ACP_TRACE);
const smokeBarrierDirectory = argument('--barrier', process.env.FAKE_ACP_SMOKE_BARRIER);
const sessionId = scenario === 'smoke' ? `smoke-session-${process.pid}` : 'fake-session-1';
let promptCalls = 0;
let listCalls = 0;
let silenceTurnRunning = false;
let blockedSetupTimer = null;
const chatConfig = [
  { configId: 'approval', name: 'Approval', type: 'select', currentValue: 'bypass', options: [{ value: 'ask', name: 'Ask' }, { value: 'bypass', name: 'Bypass' }] },
  { configId: 'model', name: 'Model', type: 'select', currentValue: scenario.startsWith('summary-') ? 'large' : 'small', options: [{ value: 'small', name: 'Small' }, { value: 'large', name: 'Large' }] },
];

if (scenario === 'blocked-setup') {
  process.stdin.once('end', () => {
    clearTimeout(blockedSetupTimer);
    blockedSetupTimer = null;
  });
}

function previousStarts() {
  if (!tracePath || !existsSync(tracePath)) return 0;
  return readFileSync(tracePath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((entry) => entry.kind === 'process_start')
    .length;
}

const processOrdinal = previousStarts() + 1;

function trace(kind, value = {}) {
  if (!tracePath) return;
  if (scenario === 'native-pipeline' && kind.startsWith('session_')) value = {};
  else if (value.params?.mcpServers) {
    value = { ...value, params: { ...value.params, mcpServers: value.params.mcpServers.map(({ type, name }) => ({ type, name })) } };
  }
  appendFileSync(tracePath, `${JSON.stringify({ kind, processOrdinal, ...value })}\n`);
}

function exitSoon(code) {
  setTimeout(() => process.exit(code), 5);
}

async function update(client, value) {
  trace('update', { update: value });
  await client.notify(CLIENT_METHODS.session_update, { sessionId, update: value });
}

async function waitForClaimBrowserMarker(timeoutMs = 30_000) {
  const marker = join(process.cwd(), '.claim-browser-follow-up-queued');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(marker)) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('Timed out waiting for browser follow-up marker');
}
async function waitForSmokeCompletionMarker(params, timeoutMs = 30_000) {
  const barrierDir = smokeBarrierDirectory;
  if (!barrierDir) {
    await new Promise((resolve) => setTimeout(resolve, 350));
    return;
  }
  const match = /SMOKE_NORMAL_(\d+)/u.exec(JSON.stringify(params));
  if (!match) throw new Error('Smoke prompt completion marker is missing');
  const marker = join(barrierDir, `claim-${match[1]}`);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(marker)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for smoke completion marker');
}

let reportingClient = null;
const reportingScenario = ['reporting-mcp', 'reporting-mcp-resume', 'reporting-runner', 'summary-report', 'summary-hang', 'summary-capture', 'summary-no-publish', 'native-pipeline'].includes(scenario);

async function connectReporting(mcpServers) {
  const descriptor = (mcpServers ?? []).find((server) => server.type === 'stdio' && server.name === 'fluent-flow-collaboration');
  if (!descriptor) throw new Error('Reporting MCP descriptor is missing');
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
  const transport = new StdioClientTransport({
    command: descriptor.command,
    args: descriptor.args ?? [],
    env: Object.fromEntries((descriptor.env ?? []).map((variable) => [variable.name, variable.value])),
    stderr: 'ignore',
  });
  const client = new Client({ name: 'fake-acp-agent', version: '2.4.0-test' });
  await client.connect(transport);
  reportingClient = client;
  const listed = await client.listTools();
  trace('reporting_connected', { pid: transport.pid, tools: listed.tools.map((tool) => tool.name) });
}

async function reportFile(params) {
  const match = /REPORT_FILE:([A-Za-z0-9._/-]+)/u.exec(JSON.stringify(params));
  if (!match || !reportingClient) throw new Error('Reporting file marker is missing');
  const result = await reportingClient.callTool({
    name: 'collaboration_add_artifact',
    arguments: { name: 'ACP reported file', kind: 'file', direction: 'output', reference: match[1] },
  });
  trace('reporting_result', { isError: result.isError === true, value: JSON.parse(result.content[0].text) });
}

function response() {
  return {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: scenario === 'missing-capability' ? {} : { session: {} },
    info: { name: 'fake-acp-agent', version: '2.4.0-test' },
  };
}

const app = agent()
  .onRequest(AGENT_METHODS.initialize, ({ params }) => {
    trace('initialize', { params });
    if (scenario === 'rolling-restart-budget') {
      exitSoon(31);
      return new Promise(() => {});
    }
    return response();
  })
  .onRequest(AGENT_METHODS.session_new, ({ params }) => {
    trace('session_new', { params });
    if (scenario === 'setup-restart' && processOrdinal === 1) {
      exitSoon(32);
      return new Promise(() => {});
    }
    if (scenario === 'blocked-setup') {
      blockedSetupTimer = setTimeout(() => process.exit(35), 200);
      return new Promise(() => {});
    }
    if (reportingScenario) return connectReporting(params.mcpServers).then(() => ({ sessionId, ...((scenario === 'reporting-runner' || scenario.startsWith('summary-')) && { configOptions: chatConfig }) }));
    return { sessionId, ...(['chat-policy', 'handoff-summary', 'pipeline-handoff'].includes(scenario) && { configOptions: chatConfig }) };
  })
  .onRequest(AGENT_METHODS.session_set_config_option, ({ params }) => {
    trace('set_config_option', { params });
    const option = chatConfig.find((item) => item.configId === params.configId);
    option.currentValue = params.value;
    return { configOptions: chatConfig };
  })
  .onRequest(AGENT_METHODS.session_prompt, ({ params, client }) => {
    promptCalls += 1;
    const messageId = `fake-user-message-${promptCalls}`;
    const promptOrdinal = promptCalls;
    trace('session_prompt', { params });
    if (scenario === 'ambiguous-prompt') {
      exitSoon(33);
      return new Promise(() => {});
    }
    if (scenario === 'smoke') {
      const cancellationMarked = JSON.stringify(params).includes('SMOKE_CANCELLATION_ACTIVE');
      setTimeout(async () => {
        await update(client, { sessionUpdate: 'state_update', state: 'running' });
        if (cancellationMarked) return;
        await waitForSmokeCompletionMarker(params);
        await update(client, {
          sessionUpdate: 'agent_message_chunk',
          messageId: `smoke-agent-message-${promptOrdinal}`,
          content: { type: 'text', text: 'Deterministic smoke completion.' },
        });
        await update(client, { sessionUpdate: 'state_update', state: 'idle', stopReason: 'end_turn' });
      }, 10);
      return { messageId };
    }
    if (scenario === 'request-key-recovery') {
      setTimeout(async () => {
        await update(client, { sessionUpdate: 'state_update', state: 'running' });
        const answer = await client.request(CLIENT_METHODS.session_request_permission, {
          sessionId,
          title: 'Before recovery',
          subject: { type: 'command', command: 'printf before', cwd: process.cwd() },
          options: [{ optionId: 'allow-before', name: 'Allow before', kind: 'allow_once' }],
        });
        trace('permission_answer', { title: 'Before recovery', answer });
        exitSoon(36);
      }, 10);
      return { messageId };
    }

    if (scenario === 'reporting-mcp' || scenario === 'reporting-runner') {
      setTimeout(async () => {
        await update(client, { sessionUpdate: 'state_update', state: 'running' });
        if (scenario === 'reporting-runner') {
          mkdirSync(join(process.cwd(), 'reports'), { recursive: true });
          writeFileSync(join(process.cwd(), 'reports/from-runner.txt'), 'runner durable artifact\n');
        }
        await reportFile(params);
        await update(client, {
          sessionUpdate: 'agent_message_chunk',
          messageId: 'reporting-agent-message-1',
          content: { type: 'text', text: 'Reported the file.' },
        });
        await update(client, { sessionUpdate: 'state_update', state: 'idle', stopReason: 'end_turn' });
      }, 10);
      return { messageId };
    }

    if (scenario === 'native-pipeline') {
      setTimeout(async () => {
        await update(client, { sessionUpdate: 'state_update', state: 'running' });
        const prompt = JSON.stringify(params);
        if (prompt.includes('deterministic verification author')) {
          const identity = /\.fluent-flow\/verify\/PR-(\d+)\/red-(\d+)\/manifest\.json/u.exec(prompt);
          if (!identity) throw new Error('Verification artifact identity is missing');
          const artifactRoot = join(process.cwd(), '.fluent-flow', 'verify', `PR-${identity[1]}`, `red-${identity[2]}`);
          mkdirSync(artifactRoot, { recursive: true });
          mkdirSync(join(process.cwd(), 'test'), { recursive: true });
          writeFileSync(join(artifactRoot, 'spec.md'), 'The add function shall return the arithmetic sum of its operands.\n');
          writeFileSync(join(artifactRoot, 'manifest.json'), JSON.stringify({
            pr_number: Number(identity[1]),
            requirements: [{
              requirement: { id: 'REQ-1', form: 'ubiquitous', text: 'The add function shall return the arithmetic sum of its operands.', source_finding_id: 'F1' },
              tests: ['test/calculator-add.test.js'], framework: 'node',
            }],
          }));
          writeFileSync(join(process.cwd(), 'test', 'calculator-add.test.js'),
            "import test from 'node:test'; import assert from 'node:assert/strict'; import { add } from '../src/calculator.js';\ntest('add sums', () => assert.equal(add(2, 3), 5));\n");
          trace('verification_authored', { claimId: Number(identity[2]), prNumber: Number(identity[1]) });
        } else if (prompt.includes('You are a code review agent for')) {
          const published = await reportingClient.callTool({ name: 'collaboration_report_review', arguments: {
            status: 'FAIL', blocking: [{ file: 'src/calculator.js', line: 1, issue: 'add subtracts instead of adding' }], advisory: [],
          } });
          if (published.isError) throw new Error('Native review publication failed');
          const { marker } = JSON.parse(published.content[0].text);
          trace('review_marker', { marker });
          await update(client, { sessionUpdate: 'agent_message_chunk', messageId: 'native-review',
            content: { type: 'text', text: `<!-- reviewer-result: ${JSON.stringify(marker)} -->` } });
        } else if (prompt.includes('You are a fix agent for')) {
          const branch = /git push origin HEAD:(ff\/task-[0-9a-f-]+)/u.exec(prompt)?.[1];
          if (!branch) throw new Error('Fix output branch is missing');
          writeFileSync(join(process.cwd(), 'src', 'calculator.js'), 'export function add(a,b){ return a + b; }\n');
          execFileSync('git', ['add', 'src/calculator.js'], { cwd: process.cwd(), stdio: 'ignore' });
          execFileSync('git', ['-c', 'user.name=Pipeline Fixture', '-c', 'user.email=pipeline@example.test', '-c', 'core.hooksPath=/dev/null', 'commit', '-m', 'Correct arithmetic'], { cwd: process.cwd(), stdio: 'ignore' });
          execFileSync('git', ['push', 'origin', `HEAD:${branch}`], { cwd: process.cwd(), stdio: 'ignore' });
          trace('fix_push', { headSha: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: process.cwd(), encoding: 'utf8' }).trim() });
        } else {
          throw new Error('Unexpected native pipeline prompt');
        }
        await update(client, { sessionUpdate: 'state_update', state: 'idle', stopReason: 'end_turn' });
      }, 10);
      return { messageId };
    }

    if (scenario === 'pipeline-handoff') {
      setTimeout(async () => {
        await update(client, { sessionUpdate: 'state_update', state: 'running' });
        if (JSON.stringify(params).includes('Prepare a build handoff')) {
          await update(client, {
            sessionUpdate: 'agent_message_chunk',
            messageId: 'pipeline-handoff-digest',
            content: { type: 'text', text: JSON.stringify({
              goal: 'Ship the accepted pipeline design',
              decisions: ['Reuse the established runner fixtures'],
              acceptanceCriteria: ['The accepted design lands on the task branch'],
              openQuestions: [],
              filesTouched: ['accepted-design.md'],
            }) },
          });
          await update(client, { sessionUpdate: 'state_update', state: 'idle', stopReason: 'end_turn' });
          return;
        }
        writeFileSync(join(process.cwd(), 'accepted-design.md'), '# Accepted design\n\nShip the chat handoff pipeline.\n');
        execFileSync('git', ['add', 'accepted-design.md'], { cwd: process.cwd(), stdio: 'ignore' });
        execFileSync('git', ['-c', 'user.name=Pipeline Fixture', '-c', 'user.email=pipeline@example.test', '-c', 'core.hooksPath=/dev/null', 'commit', '-m', 'Accept design'], { cwd: process.cwd(), stdio: 'ignore' });
        execFileSync('git', ['push', 'origin', 'HEAD'], { cwd: process.cwd(), stdio: 'ignore' });
        const branch = execFileSync('git', ['branch', '--show-current'], { cwd: process.cwd(), encoding: 'utf8' }).trim();
        const headSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: process.cwd(), encoding: 'utf8' }).trim();
        trace('pipeline_push', { branch, headSha });
        await update(client, {
          sessionUpdate: 'agent_message_chunk',
          messageId: 'pipeline-design-message',
          content: { type: 'text', text: 'Accepted design committed and pushed.' },
        });
        await update(client, { sessionUpdate: 'state_update', state: 'idle', stopReason: 'end_turn' });
      }, 10);
      return { messageId };
    }

    if (scenario === 'summary-report' || scenario === 'summary-capture' || scenario === 'summary-no-publish') {
      setTimeout(async () => {
        await update(client, { sessionUpdate: 'state_update', state: 'running' });
        if (scenario !== 'summary-no-publish') {
          const task = await reportingClient.callTool({ name: 'collaboration_get_task', arguments: {} });
          const value = JSON.parse(task.content[0].text);
          trace('summary_task', { reportingRole: value.reportingRole ?? null, selectedModel: chatConfig[1].currentValue, hasWorkspace: Object.hasOwn(value, 'workspace'), summaryKeys: value.summary ? Object.keys(value.summary).sort() : [] });
          if (scenario === 'summary-capture') {
            writeFileSync(join(process.cwd(), 'scratch.txt'), 'scratch bytes\n');
            const capture = await reportingClient.callTool({ name: 'collaboration_add_artifact', arguments: { name: 'Scratch capture', kind: 'file', direction: 'output', reference: 'scratch.txt' } });
            trace('summary_capture', { isError: capture.isError === true, code: capture.isError === true ? JSON.parse(capture.content[0].text)?.error?.code ?? null : null });
            const workspace = await reportingClient.callTool({ name: 'collaboration_report_workspace', arguments: {} });
            trace('summary_workspace_report', { isError: workspace.isError === true });
            const progress = await reportingClient.callTool({ name: 'collaboration_report_progress', arguments: { text: 'Summarizing.', percent: 40 } });
            trace('summary_progress', { isError: progress.isError === true });
          }
          const published = await reportingClient.callTool({
            name: 'collaboration_report_summary',
            arguments: { body: 'Deterministic summary body.', model: 'forged-model', sourceEpoch: 'forged-epoch', sourceSeq: '42' },
          });
          trace('summary_publication', { isError: published.isError === true, code: published.isError === true ? JSON.parse(published.content[0].text)?.error?.code ?? null : null });
        }
        await update(client, {
          sessionUpdate: 'agent_message_chunk',
          messageId: 'summary-agent-message-1',
          content: { type: 'text', text: 'Summary turn finished.' },
        });
        await update(client, { sessionUpdate: 'state_update', state: 'idle', stopReason: 'end_turn' });
      }, 10);
      return { messageId };
    }

    if (scenario === 'summary-hang') {
      setTimeout(async () => {
        await update(client, { sessionUpdate: 'state_update', state: 'running' });
      }, 10);
      return { messageId };
    }

    if (scenario === 'accepted-loss-resume-running'
      || scenario === 'accepted-loss-resume-idle'
      || scenario === 'accepted-loss-resume-before-response'
      || scenario === 'failed-resume'
      || scenario === 'reporting-mcp-resume') {
      exitSoon(34);
      return { messageId };
    }

    setTimeout(async () => {
      if (scenario === 'chat-policy' && argument('--drift') === 'yes') {
        chatConfig[0].currentValue = 'bypass';
        await update(client, { sessionUpdate: 'config_option_update', configOptions: chatConfig });
      }
      await update(client, { sessionUpdate: 'state_update', state: 'running' });
      if (scenario === 'silence') silenceTurnRunning = true;
      if (scenario === 'claim-browser-uat') {
        if (promptOrdinal === 1) {
          await update(client, {
            sessionUpdate: 'agent_message_chunk',
            messageId: 'uat-agent-message-1',
            content: { type: 'text', text: 'Deterministic claim execution started.' },
          });
          await update(client, {
            sessionUpdate: 'tool_call_update',
            toolCallId: 'uat-tool-1',
            name: 'inspect',
            title: 'Inspect deterministic fixture',
            kind: 'read',
            status: 'in_progress',
          });
          await update(client, {
            sessionUpdate: 'plan_update',
            plan: {
              type: 'items',
              planId: 'uat-plan-1',
              entries: [
                { content: 'Inspect deterministic fixture', priority: 'high', status: 'completed' },
                { content: 'Wait for operator approval', priority: 'high', status: 'in_progress' },
              ],
            },
          });
          await update(client, {
            sessionUpdate: 'tool_call_update',
            toolCallId: 'uat-tool-1',
            status: 'completed',
          });
          await update(client, { sessionUpdate: 'state_update', state: 'requires_action' });
          const answer = await client.request(CLIENT_METHODS.session_request_permission, {
            sessionId,
            title: 'Allow deterministic UAT action?',
            description: 'Approve the disposable browser fixture action.',
            subject: { type: 'command', command: 'printf browser-uat', cwd: process.cwd() },
            options: [
              { optionId: 'allow-uat', name: 'Allow once', kind: 'allow_once' },
              { optionId: 'deny-uat', name: 'Deny', kind: 'reject_once' },
            ],
          });
          trace('permission_answer', { answer });
          await update(client, { sessionUpdate: 'state_update', state: 'running' });
          await update(client, {
            sessionUpdate: 'agent_message_chunk',
            messageId: 'uat-agent-message-1',
            content: { type: 'text', text: ' Permission accepted.' },
          });
          await update(client, { sessionUpdate: 'state_update', state: 'requires_action' });
          const elicitation = await client.request(CLIENT_METHODS.elicitation_create, {
            sessionId,
            mode: 'form',
            message: 'Choose a deterministic value.',
            requestedSchema: {
              type: 'object',
              properties: { choice: { type: 'string', title: 'Choice' } },
              required: ['choice'],
            },
          });
          trace('elicitation_answer', { answer: elicitation });
          await update(client, { sessionUpdate: 'state_update', state: 'running' });
          await waitForClaimBrowserMarker();
          await update(client, { sessionUpdate: 'state_update', state: 'idle', stopReason: 'end_turn' });
          return;
        }
        await update(client, {
          sessionUpdate: 'agent_message_chunk',
          messageId: 'uat-agent-message-2',
          content: { type: 'text', text: 'Follow-up ACP turn is running.' },
        });
        return;
      }
      if (scenario === 'permission' || (scenario === 'chat-policy' && argument('--permission') === 'yes')) {
        await update(client, { sessionUpdate: 'state_update', state: 'requires_action' });
        const answer = await client.request(CLIENT_METHODS.session_request_permission, {
          sessionId,
          title: 'Allow deterministic write?',
          description: 'The fixture needs a permission decision.',
          subject: { type: 'command', command: 'printf deterministic', cwd: process.cwd() },
          options: [
            { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
            { optionId: 'deny-once', name: 'Deny', kind: 'reject_once' },
          ],
        });
        trace('permission_answer', { answer });
        await update(client, { sessionUpdate: 'state_update', state: 'running' });
      }
      if (scenario === 'elicitation' || (scenario === 'chat-policy' && argument('--elicitation') === 'yes')) {
        await update(client, { sessionUpdate: 'state_update', state: 'requires_action' });
        const answer = await client.request(CLIENT_METHODS.elicitation_create, {
          sessionId,
          mode: 'form',
          message: 'Choose a deterministic value.',
          requestedSchema: {
            type: 'object',
            properties: { choice: { type: 'string', title: 'Choice' } },
            required: ['choice'],
          },
        });
        trace('elicitation_answer', { answer });
        await update(client, { sessionUpdate: 'state_update', state: 'running' });
      }
      if (scenario === 'long-running' || scenario === 'close-hung' || scenario === 'silence'
        || (scenario === 'chat-policy' && JSON.stringify(params).includes('HOLD_CHAT_RESPONSE'))) return;
      await update(client, {
        sessionUpdate: 'agent_message_chunk',
        messageId: argument('--distinct-turns') === 'yes' ? `fake-agent-message-${promptOrdinal}` : 'fake-agent-message-1',
        content: { type: 'text', text: scenario === 'handoff-summary' ? JSON.stringify({
          goal: 'Build the agreed feature', decisions: ['Reuse existing code'], acceptanceCriteria: ['Feature works'],
          openQuestions: [], filesTouched: ['design.md'],
        }) : 'Deterministic ACP response.' },
      });
      await update(client, { sessionUpdate: 'state_update', state: 'idle', stopReason: 'end_turn' });
    }, Number(argument('--turn-start-delay-ms', '10')));
    return { messageId };
  })
  .onRequest(AGENT_METHODS.session_resume, async ({ params, client }) => {
    trace('session_resume', { params });
    if (scenario === 'failed-resume') throw new Error('fixture resume failure');
    if (scenario === 'reporting-mcp-resume') {
      await connectReporting(params.mcpServers);
      await update(client, { sessionUpdate: 'state_update', state: 'running' });
      const prompt = readFileSync(tracePath, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
        .find((entry) => entry.kind === 'session_prompt');
      setTimeout(async () => {
        await reportFile(prompt.params);
        await update(client, {
          sessionUpdate: 'agent_message_chunk',
          messageId: 'reporting-agent-message-resumed',
          content: { type: 'text', text: 'Reported the file after resume.' },
        });
        await update(client, { sessionUpdate: 'state_update', state: 'idle', stopReason: 'end_turn' });
      }, 10);
      return {};
    }
    if (scenario === 'accepted-loss-resume-idle') {
      await update(client, { sessionUpdate: 'state_update', state: 'idle', stopReason: 'end_turn' });
      return {};
    }
    if (scenario === 'accepted-loss-resume-before-response') {
      await update(client, { sessionUpdate: 'state_update', state: 'running' });
      await update(client, { sessionUpdate: 'state_update', state: 'idle', stopReason: 'end_turn' });
      return {};
    }
    if (scenario === 'request-key-recovery') {
      await update(client, { sessionUpdate: 'state_update', state: 'running' });
      setTimeout(async () => {
        const answer = await client.request(CLIENT_METHODS.session_request_permission, {
          sessionId,
          title: 'After recovery',
          subject: { type: 'command', command: 'printf after', cwd: process.cwd() },
          options: [{ optionId: 'allow-after', name: 'Allow after', kind: 'allow_once' }],
        });
        trace('permission_answer', { title: 'After recovery', answer });
        await update(client, { sessionUpdate: 'state_update', state: 'running' });
        await update(client, { sessionUpdate: 'state_update', state: 'idle', stopReason: 'end_turn' });
      }, 10);
      return {};
    }
    await update(client, { sessionUpdate: 'state_update', state: 'running' });
    setTimeout(async () => {
      await update(client, {
        sessionUpdate: 'agent_message_chunk',
        messageId: 'fake-agent-message-resumed',
        content: { type: 'text', text: 'Resumed without replay.' },
      });
      await update(client, { sessionUpdate: 'state_update', state: 'idle', stopReason: 'end_turn' });
    }, 10);
    return {};
  })
  .onRequest(AGENT_METHODS.session_close, async ({ params }) => {
    trace('session_close', { params });
    if (reportingClient) await reportingClient.close();
    if (scenario === 'close-hung') {
      setInterval(() => {}, 60_000);
    } else {
      exitSoon(0);
    }
    return {};
  })
  .onNotification(AGENT_METHODS.session_cancel, async ({ params, client }) => {
    trace('session_cancel', { params });
    await update(client, { sessionUpdate: 'state_update', state: 'idle', stopReason: 'cancelled' });
  });

if (scenario !== 'missing-list') {
  app.onRequest(AGENT_METHODS.session_list, async ({ params, client }) => {
    listCalls += 1;
    trace('session_list', { params, listCalls });
    if (scenario === 'silence' && silenceTurnRunning) {
      silenceTurnRunning = false;
      await update(client, {
        sessionUpdate: 'agent_message_chunk',
        messageId: 'after-liveness',
        content: { type: 'text', text: 'Still responsive.' },
      });
      await update(client, { sessionUpdate: 'state_update', state: 'idle', stopReason: 'end_turn' });
    }
    return { sessions: [{ sessionId, cwd: params.cwd ?? process.cwd() }] };
  });
}

trace('process_start', { scenario, githubCredentialPresent: Boolean(process.env.GH_TOKEN || process.env.GITHUB_TOKEN || process.env.GIT_CONFIG_VALUE_0?.includes('Authorization')) });
const stream = ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin));
const connection = app.connect(stream);
await connection.closed;
trace('connection_closed');
