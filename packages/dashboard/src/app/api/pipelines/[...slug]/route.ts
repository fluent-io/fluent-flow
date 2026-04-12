import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { getPipelineDetail } from '@fluent-flow/db';
import { authOptions, getOrgScope } from '@/lib/auth';

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ slug: string[] }> },
) {
  const session = await getServerSession(authOptions);
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { slug } = await params;
  if (slug.length < 3) {
    return NextResponse.json({ error: 'Invalid path. Expected: owner/repo/prNumber' }, { status: 400 });
  }

  const owner = slug[0];
  const repo = slug[1];
  const prNumber = parseInt(slug[2], 10);

  if (isNaN(prNumber)) {
    return NextResponse.json({ error: 'Invalid PR number' }, { status: 400 });
  }

  const { orgIds } = getOrgScope(session);
  const claims = await getPipelineDetail(orgIds, `${owner}/${repo}`, prNumber);
  return NextResponse.json(claims);
}
