/**
 * Workflow dispatch transport — triggers a GitHub Actions workflow.
 */
import { dispatchWorkflow } from '../../github/rest.js';
import logger from '../../logger.js';

/**
 * @param {object} agentConfig - { workflow, ref, owner, repo, ... }
 * @param {object} payload - standardized wake payload
 */
export async function send(agentConfig, payload) {
  const { workflow, ref = 'main' } = agentConfig;
  if (!workflow) {
    logger.warn({ msg: 'Workflow transport: no workflow configured', agentId: payload.agentId });
    return;
  }

  // Owner/repo can come from agentConfig or from the payload's repo field
  let owner = agentConfig.owner;
  let repo = agentConfig.repo;
  if (!owner || !repo) {
    const parts = payload.repo?.split('/');
    if (parts?.length === 2) {
      [owner, repo] = parts;
    }
  }

  if (!owner || !repo) {
    logger.error({ msg: 'Workflow transport: cannot determine owner/repo', agentId: payload.agentId });
    return;
  }

  try {
    await dispatchWorkflow(owner, repo, workflow, ref, {
      agent_id: payload.agentId,
      event: payload.event,
      message: payload.message,
      payload: JSON.stringify(payload),
    });
    logger.info({ msg: 'Agent notified via workflow_dispatch', agentId: payload.agentId, workflow });
  } catch (err) {
    logger.error({ msg: 'Workflow transport error', agentId: payload.agentId, error: err.message });
  }
}
