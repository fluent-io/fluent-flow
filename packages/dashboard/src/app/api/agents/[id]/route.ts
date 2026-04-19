import { NextResponse } from 'next/server';
import { getServerSession, type Session } from 'next-auth';
import { getAgentDetail, getAgentSessions, getAgentClaims, getKeyInfo, query } from '@fluent-flow/db';
import { authOptions, getOrgScope, hasRole } from '@/lib/auth';

/**
 * Resolve an agent by (org_id, id) from the user's scope. Requires `?org=`
 * when the scope spans >1 org since agent IDs aren't globally unique
 * (they're keyed by (org_id, id)) — picking an arbitrary match could
 * return or mutate the wrong org's agent.
 *
 * Returns either the resolved agent row or a NextResponse error that the
 * caller should return directly.
 */
async function resolveAgent(
  request: Request,
  session: Session,
  agentId: string,
): Promise<{ agent: Awaited<ReturnType<typeof getAgentDetail>>; error?: never } | { error: NextResponse; agent?: never }> {
  const { orgIds } = getOrgScope(session);
  const isSuperadmin = orgIds.length === 0;
  const requestedOrg = new URL(request.url).searchParams.get('org');

  let scope: string[];
  if (requestedOrg) {
    if (!isSuperadmin && !orgIds.includes(requestedOrg)) {
      return { error: NextResponse.json({ error: 'Forbidden: org not in user scope' }, { status: 403 }) };
    }
    scope = [requestedOrg];
  } else if (orgIds.length === 1) {
    // Single-org user — no ambiguity possible.
    scope = orgIds;
  } else {
    // Multiple orgs in scope (incl. superadmin = all orgs). Require ?org=
    // so we never return a same-named agent from an unintended org.
    return {
      error: NextResponse.json(
        { error: 'org query param is required (?org=<org_id>) when caller has access to multiple orgs' },
        { status: 400 },
      ),
    };
  }

  const agent = await getAgentDetail(scope, agentId);
  return { agent };
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await getServerSession(authOptions);
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { id } = await params;
  const resolved = await resolveAgent(request, session, id);
  if (resolved.error) return resolved.error;

  const agent = resolved.agent;
  if (!agent) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const [sessions, claims, key] = await Promise.all([
    getAgentSessions(agent.org_id, agent.id),
    getAgentClaims(agent.org_id, agent.id),
    getKeyInfo(agent.org_id, agent.id),
  ]);

  return NextResponse.json({ agent, sessions, claims, key });
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await getServerSession(authOptions);
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { id } = await params;
  const resolved = await resolveAgent(request, session, id);
  if (resolved.error) return resolved.error;

  const agent = resolved.agent;
  if (!agent) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  if (!hasRole(session, agent.org_id, 'admin')) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  await query(
    `DELETE FROM agent_claims WHERE org_id = $1 AND session_id IN (
      SELECT id FROM agent_sessions WHERE org_id = $1 AND agent_id = $2
    )`,
    [agent.org_id, agent.id],
  );
  await query('DELETE FROM agents WHERE org_id = $1 AND id = $2', [agent.org_id, agent.id]);

  return NextResponse.json({ deleted: true });
}
