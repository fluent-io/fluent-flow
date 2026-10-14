import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions, getOrgScope } from '@/lib/auth';
import { buildSpecWorkflowPayload, START_WORKFLOW_CLAIM_TYPE } from './claim-request';
import { loadDb } from '@/lib/runtime-db';

export const dynamic = 'force-dynamic';

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
  const { createClaim, query } = await loadDb();

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

  if (typeof claim_type !== 'string' || claim_type !== START_WORKFLOW_CLAIM_TYPE) {
    return NextResponse.json(
      { error: 'Start workflow only supports claim_type "spec". Other claim types are pipeline steps.' },
      { status: 400 },
    );
  }

  if (description !== undefined && description !== null && typeof description !== 'string') {
    return NextResponse.json({ error: 'description must be a string' }, { status: 400 });
  }

  if (pr_number !== undefined && pr_number !== null) {
    return NextResponse.json(
      { error: 'pr_number is not accepted when starting a spec workflow' },
      { status: 400 },
    );
  }

  const specWorkflow = buildSpecWorkflowPayload(description as string | undefined | null);

  const claim = await createClaim({
    repoId,
    ...specWorkflow,
  });

  if (!claim) {
    return NextResponse.json({ error: 'Repo not found' }, { status: 404 });
  }

  return NextResponse.json({ ...claim, claim_type: START_WORKFLOW_CLAIM_TYPE }, { status: 201 });
}
