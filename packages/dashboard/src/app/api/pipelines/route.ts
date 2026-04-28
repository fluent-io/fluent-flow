import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { listPipelines, dismissStaleClaims, dismissPipelineClaims } from '@fluent-flow/db';
import { authOptions, getOrgScope } from '@/lib/auth';

export async function GET(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { orgIds } = getOrgScope(session);
  const { searchParams } = new URL(request.url);
  const filter = (searchParams.get('filter') ?? 'active') as 'active' | 'archived' | 'all';
  const pipelines = await listPipelines(orgIds, filter);
  return NextResponse.json(pipelines);
}

export async function POST(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { orgIds, isSuperadmin } = getOrgScope(session);

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const { action, repo, pr_number, older_than_ms } = (body ?? {}) as Record<string, unknown>;

  if (action === 'dismiss-stale') {
    const olderThanMs = typeof older_than_ms === 'number' ? older_than_ms : undefined;
    const count = await dismissStaleClaims(orgIds, olderThanMs);
    return NextResponse.json({ dismissed: count });
  }

  if (action === 'dismiss-pipeline') {
    if (!isSuperadmin && orgIds.length === 0) {
      return NextResponse.json({ error: 'Forbidden: no org membership' }, { status: 403 });
    }
    if (typeof repo !== 'string' || !repo) {
      return NextResponse.json({ error: 'repo is required' }, { status: 400 });
    }
    const prNum = pr_number != null ? Number(pr_number) : undefined;
    if (pr_number != null && (typeof pr_number !== 'number' || isNaN(prNum!))) {
      return NextResponse.json({ error: 'pr_number must be a number' }, { status: 400 });
    }
    const count = await dismissPipelineClaims(orgIds, repo, prNum);
    return NextResponse.json({ dismissed: count });
  }

  return NextResponse.json({ error: 'Unknown action. Use "dismiss-stale" or "dismiss-pipeline".' }, { status: 400 });
}
