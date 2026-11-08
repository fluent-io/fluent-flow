import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROUTER_ORIGIN = 'https://preview-webhooks.fluentflow.tech';
const REPOSITORY_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9_.-]*[A-Za-z0-9_-])?\/[A-Za-z0-9](?:[A-Za-z0-9_.-]*[A-Za-z0-9_-])?$/;
const SHA_PATTERN = /^[0-9a-f]{40}$/i;

function validateIdentity({ repository, prNumber, headSha }) {
  if (typeof repository !== 'string' || !REPOSITORY_PATTERN.test(repository)) throw new Error('invalid route identity');
  if (!Number.isSafeInteger(prNumber) || prNumber < 1) throw new Error('invalid route identity');
  if (typeof headSha !== 'string' || !SHA_PATTERN.test(headSha)) throw new Error('invalid route identity');
}

function statusOk(response) {
  return response && Number.isInteger(response.status) && response.status >= 200 && response.status < 300;
}

export async function reconcilePreviewWebhookRoute({
  operation,
  repository,
  prNumber,
  headSha,
  secret,
  fetchImpl = globalThis.fetch,
}) {
  if (operation !== 'deploy' && operation !== 'remove') throw new Error('invalid route operation');
  validateIdentity({ repository, prNumber, headSha });
  if (typeof secret !== 'string' || secret.length === 0) throw new Error('route secret is required');
  if (typeof fetchImpl !== 'function') throw new Error('fetch is required');

  const response = await fetchImpl(`${ROUTER_ORIGIN}/routes`, {
    method: operation === 'deploy' ? 'PUT' : 'DELETE',
    headers: {
      authorization: `Bearer ${secret}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ repository, pullRequest: prNumber, headSha }),
  });
  if (!statusOk(response)) {
    throw new Error(`preview webhook route request failed with status ${response?.status ?? 'unknown'}`);
  }
  return { status: response.status };
}

async function runCli() {
  await reconcilePreviewWebhookRoute({
    operation: process.env.PREVIEW_OPERATION,
    repository: process.env.GITHUB_REPOSITORY,
    prNumber: Number(process.env.PREVIEW_PR_NUMBER),
    headSha: process.env.PREVIEW_HEAD_SHA,
    secret: process.env.PREVIEW_ROUTE_SECRET,
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) await runCli();
