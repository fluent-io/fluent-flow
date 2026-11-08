import { signAppJwt } from '../packages/fluent-flow/src/providers/github/app-auth.js';

export const PREVIEW_WEBHOOK_URL = 'https://preview-webhooks.fluentflow.tech/webhooks/github-app';
const GITHUB_API_URL = 'https://api.github.com';

export function decodePrivateKey(privateKey) {
  if (typeof privateKey !== 'string' || privateKey.trim() === '') throw new Error('App private key is required');
  const compact = privateKey.replace(/\s/g, '');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(compact) || compact.length % 4 !== 0) throw new Error('App private key must be base64');
  const pem = Buffer.from(compact, 'base64').toString('utf8').replace(/\r\n/g, '\n').trim();
  if (!/^-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]+-----END [A-Z0-9 ]*PRIVATE KEY-----$/.test(pem)) throw new Error('App private key is invalid');
  return `${pem}\n`;
}

function statusOk(response) {
  return response && Number.isInteger(response.status) && response.status >= 200 && response.status < 300;
}

export async function configurePreviewAppWebhook({
  appId,
  privateKey,
  webhookSecret,
  fetchImpl = globalThis.fetch,
}) {
  if (appId === undefined || appId === null || String(appId).trim() === '') throw new Error('App ID is required');
  if (typeof webhookSecret !== 'string' || webhookSecret.length === 0) throw new Error('webhook secret is required');
  if (typeof fetchImpl !== 'function') throw new Error('fetch is required');
  const jwt = signAppJwt({ appId: String(appId), privateKeyPem: decodePrivateKey(privateKey) });
  const response = await fetchImpl(`${GITHUB_API_URL}/app/hook/config`, {
    method: 'PATCH',
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${jwt}`,
      'X-GitHub-Api-Version': '2022-11-28',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      url: PREVIEW_WEBHOOK_URL,
      content_type: 'json',
      secret: webhookSecret,
      insecure_ssl: '0',
    }),
  });
  if (!statusOk(response)) throw new Error(`Preview App webhook configuration failed with status ${response?.status ?? 'unknown'}`);
  return { status: response.status };
}

async function runCli() {
  await configurePreviewAppWebhook({
    appId: process.env.PREVIEW_GITHUB_APP_ID,
    privateKey: process.env.PREVIEW_GITHUB_APP_PRIVATE_KEY,
    webhookSecret: process.env.PREVIEW_GITHUB_APP_WEBHOOK_SECRET,
  });
}

if (process.argv[1] && new URL(import.meta.url).pathname === process.argv[1]) await runCli();
