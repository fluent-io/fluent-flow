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
