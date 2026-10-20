import { signCollaborationActor } from '@fluent-flow/db';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';

/**
 * Same-origin browser proxy for the collaboration API.
 *
 * The browser talks to `/api/collab/v1/...` on Next.js; this handler forwards to
 * the Express collaboration prefix with a short-lived HMAC actor assertion. The
 * shared secret and the assertion never reach the browser, and inbound
 * authorization/actor headers are stripped so callers cannot forge identity.
 * The secret is only needed when an actor is signed: protected routes fail
 * authentication before configuration, while public invitation redemption can
 * still be forwarded without one.
 */

const ACTOR_HEADER = 'x-fluent-flow-actor';
/** Request headers safe to forward unchanged to the collaboration API. */
const FORWARDED_REQUEST_HEADERS = ['content-type', 'accept', 'idempotency-key', 'last-event-id'] as const;
/** Response headers that carry meaningful semantics (artifact downloads, SSE, rate limits) and must survive the hop. */
const FORWARDED_RESPONSE_HEADERS = [
  'content-type',
  'content-disposition',
  'x-content-type-options',
  'content-security-policy',
  'cache-control',
  'retry-after',
] as const;

interface UpstreamConfig {
  baseUrl: string;
  secret: string | null;
}

function readUpstreamConfig(): UpstreamConfig {
  const baseUrl = process.env.FF_COLLAB_API_URL ?? 'http://127.0.0.1:3847';
  return { baseUrl: baseUrl.replace(/\/+$/, ''), secret: process.env.FF_COLLAB_AUTH_SECRET ?? null };
}

function errorResponse(status: number, code: string, message: string): Response {
  return Response.json(
    { error: { code, message, requestId: crypto.randomUUID() } },
    { status, headers: { 'cache-control': 'no-store' } },
  );
}

function logError(event: Record<string, unknown>): void {
  // Structured server-side log only; never surfaced to the browser.
  console.error(JSON.stringify({ component: 'collab-proxy', ...event }));
}

async function handle(request: Request, ctx: { params: Promise<{ path: string[] }> }): Promise<Response> {
  const { path: segments } = await ctx.params;
  const method = request.method;
  const isMutation = method !== 'GET' && method !== 'HEAD';

  // Every forwarded path must stay under the fixed collab prefix: dot segments
  // survive encodeURIComponent and fetch-level URL normalization could otherwise
  // escape into legacy unauthenticated Express routes.
  if (segments.length === 0 || segments.some((s) => s.length === 0 || s === '.' || s === '..')) {
    return errorResponse(400, 'invalid_path', 'Not found.');
  }

  // Cross-origin mutations are rejected before any session or upstream work.
  // request.url can be rebuilt by the framework with a different host name, so
  // the verbatim Host header is the site identity the Origin must match.
  if (isMutation) {
    const origin = request.headers.get('origin');
    const host = request.headers.get('host');
    if (origin && (!host || new URL(origin).host !== host)) {
      return errorResponse(403, 'cross_origin_forbidden', 'You do not have permission to perform this action.');
    }
  }

  const session = await getServerSession(authOptions);
  const principalId = session?.user?.principalId;

  // Invitation redemption is the single unauthenticated collaboration mutation
  // (secret-token bound, rate limited upstream); everything else needs a principal.
  const unauthenticatedAllowed =
    method === 'POST' && segments.length === 2 && segments[0] === 'invitations' && segments[1] === 'accept';

  if (!principalId && !unauthenticatedAllowed) {
    return errorResponse(401, 'unauthenticated', 'Sign in required.');
  }

  const config = readUpstreamConfig();
  const headers = new Headers();
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  // Browser-supplied x-forwarded-for is never forwarded: upstream rate limiting
  // keys on the proxy address plus account/invite identity, not spoofable input.

  if (principalId) {
    if (!config.secret) {
      logError({ msg: 'collab proxy misconfigured', reason: 'missing FF_COLLAB_AUTH_SECRET' });
      return errorResponse(503, 'proxy_unconfigured', 'Configuration error. Contact support.');
    }
    headers.set(
      ACTOR_HEADER,
      signCollaborationActor({ principalId, sessionVersion: session.user.sessionVersion }, config.secret),
    );
  }

  const url = new URL(request.url);
  const isEventStream = (request.headers.get('accept') ?? '').includes('text/event-stream');
  const encodedPath = segments.map((s) => encodeURIComponent(s)).join('/');
  const upstreamUrl = `${config.baseUrl}/api/collab/v1/${encodedPath}${url.search}`;

  // Browser disconnects must reach the connector-facing upstream: without a
  // propagated signal an abandoned event stream or slow mutation keeps upstream
  // work (and connector waits) alive.
  const upstreamSignal = isEventStream
    ? request.signal
    : AbortSignal.any([request.signal, AbortSignal.timeout(30_000)]);

  let upstream: Response;
  try {
    upstream = await fetch(upstreamUrl, {
      method,
      headers,
      body: isMutation ? await request.arrayBuffer() : undefined,
      cache: 'no-store',
      redirect: 'manual',
      signal: upstreamSignal,
    });
  } catch (error) {
    logError({
      msg: 'collab upstream request failed',
      path: segments.join('/'),
      method,
      error: error instanceof Error ? `${error.name}: ${error.message}` : 'unknown',
    });
    return errorResponse(503, 'upstream_unavailable', 'Configuration error. Contact support.');
  }

  const responseHeaders = new Headers();
  for (const name of FORWARDED_RESPONSE_HEADERS) {
    const value = upstream.headers.get(name);
    if (value) responseHeaders.set(name, value);
  }
  if (isEventStream) {
    responseHeaders.set('cache-control', 'no-cache');
  } else if (!responseHeaders.has('cache-control')) {
    // Collaboration data is session-scoped and mutable; never let it be cached.
    responseHeaders.set('cache-control', 'no-store');
  }

  return new Response(upstream.body, { status: upstream.status, headers: responseHeaders });
}

export async function GET(request: Request, ctx: { params: Promise<{ path: string[] }> }): Promise<Response> {
  return handle(request, ctx);
}

export async function POST(request: Request, ctx: { params: Promise<{ path: string[] }> }): Promise<Response> {
  return handle(request, ctx);
}

export async function PATCH(request: Request, ctx: { params: Promise<{ path: string[] }> }): Promise<Response> {
  return handle(request, ctx);
}

export async function DELETE(request: Request, ctx: { params: Promise<{ path: string[] }> }): Promise<Response> {
  return handle(request, ctx);
}
