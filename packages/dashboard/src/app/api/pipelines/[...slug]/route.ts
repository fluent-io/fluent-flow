import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions, getOrgScope } from '@/lib/auth';
import { loadDb } from '@/lib/runtime-db';

export const dynamic = 'force-dynamic';

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ slug: string[] }> },
) {
  const session = await getServerSession(authOptions);
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { slug } = await params;
  if (slug.length < 2) {
    return NextResponse.json({ error: 'Invalid path. Expected: owner/repo or owner/repo/prNumber' }, { status: 400 });
  }

  const owner = slug[0];
  const repo = slug[1];
  const rawPr = slug[2];
  // "no-pr" segment means null pr_number (feature/spec claims)
  const prNumber = rawPr === undefined ? null : (rawPr === 'no-pr' ? null : parseInt(rawPr, 10));

  if (rawPr !== undefined && rawPr !== 'no-pr' && isNaN(prNumber!)) {
    return NextResponse.json({ error: 'Invalid PR number' }, { status: 400 });
  }

  const { orgIds } = getOrgScope(session);
  const { getPipelineDetail } = await loadDb();
  const claims = await getPipelineDetail(orgIds, `${owner}/${repo}`, prNumber);
  return NextResponse.json(claims);
}
