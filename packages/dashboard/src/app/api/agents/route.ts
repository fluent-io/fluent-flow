import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { listAgents, createAgent, createToken, query } from '@fluent-flow/db';
import { authOptions, getOrgScope, hasRole } from '@/lib/auth';

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { orgIds } = getOrgScope(session);
  const agents = await listAgents(orgIds);
  return NextResponse.json(agents);
}

const AGENT_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;
const ALLOWED_AGENT_TYPES = new Set(['claude-code', 'codex', 'devin', 'openclaw', 'aider', 'custom']);

export async function POST(req: Request) {
  // Fail fast if the fluent-flow server URL isn't configured — without it
  // the generated command would point at whatever the fallback is, which
  // silently misleads anyone running outside of production.
  const serverUrl = process.env.NEXT_PUBLIC_FLUENT_FLOW_URL;
  if (!serverUrl) {
    return NextResponse.json(
      { error: 'NEXT_PUBLIC_FLUENT_FLOW_URL is not configured on the dashboard deployment' },
      { status: 500 },
    );
  }

  const session = await getServerSession(authOptions);
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

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
