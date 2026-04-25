import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { createClaim, query } from '@fluent-flow/db';
import { authOptions, getOrgScope } from '@/lib/auth';

const ALLOWED_CLAIM_TYPES = new Set(['review', 'build', 'fix', 'test']);

export async function POST(req: Request, { params }: { params: { repoId: string } }) {
  const session = await getServerSession(authOptions);
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { repoId } = params;
  const { orgIds, isSuperadmin } = getOrgScope(session);

  if (!isSuperadmin) {
    const repoCheck = await query(
      'SELECT id FROM repos WHERE id = $1 AND org_id = ANY($2)',
      [repoId, orgIds],
    );
    if (repoCheck.rows.length === 0) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const { claim_type, description, pr_number } = (body ?? {}) as Record<string, unknown>;

  if (typeof claim_type !== 'string' || !ALLOWED_CLAIM_TYPES.has(claim_type)) {
    return NextResponse.json(
      { error: `claim_type must be one of: ${[...ALLOWED_CLAIM_TYPES].join(', ')}` },
      { status: 400 },
    );
  }
  if (typeof description !== 'string') {
    return NextResponse.json({ error: 'description is required' }, { status: 400 });
  }
  if (pr_number !== undefined && typeof pr_number !== 'number') {
    return NextResponse.json({ error: 'pr_number must be a number' }, { status: 400 });
  }

  const claim = await createClaim({
    repoId,
    claimType: claim_type,
    description,
    prNumber: typeof pr_number === 'number' ? pr_number : 0,
  });

  if (!claim) {
    return NextResponse.json({ error: 'Repo not found' }, { status: 404 });
  }

  return NextResponse.json(claim, { status: 201 });
}
