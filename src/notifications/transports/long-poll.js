/**
 * Long-poll transport — queues payloads for runner sessions to pick up.
 */
import logger from '../../logger.js';

const MAX_QUEUE_SIZE = 100;

/** @type {Map<number, Array<object>>} session_id → queued payloads */
const queue = new Map();

/**
 * Enqueue a payload for a session.
 * @param {number} sessionId
 * @param {object} payload
 */
export function enqueue(sessionId, payload) {
  if (!queue.has(sessionId)) queue.set(sessionId, []);
  const items = queue.get(sessionId);
  if (items.length >= MAX_QUEUE_SIZE) {
    items.shift(); // drop oldest
  }
  items.push(payload);
}

/**
 * Dequeue the next payload for a session.
 * @param {number} sessionId
 * @returns {object|null}
 */
export function dequeue(sessionId) {
  const items = queue.get(sessionId);
  if (!items || items.length === 0) return null;
  const payload = items.shift();
  if (items.length === 0) queue.delete(sessionId);
  return payload;
}

/**
 * Check if a session has pending work.
 * @param {number} sessionId
 * @returns {boolean}
 */
export function hasPending(sessionId) {
  return (queue.get(sessionId)?.length ?? 0) > 0;
}

/**
 * Clear the queue (for testing).
 */
export function clearQueue() {
  queue.clear();
}

/**
 * Transport send — enqueues payload for the target session.
 * @param {object} agentConfig
 * @param {object} payload - must include session_id
 */
export async function send(agentConfig, payload) {
  const sessionId = payload.session_id;
  if (!sessionId) {
    logger.warn({ msg: 'Long-poll transport: no session_id in payload', agentId: payload.agentId });
    return;
  }
  enqueue(sessionId, payload);
  logger.info({ msg: 'Work enqueued for runner session', agentId: payload.agentId, sessionId });
}
