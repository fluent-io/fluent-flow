import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions, getOrgScope } from '@/lib/auth';
import { loadDb } from '@/lib/runtime-db';

export const dynamic = 'force-dynamic';

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { orgIds, isSuperadmin } = getOrgScope(session);
  const { listRepos } = await loadDb();
  const repos = await listRepos(orgIds, isSuperadmin);
  return NextResponse.json(repos);
}
