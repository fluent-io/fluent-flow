import { appendFileSync, existsSync, readFileSync } from 'node:fs';
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
let blockedSetupTimer = null;
const chatConfig = [
  { configId: 'approval', name: 'Approval', type: 'select', currentValue: 'bypass', options: [{ value: 'ask', name: 'Ask' }, { value: 'bypass', name: 'Bypass' }] },
  { configId: 'model', name: 'Model', type: 'select', currentValue: 'small', options: [{ value: 'small', name: 'Small' }, { value: 'large', name: 'Large' }] },
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
    return { sessionId, ...(['chat-policy', 'handoff-summary'].includes(scenario) && { configOptions: chatConfig }) };
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

    if (scenario === 'accepted-loss-resume-running'
      || scenario === 'accepted-loss-resume-idle'
      || scenario === 'accepted-loss-resume-before-response'
      || scenario === 'failed-resume') {
      exitSoon(34);
      return { messageId };
    }

    setTimeout(async () => {
      if (scenario === 'chat-policy' && argument('--drift') === 'yes') {
        chatConfig[0].currentValue = 'bypass';
        await update(client, { sessionUpdate: 'config_option_update', configOptions: chatConfig });
      }
      await update(client, { sessionUpdate: 'state_update', state: 'running' });
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
    }, 10);
    return { messageId };
  })
  .onRequest(AGENT_METHODS.session_resume, async ({ params, client }) => {
    trace('session_resume', { params });
    if (scenario === 'failed-resume') throw new Error('fixture resume failure');
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
  .onRequest(AGENT_METHODS.session_close, ({ params }) => {
    trace('session_close', { params });
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
  app.onRequest(AGENT_METHODS.session_list, ({ params, client }) => {
    listCalls += 1;
    trace('session_list', { params, listCalls });
    if (scenario === 'silence' && listCalls === 2) {
      setTimeout(async () => {
        await update(client, {
          sessionUpdate: 'agent_message_chunk',
          messageId: 'after-liveness',
          content: { type: 'text', text: 'Still responsive.' },
        });
        await update(client, { sessionUpdate: 'state_update', state: 'idle', stopReason: 'end_turn' });
      }, 5);
    }
    return { sessions: [{ sessionId, cwd: params.cwd ?? process.cwd() }] };
  });
}

trace('process_start', { scenario, githubCredentialPresent: Boolean(process.env.GH_TOKEN || process.env.GITHUB_TOKEN || process.env.GIT_CONFIG_VALUE_0?.includes('Authorization')) });
const stream = ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin));
const connection = app.connect(stream);
await connection.closed;
trace('connection_closed');
