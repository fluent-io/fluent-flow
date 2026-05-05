import { expireClaims, createClaim } from '../agents/claim-manager.js';
import logger from '../logger.js';

const SLEEP_MS = 60_000;

/** Cap retries to prevent infinite loops (e.g. bad PR that always fails). */
const MAX_RETRY_ATTEMPTS = 10;

export async function expireClaimsTick() {
  try {
    const expired = await expireClaims();
    if (!expired || expired.length === 0) return expired;

    // Re-dispatch: for each expired claim, create a new claim at attempt + 1
    for (const claim of expired) {
      try {
        const newAttempt = claim.attempt + 1;

        if (newAttempt > MAX_RETRY_ATTEMPTS) {
          logger.warn({
            msg: 'Claim expired and max retry attempts reached — giving up',
            repo: claim.repo,
            prNumber: claim.pr_number,
            attempt: claim.attempt,
            maxAttempts: MAX_RETRY_ATTEMPTS,
          });
          continue;
        }

        const newClaim = await createClaim({
          orgId: claim.org_id,
          repo: claim.repo,
          prNumber: claim.pr_number,
          attempt: newAttempt,
          claimType: claim.claim_type,
          payload: claim.payload,
          headSha: claim.head_sha,
        });
        if (newClaim) {
          logger.info({
            msg: 'Re-dispatched claim after expiry',
            repo: claim.repo,
            prNumber: claim.pr_number,
            oldAttempt: claim.attempt,
            newAttempt,
            claimId: newClaim.id,
          });
        } else {
          logger.warn({
            msg: 'Failed to re-dispatch claim (conflict?)',
            repo: claim.repo,
            prNumber: claim.pr_number,
            newAttempt,
          });
        }
      } catch (err) {
        // Safe to continue: one failed re-dispatch must not abort the rest of
        // the batch. The claim remains expired in the DB; the next expiry tick
        // will not pick it up again (it's already marked expired), but the
        // on-demand re-dispatch path will still retry it if needed.
        logger.error({
          msg: 'Error re-dispatching expired claim',
          error: err.message,
          claimId: claim.id,
        });
      }
    }
    return expired;
  } catch (err) {
    // Safe to continue: worker tick failure — log and continue the loop.
    // The next tick will retry. Worker loops must never die.
    logger.error({ msg: 'expireClaimsTick: error', error: err.message });
  }
}

export async function startClaimExpiryWorker() {
  logger.info({ msg: 'startClaimExpiryWorker: started', intervalMs: SLEEP_MS });
  while (true) {
    try {
      await expireClaimsTick();
      await new Promise((resolve) => setTimeout(resolve, SLEEP_MS));
    } catch (err) {
      // Safe to continue: worker loop error — sleep and retry. Worker
      // loops must never die — they are the background heart of the system.
      logger.error({ msg: 'startClaimExpiryWorker: unhandled error', error: err.message });
      await new Promise((resolve) => setTimeout(resolve, SLEEP_MS));
    }
  }
}
