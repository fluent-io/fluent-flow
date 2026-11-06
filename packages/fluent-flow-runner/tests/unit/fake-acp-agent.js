import { createInterface } from 'node:readline';

const sessionId = 'fake-session-1';
let updateSequence = 0;

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function result(id, value) {
  send({ jsonrpc: '2.0', id, result: value });
}

function update(value) {
  updateSequence += 1;
  send({
    jsonrpc: '2.0',
    method: 'session/update',
    params: { sessionId, update: { ...value, _meta: { fixtureSequence: updateSequence } } },
  });
}

function handle(message) {
  if (message.method === 'initialize') {
    result(message.id, {
      protocolVersion: 2,
      capabilities: { session: {} },
      info: { name: 'fake-acp-agent', version: '1.0.0' },
    });
    return;
  }
  if (message.method === 'session/new') {
    result(message.id, { sessionId });
    return;
  }
  if (message.method === 'session/list') {
    result(message.id, { sessions: [{ sessionId, cwd: message.params?.cwd ?? process.cwd() }] });
    return;
  }
  if (message.method === 'session/resume') {
    update({ sessionUpdate: 'state_update', state: 'idle', stopReason: 'end_turn' });
    result(message.id, {});
    return;
  }
  if (message.method === 'session/prompt') {
    result(message.id, { messageId: 'fake-message-1' });
    update({
      sessionUpdate: 'agent_message_chunk',
      messageId: 'fake-agent-message-1',
      content: { type: 'text', text: 'Deterministic ACP response.' },
    });
    update({ sessionUpdate: 'state_update', state: 'idle', stopReason: 'end_turn' });
    return;
  }
  if (message.method === 'session/cancel') {
    update({ sessionUpdate: 'state_update', state: 'idle', stopReason: 'cancelled' });
    return;
  }
  if (message.method === 'session/close') {
    result(message.id, {});
    return;
  }
  if (message.id !== undefined) {
    send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } });
  }
}

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on('line', (line) => {
  if (line.trim() === '') return;
  try {
    handle(JSON.parse(line));
  } catch {
    send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
  }
});
