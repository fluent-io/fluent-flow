/**
 * Transport registry — maps transport names to their send functions.
 */
import * as webhook from './webhook.js';
import * as workflow from './workflow.js';
import * as longPoll from './long-poll.js';

const registry = new Map([
  ['webhook', webhook],
  ['workflow_dispatch', workflow],
  ['long_poll', longPoll],
]);

/**
 * Get a transport module by name.
 * @param {string} name - Transport name (webhook, workflow_dispatch)
 * @returns {{ send: Function }|null}
 */
export function getTransport(name) {
  return registry.get(name) ?? null;
}
