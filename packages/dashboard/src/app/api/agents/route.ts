import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions, getOrgScope, hasRole } from '@/lib/auth';
import { loadDb } from '@/lib/runtime-db';

export const dynamic = 'force-dynamic';

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { orgIds } = getOrgScope(session);
  const { listAgents } = await loadDb();
  const agents = await listAgents(orgIds);
  return NextResponse.json(agents);
}

const AGENT_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;
const ALLOWED_AGENT_TYPES = new Set(['claude-code', 'codex', 'devin', 'openclaw', 'aider', 'custom']);

// Strict validator for NEXT_PUBLIC_FLUENT_FLOW_URL. The generated CLI
// command interpolates this value into a shell line, so we must reject
// anything that could break out of the --server arg (whitespace, quotes,
// control chars, shell metacharacters) before rendering the command.
function validateServerUrl(raw: string): { url: string } | { error: string } {
  const trimmed = raw.trim();
  if (trimmed !== raw || /\s/.test(trimmed) || /[\x00-\x1f\x7f]/.test(trimmed)) {
    return { error: 'contains whitespace or control characters' };
  }
  if (/["'`$;&|<>\\]/.test(trimmed)) {
    return { error: 'contains shell-meaningful characters' };
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

  const { org_id, agent_id, agent_type } = (body ?? {}) as Record<string, unknown>;

  if (typeof org_id !== 'string' || !org_id) {
    return NextResponse.json({ error: 'org_id is required' }, { status: 400 });
  }
  if (typeof agent_id !== 'string' || !AGENT_ID_RE.test(agent_id)) {
    return NextResponse.json({ error: 'agent_id must be alphanumeric; letters, digits, _, - only' }, { status: 400 });
  }
  if (typeof agent_type !== 'string' || !ALLOWED_AGENT_TYPES.has(agent_type)) {
    return NextResponse.json({ error: `agent_type must be one of: ${[...ALLOWED_AGENT_TYPES].join(', ')}` }, { status: 400 });
  }
  if (!hasRole(session, org_id, 'admin')) {
    return NextResponse.json({ error: 'Forbidden: must be admin of the target org' }, { status: 403 });
  }
  const { createAgent, createToken, query } = await loadDb();

  let agent;
  try {
    agent = await createAgent({
      id: agent_id,
      orgId: org_id,
      agentType: agent_type,
      transport: 'long_poll',
    });
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === '23505') {
      return NextResponse.json(
        { error: `Agent '${agent_id}' already exists in org '${org_id}'` },
        { status: 409 },
      );
    }
    throw err;
  }

  // Compensating cleanup: if token creation fails after the agent row is
  // written, we'd leave a credentials-less agent behind. Delete it before
  // propagating the error so the user can retry cleanly.
  let token;
  try {
    token = await createToken({
      orgId: org_id,
      agentId: agent_id,
      label: `dashboard-${Date.now().toString(36)}`,
    });
  } catch (err) {
    await query('DELETE FROM agents WHERE org_id = $1 AND id = $2', [org_id, agent_id]).catch(() => {});
    throw err;
  }

  // The runner CLI has no subcommand today; agent_type is stored on the
  // agents row, not passed per-run. Keep the command minimal so what the
  // user sees matches what the CLI actually accepts.
  const command = [
    'npx @fluent-flow/runner@latest',
    `--server ${serverUrl}`,
    `--token ${token.plaintext}`,
  ].join(' \\\n  ');

  // `command` already embeds the plaintext token. Returning it again as a
  // top-level field doubles the exposure surface — if a consumer logs the
  // response, we'd log the token twice.
  return NextResponse.json({ agent, command }, { status: 201 });
}
