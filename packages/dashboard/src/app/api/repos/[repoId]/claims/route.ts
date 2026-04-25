import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { createClaim, query } from '@fluent-flow/db';
import { authOptions, getOrgScope } from '@/lib/auth';

/** Dashboard labels → runner claim types */
const CLAIM_TYPE_MAP: Record<string, string> = {
  review: 'review',
  build: 'build',
  fix: 'review_fix',
  test: 'test_verify',
};
const ALLOWED_DASHBOARD_TYPES = new Set(Object.keys(CLAIM_TYPE_MAP));

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

  if (typeof claim_type !== 'string' || !ALLOWED_DASHBOARD_TYPES.has(claim_type)) {
    return NextResponse.json(
      { error: `claim_type must be one of: ${[...ALLOWED_DASHBOARD_TYPES].join(', ')}` },
      { status: 400 },
    );
  }

  if (description !== undefined && description !== null && typeof description !== 'string') {
    return NextResponse.json({ error: 'description must be a string' }, { status: 400 });
  }

  if (typeof pr_number !== 'number' || !Number.isInteger(pr_number) || pr_number < 1) {
    return NextResponse.json({ error: 'pr_number is required and must be a positive integer' }, { status: 400 });
  }

  const mappedType = CLAIM_TYPE_MAP[claim_type];

  const finalDescription = typeof description === 'string' && description.trim().length > 0
    ? description.trim()
    : `${mappedType} on PR #${pr_number}`;

  const claim = await createClaim({
    repoId,
    claimType: mappedType,
    description: finalDescription,
    prNumber: pr_number,
  });

  if (!claim) {
    return NextResponse.json({ error: 'Repo not found' }, { status: 404 });
  }

  return NextResponse.json({ ...claim, claim_type: mappedType }, { status: 201 });
}
