/**
 * Agent-agnostic notification dispatcher.
 * Routes notifications to the correct agent via the configured transport.
 */
import { getAgentConfig } from '../config/agents.js';
import { getTransport } from './transports/index.js';
import { audit } from '../db/client.js';

/**
 * Extract agent ID from PR body marker.
 * @param {string} body - PR body text
 * @returns {string|null}
 */
export function extractAgentId(body) {
  if (!body) return null;
  const match = body.match(/<!--\s*fluent-flow-agent:\s*(\S+)\s*-->/);
  return match?.[1] ?? null;
}

/**
 * Resolve which agent should be notified.
 * Resolution order: PR body marker → config.default_agent → config.agent_id → null
 * @param {object} opts
 * @param {string} [opts.prBody] - PR body (may contain agent marker)
 * @param {object} opts.config - merged repo config
 * @returns {string|null}
 */
export function resolveAgentId({ prBody, config }) {
  return extractAgentId(prBody) ?? config.default_agent ?? config.agent_id ?? null;
}

/**
 * Dispatch a notification to an agent via its configured transport.
 * @param {object} opts
 * @param {string} opts.agentId - resolved agent ID
 * @param {string} opts.event - event type (review_failed, pr_merged, paused, resumed)
 * @param {object} opts.payload - structured payload for the transport
 */
export async function dispatch({ agentId, event, payload }) {
  if (!agentId) {
    console.warn({ msg: 'No agent ID — skipping notification', event });
    return;
  }

  const agentConfig = getAgentConfig(agentId);
  if (!agentConfig) {
    console.warn({ msg: 'Agent not found in registry — skipping notification', agentId, event });
    return;
  }

  const transport = getTransport(agentConfig.transport);
  if (!transport) {
    console.error({ msg: 'Unknown transport', transport: agentConfig.transport, agentId });
    return;
  }

  const fullPayload = {
    agentId,
    event,
    ...payload,
    ...(agentConfig.delivery?.channel && { channel: agentConfig.delivery.channel }),
    ...(agentConfig.delivery?.to && { to: agentConfig.delivery.to }),
  };

  await transport.send(agentConfig, fullPayload);
  audit('agent_woken', { data: { agentId, event } });
}

/**
 * Notify an agent that a review failed.
 */
export async function notifyReviewFailure({ agentId, repo, prNumber, attempt, issues, delivery = {} }) {
  const blockingCount = issues?.filter(i => i.severity === 'blocking').length ?? 0;
  const message = `Review FAILED: ${repo}#${prNumber} (attempt ${attempt}) — ${blockingCount} blocking issue(s)`;
  await dispatch({
    agentId,
    event: 'review_failed',
    payload: { message, wakeMode: 'now', deliver: true, repo, prNumber, attempt, issues, ...delivery },
  });
}

/**
 * Notify an agent that an issue was paused.
 */
export async function notifyPause({ agentId, repo, issueNumber, reason, context, delivery = {} }) {
  const message = `Paused: ${repo}#${issueNumber} — Reason: ${reason}${context ? ` — ${context}` : ''}`;
  await dispatch({
    agentId,
    event: 'paused',
    payload: { message, wakeMode: 'next-heartbeat', deliver: true, repo, issueNumber, reason, ...delivery },
  });
}

/**
 * Notify an agent that an issue was resumed.
 */
export async function notifyResume({ agentId, repo, issueNumber, resumeInstructions, targetState, delivery = {} }) {
  const message = `Resumed: ${repo}#${issueNumber} → ${targetState}${resumeInstructions ? ` — ${resumeInstructions}` : ''}`;
  await dispatch({
    agentId,
    event: 'resumed',
    payload: { message, wakeMode: 'now', deliver: true, repo, issueNumber, targetState, instructions: resumeInstructions, ...delivery },
  });
}

/**
 * Notify an agent that a PR was merged.
 */
export async function notifyPRMerged({ agentId, repo, prNumber, issueNumber, delivery = {} }) {
  const message = `PR merged: ${repo}#${prNumber} — issue #${issueNumber} is Done. Pick up the next issue.`;
  await dispatch({
    agentId,
    event: 'pr_merged',
    payload: { message, wakeMode: 'now', deliver: true, repo, prNumber, issueNumber, ...delivery },
  });
}
