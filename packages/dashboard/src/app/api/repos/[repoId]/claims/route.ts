import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { createClaim, query } from '@fluent-flow/db';
import { authOptions, getOrgScope } from '@/lib/auth';

/** Dashboard labels → runner claim types */
const CLAIM_TYPE_MAP: Record<string, string> = {
  feature: 'spec',       // chains spec→build
  fix:     'review_fix',
  review:  'review',
  spec:    'spec',       // standalone, no chain
};
const ALLOWED_DASHBOARD_TYPES = new Set(Object.keys(CLAIM_TYPE_MAP));

/** Types that require a PR number */
const PR_REQUIRED_TYPES = new Set(['fix', 'review']);

type RouteContext = {
  params: Promise<{ repoId: string }>;
};

export async function POST(req: Request, { params }: RouteContext) {
  const session = await getServerSession(authOptions);
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { repoId } = await params;
  const { orgIds, isSuperadmin } = getOrgScope(session);

  if (!isSuperadmin) {
    const repoCheck = await query(
      'SELECT id, repo_full_name FROM repos WHERE id = $1 AND org_id = ANY($2)',
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

  const mappedType = CLAIM_TYPE_MAP[claim_type];

  // PR number validation
  let prNumber: number | undefined;
  if (PR_REQUIRED_TYPES.has(claim_type)) {
    if (typeof pr_number !== 'number' || !Number.isInteger(pr_number) || pr_number < 1) {
      return NextResponse.json(
        { error: `pr_number is required for "${claim_type}" and must be a positive integer` },
        { status: 400 },
      );
    }
    prNumber = pr_number;
  } else if (pr_number !== undefined && pr_number !== null) {
    // Optional — validate if provided
    if (typeof pr_number !== 'number' || !Number.isInteger(pr_number) || pr_number < 1) {
      return NextResponse.json({ error: 'pr_number must be a positive integer' }, { status: 400 });
    }
    prNumber = pr_number;
  }

  const finalDescription = typeof description === 'string' && description.trim().length > 0
    ? description.trim()
    : prNumber
      ? `${mappedType} on PR #${prNumber}`
      : `${mappedType}`;

  // Build payload with auto_chain flag
  const payload: Record<string, unknown> = {};
  if (claim_type === 'feature') {
    payload.auto_chain = true;
  } else if (claim_type === 'spec') {
    payload.auto_chain = false;
  }

  const claim = await createClaim({
    repoId,
    claimType: mappedType,
    description: finalDescription,
    prNumber: prNumber ?? null,
    payload,
  });

  if (!claim) {
    return NextResponse.json({ error: 'Repo not found' }, { status: 404 });
  }

  return NextResponse.json({ ...claim, claim_type: mappedType }, { status: 201 });
}
