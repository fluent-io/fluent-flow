import { createServer } from 'node:http';
import { mkdir, open, readFile, rename } from 'node:fs/promises';
import { randomUUID, createHmac, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';

const MAX_BODY_BYTES = 5 * 1024 * 1024;
const STATE_VERSION = 1;
const ROUTE_RE = /^[A-Za-z0-9](?:[A-Za-z0-9_.-]*[A-Za-z0-9_-])?\/[A-Za-z0-9](?:[A-Za-z0-9_.-]*[A-Za-z0-9_-])?$/;
const SHA_RE = /^[0-9a-f]{40}$/i;

function positivePullRequest(value) {
  return Number.isInteger(value) && value > 0 ? value : null;
}

function routeKey(repository, pullRequest) {
  return `${repository}#${pullRequest}`;
}

function routeFor(repository, pullRequest, headSha) {
  return {
    key: routeKey(repository, pullRequest),
    repository,
    pullRequest,
    headSha,
    host: `api-pr-${pullRequest}-preview.fluentflow.tech`,
  };
}

function validateRouteInput({ repository, pullRequest, headSha }) {
  if (typeof repository !== 'string' || !ROUTE_RE.test(repository)) throw new Error('invalid route');
  if (positivePullRequest(pullRequest) === null) throw new Error('invalid route');
  if (typeof headSha !== 'string' || !SHA_RE.test(headSha)) throw new Error('invalid route');
}

function emptyClassification(scope = 'unresolvable', repository = null, pullRequests = []) {
  return { scope, repository, pullRequests };
}

function validPullRequests(values) {
  return values
    .map((value) => positivePullRequest(value))
    .filter((value) => value !== null);
}

export function classifyWebhook(eventName, payload) {
  const repository = typeof payload?.repository?.full_name === 'string'
    ? payload.repository.full_name
    : null;

  if (eventName === 'pull_request' || eventName === 'pull_request_review' || eventName === 'pull_request_review_comment') {
    const pullRequest = positivePullRequest(payload?.pull_request?.number);
    return repository && pullRequest !== null
      ? emptyClassification('pull_request', repository, [pullRequest])
      : emptyClassification();
  }

  if (eventName === 'issue' || eventName === 'issue_comment') {
    if (!payload?.issue?.pull_request) return repository ? emptyClassification('repository', repository) : emptyClassification();
    const pullRequest = validPullRequests([payload.issue.number]);
    return repository && pullRequest.length === 1
      ? emptyClassification('pull_request', repository, pullRequest)
      : emptyClassification();
  }

  if (eventName === 'check_run' || eventName === 'check_suite' || eventName === 'workflow_run') {
    const container = payload?.[eventName];
    const pullRequests = validPullRequests((container?.pull_requests ?? payload?.pull_requests ?? []).map((item) => item?.number));
    if (repository && pullRequests.length > 0) return emptyClassification('pull_request', repository, pullRequests);
    return repository ? emptyClassification('repository', repository) : emptyClassification();
  }

  if (eventName === 'installation' || eventName === 'installation_repositories') return emptyClassification('installation');
  return repository ? emptyClassification('repository', repository) : emptyClassification();
}

export function createRouteStore({ directory }) {
  const statePath = join(directory, 'state.json');
  let state = null;
  let mutation = Promise.resolve();

  async function atomicWrite(nextState) {
    const temporaryPath = `${statePath}.${process.pid}.${randomUUID()}.tmp`;
    const serialized = JSON.stringify(nextState);
    const handle = await open(temporaryPath, 'w', 0o600);
    try {
      await handle.writeFile(serialized, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporaryPath, statePath);
  }

  async function load() {
    await mkdir(directory, { recursive: true });
    let raw;
    try {
      raw = await readFile(statePath, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') {
        state = { version: STATE_VERSION, routes: {}, baseline: null };
        return;
      }
      throw error;
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error('router state is corrupt');
    }
    if (parsed?.version !== STATE_VERSION || !parsed.routes || Array.isArray(parsed.routes) || typeof parsed.routes !== 'object' || (parsed.baseline !== null && typeof parsed.baseline !== 'object')) {
      throw new Error('router state is corrupt');
    }
    try {
      for (const route of Object.values(parsed.routes)) validateRouteInput(route);
      baselineFromState(parsed.baseline);
    } catch (error) {
      throw new Error('router state is corrupt', { cause: error });
    }
    state = parsed;
  }

  function requireLoaded() {
    if (!state) throw new Error('router state is not loaded');
    return state;
  }

  function enqueue(operation) {
    const result = mutation.then(operation);
    mutation = result.then(() => undefined, () => undefined);
    return result;
  }

  function baselineFromState(value) {
    if (!value) return null;
    if (typeof value.body !== 'string' || typeof value.signature !== 'string' || typeof value.event !== 'string' || typeof value.delivery !== 'string') throw new Error('router state is corrupt');
    const body = Buffer.from(value.body, 'base64');
    if (body.toString('base64') !== value.body) throw new Error('router state is corrupt');
    return {
      body,
      signature: value.signature,
      event: value.event,
      delivery: value.delivery,
    };
  }

  return {
    async load() {
      await load();
    },

    register(input, pullRequestArg, headShaArg) {
      const values = input !== null && typeof input === 'object'
        ? input
        : { repository: input, pullRequest: pullRequestArg, headSha: headShaArg };
      const normalized = {
        repository: values.repository,
        pullRequest: values.pullRequest ?? values.pull_request ?? values.prNumber ?? values.number,
        headSha: values.headSha ?? values.head_sha ?? values.sha,
      };
      return enqueue(async () => {
        validateRouteInput(normalized);
        const current = requireLoaded();
        const route = routeFor(normalized.repository, normalized.pullRequest, normalized.headSha);
        const next = { ...current, routes: { ...current.routes, [route.key]: route } };
        await atomicWrite(next);
        state = next;
        return route;
      });
    },

    remove(input, pullRequestArg) {
      const values = input !== null && typeof input === 'object'
        ? input
        : { repository: input, pullRequest: pullRequestArg };
      const normalized = {
        repository: values.repository,
        pullRequest: values.pullRequest ?? values.pull_request ?? values.prNumber ?? values.number,
      };
      return enqueue(async () => {
        if (typeof normalized.repository !== 'string' || !ROUTE_RE.test(normalized.repository) || positivePullRequest(normalized.pullRequest) === null) throw new Error('invalid route');
        const current = requireLoaded();
        const routes = { ...current.routes };
        delete routes[routeKey(normalized.repository, normalized.pullRequest)];
        const next = { ...current, routes };
        await atomicWrite(next);
        state = next;
      });
    },

    routesFor(classificationOrEvent, payload) {
      const current = requireLoaded();
      const classification = typeof classificationOrEvent === 'string'
        ? classifyWebhook(classificationOrEvent, payload)
        : classificationOrEvent;
      if (!classification || classification.scope === 'unresolvable') return [];
      const routes = Object.values(current.routes);
      if (classification.scope === 'installation') return routes;
      if (classification.scope === 'pull_request') {
        const selected = new Set(classification.pullRequests ?? []);
        return routes.filter((route) => route.repository === classification.repository && selected.has(route.pullRequest));
      }
      if (classification.scope === 'repository') return routes.filter((route) => route.repository === classification.repository);
      return [];
    },

    saveInstallationBaseline(input, payload, signatureArg, deliveryArg) {
      const baseline = typeof input === 'object'
        ? input
        : { event: input, payload, signature: signatureArg, delivery: deliveryArg };
      if (!Buffer.isBuffer(baseline.body) || typeof baseline.signature !== 'string' || typeof baseline.event !== 'string' || typeof baseline.delivery !== 'string') throw new Error('invalid baseline');
      return enqueue(async () => {
        const current = requireLoaded();
        const next = {
          ...current,
          baseline: {
            body: baseline.body.toString('base64'),
            signature: baseline.signature,
            event: baseline.event,
            delivery: baseline.delivery,
          },
        };
        await atomicWrite(next);
        state = next;
      });
    },

    installationBaseline() {
      return baselineFromState(requireLoaded().baseline);
    },
  };
}

function safeSignature(rawBody, signature, secret) {
  if (typeof signature !== 'string' || !secret) return false;
  const expected = `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`;
  const actual = Buffer.from(signature, 'utf8');
  const wanted = Buffer.from(expected, 'utf8');
  return actual.length === wanted.length && timingSafeEqual(actual, wanted);
}

function readRequestBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    req.on('data', (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > limit) {
        settled = true;
        req.resume();
        reject(Object.assign(new Error('payload too large'), { statusCode: 413 }));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!settled) resolve(Buffer.concat(chunks));
    });
    req.on('error', (error) => {
      if (!settled) reject(error);
    });
  });
}

