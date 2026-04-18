import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { listAgents, createAgent, createToken } from '@fluent-flow/db';
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
const SERVER_URL = process.env.NEXT_PUBLIC_FLUENT_FLOW_URL ?? 'https://flow.fluentflow.tech';

export async function POST(req: Request) {
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

  try {
    const agent = await createAgent({
      id: agent_id,
      orgId: org_id,
      agentType: agent_type,
      transport: 'long_poll',
    });
    const token = await createToken({
      orgId: org_id,
      agentId: agent_id,
      label: `dashboard-${Date.now().toString(36)}`,
    });

    const command = [
      'npx @fluent-flow/runner@latest run',
      `--server ${SERVER_URL}`,
      `--token ${token.plaintext}`,
      `--agent-type ${agent_type}`,
    ].join(' \\\n  ');

    return NextResponse.json({ agent, token: token.plaintext, command }, { status: 201 });
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
}
