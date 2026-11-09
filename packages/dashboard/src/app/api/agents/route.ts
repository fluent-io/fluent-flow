import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { listAgents, createAgentWithEnrollment } from '@fluent-flow/db';
import { authOptions, getOrgScope, hasRole } from '@/lib/auth';

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { orgIds, isSuperadmin } = getOrgScope(session);
  const agents = await listAgents(orgIds, isSuperadmin);
  return NextResponse.json(agents);
}

const AGENT_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;
const ENROLLMENT_TOKEN_RE = /^enroll_[0-9a-f]{64}$/;
const PROVIDERS = ['claude-code', 'codex'] as const;
const DEPLOYMENTS = ['local', 'self_hosted'] as const;
const MIN_CAPACITY = 1;
const MAX_CAPACITY = 16;
const ENROLLMENT_TTL_MS = 15 * 60 * 1000;
const SELF_HOSTED_IMAGE = 'ghcr.io/fluent-io/fluent-flow-agent-server:latest';
const COMMAND_LINE_BREAK = ' \\\n  ';

type Provider = (typeof PROVIDERS)[number];
type Deployment = (typeof DEPLOYMENTS)[number];

function isProvider(value: unknown): value is Provider {
  return typeof value === 'string' && (PROVIDERS as readonly string[]).includes(value);
}

function isDeployment(value: unknown): value is Deployment {
  return typeof value === 'string' && (DEPLOYMENTS as readonly string[]).includes(value);
}

function isCapacity(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= MIN_CAPACITY && value <= MAX_CAPACITY;
}

function buildCommand(input: {
  serverUrl: string;
  provider: Provider;
  capacity: number;
  deployment: Deployment;
  enrollmentToken: string;
}): string {
  const { serverUrl, provider, capacity, deployment, enrollmentToken } = input;
  if (deployment === 'self_hosted') {
    return [
      'docker run -d --name fluent-flow-agent-server --restart unless-stopped --init',
      '-v /etc/fluent-flow/provider-auth:/run/secrets/provider-auth:ro',
      '-v fluent-flow-state:/home/node/.fluent-flow',
      '-v fluent-flow-work:/work',
      SELF_HOSTED_IMAGE,
      `--server ${serverUrl}`,
      `--provider ${provider}`,
      `--capacity ${capacity}`,
      `--deployment ${deployment}`,
      `--enrollment-token ${enrollmentToken}`,
      '--provider-secret-file /run/secrets/provider-auth',
    ].join(COMMAND_LINE_BREAK);
  }
  return [
    'npx @fluent-flow/agent-server@latest',
    `--server ${serverUrl}`,
    `--provider ${provider}`,
    `--capacity ${capacity}`,
    `--enrollment-token ${enrollmentToken}`,
  ].join(COMMAND_LINE_BREAK);
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === 'localhost' || /^127(\.\d{1,3}){3}$/.test(hostname);
}

