import { expireClaims } from '../agents/claim-manager.js';
import logger from '../logger.js';

const SLEEP_MS = 60_000;

export async function startClaimExpiryWorker() {
  logger.info({ msg: 'startClaimExpiryWorker: started', intervalMs: SLEEP_MS });
  while (true) {
    try {
      await expireClaims();
    } catch (err) {
      logger.error({ msg: 'startClaimExpiryWorker: error', error: err.message });
    }
    await new Promise((resolve) => setTimeout(resolve, SLEEP_MS));
  }
}
