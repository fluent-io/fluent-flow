import * as rest from './github/rest.js';
import { verifyWebhookSignature } from './github/webhook-verify.js';
import { enqueueProviderAction } from './enqueue.js';

/**
 * Build a GitHub App ProviderClient for the given repo/installation context.
 * @param {object} repo - { installation_id, ... }
 * @returns {import('./client.js').ProviderClient}
 */
function buildGitHubClient(repo) {
  const installationId = repo.installation_id;
  const readCtx = { installation_id: installationId };

  return {
    // --- Read operations (direct, not queued) ---

    async listOpenPRs({ owner, repo: repoName }) {
      return rest.listOpenPRs(owner, repoName, readCtx);
    },

    async getPR({ owner, repo: repoName }, prNumber) {
      return rest.getPR(owner, repoName, prNumber, readCtx);
    },

    async getDiff({ owner, repo: repoName }, prNumber) {
      return rest.getDiff(owner, repoName, prNumber, readCtx);
    },

    verifyWebhook(headers, rawBody) {
      return verifyWebhookSignature(
        rawBody,
        headers['x-hub-signature-256'],
        process.env.FF_GITHUB_APP_WEBHOOK_SECRET
      );
    },

    parseWebhookEvent(headers, body) {
      return { event: headers['x-github-event'], ...body };
    },

    // --- Write operations (queued through provider_outbound_queue) ---

    async postComment({ owner, repo: repoName }, prNumber, body, ctx) {
      const payload = { owner, repo: repoName, prNumber, body };
      return enqueueProviderAction({
        installation_id: installationId,
        kind: 'comment',
        payload,
        claim_id: ctx?.claim_id,
      });
    },

    async postReview({ owner, repo: repoName }, prNumber, review, ctx) {
      const payload = { owner, repo: repoName, prNumber, review };
      return enqueueProviderAction({
        installation_id: installationId,
        kind: 'review',
        payload,
        claim_id: ctx?.claim_id,
      });
    },

    async createCheckRun({ owner, repo: repoName }, input, ctx) {
      const payload = { owner, repo: repoName, ...input };
      return enqueueProviderAction({
        installation_id: installationId,
        kind: 'create_check_run',
        payload,
        claim_id: ctx?.claim_id,
      });
    },

    async updateCheckRun({ owner, repo: repoName }, checkRunId, input, ctx) {
      const payload = { owner, repo: repoName, checkRunId, ...input };
      return enqueueProviderAction({
        installation_id: installationId,
        kind: 'update_check_run',
        payload,
        claim_id: ctx?.claim_id,
      });
    },
  };
}

/**
 * Get a ProviderClient for the given repo context.
 * @param {object} repo - { provider?, installation_id, ... }
 * @returns {import('./client.js').ProviderClient}
 */
export function getProvider(repo = {}) {
  const provider = repo.provider ?? 'github';

  if (provider === 'github') {
    return buildGitHubClient(repo);
  }

  throw new Error(`Unsupported provider: ${provider}`);
}
