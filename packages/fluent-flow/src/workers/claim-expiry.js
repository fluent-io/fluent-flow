import { expireClaims, redispatchClaim } from '../agents/claim-manager.js';
import { sweepStrandedVerifyClaims } from '../engine/verify-transitions.js';
import { db } from '@fluent-flow/db';
import logger from '../logger.js';

const SLEEP_MS = 60_000;

export async function expireClaimsTick() {
  try {
    const expired = await expireClaims();
    if (!expired || expired.length === 0) return expired;

    for (const claim of expired) {
      try {
        const newClaim = await redispatchClaim(claim);
        if (newClaim) {
          logger.info({
            msg: 'Re-dispatched claim after expiry',
            repo: claim.repo,
            prNumber: claim.pr_number,
            oldAttempt: claim.attempt,
            newAttempt: claim.attempt + 1,
            claimId: newClaim.id,
          });
        } else {
          logger.warn({
            msg: 'Failed to re-dispatch expired claim (conflict or max attempts)',
            repo: claim.repo,
            prNumber: claim.pr_number,
            attempt: claim.attempt,
          });
        }
      } catch (err) {
        logger.error({
          msg: 'Error re-dispatching expired claim',
          error: err.message,
          claimId: claim.id,
        });
      }
    }
    return expired;
  } catch (err) {
    logger.error({ msg: 'expireClaimsTick: error', error: err.message });
  }
}

export async function startClaimExpiryWorker() {
  logger.info({ msg: 'startClaimExpiryWorker: started', intervalMs: SLEEP_MS });
  while (true) {
    try {
      await expireClaimsTick();
      await sweepStrandedVerifyClaims(db);
      await new Promise((resolve) => setTimeout(resolve, SLEEP_MS));
    } catch (err) {
      logger.error({ msg: 'startClaimExpiryWorker: unhandled error', error: err.message });
      await new Promise((resolve) => setTimeout(resolve, SLEEP_MS));
    }
  }
}