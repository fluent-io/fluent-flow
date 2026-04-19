import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { getAgentDetail, getAgentSessions, getAgentClaims, getKeyInfo, query } from '@fluent-flow/db';
import { authOptions, getOrgScope, hasRole } from '@/lib/auth';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await getServerSession(authOptions);
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { id } = await params;
  const { orgIds } = getOrgScope(session);

  // Agents are keyed by (org_id, id) — not globally unique. Callers that
  // know which org they mean (e.g. the New Agent modal polling after
  // create) pass `?org=<id>` to scope the lookup and avoid flipping to
  // "connected" on a same-named agent in a different org.
  const requestedOrg = new URL(request.url).searchParams.get('org');
  const isSuperadmin = orgIds.length === 0;
  let scope: string[];
  if (requestedOrg) {
    if (!isSuperadmin && !orgIds.includes(requestedOrg)) {
      return NextResponse.json({ error: 'Forbidden: org not in user scope' }, { status: 403 });
    }
    scope = [requestedOrg];
  } else {
    scope = orgIds;
  }

  const agent = await getAgentDetail(scope, id);

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
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await getServerSession(authOptions);
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { id } = await params;
  const { orgIds } = getOrgScope(session);
  const agent = await getAgentDetail(orgIds, id);

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
