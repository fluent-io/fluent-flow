import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { db, schema } from '@fluent-flow/db';
import { audit } from '../db/client.js';

const { stateTransitions, projectItems } = schema;
import { resolveConfig, installationCtxForRepo } from '../config/loader.js';
import { moveProjectItem, findProjectItem } from '../providers/github/graphql.js';
import { postComment, getIssue } from '../providers/github/rest.js';
import logger from '../logger.js';

// Terminal states — no further transitions allowed
const TERMINAL_STATES = new Set(['Done']);

// States from which any state can transition to Cancelled
const WILDCARD_TARGET = 'Cancelled';

/**
 * Parse transition map from config into a lookup structure.
 * Returns Map<fromState, Map<toState, requirements>>
 * @param {object} transitions - Raw transitions object from config
 * @returns {Map<string, Map<string, object>>}
 */
export function buildTransitionMap(transitions) {
  const map = new Map();

  for (const [key, requirements] of Object.entries(transitions)) {
    const [fromRaw, toRaw] = key.split('->').map((s) => s.trim());
    if (!fromRaw || !toRaw) continue;

    if (!map.has(fromRaw)) map.set(fromRaw, new Map());
    map.get(fromRaw).set(toRaw, requirements ?? {});
  }

  return map;
}

/**
 * Check if a transition is valid given the transition map.
 * @param {Map} transitionMap
 * @param {string} fromState
 * @param {string} toState
 * @returns {{ valid: boolean, requirements: object|null }}
 */
export function checkTransitionAllowed(transitionMap, fromState, toState) {
  // Check terminal state
  if (TERMINAL_STATES.has(fromState)) {
    return { valid: false, requirements: null };
  }

  // Check wildcard (any -> Cancelled)
  if (toState === WILDCARD_TARGET) {
    const wildcardMap = transitionMap.get('*');
    if (wildcardMap?.has(WILDCARD_TARGET)) {
      return { valid: true, requirements: wildcardMap.get(WILDCARD_TARGET) };
    }
  }

  // Check specific transition
  const fromMap = transitionMap.get(fromState);
  if (fromMap?.has(toState)) {
    return { valid: true, requirements: fromMap.get(toState) };
  }

  return { valid: false, requirements: null };
}

/**
 * Validate that requirements are met for a transition.
 * @param {object} requirements - { require?: string[] }
 * @param {object} context - { assignee, linked_pr, merged_pr, open_pr, ... }
 * @returns {{ ok: boolean, missing: string[] }}
 */
export function validateRequirements(requirements, context = {}) {
  const required = requirements?.require ?? [];
  const missing = required.filter((req) => !context[req]);
  return { ok: missing.length === 0, missing };
}

/**
 * Get current state for an issue from the DB.
 * Returns null if no transitions recorded yet (defaults to Backlog).
 * @param {string} repo - "owner/repo"
 * @param {number} issueNumber
 * @returns {Promise<string>} Current state
 */
export async function getCurrentState(repo, issueNumber) {
  const [row] = await db
    .select({ toState: stateTransitions.toState })
    .from(stateTransitions)
    .where(and(eq(stateTransitions.repo, repo), eq(stateTransitions.issueNumber, issueNumber)))
    .orderBy(desc(stateTransitions.createdAt))
    .limit(1);
  return row?.toState ?? 'Backlog';
}

/**
 * Get full transition history for an issue.
 * @param {string} repo
 * @param {number} issueNumber
 * @returns {Promise<Array>}
 */
export async function getTransitionHistory(repo, issueNumber) {
  return db
    .select()
    .from(stateTransitions)
    .where(and(eq(stateTransitions.repo, repo), eq(stateTransitions.issueNumber, issueNumber)))
    .orderBy(asc(stateTransitions.createdAt));
}

/**
 * Record a state transition in the DB.
 * @param {object} opts
 * @returns {Promise<object>} The created transition record
 */
async function recordTransition({ repo, issueNumber, fromState, toState, triggerType, triggerDetail, actor, metadata }) {
  const [row] = await db
    .insert(stateTransitions)
    .values({
      repo,
      issueNumber,
      fromState: fromState ?? null,
      toState,
      triggerType,
      triggerDetail: triggerDetail ?? null,
      actor: actor ?? null,
      metadata: metadata ?? null,
    })
    .returning();
  return row;
}

