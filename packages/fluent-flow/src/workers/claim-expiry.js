import { expireClaims } from '../agents/claim-manager.js';
import logger from '../logger.js';

const SLEEP_MS = 60_000;

export async function expireClaimsTick() {
  try {
    return await expireClaims();
  } catch (err) {
    logger.error({ msg: 'startClaimExpiryWorker: error', error: err.message });
  }
}

export async function startClaimExpiryWorker() {
  logger.info({ msg: 'startClaimExpiryWorker: started', intervalMs: SLEEP_MS });
  while (true) {
    await expireClaimsTick();
    await new Promise((resolve) => setTimeout(resolve, SLEEP_MS));
  }
}
