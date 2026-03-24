import { query, audit } from '../db/client.js';
import { resolveConfig } from '../config/loader.js';
import { executeTransition, getCurrentState } from './state-machine.js';
import { postComment, addLabel, removeLabel } from '../github/rest.js';
import { notifyPause, notifyResume } from '../notifications/dispatcher.js';
import logger from '../logger.js';

const NEEDS_HUMAN_LABEL = 'needs-human';

/**
 * Build a checklist markdown for a pause comment.
 * @param {string} reason
 * @param {string} [context]
 * @returns {{ markdown: string, checklist: object[] }}
 */
function buildPauseChecklist(reason, context) {
  const items = [];

  switch (reason) {
    case 'decision':
      items.push(
        { text: 'Review the decision options', done: false },
        { text: 'Document the chosen approach', done: false },
        { text: 'Reply `/resume` to continue', done: false }
      );
      break;
    case 'ui-review':
      items.push(
        { text: 'Review the UI changes', done: false },
        { text: 'Test on mobile and desktop', done: false },
        { text: 'Reply `/resume` when approved', done: false }
      );
      break;
    case 'external-action':
      items.push(
        { text: 'Complete the external action required', done: false },
        { text: 'Reply `/resume` when done', done: false }
      );
      break;
    case 'agent-stuck':
      items.push(
        { text: 'Review the agent\'s last output above', done: false },
        { text: 'Provide guidance or clarification', done: false },
        { text: 'Reply `/resume` with instructions, e.g. `/resume Try approach X`', done: false }
      );
      break;
    case 'review-escalation':
      items.push(
        { text: 'Review the automated review failures (see above)', done: false },
        { text: 'Fix blocking issues or override if necessary', done: false },
        { text: 'Reply `/resume` or `/resume to:review` to re-run review', done: false }
      );
      break;
    default:
      items.push(
        { text: 'Address the issue requiring human attention', done: false },
        { text: 'Reply `/resume` when ready to continue', done: false }
      );
  }

  const markdown = items.map((item) => `- [ ] ${item.text}`).join('\n');
  return { markdown, checklist: items };
}

/**
 * Record a pause and perform all side effects:
 * - Insert into pauses table
 * - Add needs-human label
 * - Post checklist comment
 * - Notify agent via OpenClaw
 *
 * @param {object} opts
 * @param {string} opts.owner
 * @param {string} opts.repo
 * @param {number} opts.issueNumber
 * @param {number} [opts.prNumber]
 * @param {string} opts.reason - One of the configured pause reasons
 * @param {string} [opts.context] - Human-readable context about why paused
 * @param {string} [opts.actor] - Who triggered the pause
 * @returns {Promise<object>} The created pause record
 */
export async function recordPause({ owner, repo, issueNumber, prNumber, reason, context, actor, agentId }) {
  const repoKey = `${owner}/${repo}`;
  const config = await resolveConfig(owner, repo);
  const resolvedAgent = agentId ?? config.default_agent ?? config.agent_id ?? null;
  const previousState = await getCurrentState(repoKey, issueNumber);

  const { markdown, checklist } = buildPauseChecklist(reason, context);

  // Insert pause record
  const result = await query(
    `INSERT INTO pauses
       (repo, issue_number, pr_number, previous_state, reason, context, checklist, agent_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING *`,
    [
      repoKey,
      issueNumber,
      prNumber ?? null,
      previousState,
      reason,
      context ?? null,
      JSON.stringify(checklist),
      resolvedAgent,
    ]
  );
  const pause = result.rows[0];

  // Transition to Awaiting Human if not already there
  if (previousState !== 'Awaiting Human') {
    try {
      await executeTransition({
        owner,
        repo,
        issueNumber,
        toState: 'Awaiting Human',
        triggerType: 'pause',
        triggerDetail: reason,
        actor,
        skipProjectUpdate: false,
      });
    } catch (err) {
      logger.warn({ msg: 'Could not transition to Awaiting Human during pause', error: err.message, repo: repoKey, issueNumber });
    }
  }

  // Add needs-human label
  try {
    await addLabel(owner, repo, issueNumber, NEEDS_HUMAN_LABEL);
  } catch (err) {
    logger.warn({ msg: 'Failed to add needs-human label', error: err.message });
  }

  // Post checklist comment
  const contextLine = context ? `\n\n**Context:** ${context}` : '';
  const commentBody = `## ⏸ Paused — Human Action Required

**Reason:** \`${reason}\`${contextLine}

### Checklist

${markdown}

---
*Reply \`/resume\` to continue, or \`/resume to:review\` / \`/resume to:progress\` to specify the target state.*
*This pause was triggered by: ${actor ?? 'system'}*

<!-- pause-id: ${pause.id} -->`;

  try {
    await postComment(owner, repo, issueNumber, commentBody);
  } catch (err) {
    logger.error({ msg: 'Failed to post pause comment', error: err.message });
  }

  // Notify agent
  if (resolvedAgent) {
    await notifyPause({
      agentId: resolvedAgent,
      repo: repoKey,
      issueNumber,
      reason,
      context,
      delivery: config.delivery,
    });
  }

  logger.info({ msg: 'Issue paused', repo: repoKey, issueNumber, reason, previousState, pauseId: pause.id });
  audit('pause_created', { repo: repoKey, actor, data: { issueNumber, reason, previousState, pauseId: pause.id } });
  return pause;
}

