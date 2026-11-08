import { signAppJwt } from '../packages/fluent-flow/src/providers/github/app-auth.js';
import { decodePrivateKey } from './preview-github-app.mjs';

const GITHUB_API_URL = 'https://api.github.com';
const PAGE_SIZE = 100;
const MAX_PAGES = 3;
const LOOKBACK_MS = 15 * 60 * 1000;

function statusOk(response) {
  return response && Number.isInteger(response.status) && response.status >= 200 && response.status < 300;
}

function currentTime(now) {
  if (typeof now === 'function') return new Date(now());
  if (now instanceof Date) return new Date(now.getTime());
  if (now === undefined) return new Date();
  return new Date(now);
}

function deliveryTime(delivery) {
  const value = Date.parse(delivery?.delivered_at ?? '');
  return Number.isFinite(value) ? value : null;
}

function succeeded(delivery) {
  return delivery?.status === 'OK'
    || delivery?.status === 'SUCCESS'
    || (Number.isInteger(delivery?.status_code) && delivery.status_code >= 200 && delivery.status_code < 300);
}

function deliveryGuid(delivery) {
  return typeof delivery?.guid === 'string' && delivery.guid.length > 0 ? delivery.guid : String(delivery?.id ?? '');
}

function headers(jwt) {
  return {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${jwt}`,
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

async function listRecentDeliveries({ jwt, fetchImpl, cutoff }) {
  const deliveries = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const response = await fetchImpl(`${GITHUB_API_URL}/app/hook/deliveries?per_page=${PAGE_SIZE}&page=${page}`, {
      headers: headers(jwt),
    });
    if (!statusOk(response)) throw new Error(`GitHub App delivery listing failed with status ${response?.status ?? 'unknown'}`);
    const batch = await response.json();
    if (!Array.isArray(batch)) throw new Error('GitHub App delivery listing returned invalid data');
    const recent = batch.filter((delivery) => {
      const timestamp = deliveryTime(delivery);
      return timestamp !== null && timestamp >= cutoff;
    });
    deliveries.push(...recent);
    const oldest = batch.reduce((value, delivery) => {
      const timestamp = deliveryTime(delivery);
      return timestamp === null ? value : Math.min(value, timestamp);
    }, Number.POSITIVE_INFINITY);
    if (batch.length < PAGE_SIZE || oldest < cutoff) break;
  }
  return deliveries;
}

export async function redeliverFailedPreviewWebhooks({
  appId,
  privateKey,
  fetchImpl = globalThis.fetch,
  now,
}) {
  if (appId === undefined || appId === null || String(appId).trim() === '') throw new Error('App ID is required');
  if (typeof fetchImpl !== 'function') throw new Error('fetch is required');
  const jwt = signAppJwt({ appId: String(appId), privateKeyPem: decodePrivateKey(privateKey) });
  const cutoff = currentTime(now).getTime() - LOOKBACK_MS;
  const deliveries = await listRecentDeliveries({ jwt, fetchImpl, cutoff });
  const grouped = new Map();
  for (const delivery of deliveries) {
    const guid = deliveryGuid(delivery);
    if (!guid) continue;
    const group = grouped.get(guid) ?? [];
    group.push(delivery);
    grouped.set(guid, group);
  }

  const candidates = [];
  for (const group of grouped.values()) {
    if (group.some(succeeded)) continue;
    const failed = group
      .filter((delivery) => !succeeded(delivery))
      .sort((left, right) => (deliveryTime(right) ?? 0) - (deliveryTime(left) ?? 0));
    if (failed[0]?.id !== undefined && failed[0]?.id !== null) candidates.push(failed[0]);
  }

  let redelivered = 0;
  for (const delivery of candidates) {
    const response = await fetchImpl(`${GITHUB_API_URL}/app/hook/deliveries/${encodeURIComponent(delivery.id)}/attempts`, {
      method: 'POST',
      headers: headers(jwt),
    });
    if (!statusOk(response)) throw new Error(`GitHub App webhook redelivery failed with status ${response?.status ?? 'unknown'}`);
    redelivered += 1;
  }
  return { redelivered };
}

async function runCli() {
  await redeliverFailedPreviewWebhooks({
    appId: process.env.PREVIEW_GITHUB_APP_ID,
    privateKey: process.env.PREVIEW_GITHUB_APP_PRIVATE_KEY,
  });
}

if (process.argv[1] && new URL(import.meta.url).pathname === process.argv[1]) await runCli();
