import * as rest from './github/rest.js';
import * as graphql from './github/graphql.js';
import { verifyWebhookSignature } from './github/webhook-verify.js';
import { createCheckRunDirect, updateCheckRunDirect } from './github/check-run.js';
import { enqueueProviderAction } from './enqueue.js';

/**
 * Build a GitHub App ProviderClient for the given repo/installation context.
 * @param {object} repo - { installation_id, ... }
 * @returns {import('./client.js').ProviderClient}
 */
function buildGitHubClient(repo) {
  const installationId = repo.installation_id;

  return {
    // --- Read operations (direct, not queued) ---

    async listOpenPRs({ owner, repo: repoName }) {
      const response = await fetch(`https://api.github.com/repos/${owner}/${repoName}/pulls?state=open&per_page=100`, {
        headers: {
          Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
      });
      if (!response.ok) throw new Error(`listOpenPRs failed: ${response.status}`);
      return response.json();
    },

    async getPR({ owner, repo: repoName }, prNumber) {
      return rest.getPR(owner, repoName, prNumber);
    },

    async getDiff({ owner, repo: repoName }, prNumber) {
      const response = await fetch(`https://api.github.com/repos/${owner}/${repoName}/pulls/${prNumber}`, {
        headers: {
          Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
          Accept: 'application/vnd.github.diff',
          'X-GitHub-Api-Version': '2022-11-28',
        },
      });
      if (!response.ok) throw new Error(`getDiff failed: ${response.status}`);
      return response.text();
    },

    verifyWebhook(headers, rawBody) {
      const secret = process.env.FF_GITHUB_APP_WEBHOOK_SECRET ?? process.env.GITHUB_WEBHOOK_SECRET;
      return verifyWebhookSignature(rawBody, headers['x-hub-signature-256'], secret);
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