// Strict validator for NEXT_PUBLIC_FLUENT_FLOW_URL. The generated CLI
// command interpolates this value into a shell line, so we must reject
// anything that could break out of the --server arg (whitespace, quotes,
// control chars, shell metacharacters) before rendering the command.
function validateServerUrl(raw: string): { url: string } | { error: string } {
  const trimmed = raw.trim();
  if (trimmed !== raw || /\s/.test(trimmed) || /[\x00-\x1f\x7f]/.test(trimmed)) {
    return { error: 'contains whitespace or control characters' };
  }
  if (!/^[A-Za-z0-9:/._-]+$/.test(trimmed)) {
    return { error: 'contains characters outside the shell-safe set' };
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { error: 'not a valid URL' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { error: `protocol must be http or https (got "${parsed.protocol}")` };
  }
  if (parsed.protocol === 'http:' && !isLoopbackHost(parsed.hostname)) {
    return { error: 'plain http is only allowed for loopback hosts; use https' };
  }
  // Normalise: drop trailing slash so the command is consistent.
  return { url: trimmed.replace(/\/+$/, '') };
}

export async function POST(req: Request) {
  // Auth first — unauthenticated callers always get 401, never leak
  // deployment-config details via a 500 they can trigger without a session.
  const session = await getServerSession(authOptions);
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Then fail fast if the fluent-flow server URL isn't configured — without
  // it the generated command would point at whatever the fallback is, which
  // silently misleads anyone running outside of production. User-facing error
  // stays generic; the specific reason (env var name, validation detail) is
  // logged server-side only so it can't leak to the browser.
  const rawServerUrl = process.env.NEXT_PUBLIC_FLUENT_FLOW_URL;
  if (!rawServerUrl) {
    console.error('[agents.POST] NEXT_PUBLIC_FLUENT_FLOW_URL is not set on the dashboard deployment');
    return NextResponse.json({ error: 'Service misconfigured. Contact an administrator.' }, { status: 500 });
  }
  const serverUrlResult = validateServerUrl(rawServerUrl);
  if ('error' in serverUrlResult) {
    console.error(`[agents.POST] NEXT_PUBLIC_FLUENT_FLOW_URL is invalid: ${serverUrlResult.error}`);
    return NextResponse.json({ error: 'Service misconfigured. Contact an administrator.' }, { status: 500 });
  }
  const serverUrl = serverUrlResult.url;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const { org_id, agent_id, provider, capacity, deployment } = body as Record<string, unknown>;

  if (typeof org_id !== 'string' || !org_id) {
    return NextResponse.json({ error: 'org_id is required' }, { status: 400 });
  }
  if (typeof agent_id !== 'string' || !AGENT_ID_RE.test(agent_id)) {
    return NextResponse.json(
      { error: "Server name must use letters, digits, '_' or '-' and start with a letter or digit" },
      { status: 400 },
    );
  }
  if (!isProvider(provider)) {
    return NextResponse.json({ error: `provider must be one of: ${PROVIDERS.join(', ')}` }, { status: 400 });
  }
  if (!isCapacity(capacity)) {
    return NextResponse.json(
      { error: `capacity must be an integer from ${MIN_CAPACITY} to ${MAX_CAPACITY}` },
      { status: 400 },
    );
  }
  if (!isDeployment(deployment)) {
    return NextResponse.json({ error: `deployment must be one of: ${DEPLOYMENTS.join(', ')}` }, { status: 400 });
  }
  if (!hasRole(session, org_id, 'admin')) {
    return NextResponse.json({ error: 'Forbidden: must be admin of the target org' }, { status: 403 });
  }

  const enrollmentExpiresAt = new Date(Date.now() + ENROLLMENT_TTL_MS);
  let created;
  try {
    created = await createAgentWithEnrollment(
      {
        id: agent_id,
        orgId: org_id,
        agentType: provider,
        transport: 'long_poll',
        transportMeta: { capacity, deployment, provider },
      },
      enrollmentExpiresAt,
    );
  } catch (err) {
    const isUniqueViolation = typeof err === 'object' && err !== null && 'code' in err && err.code === '23505';
    if (isUniqueViolation) {
      return NextResponse.json(
        { error: `A server named '${agent_id}' already exists` },
        { status: 409 },
      );
    }
    throw err;
  }

  if (!ENROLLMENT_TOKEN_RE.test(created.enrollment.plaintext)) {
    console.error('[agents.POST] enrollment token has an unexpected format; refusing to render a command');
    throw new Error('Enrollment token has an unexpected format');
  }

  const command = buildCommand({
    serverUrl,
    provider,
    capacity,
    deployment,
    enrollmentToken: created.enrollment.plaintext,
  });

  return NextResponse.json(
    { agent: created.agent, command, enrollment_expires_at: enrollmentExpiresAt.toISOString() },
    { status: 201 },
  );
}
