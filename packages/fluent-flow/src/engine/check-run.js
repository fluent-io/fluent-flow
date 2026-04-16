import { eq } from 'drizzle-orm';
import { db, schema } from '@fluent-flow/db';
import { resolveRepoConfig } from '../db/repo-configs.js';
import logger from '../logger.js';

const { agentClaims } = schema;

/**
 * Hook called when a claim is dispatched (queued for an agent).
 * Creates a check run with status 'queued' and stores the external id on the claim.
 *
 * @param {import('../providers/client.js').ProviderClient} client
 * @param {object} claim
 * @returns {Promise<object>} Updated claim with check_run_external_id
 */
export async function onClaimDispatched(client, claim) {
  const { repo, head_sha, claim_type, id } = claim;
  const [owner, repoName] = repo.split('/');

  const checkRun = await client.createCheckRun({ owner, repo: repoName }, {
    name: `Fluent Flow — ${claim_type}`,
    head_sha,
    status: 'queued',
  });

  const checkRunId = checkRun?.id;
  if (checkRunId && id) {
    await db
      .update(agentClaims)
      .set({ checkRunExternalId: checkRunId })
      .where(eq(agentClaims.id, id));
  }

  logger.info({ msg: 'onClaimDispatched', claimId: id, checkRunId });
  return { ...claim, check_run_external_id: checkRunId };
}

/**
 * Hook called when an agent picks up (starts) a claim.
 * Updates check run to in_progress.
 *
 * @param {import('../providers/client.js').ProviderClient} client
 * @param {object} claim
 */
export async function onClaimStarted(client, claim) {
  const { repo, check_run_external_id } = claim;
  if (!check_run_external_id) return;

  const [owner, repoName] = repo.split('/');

  await client.updateCheckRun({ owner, repo: repoName }, check_run_external_id, {
    status: 'in_progress',
    started_at: new Date().toISOString(),
  });

  logger.info({ msg: 'onClaimStarted', claimId: claim.id, checkRunId: check_run_external_id });
}

/**
 * Hook called when a claim is resolved (completed / failed / cancelled).
 * Updates check run to completed with the given conclusion.
 *
 * @param {import('../providers/client.js').ProviderClient} client
 * @param {object} claim
 * @param {{ conclusion: string, output?: object }} opts
 */
/**
 * Build a config snapshot output.text fenced code block for a check run.
 * @param {string} repo - "owner/repo" string
 * @returns {Promise<object|undefined>} output object or undefined on failure
 */
async function buildConfigSnapshot(repo) {
  try {
    const config = await resolveRepoConfig(repo);
    const snippet = {
      default_agent: config.default_agent ?? null,
      claim_types: config.claim_types ?? null,
      review_model: config.review_model ?? null,
    };
    return {
      title: 'Effective Config',
      summary: 'Config snapshot at time of resolution',
      text: `\`\`\`json\n${JSON.stringify(snippet, null, 2)}\n\`\`\``,
    };
  } catch (err) {
    logger.warn({ msg: 'buildConfigSnapshot failed', repo, error: err.message });
    return undefined;
  }
}

export async function onClaimResolved(client, claim, { conclusion, output } = {}) {
  const { repo, check_run_external_id } = claim;
  if (!check_run_external_id) return;

  const [owner, repoName] = repo.split('/');

  // Build config snapshot for output.text if no output provided
  const resolvedOutput = output ?? await buildConfigSnapshot(repo);

  await client.updateCheckRun({ owner, repo: repoName }, check_run_external_id, {
    status: 'completed',
    conclusion,
    completed_at: new Date().toISOString(),
    ...(resolvedOutput && { output: resolvedOutput }),
  });

  logger.info({ msg: 'onClaimResolved', claimId: claim.id, checkRunId: check_run_external_id, conclusion });
}
