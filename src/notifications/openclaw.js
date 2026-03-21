/**
 * OpenClaw webhook client for waking agents.
 */

const OPENCLAW_WEBHOOK_URL = process.env.OPENCLAW_WEBHOOK_URL;
const OPENCLAW_WEBHOOK_TOKEN = process.env.OPENCLAW_WEBHOOK_TOKEN;

/**
 * Wake an agent via OpenClaw webhook.
 * @param {Object} opts
 * @param {string} opts.agentId - Agent identifier
 * @param {string} opts.text - Message text
 * @param {string} [opts.wakeMode='now'] - Wake mode
 * @param {boolean} [opts.deliver=true] - Whether to deliver
 * @param {Object} [opts.delivery={}] - Delivery target (channel + to)
 */
export async function wakeAgent({ agentId, text, wakeMode = 'now', deliver = true, delivery = {} }) {
  if (!OPENCLAW_WEBHOOK_URL) {
    console.warn({ msg: 'OPENCLAW_WEBHOOK_URL not set — skipping agent wake', agentId });
    return;
  }

  const payload = {
    agentId,
    message: text,
    wakeMode,
    deliver,
    ...(delivery.channel && { channel: delivery.channel }),
    ...(delivery.to && { to: delivery.to }),
  };

  const headers = { 'Content-Type': 'application/json' };
  if (OPENCLAW_WEBHOOK_TOKEN) {
    headers['Authorization'] = `Bearer ${OPENCLAW_WEBHOOK_TOKEN}`;
  }

  try {
    const response = await fetch(OPENCLAW_WEBHOOK_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      console.error({
        msg: 'OpenClaw webhook failed',
        status: response.status,
        agentId,
        body,
      });
    } else {
      console.log({ msg: 'Agent woken via OpenClaw', agentId, wakeMode });
    }
  } catch (err) {
    console.error({ msg: 'OpenClaw webhook error', agentId, error: err.message });
  }
}

/**
 * Notify an agent that a pause occurred.
 */
export async function notifyPause({ agentId, repo, issueNumber, reason, context, delivery = {} }) {
  const text = `Paused: ${repo}#${issueNumber} — Reason: ${reason}${context ? ` — ${context}` : ''}`;
  await wakeAgent({ agentId, text, wakeMode: 'next', deliver: true, delivery });
}

/**
 * Notify an agent that a resume occurred.
 */
export async function notifyResume({ agentId, repo, issueNumber, resumeInstructions, targetState, delivery = {} }) {
  const text = `Resumed: ${repo}#${issueNumber} → ${targetState}${resumeInstructions ? ` — ${resumeInstructions}` : ''}`;
  await wakeAgent({ agentId, text, wakeMode: 'now', deliver: true, delivery });
}

/**
 * Notify an agent about a review failure.
 */
export async function notifyReviewFailure({ agentId, repo, prNumber, attempt, issues, delivery = {} }) {
  const blockingCount = issues?.filter(i => i.severity === 'blocking').length ?? 0;
  const text = `Review FAILED: ${repo}#${prNumber} (attempt ${attempt}) — ${blockingCount} blocking issue(s)`;
  await wakeAgent({ agentId, text, wakeMode: 'now', deliver: true, delivery });
}
