import { expireSessions } from '../agents/session-manager.js';
import logger from '../logger.js';

const SLEEP_MS = 60_000;

export async function expireSessionsTick() {
  try {
    return await expireSessions();
  } catch (err) {
    // Safe to continue: worker tick failure — log and continue the loop.
    // The next tick will retry. Worker loops must never die.
    logger.error({ msg: 'expireSessionsTick: error', error: err.message });
  }
}

export async function startSessionExpiryWorker() {
  logger.info({ msg: 'startSessionExpiryWorker: started', intervalMs: SLEEP_MS });
  while (true) {
    try {
      await expireSessionsTick();
      await new Promise((resolve) => setTimeout(resolve, SLEEP_MS));
    } catch (err) {
      // Safe to continue: worker loop error — sleep and retry. Worker
      // loops must never die — they are the background heart of the system.
      logger.error({ msg: 'startSessionExpiryWorker: unhandled error', error: err.message });
      await new Promise((resolve) => setTimeout(resolve, SLEEP_MS));
    }
  }
}
