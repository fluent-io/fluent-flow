import { and, desc, eq } from 'drizzle-orm';
import { db, schema } from '../client.js';

const { verificationResults } = schema;
type VerificationResultInsert = typeof verificationResults.$inferInsert;

export async function insertVerificationResult(row: VerificationResultInsert, executor: typeof db = db) {
  const [inserted] = await executor.insert(verificationResults)
    .values(row)
    .onConflictDoUpdate({ target: verificationResults.claimId, set: { ...row } })
    .returning();
  return inserted;
}

type QueryClient = {
  query: (text: string, values?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
};

export async function insertVerificationResultAtomic(row: VerificationResultInsert, client: QueryClient) {
  const result = await client.query(
    `INSERT INTO verification_results (
       org_id, claim_id, repo, pr_number, phase, framework, outcome, matrix,
       manifest, test_hashes, artifact_sha, red_base_sha, green_sha
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     ON CONFLICT (claim_id) DO UPDATE SET
       phase = EXCLUDED.phase,
       framework = EXCLUDED.framework,
       outcome = EXCLUDED.outcome,
       matrix = EXCLUDED.matrix,
       manifest = EXCLUDED.manifest,
       test_hashes = EXCLUDED.test_hashes,
       artifact_sha = EXCLUDED.artifact_sha,
       red_base_sha = EXCLUDED.red_base_sha,
       green_sha = EXCLUDED.green_sha
     RETURNING *`,
    [
      row.orgId,
      row.claimId,
      row.repo,
      row.prNumber,
      row.phase,
      row.framework,
      row.outcome,
      row.matrix ?? null,
      row.manifest ?? null,
      row.testHashes ?? null,
      row.artifactSha ?? null,
      row.redBaseSha ?? null,
      row.greenSha ?? null,
    ],
  );
  return result.rows[0] ?? null;
}

export async function markVerificationTransitionApplied(claimId: number, executor: typeof db = db) {
  const [updated] = await executor
    .update(verificationResults)
    .set({ transitionAppliedAt: new Date() })
    .where(eq(verificationResults.claimId, claimId))
    .returning();
  return updated ?? null;
}

export async function getVerificationResultByClaim(orgId: string, claimId: number) {
  const [row] = await db.select().from(verificationResults)
    .where(and(eq(verificationResults.orgId, orgId), eq(verificationResults.claimId, claimId)));
  return row ?? null;
}

export async function getVerificationResultsForPR(orgId: string, repo: string, prNumber: number) {
  return db.select().from(verificationResults)
    .where(and(eq(verificationResults.orgId, orgId), eq(verificationResults.repo, repo),
               eq(verificationResults.prNumber, prNumber)))
    .orderBy(desc(verificationResults.createdAt));
}
