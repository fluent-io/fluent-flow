import { signCollaborationActor } from '@fluent-flow/db';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';

const ACTOR_HEADER = 'x-fluent-flow-actor';
const FORWARDED_REQUEST_HEADERS = ['content-type', 'accept', 'idempotency-key', 'last-event-id'] as const;
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
  console.error(JSON.stringify({ component: 'collab-proxy', ...event }));
}

async function handle(request: Request, ctx: { params: Promise<{ path: string[] }> }): Promise<Response> {
  const { path: segments } = await ctx.params;
  const method = request.method;
  const isMutation = method !== 'GET' && method !== 'HEAD';

  if (segments.length === 0 || segments.some((s) => s.length === 0 || s === '.' || s === '..')) {
    return errorResponse(400, 'invalid_path', 'Not found.');
  }

  if (isMutation) {
    const origin = request.headers.get('origin');
    const host = request.headers.get('host');
    const originHost = origin && URL.canParse(origin) ? new URL(origin).host : null;
    if (origin && (!host || originHost !== host)) {
      return errorResponse(403, 'cross_origin_forbidden', 'You do not have permission to perform this action.');
    }
  }

  const session = await getServerSession(authOptions);
  const principalId = session?.user?.principalId;

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
