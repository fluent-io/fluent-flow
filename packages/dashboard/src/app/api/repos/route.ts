import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { listRepos } from '@fluent-flow/db';
import { authOptions, getOrgScope } from '@/lib/auth';

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { orgIds } = getOrgScope(session);
  const repos = await listRepos(orgIds);
  return NextResponse.json(repos);
}