/**
 * Update the GitHub Projects v2 card for this issue.
 * Silently logs errors — project update failure should not fail the transition.
 * @param {string} repo - "owner/repo"
 * @param {number} issueNumber
 * @param {string} toState
 * @param {string} projectId
 */
async function updateProjectCard(repo, issueNumber, toState, projectId) {
  if (!projectId) return;

  try {
    const [owner, repoName] = repo.split('/');
    const ctx = await installationCtxForRepo(owner, repoName);
    if (!ctx) {
      logger.warn({ msg: 'Cannot update project card — no installation context', repo, issueNumber, projectId });
      return;
    }
    let itemNodeId = null;

    const [cached] = await db
      .select({ itemNodeId: projectItems.itemNodeId })
      .from(projectItems)
      .where(
        and(
          eq(projectItems.repo, repo),
          eq(projectItems.issueNumber, issueNumber),
          eq(projectItems.projectId, projectId),
        ),
      )
      .limit(1);

    if (cached) {
      itemNodeId = cached.itemNodeId;
    } else {
      itemNodeId = await findProjectItem(projectId, owner, repoName, issueNumber, ctx);
      if (itemNodeId) {
        await db
          .insert(projectItems)
          .values({ projectId, itemNodeId, repo, issueNumber, currentState: toState })
          .onConflictDoUpdate({
            target: [projectItems.projectId, projectItems.itemNodeId],
            set: { currentState: toState, lastActivity: sql`NOW()` },
          });
      }
    }

    if (!itemNodeId) {
      logger.warn({ msg: 'Project item not found', repo, issueNumber, projectId });
      return;
    }

    await moveProjectItem(projectId, itemNodeId, toState, ctx);

    await db
      .update(projectItems)
      .set({ currentState: toState, lastActivity: sql`NOW()` })
      .where(
        and(eq(projectItems.projectId, projectId), eq(projectItems.itemNodeId, itemNodeId)),
      );
  } catch (err) {
    logger.error({ msg: 'Failed to update project card', repo, issueNumber, toState, error: err.message });
  }
}

/**
 * Execute a validated state transition.
 * This is the core function — it:
 * 1. Validates the transition is allowed
 * 2. Validates requirements are met (if any)
 * 3. Records in DB
 * 4. Updates GitHub Projects v2
 * 5. Returns the recorded transition or throws on invalid
 *
 * @param {object} opts
 * @param {string} opts.owner
 * @param {string} opts.repo
 * @param {number} opts.issueNumber
 * @param {string} opts.toState
 * @param {string} opts.triggerType - 'webhook', 'api', 'auto', 'resume'
 * @param {string} [opts.triggerDetail]
 * @param {string} [opts.actor]
 * @param {object} [opts.context] - Requirements context: { assignee, linked_pr, merged_pr, open_pr }
 * @param {object} [opts.metadata]
 * @param {boolean} [opts.skipProjectUpdate=false]
 * @returns {Promise<{ transition: object, fromState: string, toState: string }>}
 */
