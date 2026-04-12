import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { getAgentDetail, getAgentSessions, getAgentClaims, getKeyInfo, query } from '@fluent-flow/db';
import { authOptions, getOrgScope, hasRole } from '@/lib/auth';

export async function GET(
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

  await query('DELETE FROM agents WHERE org_id = $1 AND id = $2', [agent.org_id, agent.id]);

  return NextResponse.json({ deleted: true });
}
