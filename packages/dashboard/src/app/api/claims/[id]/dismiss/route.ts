import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions, getOrgScope } from '@/lib/auth';
import { loadDb } from '@/lib/runtime-db';

export const dynamic = 'force-dynamic';

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
  const { query, dismissClaim } = await loadDb();

  // Verify the claim exists and is within the user's org scope
  if (!isSuperadmin) {
    const check = await query(
      'SELECT id FROM agent_claims WHERE id = $1 AND org_id = ANY($2)',
      [claimId, orgIds],
    );
    if (check.rows.length === 0) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }
  } else {
    const check = await query('SELECT id FROM agent_claims WHERE id = $1', [claimId]);
    if (check.rows.length === 0) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }
  }

  await dismissClaim(claimId);
  return NextResponse.json({ id: claimId, status: 'cancelled' });
}