/**
 * Parse a /resume command from a comment body.
 * Supports:
 *   /resume
 *   /resume some instructions
 *   /resume to:review
 *   /resume to:progress
 * @param {string} body
 * @returns {{ isResume: boolean, toState: string|null, instructions: string|null }}
 */
export function parseResumeCommand(body) {
  if (!body) return { isResume: false, toState: null, instructions: null };

  const trimmed = body.trim();
  if (!trimmed.toLowerCase().startsWith('/resume')) {
    return { isResume: false, toState: null, instructions: null };
  }

  const rest = trimmed.slice('/resume'.length).trim();

  // Check for to:state syntax
  const toMatch = rest.match(/^to:(review|progress|backlog|ready|in-progress|in-review|awaiting-human|done|cancelled)\b(.*)$/i);
  if (toMatch) {
    const stateAlias = toMatch[1].toLowerCase();
    const instructions = toMatch[2].trim() || null;
    const stateMap = {
      review: 'In Review',
      progress: 'In Progress',
      'in-progress': 'In Progress',
      'in-review': 'In Review',
      backlog: 'Backlog',
      ready: 'Ready',
      'awaiting-human': 'Awaiting Human',
      done: 'Done',
      cancelled: 'Cancelled',
    };
    return { isResume: true, toState: stateMap[stateAlias] ?? null, instructions };
  }

  // Plain /resume with optional instructions
  const instructions = rest || null;
  return { isResume: true, toState: null, instructions };
}

/**
 * Get the active (unresolved) pause for an issue.
 * @param {string} repoKey
 * @param {number} issueNumber
 * @returns {Promise<object|null>}
 */
export async function getActivePause(repoKey, issueNumber) {
  const result = await query(
    `SELECT * FROM pauses
     WHERE repo = $1 AND issue_number = $2 AND resumed_at IS NULL
     ORDER BY paused_at DESC
     LIMIT 1`,
    [repoKey, issueNumber]
  );
  return result.rows[0] ?? null;
}

/**
 * Process a resume event. Determines target state, updates DB, transitions state,
 * removes label, wakes agent.
 *
 * @param {object} opts
 * @param {string} opts.owner
 * @param {string} opts.repo
 * @param {number} opts.issueNumber
 * @param {string} [opts.toState] - Explicit target state (overrides previous_state)
 * @param {string} [opts.instructions] - Instructions to pass to agent
 * @param {string} [opts.resumedBy] - Who triggered the resume
 * @returns {Promise<{ pause: object, targetState: string }>}
 */
export async function processResume({ owner, repo, issueNumber, toState, instructions, resumedBy, agentId }) {
  const repoKey = `${owner}/${repo}`;
  const config = await resolveConfig(owner, repo);
  const resolvedAgent = agentId ?? config.default_agent ?? config.agent_id ?? null;

  const pause = await getActivePause(repoKey, issueNumber);
  if (!pause) {
    const err = new Error(`No active pause found for ${repoKey}#${issueNumber}`);
    err.code = 'NO_ACTIVE_PAUSE';
    throw err;
  }

  // Determine target state
  const targetState = toState ?? pause.previous_state ?? 'In Progress';

  // Update pause record
  await query(
    `UPDATE pauses SET
       resumed_at = NOW(),
       resumed_by = $1,
       resume_instructions = $2,
       resume_to_state = $3
     WHERE id = $4`,
    [resumedBy ?? null, instructions ?? null, targetState, pause.id]
  );

  // Execute state transition
  try {
    await executeTransition({
      owner,
      repo,
      issueNumber,
      toState: targetState,
      triggerType: 'resume',
      triggerDetail: `Resumed by ${resumedBy ?? 'unknown'}`,
      actor: resumedBy,
      metadata: { pauseId: pause.id, instructions },
    });
  } catch (err) {
    logger.error({ msg: 'Failed to transition on resume', error: err.message, targetState });
    // Don't block resume even if transition fails
  }

  // Remove needs-human label
  try {
    await removeLabel(owner, repo, issueNumber, NEEDS_HUMAN_LABEL);
  } catch (err) {
    logger.warn({ msg: 'Failed to remove needs-human label', error: err.message });
  }

  // Post resume comment
  const instructionsLine = instructions ? `\n\n**Instructions for agent:** ${instructions}` : '';
  try {
    await postComment(owner, repo, issueNumber,
      `## ▶️ Resumed

**Target state:** \`${targetState}\`${instructionsLine}

*Resumed by @${resumedBy ?? 'system'}*`
    );
  } catch (err) {
    logger.error({ msg: 'Failed to post resume comment', error: err.message });
  }

  // Wake agent
  if (resolvedAgent) {
    await notifyResume({
      agentId: resolvedAgent,
      repo: repoKey,
      issueNumber,
      resumeInstructions: instructions,
      targetState,
      delivery: config.delivery,
    });
  }

  logger.info({ msg: 'Issue resumed', repo: repoKey, issueNumber, targetState, resumedBy, pauseId: pause.id });
  audit('pause_resumed', { repo: repoKey, actor: resumedBy, data: { issueNumber, targetState, pauseId: pause.id } });
  return { pause, targetState };
}
