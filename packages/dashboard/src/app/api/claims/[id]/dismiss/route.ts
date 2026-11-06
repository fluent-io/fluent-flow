import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { dismissClaim } from '@fluent-flow/db';
import { authOptions, getOrgScope } from '@/lib/auth';

type RouteContext = {
  params: Promise<{ id: string }>;
};

export async function POST(_request: Request, { params }: RouteContext) {
  const session = await getServerSession(authOptions);
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { id } = await params;
  const claimId = parseInt(id, 10);
  if (isNaN(claimId)) {
    return NextResponse.json({ error: 'Invalid claim ID' }, { status: 400 });
  }

  const { orgIds, isSuperadmin } = getOrgScope(session);

  const dismissed = await dismissClaim(claimId, orgIds, isSuperadmin);
  if (!dismissed) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }
  return NextResponse.json({ id: claimId, status: 'cancelled' });
}
