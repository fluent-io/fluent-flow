import { and, desc, eq } from 'drizzle-orm';
import { db, schema } from '../client.js';

const { verificationResults } = schema;

export async function insertVerificationResult(row) {
  const [inserted] = await db.insert(verificationResults)
    .values(row)
    .onConflictDoUpdate({ target: verificationResults.claimId, set: { ...row } })
    .returning();
  return inserted;
}

export async function getVerificationResultByClaim(orgId, claimId) {
  const [row] = await db.select().from(verificationResults)
    .where(and(eq(verificationResults.orgId, orgId), eq(verificationResults.claimId, claimId)));
  return row ?? null;
}

export async function getVerificationResultsForPR(orgId, repo, prNumber) {
  return db.select().from(verificationResults)
    .where(and(eq(verificationResults.orgId, orgId), eq(verificationResults.repo, repo),
               eq(verificationResults.prNumber, prNumber)))
    .orderBy(desc(verificationResults.createdAt));
}