async function responseAccepted(response) {
  return response && response.status >= 200 && response.status < 300;
}

function authorizationValid(req, routeSecret) {
  const authorization = req.headers.authorization;
  if (typeof authorization === 'string' && authorization.startsWith('Bearer ')) return authorization.slice(7) === routeSecret;
  return req.headers['x-route-secret'] === routeSecret;
}

async function parseJsonRequest(req) {
  const body = await readRequestBody(req, 1024 * 1024);
  try {
    return JSON.parse(body.toString('utf8'));
  } catch {
    throw Object.assign(new Error('invalid request'), { statusCode: 400 });
  }
}

function writeText(res, statusCode, body) {
  res.writeHead(statusCode, { 'content-type': 'text/plain; charset=utf-8' });
  res.end(body);
}

export function createPreviewWebhookRouter({
  webhookSecret,
  routeSecret,
  store,
  fetchImpl = globalThis.fetch,
  logger = { info() {}, warn() {}, error() {} },
}) {

  let routeMutation = Promise.resolve();
  function enqueueRouteMutation(operation) {
    const result = routeMutation.then(operation);
    routeMutation = result.then(() => undefined, () => undefined);
    return result;
  }
  async function forward(route, body, headers, selector) {
    const response = await fetchImpl('http://traefik/webhooks/github-app', {
      method: 'POST',
      headers: {
        host: route.host,
        'x-hub-signature-256': headers.signature,
        'x-github-event': headers.event,
        'x-github-delivery': headers.delivery,
        ...(headers.contentType ? { 'content-type': headers.contentType } : {}),
      },
      body,
      signal: AbortSignal.timeout(10000),
    });
    const accepted = await responseAccepted(response);
    logger.info({ delivery_id: headers.delivery, event: headers.event, selector, route: route.key, status: response.status });
    if (!accepted) throw new Error('downstream rejected');
    return response.status;
  }

  return createServer(async (req, res) => {
    const requestUrl = new URL(req.url ?? '/', 'http://router');
    try {
      if (requestUrl.pathname === '/health' && req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"status":"ok"}');
        return;
      }

      if (requestUrl.pathname === '/routes' && (req.method === 'PUT' || req.method === 'DELETE')) {
        if (!authorizationValid(req, routeSecret)) {
          writeText(res, 401, 'Unauthorized');
          return;
        }
        const input = await parseJsonRequest(req);
        if (!input || typeof input !== 'object' || Array.isArray(input)) {
          writeText(res, 400, 'Bad Request');
          return;
        }
        if (req.method === 'DELETE') {
          const removal = await Promise.allSettled([enqueueRouteMutation(() => store.remove(input))]);
          if (removal[0].status === 'rejected') {
            writeText(res, 400, 'Bad Request');
            return;
          }
          res.writeHead(204);
          res.end();
          return;
        }
        const normalized = {
          repository: input.repository,
          pullRequest: input.pullRequest ?? input.pull_request ?? input.prNumber ?? input.number,
          headSha: input.headSha ?? input.head_sha ?? input.sha,
        };
        try {
          validateRouteInput(normalized);
        } catch {
          writeText(res, 400, 'Bad Request');
          return;
        }
        await enqueueRouteMutation(async () => {
          const existed = store.routesFor({ scope: 'pull_request', repository: normalized.repository, pullRequests: [normalized.pullRequest] }).length > 0;
          const route = await store.register(normalized);
          if (!existed) {
            const baseline = store.installationBaseline();
            if (baseline) {
              const replay = await Promise.allSettled([forward(route, baseline.body, {
                signature: baseline.signature,
                event: baseline.event,
                delivery: baseline.delivery,
              }, 'installation-baseline')]);
              if (replay[0].status === 'rejected') {
                await store.remove(normalized);
                throw Object.assign(new Error('downstream rejected'), { statusCode: 502 });
              }
            }
          }
        });
        res.writeHead(204);
        res.end();
        return;
      }

      if (requestUrl.pathname === '/webhooks/github-app' && req.method === 'POST') {
        const body = await readRequestBody(req, MAX_BODY_BYTES);
        const signature = req.headers['x-hub-signature-256'];
        const event = req.headers['x-github-event'];
        const delivery = req.headers['x-github-delivery'];
        if (typeof signature !== 'string' || typeof event !== 'string' || typeof delivery !== 'string') {
          writeText(res, 401, 'Unauthorized');
          return;
        }
        if (!safeSignature(body, signature, webhookSecret)) {
          writeText(res, 401, 'Unauthorized');
          return;
        }
        let payload;
        try {
          payload = JSON.parse(body.toString('utf8'));
        } catch {
          writeText(res, 400, 'Bad Request');
          return;
        }
        if (event === 'installation' && payload.action === 'created') {
          await store.saveInstallationBaseline({ body, signature, event, delivery });
        }
        const classification = classifyWebhook(event, payload);
        const routes = store.routesFor(classification);
        const selector = classification.scope === 'pull_request'
          ? `${classification.repository}#${classification.pullRequests.join(',')}`
          : classification.repository ?? classification.scope;
        if (routes.length > 0) {
          const results = await Promise.allSettled(routes.map((route) => forward(route, body, {
            signature,
            event,
            delivery,
            contentType: req.headers['content-type'],
          }, selector)));
          if (results.some((result) => result.status === 'rejected')) {
            writeText(res, 502, 'Bad Gateway');
            return;
          }
        }
        logger.info({ delivery_id: delivery, event, selector, route: routes.length, status: 202 });
        res.writeHead(202);
        res.end();
        return;
      }

      writeText(res, 404, 'Not Found');
    } catch (error) {
      if (error.statusCode) {
        const body = error.statusCode === 413 ? 'Payload Too Large' : error.statusCode === 502 ? 'Bad Gateway' : 'Bad Request';
        writeText(res, error.statusCode, body);
        return;
      }
      logger.error({ msg: 'preview webhook router request failed' });
      writeText(res, 500, 'Internal Server Error');
    }
  });
}

const entryPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (entryPath && entryPath === fileURLToPath(import.meta.url)) {
  const webhookSecret = process.env.PREVIEW_WEBHOOK_SECRET;
  const routeSecret = process.env.PREVIEW_ROUTE_SECRET;
  if (!webhookSecret || !routeSecret) throw new Error('router secrets are required');
  const store = createRouteStore({ directory: process.env.ROUTER_STATE_DIR ?? '/data' });
  await store.load();
  const server = createPreviewWebhookRouter({ webhookSecret, routeSecret, store });
  server.listen(Number(process.env.PORT ?? 3000), '0.0.0.0');
}
