
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { PassThrough, Writable } from 'node:stream';

/**
 * @param {{ model?: string, onInterrupt?: (fake: any) => object }} [opts]
 */
export function createFakeClaudeChild({ model = 'fixture-model', onInterrupt } = {}) {
  const writes = [];
  /** @type {Set<string>} prompts that started and have no result yet */
  const active = new Set();
  const child = /** @type {any} */ (new EventEmitter());
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exitCode = null;
  child.signalCode = null;
  child.pid = 1;
  child.kill = () => {
    throw new Error('the fake child is never signalled');
  };
  const emit = (obj) => child.stdout.write(`${JSON.stringify(obj)}\n`);
  const stop = () => {
    if (child.exitCode !== null) return;
    child.exitCode = 0;
    child.stdout.end();
    child.emit('exit', 0, null);
  };
  const fake = {
    child,
    writes,
    active,
    emit,
    stop,
    result(uuids, { isError = false, subtype = 'success', terminalReason = 'completed' } = {}) {
      for (const id of uuids) active.delete(id);
      emit({ type: 'result', subtype, is_error: isError, terminal_reason: terminalReason, uuid: randomUUID(), user_message_uuids: uuids, modelUsage: {} });
    },
    userWrites: () => writes.filter((m) => m.type === 'user'),
    controlResponses: () => writes.filter((m) => m.type === 'control_response'),
  };
  child.stdin = new Writable({
    write(chunk, _enc, cb) {
      for (const line of String(chunk).split('\n').filter(Boolean)) {
        const msg = JSON.parse(line);
        writes.push(msg);
        if (msg.type === 'control_request') {
          let response;
          switch (msg.request.subtype) {
            case 'initialize':
              response = { current_permission_mode: 'default', account: { apiProvider: 'firstParty', subscriptionType: 'Claude Max' } };
              break;
            case 'mcp_status':
              response = { mcpServers: [{ name: 'ff_reporting', status: 'connected' }] };
              break;
            case 'get_settings':
              response = { applied: { model } };
              break;
            case 'interrupt':
              response = onInterrupt ? onInterrupt(fake) : { still_queued: [], cancelled: [] };
              break;
            default:
              throw new Error(`unexpected control request ${msg.request.subtype}`);
          }
          emit({ type: 'control_response', response: { subtype: 'success', request_id: msg.request_id, response } });
        } else if (msg.type === 'user') {
          active.add(msg.uuid);
          emit({ type: 'command_lifecycle', command_uuid: msg.uuid, uuid: randomUUID(), state: 'started' });
          emit({ ...msg, isReplay: true });
        }
      }
      cb();
    },
    final(cb) {
      stop();
      cb();
    },
  });
  return fake;
}
