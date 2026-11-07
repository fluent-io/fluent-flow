import { expireClaims, redispatchClaim } from '../agents/claim-manager.js';
import { installationCtxForRepo } from '../config/loader.js';
import { getProvider } from '../providers/index.js';
import { onClaimDispatched } from '../engine/check-run.js';
import { sweepStrandedVerifyClaims } from '../engine/verify-transitions.js';
import { db } from '@fluent-flow/db';
import logger from '../logger.js';

const SLEEP_MS = 60_000;

export async function expireClaimsTick() {
  try {
    const expired = await expireClaims() ?? [];

    // Re-dispatch: for each expired claim, create a new claim at attempt + 1
    // (shared with the transient-failure path in the claim-result route).
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
          if (newClaim.head_sha) {
            const [owner, repoName] = newClaim.repo.split('/');
            const ctx = await installationCtxForRepo(owner, repoName);
            if (ctx?.installation_id) {
              const providerClient = getProvider({ installation_id: ctx.installation_id });
              await onClaimDispatched(providerClient, { ...newClaim, installation_id: ctx.installation_id });
            }
          }
        } else {
          logger.warn({
            msg: 'Failed to re-dispatch expired claim (conflict or max attempts)',
            repo: claim.repo,
            prNumber: claim.pr_number,
            attempt: claim.attempt,
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
    await sweepStrandedVerifyClaims(db);
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
