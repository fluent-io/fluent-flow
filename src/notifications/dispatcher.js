/**
 * Agent-agnostic notification dispatcher.
 * Routes notifications to the correct agent via the configured transport.
 */
import { getAgentConfig } from '../config/agents.js';
import { getTransport } from './transports/index.js';
import { audit } from '../db/client.js';
import { getActivePause } from '../engine/pause-manager.js';
import { getLinkedPR, getPR } from '../github/rest.js';

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
 * Resolve agent for an issue using all available data sources.
 * Resolution: active pause agent_id → linked PR body marker → config default.
 * @param {string} owner
 * @param {string} repo
 * @param {number} issueNumber
 * @param {object} config
 * @returns {Promise<string|null>}
 */
export async function resolveAgentForIssue(owner, repo, issueNumber, config) {
  const repoKey = `${owner}/${repo}`;

  // 1. Check active pause — cheapest (DB query), most common case
  const pause = await getActivePause(repoKey, issueNumber);
  if (pause?.agent_id) {
    return pause.agent_id;
  }

  // 2. Check linked PR body marker
  const linkedPrNumber = await getLinkedPR(owner, repo, issueNumber);
  if (linkedPrNumber) {
    try {
      const pr = await getPR(owner, repo, linkedPrNumber);
      const fromBody = resolveAgentId({ prBody: pr?.body, config });
      if (fromBody) return fromBody;
    } catch (err) {
      console.warn({ msg: 'Failed to resolve agent from linked PR', error: err.message, repo: repoKey, issueNumber });
    }
  }

  // 3. Config fallback
  return config.default_agent ?? config.agent_id ?? null;
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
 * Format review issues into a rich message string for the agent prompt.
 * @param {object} opts
 * @param {string} opts.repo
 * @param {number} opts.prNumber
 * @param {number} opts.attempt
 * @param {Array} [opts.blocking]
 * @param {Array} [opts.advisory]
 * @returns {string}
 */
export function formatRichMessage({ repo, prNumber, attempt, blocking = [], advisory = [] }) {
  const summary = `Review FAILED: ${repo}#${prNumber} (attempt ${attempt}) — ${blocking.length} blocking issue(s)`;

  if (blocking.length === 0 && advisory.length === 0) return summary;

  const lines = [summary, ''];

  if (blocking.length > 0) {
    lines.push('Fix the following blocking issues and push your changes:', '');
    for (const b of blocking) {
      lines.push(`- ${b.file}:${b.line} — ${b.issue}`);
      if (b.fix) lines.push(`  > Fix: ${b.fix}`);
    }
  }

  if (advisory.length > 0) {
    if (blocking.length > 0) lines.push('');
    lines.push('Advisory (non-blocking):', '');
    for (const a of advisory) {
      lines.push(`- ${a.file}:${a.line} — ${a.issue}`);
      if (a.suggestion) lines.push(`  > Suggestion: ${a.suggestion}`);
    }
  }

  return lines.join('\n');
}

/**
 * Notify an agent that a review failed.
 */
export async function notifyReviewFailure({ agentId, repo, prNumber, attempt, issues, onFailure, delivery = {} }) {
  const blocking = issues?.filter(i => i.severity === 'blocking') ?? [];
  const advisory = issues?.filter(i => i.severity === 'advisory') ?? [];
  const message = formatRichMessage({ repo, prNumber, attempt, blocking, advisory });
  await dispatch({
    agentId,
    event: 'review_failed',
    payload: {
      message, wakeMode: 'now', deliver: true,
      repo, prNumber, attempt, issues,
      ...(onFailure?.model && { model: onFailure.model }),
      ...(onFailure?.thinking && { thinking: onFailure.thinking }),
      ...delivery,
    },
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