export async function executeTransition({
  owner,
  repo,
  issueNumber,
  toState,
  triggerType,
  triggerDetail,
  actor,
  context = {},
  metadata,
  skipProjectUpdate = false,
}) {
  const repoKey = `${owner}/${repo}`;
  const config = await resolveConfig(owner, repo);
  const transitionMap = buildTransitionMap(config.transitions);

  const fromState = await getCurrentState(repoKey, issueNumber);

  // Check if transition is allowed
  const { valid, requirements } = checkTransitionAllowed(transitionMap, fromState, toState);

  if (!valid) {
    const err = new Error(`Invalid transition: ${fromState} → ${toState}`);
    err.code = 'INVALID_TRANSITION';
    err.fromState = fromState;
    err.toState = toState;
    throw err;
  }

  // Validate requirements
  // For Done transitions, always enforce merged_pr requirement
  let effectiveRequirements = requirements;
  if (toState === 'Done') {
    effectiveRequirements = { ...requirements, require: [...(requirements.require ?? []), 'merged_pr'].filter((v, i, a) => a.indexOf(v) === i) };
  }

  const { ok, missing } = validateRequirements(effectiveRequirements, context);
  if (!ok) {
    const err = new Error(`Transition ${fromState} → ${toState} requires: ${missing.join(', ')}`);
    err.code = 'REQUIREMENTS_NOT_MET';
    err.missing = missing;
    err.fromState = fromState;
    err.toState = toState;
    throw err;
  }

  // Record transition
  const transition = await recordTransition({
    repo: repoKey,
    issueNumber,
    fromState,
    toState,
    triggerType,
    triggerDetail,
    actor,
    metadata,
  });

  logger.info({ msg: 'State transition recorded', repo: repoKey, issueNumber, fromState, toState, triggerType });
  audit('state_transition', { repo: repoKey, actor, data: { issueNumber, fromState, toState, triggerType, triggerDetail } });

  // Update GitHub Projects v2 (non-blocking, all projects)
  if (!skipProjectUpdate) {
    const projectIds = config.project_ids ?? (config.project_id ? [config.project_id] : []);
    await Promise.allSettled(
      projectIds.map((pid) => updateProjectCard(repoKey, issueNumber, toState, pid))
    );
  }

  return { transition, fromState, toState };
}

/**
 * Attempt to move to Done but revert + comment if merged_pr is not set.
 * Called when a project board drag or manual transition to Done is detected.
 * @param {object} opts
 * @returns {Promise<{ reverted: boolean, transition?: object }>}
 */
export async function attemptTransitionToDone({ owner, repo, issueNumber, actor, context = {}, triggerType = 'webhook' }) {
  const repoKey = `${owner}/${repo}`;

  // Check if there is a merged PR
  if (!context.merged_pr) {
    // Revert: post a comment and move back
    const fromState = await getCurrentState(repoKey, issueNumber);
    const doneCtx = await installationCtxForRepo(owner, repo);
    if (doneCtx) {
      await postComment(owner, repo, issueNumber,
        `⚠️ **Transition to Done blocked**: This issue cannot be moved to Done without a merged pull request.\n\nPlease merge a linked PR first, then the issue will automatically transition to Done.`,
        doneCtx
      );
    }

    // Move the project card back to the current state (all projects)
    const config = await resolveConfig(owner, repo);
    const projectIds = config.project_ids ?? (config.project_id ? [config.project_id] : []);
    await Promise.allSettled(
      projectIds.map((pid) => updateProjectCard(repoKey, issueNumber, fromState, pid))
    );

    logger.info({ msg: 'Reverted invalid Done transition', repo: repoKey, issueNumber, fromState });
    return { reverted: true };
  }

  const result = await executeTransition({
    owner,
    repo,
    issueNumber,
    toState: 'Done',
    triggerType,
    actor,
    context,
  });

  return { reverted: false, transition: result.transition };
}

/**
 * Auto-transition an issue (e.g., In Review → In Progress on review_rejected).
 * Looks for transitions with auto: true and matching on: event.
 * @param {string} owner
 * @param {string} repo
 * @param {number} issueNumber
 * @param {string} event - The event name (e.g. 'review_rejected')
 * @param {string} [actor]
 * @param {object} [metadata]
 */
export async function autoTransition(owner, repo, issueNumber, event, actor, metadata) {
  const repoKey = `${owner}/${repo}`;
  const config = await resolveConfig(owner, repo);
  const fromState = await getCurrentState(repoKey, issueNumber);

  // Find an auto transition matching the event from the current state
  let targetState = null;
  for (const [key, req] of Object.entries(config.transitions)) {
    if (!req?.auto || req?.on !== event) continue;
    const [fromRaw, toRaw] = key.split('->').map((s) => s.trim());
    if (fromRaw === fromState || fromRaw === '*') {
      targetState = toRaw;
      break;
    }
  }

  if (!targetState) {
    logger.info({ msg: 'No auto transition found', repo: repoKey, issueNumber, fromState, event });
    return null;
  }

  return executeTransition({
    owner,
    repo,
    issueNumber,
    toState: targetState,
    triggerType: 'auto',
    triggerDetail: event,
    actor,
    metadata,
  });
}
