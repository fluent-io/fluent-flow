import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions, getOrgScope, hasRole } from '@/lib/auth';
import { loadDb } from '@/lib/runtime-db';

export const dynamic = 'force-dynamic';

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await getServerSession(authOptions);
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { id } = await params;
  const { orgIds } = getOrgScope(session);
  const { getAgentDetail, regenerateKey } = await loadDb();
  const agent = await getAgentDetail(orgIds, id);

  if (!agent) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  if (!hasRole(session, agent.org_id, 'admin')) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const result = await regenerateKey(agent.org_id, agent.id);
  return NextResponse.json(result);
}
